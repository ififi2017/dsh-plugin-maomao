import { dirname, join, resolve } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';
import { ApiError, MediaFileType, MsgType, QQBot, contentSanitizer } from '@tencent-connect/qqbot-nodejs';

import { HarnessConversation } from './harness.mjs';
import { HarnessShadowJudge } from './judge.mjs';
import { qqCommand, qqPersonaReply, sidReply, statusReply } from './commands.mjs';
import { GatewaySessionFile, gatewaySessionPath } from './gateway-session.mjs';
import { GeminiImageGeneration, OpenAiImageGeneration, QqImageTool, imageRequest } from './image-generation.mjs';
import { allowedInbound, inboundImage, normalizeInbound, recentImageFor, SPLIT_IMAGE_WAIT_MS,
  textBubbles, waitsForSplitImage } from './inbound.mjs';
import { plainQqMarkdown } from './markdown.mjs';
import { loadQqImage } from './media.mjs';
import { OrdinaryBridge } from './ordinary.mjs';
import { PassiveShadow } from './shadow.mjs';
import { GeminiSpeech, spokenTranscript } from './speech.mjs';
import { ConnectorState, qqStorageHome, routeKey } from './state.mjs';
import { choiceData, parseChoiceData, parseChoiceReply } from '../choices.mjs';
import { channelPersona } from '../personas.mjs';
import { ReplyCheck } from '../onboarding.mjs';
import { StickerIntelligence } from './stickers.mjs';
import { provisionQQ, verifyQQ } from './setup-qq.mjs';

export const name = 'maomao-dsh-qq';
export const inject = ['sessionController'];

function errorLabel(error) {
  const code = typeof error?.code === 'string' ? error.code.slice(0, 64) : '';
  return code || (typeof error?.name === 'string' ? error.name.slice(0, 64) : 'Error');
}

const personaTarget = ({ botId, scope, chatId }) => ({
  id: routeKey(botId, scope, chatId), kind: scope === 'group' ? 'qq-group' : 'qq-dm',
});
const qqId = (value) => typeof value === 'string' && /^[a-z0-9_-]{1,128}$/i.test(value);

function choiceKeyboard(token, options, senderId) {
  return { content: { rows: options.map((label, index) => ({ buttons: [{
    id: String(index),
    render_data: { label, visited_label: '已选择', style: 1 },
    action: { type: 1, permission: { type: 0, specify_user_ids: [senderId] },
      data: choiceData(token, index), unsupport_tips: '当前客户端不支持按钮，可以直接发文字。' },
  }] })) } };
}

export class MaomaoQqConnector {
  #ctx;
  #logger;
  #config;
  #state;
  #storageHome;
  #harness;
  #botFactory;
  #managedCredential;
  #appId = '';
  #bot = null;
  #running = null;
  #starting = null;
  #stopped = false;
  #abort = new AbortController();
  #ready = false;
  #lastError = '';
  #observed = new Map();
  #imageInFlight = new Map();
  #queues = new Map();
  #shadow;
  #ordinary;
  #stickers = null;
  #mediaJobs = new Set();
  #imageDetails = new Map();
  #mediaStatus = null;
  #diagnostics = {};
  #markdownDenied = new Set();
  #pairing = null;
  #replyCheck = new ReplyCheck();
  #speech = null;
  #workerOptions;
  #voiceHistory = new Map();
  #imageGeneration = null;
  #imageTool = null;

  constructor(ctx, config, { state, harness, shadowJudge, ordinary, stickers, speech, imageGeneration,
    managedCredential, botFactory = (options) => new QQBot(options) } = {}) {
    this.#ctx = ctx;
    this.#logger = typeof ctx.logger === 'function' ? ctx.logger(name) : (ctx.logger ?? console);
    this.#config = config;
    this.#managedCredential = managedCredential;
    const home = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh');
    const profileDocument = ctx.get?.('configEditor')?.documentPath;
    const root = qqStorageHome(home, profileDocument ? dirname(profileDocument) : process.env.DSH_PROFILE_DIR);
    this.#storageHome = root;
    this.#state = state ?? new ConnectorState(resolve(config.statePath ?? join(root, 'integrations', 'maomao-qq', 'state.json')));
    this.#harness = harness ?? new HarnessConversation(ctx.sessionController, this.#state, {
      workspace: config.workspace,
      agentPreset: config.agentPreset,
    });
    const semanticJudge = config.shadow?.semantic?.enabled === true
      ? new HarnessShadowJudge(ctx.sessionController, this.#state, {
        preset: config.shadow.semantic.preset,
        workspace: config.workspace,
        selectModel: (sessionId) => ctx.get?.('maomaoModels')?.useChat?.(ctx.sessionController, sessionId),
      }) : null;
    this.#shadow = config.shadow?.enabled === true ? new PassiveShadow(
      resolve(config.shadow.path ?? join(root, 'integrations', 'maomao-qq', 'shadow-decisions.jsonl')),
      { isOwner: (envelope) => this.#isOwner(envelope),
        debounceMs: config.shadow.debounceMs ?? 1_500,
        judge: shadowJudge ?? (semanticJudge ? semanticJudge.judge.bind(semanticJudge) : null) },
    ) : null;
    const stickerEnabled = config.stickers?.enabled === true && config.dryRun !== true;
    const voiceEnabled = config.voice?.enabled === true && config.dryRun !== true;
    this.#workerOptions = {
      root: resolve(config.ordinary?.root ?? join(root, 'integrations', 'maomao-qq', 'ordinary')),
      companionPath: config.ordinary?.companionPath,
      python: config.ordinary?.python,
      stickerPack: stickerEnabled ? config.stickers.packRoot : undefined,
      embedding: stickerEnabled && config.stickers.embedding === true,
      modelSelection: () => ctx.get?.('maomaoModels'),
    };
    this.#ordinary = ordinary ?? (config.ordinary?.enabled === true || stickerEnabled || voiceEnabled
      ? new OrdinaryBridge(this.#workerOptions) : null);
    if (stickerEnabled) {
      try {
        this.#stickers = stickers ?? new StickerIntelligence({
          model: config.stickers.model,
          key: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
        });
      } catch (error) {
        this.#logger.warn?.('QQ stickers unavailable:', errorLabel(error));
      }
    }
    if (voiceEnabled) {
      try {
        this.#speech = speech ?? new GeminiSpeech({ key: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY });
      } catch (error) {
        this.#logger.warn?.('QQ voice unavailable:', errorLabel(error));
      }
    }
    if (config.imageGeneration?.enabled === true && config.dryRun !== true) {
      try {
        this.#imageGeneration = imageGeneration ?? new GeminiImageGeneration({
          key: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
        });
      } catch (error) {
        this.#logger.warn?.('QQ image generation unavailable:', errorLabel(error));
      }
    }
    if (config.dryRun !== true) this.#imageTool = new QqImageTool();
    this.#botFactory = botFactory;
  }

  async start() {
    if (this.#starting) return this.#starting;
    if (this.#bot) return;
    this.#stopped = false;
    this.#lastError = '';
    this.#markdownDenied.clear();
    if (this.#abort.signal.aborted) this.#abort = new AbortController();
    this.#starting = this.#start().finally(() => { this.#starting = null; });
    return this.#starting;
  }

  async #start() {
    await this.#state.load();
    const appId = this.#managedCredential?.appId ?? process.env.MAOMAO_QQ_APP_ID?.trim();
    const appSecret = this.#managedCredential?.secret ?? process.env.MAOMAO_QQ_APP_SECRET?.trim();
    if (!appId || !appSecret) throw new Error('MAOMAO_QQ_APP_ID and MAOMAO_QQ_APP_SECRET are required');
    if (!this.#managedCredential && process.env.MAOMAO_QQ_CONNECT !== 'I_STOPPED_HERMES_QQ') {
      throw new Error('Set MAOMAO_QQ_CONNECT=I_STOPPED_HERMES_QQ only after stopping the Hermes QQ connector');
    }
    if (this.#stopped) return;
    this.#appId = appId;
    const sessionPersistence = this.#config.gatewaySession?.enabled === false ? undefined
      : new GatewaySessionFile(resolve(this.#config.gatewaySession?.path ?? gatewaySessionPath(
        this.#storageHome, appId)), appId,
      { warn: (code) => this.#logger.warn?.('QQ gateway session:', code) });
    const bot = this.#botFactory({ appId, appSecret, accountId: appId, transport: 'websocket', sessionPersistence });
    this.#bot = bot;
    bot.use?.(contentSanitizer({ stripBotMention: true, parseFaceTags: true }));
    bot.on('ready', () => { this.#ready = true; this.#lastError = ''; });
    bot.on('resumed', () => { this.#ready = true; this.#lastError = ''; });
    bot.on('message', (_context, message) => {
      void this.accept(message).catch((error) => this.#logger.error?.('QQ inbound failed:', errorLabel(error)));
    });
    bot.on('interaction', (_context, event) =>
      this.#acceptChoice(bot, event).catch((error) => this.#logger.warn?.('QQ choice failed:', errorLabel(error))));
    bot.on('error', (error) => {
      this.#ready = false;
      this.#lastError = errorLabel(error);
      this.#logger.warn?.('QQ transport error:', this.#lastError);
    });
    this.#running = Promise.resolve(bot.start()).catch((error) => {
      this.#lastError = errorLabel(error);
      this.#logger.error?.('QQ transport stopped:', this.#lastError);
    }).finally(() => {
      this.#ready = false;
      if (this.#bot === bot) this.#bot = null;
    });
  }

  status() {
    return Object.freeze({ channel: 'qq', running: this.#bot !== null, ready: this.#ready,
      lastError: this.#lastError, shadow: this.#shadow?.status() ?? { enabled: false },
      ordinary: { enabled: this.#config.ordinary?.enabled === true }, media: this.#mediaStatus, diagnostics: this.#diagnostics,
      panelRoutes: this.#state.panelRouteCount(this.#appId),
      panelBindings: [...this.#state.panelRoutes(this.#appId), ...this.#state.panelOwnerBindings(this.#appId)] });
  }

  #allowed(envelope) {
    return allowedInbound(envelope, this.#config) || this.#state.panelAllowed(envelope.botId, envelope.scope, envelope.chatId);
  }

  memorySources() {
    if (!this.#appId || this.#config.dryRun === true) return [];
    const configured = this.#config.groupAllowlist;
    const bot = createHash('sha256').update(this.#appId).digest('hex');
    const labels = new Map(this.personaTargets().map(({ id, label }) => [id, label]));
    return this.#state.memoryGroups(this.#appId, Array.isArray(configured) ? configured : [])
      .map(({ key, directory, scope }) => ({ key, scope, platforms: ['qq'], label: labels.get(key) ?? `QQ 群 · ${key.slice(-8)}`,
        path: /^[a-f0-9]{64}$/.test(directory) && /^[a-f0-9]{64}$/.test(scope)
          ? join(this.#workerOptions.root, 'qq', bot, 'group', directory, 'dialogue.sqlite3') : null }));
  }

  personaTargets() {
    if (!this.#appId || this.#config.dryRun === true) return [];
    const targets = new Map();
    for (const [scope, list] of [['group', this.#config.groupAllowlist], ['c2c', this.#config.dmAllowlist]]) {
      for (const chatId of Array.isArray(list) ? list : []) {
        const target = personaTarget({ botId: this.#appId, scope, chatId });
        targets.set(target.id, { ...target, ...(scope === 'group' ? { groupOpenId: chatId } : {}) });
      }
    }
    for (const { id, scope, groupOpenId } of this.#state.panelRoutes(this.#appId)) {
      if ((scope === 'group' || scope === 'c2c') && !targets.has(id)) {
        targets.set(id, { id, kind: scope === 'group' ? 'qq-group' : 'qq-dm', groupOpenId });
      }
    }
    return [...targets.values()].sort((a, b) => a.id.localeCompare(b.id)).map((target) => ({
      ...target, label: `${target.kind === 'qq-group' ? 'QQ 群' : 'QQ 私聊'} · ${(target.groupOpenId ?? target.id).slice(-8)}`,
    }));
  }

  #isOwner({ botId, scope, chatId, senderId }) {
    const owners = this.#config.shadow?.ownerIds;
    return (Array.isArray(owners) && owners.includes(senderId))
      || (scope === 'group' && this.#state.panelOwnsGroup(botId, chatId, senderId));
  }

  unbind(id) { return this.#state.removePanelRoute(this.#appId, id); }

  async pair({ action, scope, id, proof }) {
    if (this.#pairing?.expires <= Date.now()) this.#pairing = null;
    if (action === 'start') {
      if (!this.#ready || this.#config.dryRun === true) return { status: 'unavailable' };
      if (this.#pairing) return { status: 'busy' };
      this.#pairing = { id: randomUUID(), scope, code: randomBytes(12).toString('hex'),
        expires: Date.now() + 5 * 60_000, attempts: 0 };
    }
    const pairing = this.#pairing;
    if (action === 'current' && !pairing) return { status: 'idle' };
    if (!pairing || (!['start', 'current'].includes(action) && pairing.id !== id)) {
      return { status: 'expired' };
    }
    if (action === 'cancel') {
      this.#pairing = null;
      return { status: 'cancelled' };
    }
    if (action === 'confirm') {
      if (!pairing.envelope) return { status: 'waiting' };
      if (proof !== pairing.proof) {
        if (++pairing.attempts >= 5) {
          this.#pairing = null;
          return { status: 'locked' };
        }
        return { status: 'invalid' };
      }
      this.#pairing = null;
      const { botId, scope, chatId, senderId } = pairing.envelope;
      if (pairing.scope === 'owner') {
        const configured = allowedInbound(pairing.envelope, this.#config);
        if (!await this.#state.bindPanelOwner(botId, chatId, senderId, configured)) return { status: 'unavailable' };
      } else {
        await this.#state.allowPanelRoute(botId, scope, chatId);
      }
      return pairing.scope === 'owner' ? { status: 'bound' } : { status: 'bound', route: routeKey(botId, scope, chatId) };
    }
    return { status: pairing.envelope ? 'claimed' : 'waiting', delivery: pairing.delivery, scope: pairing.scope,
      id: pairing.id, expires: pairing.expires, command: `/pair ${pairing.code}` };
  }

  replyCheck({ action, route }) {
    if (action === 'read') return this.#replyCheck.read();
    if (!this.#ready || this.#config.dryRun === true
      || !this.#state.panelRoutes(this.#appId).some((entry) => entry.id === route)) return { status: 'unavailable' };
    return this.#replyCheck.start(route);
  }

  async stop() {
    this.#stopped = true;
    this.#ready = false;
    this.#abort.abort(new Error('QQ connector stopped'));
    await this.#starting?.catch(() => undefined);
    this.#bot?.stop();
    await this.#running;
    await Promise.allSettled([...this.#queues.values()]);
    await Promise.allSettled([...this.#mediaJobs]);
    this.#bot = null;
    this.#appId = '';
    this.#observed.clear();
    this.#imageInFlight.clear();
    this.#imageDetails.clear();
    this.#voiceHistory.clear();
    this.#pairing = null;
    await this.#shadow?.stop();
    await this.#ordinary?.stop();
  }

  async accept(message) {
    if (this.#stopped) return false;
    const delivery = this.#config.shadow?.delivery;
    const passiveGroup = message?.kind === 'group' && delivery?.enabled === true
      && Array.isArray(delivery.groupAllowlist) && delivery.groupAllowlist.includes(message.groupOpenid);
    const peer = passiveGroup && Object.hasOwn(delivery.peers ?? {}, message.groupOpenid)
      ? delivery.peers[message.groupOpenid] : null;
    if (message?.senderIsBot === true && peer?.name
      && (peer.memberId ? message.senderId === peer.memberId : message.senderName === peer.name)) {
      const group = { botId: this.#appId, scope: 'group', chatId: message.groupOpenid };
      if (!this.#allowed(group) || message.senderId === this.#appId) return false;
      this.#shadow?.notePeer(this.#appId, group.chatId, peer.name, message.content, message.messageId);
      return true;
    }
    const envelope = normalizeInbound(message, Date.now(), this.#appId, peer);
    if (!envelope) return false;
    const allowed = this.#allowed(envelope);
    const commandText = envelope.text.replace(/^<@!?[A-Za-z0-9_-]{1,128}>\s*/, '');
    if (/^\/pair(?:\s|$)/i.test(commandText)) {
      const pairCode = envelope.addressed && /^\/pair ([a-f0-9]{24})$/.exec(commandText)?.[1];
      const pairing = this.#pairing;
      const matching = pairing?.scope === 'owner'
        ? allowed && envelope.scope === 'group' && !this.#state.panelOwnsGroup(envelope.botId, envelope.chatId, envelope.senderId)
        : !allowed && pairing?.scope === envelope.scope;
      if (!pairCode || !matching || pairing.envelope
        || pairing.expires <= Date.now() || pairing.code !== pairCode) return false;
      pairing.envelope = envelope;
      pairing.proof = randomBytes(4).toString('hex');
      try {
        if (!await this.#state.recordReceipt(envelope)) return false;
        if (pairing !== this.#pairing || pairing.expires <= Date.now()) return false;
        const ticket = await this.#state.reserve(envelope, pairing.proof);
        if (!ticket.fresh) return false;
        let messageId;
        try {
          messageId = await this.#sendText(envelope, `请在猫猫面板输入确认码 ${pairing.proof}，五分钟内有效。`, ticket.seq,
            () => pairing === this.#pairing && pairing.expires > Date.now());
          if (messageId) pairing.delivery = 'sent';
        } finally { await this.#state.finish(ticket.key, messageId); }
      } finally { pairing.delivery ??= 'failed'; }
      return true;
    }
    if (!allowed) return false;
    if (!await this.#state.recordReceipt(envelope)) return false;
    this.#diagnostics.receive = { outcome: 'ok', at: Date.now() };
    this.#observeReceipt(envelope);
    const test = envelope.addressed && this.#replyCheck.receive(
      routeKey(envelope.botId, envelope.scope, envelope.chatId), envelope.text);
    if (test) {
      if (this.#config.respondToMentions === false) test('replies_disabled');
      else this.#queueAnswer(envelope, null, false, null, null, false, null, test);
      return true;
    }
    // This is a trusted, per-message event. The Harness prompt does not carry authorization data.
    try { this.#ctx.emit('maomao-qq/inbound', envelope); }
    catch (error) { this.#logger.warn?.('QQ inbound observer failed:', errorLabel(error)); }
    const command = qqCommand(envelope);
    if (command) {
      if (typeof command === 'object') {
        const answer = qqPersonaReply(command, { book: this.#ctx.get?.('maomaoPersonas'),
          target: personaTarget(envelope), owner: this.#isOwner(envelope) });
        await this.respond(envelope.receiptKey, answer);
        return true;
      }
      this.#enqueue(envelope, async () => {
        const answer = command === '/sid' ? sidReply(envelope) : await this.#statusReply(envelope);
        await this.respond(envelope.receiptKey, answer);
      });
      return true;
    }
    const priorImage = recentImageFor(envelope, this.#observed.values());
    const judgeGroups = this.#config.shadow?.semantic?.groupAllowlist;
    const allowJudgment = !Array.isArray(judgeGroups) || judgeGroups.includes(envelope.chatId);
    const shadowDecision = this.#shadow?.observe(envelope, {
      hasReferencedImage: Boolean(priorImage || envelope.quotedImages.length), peer, allowJudgment,
    }) ?? null;
    if (shadowDecision) void shadowDecision.catch((error) =>
      this.#logger.warn?.('QQ shadow unavailable:', errorLabel(error)));
    let ordinaryContext = null;
    if (this.#ordinary) {
      try {
        if (this.#config.ordinary?.enabled === true) {
          ordinaryContext = (await this.#ordinary.observe(envelope))?.context ?? null;
        }
      }
      catch (error) { this.#logger.warn?.('QQ ordinary memory unavailable:', errorLabel(error)); }
    }
    if (envelope.addressed && this.#config.respondToMentions !== false
      && (envelope.text || priorImage || inboundImage(envelope) || waitsForSplitImage(envelope)
        || envelope.attachments.some((item) => item.asrText))) {
      this.#queueAnswer(envelope, ordinaryContext, false, priorImage, peer);
    } else if (shadowDecision && passiveGroup && this.#config.shadow?.semantic?.enabled === true) {
      void shadowDecision.then((row) => {
        if (row?.decision === 'would_reply' && this.#shadow?.isLatest(envelope)) {
          this.#queueAnswer(envelope, ordinaryContext, true, priorImage, peer, row.mode === 'peer_handoff');
        }
      }).catch((error) => this.#logger.warn?.('QQ passive delivery unavailable:', errorLabel(error)));
    }
    if (this.#stickers && !envelope.addressedToOther
      && envelope.attachments.some((item) => item.kind === 'image')) {
      this.#runMediaJob(() => this.#observeImage(envelope));
    }
    return true;
  }

  async #acceptChoice(bot, event) {
    const button = parseChoiceData(event?.data?.resolved?.button_data);
    if (!button || !qqId(event.id) || this.#stopped || this.#bot !== bot) return;
    const group = event.scene === 'group' || (event.scene === undefined && event.chat_type === 1);
    const id = event.data.resolved.button_id;
    if (!group || (event.chat_type !== undefined && event.chat_type !== 1)
      || (event.type ?? event.data.type) !== 11 || (id !== undefined && id !== String(button.index))
      || !qqId(event.group_openid) || !qqId(event.group_member_openid)) {
      await bot.acknowledgeInteraction(event.id, 4);
      return;
    }
    const envelope = { ...normalizeInbound({ kind: 'group', rawEventType: 'GROUP_AT_MESSAGE_CREATE',
      groupOpenid: event.group_openid, senderId: event.group_member_openid, messageId: event.id }, Date.now(), this.#appId) };
    envelope.receiptKey += ':choice';
    if (!this.#allowed(envelope)) {
      await bot.acknowledgeInteraction(event.id, 4);
      return;
    }
    const profile = channelPersona(this.#ctx, personaTarget(envelope));
    const { code, label, anchor } = await this.#state.takeChoice(button, envelope, profile.token);
    try { await bot.acknowledgeInteraction(event.id, code); }
    catch (error) { this.#logger.warn?.('QQ choice acknowledgement failed:', errorLabel(error)); }
    if (code !== 0 || this.#stopped || !profile.current() || !this.#allowed(envelope)) return;
    envelope.text = `[已选择的聊天分支] ${JSON.stringify(label)}`;
    envelope.replyAnchor = Object.freeze(anchor);
    this.#observeReceipt(Object.freeze(envelope));
    this.#diagnostics.choice = { outcome: 'ok', at: Date.now() };
    this.#queueAnswer(envelope, null, false, null, null, false, profile.token);
  }

  #observeReceipt(envelope) {
    this.#observed.set(envelope.receiptKey, envelope);
    for (const [key, value] of this.#observed) {
      if (Date.now() - value.receivedAt > 10 * 60_000) {
        this.#observed.delete(key);
        this.#imageDetails.delete(key);
      }
    }
    while (this.#observed.size > 1000) {
      const oldest = this.#observed.keys().next().value;
      this.#observed.delete(oldest);
      this.#imageDetails.delete(oldest);
    }
  }

  #queueAnswer(envelope, ordinaryContext, passive, priorImage, peer = null, handoff = false, choiceProfile = null, test = null) {
    const queued = this.#enqueue(envelope, async () => {
      const profile = channelPersona(this.#ctx, personaTarget(envelope));
      if (envelope.receivedAt < profile.changedAt || (choiceProfile && choiceProfile !== profile.token)) return;
      const current = () => !this.#stopped && this.#allowed(envelope) && profile.current()
        && (!passive || this.#shadow?.isLatest(envelope) === true);
      if (!current()) return;
      let linkedImage = priorImage;
      if (!test && waitsForSplitImage(envelope)) {
        const remaining = envelope.receivedAt + SPLIT_IMAGE_WAIT_MS - Date.now();
        if (remaining > 0) await wait(remaining, undefined, { signal: this.#abort.signal }).catch(() => {});
        if (!current()) return;
        linkedImage = recentImageFor(envelope, this.#observed.values());
      }
      const source = linkedImage ?? envelope;
      const attachment = inboundImage(source);
      const quoted = attachment && source.quotedImages?.includes(attachment);
      const visionSource = quoted ? { ...source, attachments: [attachment] } : source;
      const models = this.#ctx.get?.('maomaoModels');
      const visionChoice = models?.mediaChoice?.('vision');
      const signal = AbortSignal.any([this.#abort.signal, AbortSignal.timeout(120_000)]);
      let images = test ? [] : await this.loadImages(source.receiptKey);
      let imageDescription = this.#imageDetails.get(source.receiptKey);
      // The standard Gemini image route has no GIF input. With enrichment enabled, use the same JPEG preview.
      if (images[0]?.mediaType === 'image/gif' && (this.#ordinary || visionChoice?.enabled)) {
        this.#ordinary ??= new OrdinaryBridge(this.#workerOptions);
        try {
          const { jpeg } = await this.#ordinary.media('image_preview', visionSource, { data: images[0].data });
          images = jpeg ? [{ ...images[0], data: jpeg, mediaType: 'image/jpeg', name: 'qq-sticker.jpg' }] : [];
        } catch (error) {
          images = [];
          this.#logger.warn?.('QQ image preview failed:', errorLabel(error));
        }
      }
      if (!current()) return;
      const reference = images[0];
      if (visionChoice && reference) {
        if (visionChoice.enabled) {
          this.#ordinary ??= new OrdinaryBridge(this.#workerOptions);
          imageDescription = await models.mediaAdapter('vision').then(async (adapter) => {
            if (!adapter || !(await this.#ordinary.media('vision_claim', visionSource)).allowed) return '';
            return adapter.inspect(reference, envelope.text, signal);
          }).catch(() => '') || imageDescription;
        } else imageDescription = null;
        images = [];
      }
      const speech = !choiceProfile && envelope.text && models?.mediaChoice?.('voice')
        ? await models.mediaAdapter('voice').catch(() => null) : this.#speech;
      const voice = test || choiceProfile || (passive && peer) ? null : await this.#voiceIntent(envelope, speech, profile.token);
      if (!current()) return;
      const generation = !choiceProfile && this.#imageTool && !voice && envelope.addressed && imageRequest(envelope.text)
        ? models?.mediaChoice?.('image') ? await models.mediaAdapter('image').catch(() => null) : this.#imageGeneration : null;
      const imageTool = generation ? this.#openImageTool(envelope, source, quoted ? null : reference, current, generation) : null;
      const choices = !test && envelope.scope === 'group' && !passive && !voice && !imageTool
        && this.#config.markdownSupport !== false && !this.#markdownDenied.has('group');
      const reply = await this.#harness.ask(envelope, {
        images,
        imageDescription,
        referencedImage: linkedImage ? { sameSender: linkedImage.senderId === envelope.senderId }
          : quoted ? { quoted: true } : null,
        ambient: this.#shadow?.contextFor(envelope, profile.changedAt) ?? [],
        ordinaryContext,
        profile,
        voice,
        imageTool,
        passive,
        peer,
        handoff,
        choices,
        owner: this.#isOwner(envelope),
        models,
        signal,
      }).then((reply) => {
        this.#diagnostics.model = { outcome: reply || imageTool?.outcome() === 'sent' ? 'ok' : 'empty', at: Date.now() };
        return reply;
      }).catch((error) => {
        test?.('model_failed');
        this.#diagnostics.model = { outcome: 'failed', at: Date.now() };
        throw error;
      });
      const { text: answer, options } = parseChoiceReply(reply ?? '');
      if (imageTool?.outcome() === 'sent' || imageTool?.outcome() === 'uncertain') return;
      if (!current()) return;
      if (!answer) {
        test?.('model_empty');
        if (imageTool) await this.respond(envelope.receiptKey, '这次图没生成成功，等会儿再试一下喵。', { current });
        return;
      }
      if (voice) {
        const outcome = await this.#voiceReply(envelope, answer, voice, current, speech);
        if (outcome !== 'unavailable' || !current()) return;
        await this.respond(envelope.receiptKey, `这次语音没发出去，先给你文字版喵。<|bubble|>${answer}`, { current });
        return;
      }
      const limit = test || choiceProfile || (passive && peer) ? 1 : undefined;
      const card = choices && options.length ? { profile: profile.token, options } : null;
      test?.('sending');
      const sent = await this.respond(envelope.receiptKey, answer, { current, limit, card }).catch((error) => {
        test?.('delivery_failed');
        throw error;
      });
      test?.(sent.length ? 'sent' : 'delivery_failed');
      if (!test && this.#stickers && !card && !choiceProfile && !limit
        && sent.length === textBubbles(answer, envelope.scope === 'group' ? 4 : 3).length
        && sent.length > 0) {
        this.#runMediaJob(() => this.#afterReplySticker(envelope, answer));
      }
    });
    if (test) void queued.then(() => test('interrupted'), () => test('interrupted'));
  }

  #openImageTool(envelope, source, image, current, generation) {
    const reference = source.senderId === envelope.senderId && image?.mediaType !== 'image/gif' ? image : null;
    return this.#imageTool.open({
      current,
      reference,
      run: async (args, signal) => {
        const deadline = envelope.scope === 'group' ? 300_000 : 60_000;
        const remaining = deadline - (Date.now() - envelope.receivedAt) - 10_000;
        if (remaining <= 0 || signal.aborted || !current()) return 'cancelled';
        try {
          if (!await this.#state.reserveImage(envelope)) return 'limit';
          const output = await generation.generate(
            `为全年龄 QQ 聊天生成图片。\n${args.prompt.trim()}`, {
              reference: args.use_reference ? reference : null,
              aspectRatio: args.aspect_ratio,
              signal: AbortSignal.any([signal, this.#abort.signal, AbortSignal.timeout(remaining)]),
            });
          if (!output) return 'unavailable';
          return await this.#sendMedia(envelope, { ...output, fileType: MediaFileType.IMAGE,
            fingerprint: 'generated-image:reply' }, () => !signal.aborted && current());
        } catch (error) {
          this.#logger.warn?.('QQ image generation failed:', errorLabel(error));
          return signal.aborted || !current() ? 'cancelled' : 'unavailable';
        }
      },
    });
  }

  async #voiceIntent(envelope, speech, personaToken) {
    if (!speech || !envelope.text) return null;
    const key = JSON.stringify([envelope.botId, envelope.scope, envelope.chatId, envelope.senderId, personaToken]);
    const last = this.#voiceHistory.get(key);
    this.#voiceHistory.delete(key);
    try {
      this.#ordinary ??= new OrdinaryBridge(this.#workerOptions);
      const intent = await this.#ordinary.media('voice_intent', envelope);
      const age = last ? envelope.receivedAt - last.at : Infinity;
      const prior = intent.followup && age >= 0 && age <= 5 * 60_000 ? last : null;
      return intent.requested || prior
        ? { key, language: intent.language || prior?.language || '', previous: prior?.text || '' } : null;
    } catch (error) {
      this.#logger.warn?.('QQ voice intent unavailable:', errorLabel(error));
      return null;
    }
  }

  async #voiceReply(envelope, answer, voice, current, speech) {
    try {
      const text = spokenTranscript(answer);
      const replyWindow = envelope.scope === 'group' ? 300_000 : 60_000;
      const remaining = replyWindow - (Date.now() - envelope.receivedAt) - 8_000;
      if (remaining <= 0) return 'unavailable';
      const audio = await speech.synthesize(text,
        AbortSignal.any([this.#abort.signal, AbortSignal.timeout(remaining)]));
      if (!current()) return 'cancelled';
      const outcome = await this.#sendMedia(envelope, {
        fileType: MediaFileType.VOICE, buffer: audio, fileName: 'maomao-voice.wav', fingerprint: 'voice:reply',
      }, current);
      if (outcome === 'sent') {
        this.#shadow?.noteReply(envelope, text);
        this.#voiceHistory.set(voice.key, { at: Date.now(), text, language: voice.language });
        if (this.#voiceHistory.size > 1000) this.#voiceHistory.delete(this.#voiceHistory.keys().next().value);
      }
      return outcome;
    } catch (error) {
      this.#logger.warn?.('QQ voice synthesis or upload failed:', errorLabel(error));
      return 'unavailable';
    }
  }

  #runMediaJob(task) {
    if (this.#stopped || this.#mediaJobs.size >= 2) return;
    const job = task().catch((error) =>
      this.#logger.warn?.('QQ optional media job failed:', errorLabel(error)))
      .finally(() => this.#mediaJobs.delete(job));
    this.#mediaJobs.add(job);
  }

  async #observeImage(envelope) {
    const [image] = await this.loadImages(envelope.receiptKey);
    if (!image || this.#stopped) return;
    const prepared = await this.#ordinary.media('prepare_image', envelope, { data: image.data });
    const models = this.#ctx.get?.('maomaoModels');
    const choice = models?.mediaChoice?.('vision');
    const classifier = choice?.enabled ? await models.mediaAdapter('vision').catch(() => null) : this.#stickers;
    const result = prepared.known ?? (prepared.jpeg
      ? await classifier?.describe(prepared.jpeg, this.#abort.signal) : null);
    if (!result || this.#stopped) return;
    if (!result.personal_or_sensitive && this.#observed.has(envelope.receiptKey)) {
      this.#imageDetails.set(envelope.receiptKey, result.description);
    }
    const collected = await this.#ordinary.media('remember_image', envelope,
      { data: image.data, result, collect: this.#config.stickers.collect === true });
    if (!collected.notice) return;
    let success = false;
    try {
      // An addressed image's regular response was queued before the background classification.
      await this.#enqueue(envelope, async () => {
        if (Date.now() - envelope.receivedAt <= 30_000) {
          success = Boolean((await this.respond(envelope.receiptKey, collected.notice)).length);
        }
      });
    } finally {
      await this.#ordinary.media('finish_notice', envelope, { id: collected.id, success });
    }
  }

  async #afterReplySticker(envelope, answer) {
    const current = () => {
      if (this.#stopped || Date.now() - envelope.receivedAt > 60_000) return false;
      const latest = Array.from(this.#observed.values()).findLast((row) =>
        row.botId === envelope.botId && row.scope === envelope.scope && row.chatId === envelope.chatId);
      return latest === envelope;
    };
    if (!current()) return;
    const query = `${envelope.text.slice(-70)} ${answer.replaceAll('<|bubble|>', ' ').slice(-120)}`;
    const candidates = await this.#ordinary.media('sticker_candidates', envelope, { query });
    if (!candidates.length || !current()) return;
    const id = await this.#stickers.choose(envelope.text, answer, candidates, this.#abort.signal);
    if (!id || !candidates.some((candidate) => candidate.id === id) || !current()) return;
    const path = await this.#ordinary.media('claim_sticker', envelope, { id });
    if (!path || !current()) return;
    const buffer = await readFile(path);
    if (!buffer.length || buffer.length > 2_000_000 || !current()) return;
    await this.#sendMedia(envelope, { fileType: MediaFileType.IMAGE, buffer,
      fileName: path.split('/').at(-1), fingerprint: `sticker:${id}` }, current);
  }

  async #sendMedia(envelope, { fileType, buffer, fileName, fingerprint }, current) {
    const bot = this.#bot;
    if (!bot || !this.#allowed(envelope) || !current()) return 'cancelled';
    const target = { scope: envelope.scope, targetId: envelope.chatId, msgId: envelope.messageId };
    const upload = await bot.uploadMedia({ target, fileType, buffer, fileName, srvSendMsg: false });
    if (!upload?.file_info) return 'unavailable';
    if (!current() || !this.#allowed(envelope) || this.#bot !== bot) return 'cancelled';
    const ticket = await this.#state.reserve(envelope, fingerprint);
    if (!ticket.fresh) return ticket.status === 'sent' ? 'sent' : 'uncertain';
    let messageId = '';
    try {
      if (!current() || this.#bot !== bot) return 'cancelled';
      const sent = await bot.send({ target, msgType: 7, media: { file_info: upload.file_info },
        extra: { msg_seq: ticket.seq } });
      messageId = typeof sent?.id === 'string' ? sent.id : '';
      this.#diagnostics.reply = { outcome: messageId ? 'ok' : 'failed', at: Date.now() };
      return messageId ? 'sent' : 'uncertain';
    } catch (error) {
      this.#diagnostics.reply = { outcome: 'failed', at: Date.now() };
      this.#logger.warn?.('QQ media delivery uncertain:', errorLabel(error));
      return 'uncertain';
    } finally {
      try { await this.#state.finish(ticket.key, messageId); }
      catch (error) { this.#logger.warn?.('QQ media ledger update failed:', errorLabel(error)); }
    }
  }

  #enqueue(envelope, task) {
    const key = `${envelope.botId}:${envelope.scope}:${envelope.chatId}`;
    const prior = this.#queues.get(key) ?? Promise.resolve();
    const queued = prior.catch(() => undefined).then(() => this.#stopped ? undefined : task()).finally(() => {
      if (this.#queues.get(key) === queued) this.#queues.delete(key);
    });
    this.#queues.set(key, queued);
    void queued.catch((error) => this.#logger.error?.('QQ queued action failed:', errorLabel(error)));
    return queued;
  }

  async #statusReply(envelope) {
    const profile = this.#ctx.get?.('maomaoPersonas')?.current(personaTarget(envelope));
    const sessionId = this.#state.sessionId(envelope.botId, envelope.scope, envelope.chatId, profile?.token);
    let values = null;
    if (sessionId && typeof this.#ctx.sessionController.projections === 'function') {
      try {
        const result = await this.#ctx.sessionController.projections(
          { sessionId }, AbortSignal.timeout(3_000));
        values = result?.values ?? null;
      } catch (error) {
        this.#logger.warn?.('QQ status projection unavailable:', errorLabel(error));
      }
    }
    const recorded = values?.modelSelection?.next ?? values?.modelSelection?.lastUsed;
    let fallback = null;
    try {
      const defaults = this.#ctx.agentDefaultModel ?? this.#ctx.get?.('agentDefaultModel');
      fallback = defaults?.currentSelection?.() ?? null;
    } catch (error) {
      this.#logger.warn?.('QQ default model unavailable:', errorLabel(error));
    }
    return statusReply({ ready: this.#ready, selection: recorded ?? fallback,
      selectionSource: recorded ? 'session' : 'default', pressure: values?.contextPressure });
  }

  async loadImages(receiptKey) {
    const envelope = this.#observed.get(receiptKey);
    if (!envelope || Date.now() - envelope.receivedAt > 10 * 60_000) return [];
    const attachment = inboundImage(envelope);
    if (!attachment || !this.#bot) return [];
    if (!this.#imageInFlight.has(receiptKey)) {
      const operation = loadQqImage(attachment, {
        getToken: () => this.#bot.api.getToken(),
        signal: this.#abort.signal,
      }).then((image) => {
        this.#mediaStatus = { outcome: image ? 'ok' : 'unsafe_source', at: Date.now() };
        return image ? [image] : [];
      })
        .catch((error) => {
          this.#mediaStatus = { outcome: error.code ?? (error.name === 'TimeoutError' ? 'timeout' : 'network'), at: Date.now() };
          this.#logger.warn?.('QQ image unavailable:', errorLabel(error));
          return [];
        }).finally(() => this.#imageInFlight.delete(receiptKey));
      this.#imageInFlight.set(receiptKey, operation);
    }
    return this.#imageInFlight.get(receiptKey);
  }

  async respond(receiptKey, text, { current = () => true, limit, card = null } = {}) {
    const envelope = this.#observed.get(receiptKey);
    if (!envelope || !this.#allowed(envelope) || Date.now() - envelope.receivedAt > 10 * 60_000) {
      throw new Error('QQ inbound receipt is unavailable');
    }
    if (!this.#bot) throw new Error('QQ transport is not running');
    const stillAllowed = () => current() && this.#allowed(envelope);
    // QQ group apps may reject the interaction ID as a reply anchor. Keep the
    // click's identity for the model, but spend the original human message's budget.
    const anchor = envelope.replyAnchor ?? envelope;
    const parts = textBubbles(text, limit ?? (envelope.scope === 'group' ? 4 : 3));
    const sent = [];
    for (const [index, part] of parts.entries()) {
      if (!stillAllowed()) break;
      const ticket = await this.#state.reserve(anchor, `${envelope.replyAnchor ? envelope.receiptKey : ''}${index}\u0000${part}`);
      if (!ticket.fresh) continue;
      try {
        if (!stillAllowed()) {
          await this.#state.finish(ticket.key);
          break;
        }
        let keyboard;
        const options = card && index === parts.length - 1 ? card.options : null;
        if (options) {
          const token = randomBytes(16).toString('hex');
          if (await this.#state.saveChoiceCard(token, anchor, card.profile, options)) {
            keyboard = choiceKeyboard(token, options, envelope.senderId);
          }
        }
        const messageId = await this.#sendText(anchor, part, ticket.seq, stillAllowed, keyboard, options);
        await this.#state.finish(ticket.key, messageId);
        if (!messageId && !stillAllowed()) break;
        if (!messageId) throw new Error('QQ send result did not include a message id');
        sent.push(messageId);
        this.#diagnostics.reply = { outcome: 'ok', at: Date.now() };
        this.#shadow?.noteReply(envelope, part);
      } catch (error) {
        this.#diagnostics.reply = { outcome: 'failed', at: Date.now() };
        await this.#state.finish(ticket.key);
        throw error;
      }
    }
    return sent;
  }

  async #sendText(envelope, content, seq, current = () => true, keyboard, choices) {
    const options = {
      target: { scope: envelope.scope, targetId: envelope.chatId, msgId: envelope.messageId },
      extra: { msg_seq: seq },
    };
    if (!current()) return '';
    const plain = plainQqMarkdown(content);
    if ((keyboard || (!choices && plain !== content)) && this.#config.markdownSupport !== false && !this.#markdownDenied.has(envelope.scope)) {
      try {
        const result = await this.#bot.send({ ...options, msgType: MsgType.MARKDOWN, markdown: { content },
          ...(keyboard ? { keyboard } : {}) });
        return typeof result?.id === 'string' ? result.id : '';
      } catch (error) {
        // A timeout can mean the message landed. Only retry a definite Markdown rejection.
        const code = Number(error instanceof ApiError ? error.bizCode : 0);
        if (![40034012, 40034090].includes(code)) throw error;
        if (code === 40034012) this.#markdownDenied.add(envelope.scope);
        this.#logger.info?.('QQ Markdown rejected, using plain text', code);
        if (!current()) return '';
      }
    }
    const fallback = choices ? `${plain}\n\n${choices.map((label, index) => `${index + 1}. ${label}`).join('\n')}\n可以直接回复你想选的方向。` : plain;
    const result = await this.#bot.send({ ...options, content: fallback, msgType: MsgType.TEXT });
    return typeof result?.id === 'string' ? result.id : '';
  }
}

function mount(ctx, config, managedCredential) {
  const connector = new MaomaoQqConnector(ctx, config, { managedCredential });
  const logger = typeof ctx.logger === 'function' ? ctx.logger(name) : (ctx.logger ?? console);
  ctx.provide('maomaoQq', Object.freeze({
    respond: (receiptKey, text) => connector.respond(receiptKey, text),
    loadImages: (receiptKey) => connector.loadImages(receiptKey),
    status: () => connector.status(),
    ...(config.dryRun === true ? {} : { pair: (request) => connector.pair(request),
      replyCheck: (request) => connector.replyCheck(request), unbind: (id) => connector.unbind(id),
      memorySources: () => connector.memorySources(), personaTargets: () => connector.personaTargets() }),
  }));
  if (config.dryRun === true) return;
  ctx.effect(() => {
    void connector.start().catch((error) => logger.error?.('QQ connector startup failed:', errorLabel(error)));
    return () => connector.stop();
  }, 'maomao-dsh-qq');
}

export function apply(ctx, config = {}) {
  if (config.enabled === true && config.dryRun === true) return mount(ctx, config);
  ctx.provide('maomaoQqSetup', Object.freeze({ provisionQQ, verifyQQ, mediaAdapters: {
    vision: (options) => new StickerIntelligence(options),
    image: (options) => options.provider === 'openai' ? new OpenAiImageGeneration(options) : new GeminiImageGeneration(options),
    voice: (options) => new GeminiSpeech(options),
  } }));
  if (config.enabled !== true) return;
  if (config.credentialRef) {
    return Promise.resolve(ctx.get('credentials')?.resolve(config.credentialRef)).then((resolved) => {
      if (!resolved?.value || !/^\d{1,32}$/.test(config.accountId ?? '')) throw new Error('QQ connector credential is missing');
      return mount(ctx, config, { appId: config.accountId, secret: resolved.value });
    });
  }
  if (!process.env.MAOMAO_QQ_APP_ID?.trim() || !process.env.MAOMAO_QQ_APP_SECRET?.trim()
    || process.env.MAOMAO_QQ_CONNECT !== 'I_STOPPED_HERMES_QQ') {
    throw new Error('QQ connector enabled without credentials and explicit Hermes cutover guard');
  }
  return mount(ctx, config);
}
