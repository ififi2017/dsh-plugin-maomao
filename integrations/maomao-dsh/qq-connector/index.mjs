import { dirname, join, resolve } from 'node:path';
import { chatSeesImages, chatSelection, completeText } from '../model-call.mjs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';
import { joinInPause, typingPause } from '../pacing.mjs';
import { ApiError, MediaFileType, MsgType, QQBot, contentSanitizer } from '@tencent-connect/qqbot-nodejs';
import { apiError, log } from '../debug-log.mjs';

import { HarnessConversation } from './harness.mjs';
import { QqGroupTools } from './group-tools.mjs';
import { openChatTools } from '../chat-tools.mjs';
import { openStickerTools } from '../sticker-tools.mjs';
import { qqMemoryScope } from '../learning-store.mjs';
import { HarnessShadowJudge, archiveJudgeSessions } from './judge.mjs';
import { chatWorkspace } from '../chat-workspace.mjs';
import { MoodBook } from '../mood.mjs';
import { qqCommand, qqPersonaReply, sidReply, statusReply } from './commands.mjs';
import { GatewaySessionFile, gatewaySessionPath } from './gateway-session.mjs';
import { GeminiImageGeneration, OpenAiImageGeneration } from './image-generation.mjs';
import { allowedInbound, inboundImage, normalizeInbound, recentImageFor, recentImagesFrom, SPLIT_IMAGE_WAIT_MS,
  textBubbles, waitsForSplitImage } from './inbound.mjs';
import { hasChatMarkdown, plainChatMarkdown } from '../message-markdown.mjs';
import { loadQqImage } from './media.mjs';
import { OrdinaryBridge } from './ordinary.mjs';
import { PassiveShadow } from './shadow.mjs';
import { GeminiSpeech, spokenTranscript } from './speech.mjs';
import { ConnectorState, qqStorageHome, routeKey } from './state.mjs';
import { choiceData, parseChoiceData, parseChoiceReply, ChoiceThrottle } from '../choices.mjs';
import { channelPersona } from '../personas.mjs';
import { pairingGreeting } from '../pairing-greeting.mjs';
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
  #stickerOffered = new Set();
  #steals = new Map();
  #stealNoticeDelayMs = 15_000;
  #dshHome = '';
  #chatFolder;
  #imageInFlight = new Map();
  #queues = new Map();
  #shadow;
  #groupTools = new QqGroupTools();
  #recentReplies = new Map();
  #choiceThrottle = new ChoiceThrottle();
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
  #dmNotices = new Map();
  #dmNoticeTimes = [];
  #imageGeneration = null;

  constructor(ctx, config, { state, harness, shadowJudge, ordinary, stickers, speech, imageGeneration,
    managedCredential, botFactory = (options) => new QQBot(options), stealNoticeDelayMs = 15_000 } = {}) {
    this.#ctx = ctx;
    this.#stealNoticeDelayMs = stealNoticeDelayMs;
    this.#logger = typeof ctx.logger === 'function' ? ctx.logger(name) : (ctx.logger ?? console);
    this.#config = config;
    this.#managedCredential = managedCredential;
    const home = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh');
    const profileDocument = ctx.get?.('configEditor')?.documentPath;
    const root = qqStorageHome(home, profileDocument ? dirname(profileDocument) : process.env.DSH_PROFILE_DIR);
    this.#storageHome = root;
    this.#dshHome = home;
    const statePath = resolve(config.statePath ?? join(root, 'integrations', 'maomao-qq', 'state.json'));
    this.#state = state ?? new ConnectorState(statePath);
    this.#chatFolder = chatWorkspace(ctx, { configured: config.workspace, home });
    this.#harness = harness ?? new HarnessConversation(ctx.sessionController, this.#state, {
      workspace: this.#chatFolder,
      mood: new MoodBook(join(dirname(statePath), 'mood.json')),
      agentPreset: config.agentPreset,
    });
    const semanticJudge = config.shadow?.enabled === true
      ? new HarnessShadowJudge((call) => completeText(ctx, { ...call, maxTokens: 1500 })) : null;
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
    this.#runMediaJob(() => this.#archiveOldJudgeSessions());
    this.#chatFolder.attachExisting().then((count) => log('info', 'plugin', '猫猫的聊天分组已就绪', { sessions: count }))
      .then(() => this.#archiveOldChatSessions()).catch((error) => log('warn', 'plugin', '整理旧聊天会话失败', error?.message ?? String(error)));
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
      directMessages: this.directMessageSettings(),
      lastError: this.#lastError, shadow: this.#shadow?.status() ?? { enabled: false },
      ordinary: { enabled: this.#config.ordinary?.enabled === true }, media: this.#mediaStatus, diagnostics: this.#diagnostics,
      panelRoutes: this.#state.panelRouteCount(this.#appId),
      panelBindings: [...this.#state.panelRoutes(this.#appId), ...this.#state.panelOwnerBindings(this.#appId)] });
  }

  #paired(envelope) {
    return allowedInbound(envelope, this.#config) || this.#state.panelAllowed(envelope.botId, envelope.scope, envelope.chatId);
  }

  #allowed(envelope) {
    return this.#paired(envelope) || (envelope.scope === 'c2c' && envelope.botId === this.#appId
      && envelope.chatId === envelope.senderId && this.directMessageSettings().acceptStrangers);
  }

  directMessageSettings() {
    return { acceptStrangers: this.#state.directMessageSettings(this.#appId)?.acceptStrangers
      ?? this.#config.directMessages?.acceptStrangers === true,
      lastInbound: this.#diagnostics.directMessage ?? null };
  }

  async saveDirectMessageSettings({ acceptStrangers } = {}) {
    if (!this.#appId || this.#stopped || this.#config.dryRun === true) return { status: 'unavailable' };
    if (typeof acceptStrangers !== 'boolean') return { status: 'invalid' };
    await this.#state.saveDirectMessageSettings(this.#appId, { acceptStrangers });
    return { status: 'saved' };
  }

  #dmAdmission(envelope) {
    return { paired: this.#paired(envelope), owner: this.#isOwner(envelope),
      acceptStrangers: this.directMessageSettings().acceptStrangers };
  }

  async #dmNotice(envelope, text, kind) {
    // Fixed onboarding replies are allowed without chat admission. They never enter the LLM or memory.
    if (envelope.scope !== 'c2c' || this.#stopped || envelope.botId !== this.#appId) return false;
    const now = Date.now();
    const key = `${envelope.senderId}:${kind}`;
    const last = this.#dmNotices.get(key);
    this.#dmNoticeTimes = this.#dmNoticeTimes.filter((at) => now - at < 60_000);
    if ((last !== undefined && now - last < 30_000) || this.#dmNoticeTimes.length >= 30) return false;
    this.#dmNotices.set(key, now);
    this.#dmNoticeTimes.push(now);
    if (this.#dmNotices.size > 1000) this.#dmNotices.delete(this.#dmNotices.keys().next().value);
    if (!await this.#state.recordReceipt(envelope)) return false;
    const bot = this.#bot;
    const current = () => !this.#stopped && this.#bot === bot;
    const ticket = await this.#state.reserve(envelope, text);
    if (!ticket.fresh || !current()) return false;
    let messageId;
    try { messageId = await this.#sendText(envelope, text, ticket.seq, current); }
    finally { await this.#state.finish(ticket.key, messageId); }
    return Boolean(messageId);
  }

  #pairHelp(envelope) {
    if (envelope.scope === 'group') return `本群主人身份：${this.#isOwner(envelope) ? '你已验证为主人' : '你尚未绑定为本群主人'}。\n`
      + '请在 DSH「设置 → 猫猫 → 渠道与会话 → QQ → 会话与权限 → 添加绑定」进入「绑定 QQ 群或私聊」，选择「QQ群主人身份」。生成指令后，在本群 @猫猫 发送完整的 /pair 配对码，再把确认码填回面板。\n'
      + '绑定只对这个群生效；QQ群主或管理员身份不会自动变成猫猫的主人。';
    return `${this.#paired(envelope) ? '这个 QQ 私聊已获准聊天。' : '这个 QQ 私聊还没有配对。'}\n`
      + '请在 DSH 的「设置 → 猫猫 → 渠道与会话」选择 QQ，在「会话与权限 → 添加绑定 → 绑定 QQ 群或私聊」选择「QQ 私聊」，生成配对指令。\n'
      + '把完整的 /pair 配对码发到这里，再把收到的确认码填回面板。陌生人聊天开关不会自动绑定主人。';
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
    for (const { id, scope, groupOpenId, userOpenId } of this.#state.panelRoutes(this.#appId)) {
      if ((scope === 'group' || scope === 'c2c') && !targets.has(id)) {
        targets.set(id, { id, kind: scope === 'group' ? 'qq-group' : 'qq-dm', groupOpenId, userOpenId });
      }
    }
    return [...targets.values()].sort((a, b) => a.id.localeCompare(b.id)).map((target) => ({
      ...target, label: `${target.kind === 'qq-group' ? 'QQ 群' : 'QQ 私聊'} · ${(target.groupOpenId ?? target.userOpenId ?? target.id).slice(-8)}`,
    }));
  }

  #groupPeer(chatId) {
    const delivery = this.#config.shadow?.delivery;
    const legacy = Object.hasOwn(delivery?.peers ?? {}, chatId) ? delivery.peers[chatId] : null;
    const active = delivery?.enabled === true && Array.isArray(delivery.groupAllowlist) && delivery.groupAllowlist.includes(chatId)
      && this.#config.shadow?.semantic?.enabled === true
      && (!Array.isArray(this.#config.shadow.semantic.groupAllowlist)
        || this.#config.shadow.semantic.groupAllowlist.includes(chatId));
    const saved = this.#state.peerSettings(this.#appId, chatId);
    return { enabled: Boolean(this.#shadow && (saved?.enabled ?? (active && legacy))),
      paused: saved?.paused === true, maxRounds: saved?.maxRounds ?? 2, waitMs: legacy?.waitMs };
  }

  // Unprompted replies in a group: the panel switch once saved; before that, the config lists
  // (shadow.semantic + shadow.delivery groupAllowlist) or an enabled group interaction, as before.
  #groupPassive(chatId) {
    if (!this.#shadow) return false;
    const saved = this.#state.peerSettings(this.#appId, chatId);
    if (saved?.paused === true) return false;
    if (typeof saved?.passive === 'boolean') return saved.passive;
    const delivery = this.#config.shadow?.delivery;
    const judgeGroups = this.#config.shadow?.semantic?.groupAllowlist;
    const listed = delivery?.enabled === true && Array.isArray(delivery.groupAllowlist) && delivery.groupAllowlist.includes(chatId)
      && this.#config.shadow?.semantic?.enabled === true && (!Array.isArray(judgeGroups) || judgeGroups.includes(chatId));
    return listed || this.#groupPeer(chatId).enabled;
  }

  peerGroups() {
    return this.personaTargets().filter(({ kind, groupOpenId }) => kind === 'qq-group' && groupOpenId)
      .map(({ id, label, groupOpenId }) => ({ id, label, ...this.#groupPeer(groupOpenId),
        passive: typeof this.#state.peerSettings(this.#appId, groupOpenId)?.passive === 'boolean'
          ? this.#state.peerSettings(this.#appId, groupOpenId).passive : this.#groupPassive(groupOpenId) }));
  }

  async savePeerGroup({ id, enabled, maxRounds, paused, passive }) {
    const group = this.personaTargets().find((target) => target.id === id && target.kind === 'qq-group');
    if (!group?.groupOpenId || !this.#shadow) return { status: 'unavailable' };
    if (typeof enabled !== 'boolean' || typeof paused !== 'boolean' || !Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 5
      || (passive !== undefined && typeof passive !== 'boolean')) {
      return { status: 'invalid' };
    }
    this.#shadow.cancelPeer({ botId: this.#appId, chatId: group.groupOpenId });
    await this.#state.savePeerSettings(this.#appId, group.groupOpenId, {
      enabled, paused, maxRounds, ...(passive !== undefined ? { passive } : {}),
    });
    return { status: 'saved' };
  }

  #isOwner({ botId, scope, chatId, senderId }) {
    const owners = this.#config.shadow?.ownerIds;
    return (Array.isArray(owners) && owners.includes(senderId))
      || (scope === 'group' && this.#state.panelOwnsGroup(botId, chatId, senderId))
      || Boolean(this.#linkedOwner({ botId, scope, chatId, senderId }));
  }

  #privateOwners() { return this.#ctx.get?.('maomaoPrivate')?.owners?.() ?? []; }

  // The Lark / Telegram owner this QQ private chat was linked to at pairing, if that owner still exists.
  #linkedOwner({ botId, scope, chatId, senderId }) {
    if (scope !== 'c2c' || chatId !== senderId) return null;
    const owner = this.#state.privateOwner(botId, chatId);
    return owner && this.#privateOwners().some(({ id }) => id === owner) ? owner : null;
  }

  unbind(id) { return this.#state.removePanelRoute(this.#appId, id); }

  async pair({ action, scope, id, proof, owner: requestedOwner }) {
    const owner = typeof requestedOwner === 'string' && requestedOwner ? requestedOwner : null;
    if (this.#pairing?.expires <= Date.now()) this.#pairing = null;
    if (action === 'start') {
      if (!this.#ready || this.#config.dryRun === true) return { status: 'unavailable' };
      if (!['group', 'c2c', 'owner'].includes(scope)) return { status: 'invalid' };
      // A QQ private chat may be linked to an existing Lark / Telegram owner.
      if (owner !== null && (scope !== 'c2c' || !this.#privateOwners().some(({ id: known }) => known === owner))) return { status: 'invalid' };
      if (this.#pairing) return { status: 'busy' };
      this.#pairing = { id: randomUUID(), scope, code: randomBytes(12).toString('hex'),
        expires: Date.now() + 5 * 60_000, attempts: 0, owner };
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
        await this.#state.allowPanelRoute(botId, scope, chatId, scope === 'c2c' ? pairing.owner : null);
        this.#greetAfterPairing(pairing.envelope);
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

  #greetAfterPairing(envelope) {
    const profile = channelPersona(this.#ctx, personaTarget(envelope));
    const bot = this.#bot;
    this.#observeReceipt(envelope);
    // Same queue and Harness session as subsequent messages. Do not observe this
    // host event as a user memory, nor expose the pairing code to the model.
    this.#enqueue(envelope, async () => {
      const signal = AbortSignal.any([this.#abort.signal, AbortSignal.timeout(120_000)]);
      const current = () => !signal.aborted && this.#bot === bot && profile.current()
        && this.#state.panelAllowed(envelope.botId, envelope.scope, envelope.chatId);
      if (!current()) return;
      const owner = this.#isOwner(envelope);
      const reply = await this.#harness.ask({ ...envelope,
        text: pairingGreeting({ group: envelope.scope === 'group', owner }), attachments: [], quotedImages: [],
      }, { profile, owner, models: this.#ctx.get?.('maomaoModels'), signal });
      this.#diagnostics.model = { outcome: reply ? 'ok' : 'empty', at: Date.now() };
      if (!reply || !current()) return;
      await this.respond(envelope.receiptKey, parseChoiceReply(reply).text, { current, limit: 1 });
    });
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
    this.#dmNotices.clear();
    this.#dmNoticeTimes = [];
    this.#pairing = null;
    await this.#shadow?.stop();
    await this.#ordinary?.stop();
  }

  async accept(message) {
    if (this.#stopped) return false;
    const peerSettings = message?.kind === 'group' ? this.#groupPeer(message.groupOpenid) : null;
    const peer = peerSettings?.enabled ? peerSettings : null;
    // Whether the cat may join this group's conversation without being @-mentioned.
    const passiveReplies = message?.kind === 'group' && this.#groupPassive(message.groupOpenid);
    if (message?.senderIsBot === true && peer) {
      const group = { botId: this.#appId, scope: 'group', chatId: message.groupOpenid };
      if (!this.#allowed(group) || message.senderId === this.#appId) return false;
      const enabled = () => {
        const settings = this.#groupPeer(group.chatId);
        return this.#allowed(group) && settings.enabled && !settings.paused && settings.maxRounds === peer.maxRounds;
      };
      const recall = this.#config.ordinary?.enabled === true && this.#ordinary
        ? (anchor, query) => this.#ordinary.media('peer_context', anchor, { query }).catch(() => null) : undefined;
      void this.#shadow?.notePeer(this.#appId, group.chatId, peer, message, { enabled, recall }).then((turn) => {
        if (turn) return this.#queueAnswer(turn.anchor, turn.memory, true, null, peer,
          { peerTurn: turn.peerTurn, peerCurrent: turn.current }).finally(turn.release);
      }).catch((error) => this.#logger.warn?.('QQ peer judgment unavailable:', errorLabel(error)));
      return true;
    }
    const envelope = normalizeInbound(message, Date.now(), this.#appId);
    if (!envelope) return false;
    const allowed = this.#allowed(envelope);
    let commandText = envelope.text.replace(/^<@!?[A-Za-z0-9_-]{1,128}>\s*/, '');
    // Some QQ clients swallow the leading "/pair" and deliver only the code. While a QQ private
    // pairing is waiting, a bare matching code counts as the pairing command.
    if (envelope.scope === 'c2c' && this.#pairing?.scope === 'c2c' && commandText.trim() === this.#pairing.code) {
      commandText = `/pair ${this.#pairing.code}`;
      log('info', 'qq', '收到不带 /pair 的配对码，按配对指令处理');
    }
    if (envelope.scope === 'c2c') {
      this.#diagnostics.directMessage = { at: Date.now(), outcome: allowed ? 'admitted' : 'needs_pairing' };
      if (commandText.toLowerCase() === '/pair') return this.#dmNotice(envelope, this.#pairHelp(envelope), 'pair');
      if (!allowed && qqCommand(envelope) === '/sid') {
        return this.#dmNotice(envelope, sidReply(envelope, this.#dmAdmission(envelope)), 'sid');
      }
    }
    if (envelope.scope === 'group' && envelope.addressed && commandText.toLowerCase() === '/pair' && allowed) {
      if (!await this.#state.recordReceipt(envelope)) return false;
      this.#observeReceipt(envelope);
      await this.respond(envelope.receiptKey, this.#pairHelp(envelope));
      return true;
    }
    if (/^\/pair(?:\s|$)/i.test(commandText)) {
      const pairCode = envelope.addressed && /^\/pair ([a-f0-9]{24})$/.exec(commandText)?.[1];
      const pairing = this.#pairing;
      // An already-paired QQ private chat may pair again to link or unlink an owner.
      const matching = pairing?.scope === 'owner'
        ? allowed && envelope.scope === 'group' && !this.#state.panelOwnsGroup(envelope.botId, envelope.chatId, envelope.senderId)
        : (!this.#paired(envelope) || envelope.scope === 'c2c') && pairing?.scope === envelope.scope;
      if (!pairCode || !matching || pairing.envelope
        || pairing.expires <= Date.now() || pairing.code !== pairCode) {
        log('info', 'qq', '配对指令未通过', { scope: envelope.scope, hasCode: Boolean(pairCode), pending: pairing?.scope ?? null,
          alreadyPaired: this.#paired(envelope), codeMatches: Boolean(pairing && pairCode === pairing.code), expired: Boolean(pairing && pairing.expires <= Date.now()) });
        return envelope.scope === 'c2c' ? this.#dmNotice(envelope,
          this.#paired(envelope) ? this.#pairHelp(envelope) : '配对指令已失效或不匹配，请在猫猫面板重新生成 QQ 私聊配对指令。发送 /pair 查看步骤。', 'pair') : false;
      }
      pairing.envelope = envelope;
      pairing.proof = randomBytes(4).toString('hex');
      log('info', 'qq', '配对指令通过，已发送确认码', { scope: envelope.scope, linkOwner: Boolean(pairing.owner) });
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
    if (!allowed) return envelope.scope === 'c2c' ? this.#dmNotice(envelope,
      '猫猫收到了，但这个 QQ 私聊还没有获准聊天。发送 /sid 查看身份，或发送 /pair 查看配对步骤。', 'welcome') : false;
    if (!await this.#state.recordReceipt(envelope)) return false;
    this.#diagnostics.receive = { outcome: 'ok', at: Date.now() };
    this.#observeReceipt(envelope);
    if (peer && /^\/(?:stop|停止互动|resume|恢复互动)$/i.test(commandText)) {
      const paused = /^\/(?:stop|停止互动)$/i.test(commandText);
      if (!paused && !this.#isOwner(envelope)) {
        await this.respond(envelope.receiptKey, '请由已绑定的群主人恢复同伴互动。');
        return true;
      }
      this.#shadow.cancelPeer(envelope);
      await this.#state.savePeerSettings(envelope.botId, envelope.chatId, { paused });
      await this.respond(envelope.receiptKey, paused ? '已暂停本群的同伴互动。' : '已恢复本群的同伴互动。');
      return true;
    }
    const test = envelope.addressed && this.#replyCheck.receive(
      routeKey(envelope.botId, envelope.scope, envelope.chatId), envelope.text);
    if (test) {
      if (envelope.scope === 'group' && this.#config.respondToMentions === false) test('replies_disabled');
      else this.#queueAnswer(envelope, null, false, null, null, undefined, null, test);
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
        const answer = command === '/sid' ? sidReply(envelope, this.#dmAdmission(envelope)) : await this.#statusReply(envelope);
        await this.respond(envelope.receiptKey, answer);
      });
      return true;
    }
    const priorImage = recentImageFor(envelope, this.#observed.values());
    // Ordinary group observations can teach tone even when the bot chooses silence.
    // The model decides what is worth learning; no keyword or fixed imitation rules.
    if (envelope.scope === 'group' && !envelope.addressed && this.#config.ordinary?.enabled === true && envelope.text && !envelope.text.startsWith('/')) {
      this.#ctx.get?.('maomaoLearning')?.open({ namespace: 'qq', scope: qqMemoryScope(envelope),
        subject: envelope.senderId, name: envelope.senderName, owner: this.#isOwner(envelope), label: `QQ 群 · ${envelope.chatId.slice(-8)}`, platform: 'qq',
        text: envelope.text, sourceId: envelope.receiptKey, signal: this.#abort.signal,
        current: () => !this.#stopped && this.#allowed(envelope),
      })?.finish();
    }
    const shadowDecision = this.#shadow?.observe(envelope, {
      hasReferencedImage: Boolean(priorImage || envelope.quotedImages.length), peer, allowJudgment: passiveReplies,
    }) ?? null;
    if (shadowDecision) void shadowDecision.catch((error) =>
      this.#logger.warn?.('QQ shadow unavailable:', errorLabel(error)));
    let ordinaryContext = null;
    if (this.#ordinary) {
      try {
        if (this.#config.ordinary?.enabled === true) {
          ordinaryContext = (await this.#ordinary.observe(envelope, {
            learningManaged: this.#ctx.get?.('maomaoLearning')?.settings.enabled === true,
          }))?.context ?? null;
        }
      }
      catch (error) { this.#logger.warn?.('QQ ordinary memory unavailable:', errorLabel(error)); }
    }
    if (envelope.addressed && (envelope.scope === 'c2c' || this.#config.respondToMentions !== false)
      && (envelope.text || priorImage || inboundImage(envelope) || waitsForSplitImage(envelope)
        || envelope.attachments.some((item) => item.asrText))) {
      this.#queueAnswer(envelope, ordinaryContext, false, priorImage, peer);
    } else if (shadowDecision && passiveReplies) {
      void shadowDecision.then((row) => {
        // The judge's reply form travels with the turn; inbound messages are frozen and must not be
        // written to (doing so threw and silently dropped every unprompted group reply).
        if (row?.decision === 'would_reply' && this.#shadow?.isLatest(envelope)) {
          this.#queueAnswer(envelope, ordinaryContext, true, priorImage, peer, { replyForm: row.form ?? null });
        }
      }).catch((error) => {
        this.#logger.warn?.('QQ passive delivery unavailable:', errorLabel(error));
        log('warn', 'qq', '主动接话没能开始', errorLabel(error));
      });
    }
    // Every posted picture gets a quick look in the background, the way a person notices a sticker
    // in passing; likely stickers are kept quietly and mentioned (or not) on the cat's next turn.
    if (!envelope.addressedToOther && envelope.attachments.some((item) => item.kind === 'image')
      && (this.#stickers || this.#ctx.get?.('maomaoModels')?.mediaChoice?.('vision')?.enabled) && this.#collectsStickers()) {
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
    this.#queueAnswer(envelope, null, false, null, null, undefined, profile.token);
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

  #queueAnswer(envelope, ordinaryContext, passive, priorImage, peer = null,
    { peerTurn = null, peerCurrent = null, replyForm = null } = {}, choiceProfile = null, test = null) {
    const queued = this.#enqueue(envelope, async () => {
      const turnStart = Date.now();
      const profile = channelPersona(this.#ctx, personaTarget(envelope));
      if (envelope.receivedAt < profile.changedAt || (choiceProfile && choiceProfile !== profile.token)) return;
      const current = () => !this.#stopped && this.#allowed(envelope) && profile.current()
        && (!peerCurrent || peerCurrent())
        && (!passive || this.#shadow?.isLatest(envelope) === true);
      if (!current()) return;
      let linkedImage = priorImage;
      if (!test && !peerTurn && waitsForSplitImage(envelope)) {
        const remaining = envelope.receivedAt + SPLIT_IMAGE_WAIT_MS - Date.now();
        if (remaining > 0) await wait(remaining, undefined, { signal: this.#abort.signal }).catch(() => {});
        if (!current()) return;
        linkedImage = recentImageFor(envelope, this.#observed.values());
      }
      // When the question has no picture of its own, look at what the same person just posted.
      const recentImages = !test && !peerTurn && !linkedImage && !inboundImage(envelope)
        ? recentImagesFrom(envelope, this.#observed.values(), 3) : [];
      linkedImage ??= recentImages.at(-1) ?? null;
      const source = linkedImage ?? envelope;
      const attachment = inboundImage(source);
      const quoted = !peerTurn && attachment && source.quotedImages?.includes(attachment);
      const visionSource = quoted ? { ...source, attachments: [attachment] } : source;
      const models = this.#ctx.get?.('maomaoModels');
      const visionChoice = models?.mediaChoice?.('vision');
      const signal = AbortSignal.any([this.#abort.signal, AbortSignal.timeout(120_000)]);
      let images = test || peerTurn ? [] : await this.loadImages(source.receiptKey);
      const earlierImages = recentImages.length > 1
        ? (await Promise.all(recentImages.slice(0, -1).map((item) => this.loadImages(item.receiptKey)))).flat()
          .filter((image) => image.mediaType !== 'image/gif') : [];
      // Stickers people posted in the group recently (not addressed to the cat) are offered too,
      // each once, so the cat can keep ones it likes the next time it speaks there.
      const stickerImages = [...images, ...(!test && !peerTurn ? await this.#ambientStickers(envelope, source) : [])];
      let imageDescription = peerTurn ? null : this.#imageDetails.get(source.receiptKey);
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
      // The chat model looks at the picture itself when it can; the separate vision
      // model only describes it for chat models that cannot take images.
      const directVision = Boolean(reference) && visionChoice?.enabled !== false
        && await chatSeesImages(this.#ctx, chatSelection(this.#ctx), signal);
      if (directVision && earlierImages.length) images = [...earlierImages, ...images];
      if (visionChoice && reference && !directVision) {
        if (visionChoice.enabled) {
          this.#ordinary ??= new OrdinaryBridge(this.#workerOptions);
          imageDescription = await models.mediaAdapter('vision').then(async (adapter) => {
            if (!adapter || !(await this.#ordinary.media('vision_claim', visionSource)).allowed) return '';
            return adapter.inspect(reference, envelope.text, signal);
          }).catch(() => '') || imageDescription;
        } else imageDescription = null;
        images = [];
      }
      const speechKey = JSON.stringify([envelope.botId, envelope.scope, envelope.chatId, peerTurn?.senderId ?? envelope.senderId, profile.token]);
      const lastSpeech = this.#voiceHistory.get(speechKey);
      const voice = !peerTurn && lastSpeech && Date.now() - lastSpeech.at < 5 * 60_000 ? { previous: lastSpeech.text } : null;
      const imageEnabled = models?.mediaChoice?.('image')?.enabled ?? Boolean(this.#imageGeneration);
      const voiceEnabled = models?.mediaChoice?.('voice')?.enabled ?? Boolean(this.#speech);
      const chatTools = test ? null : openChatTools({ current, signal, web: this.#ctx.get?.('web'), browser: this.#ctx.get?.('maomaoBrowser'),
        // A line said before the media (e.g. while drawing); the model decides whether to use it.
        say: peerTurn ? null : async (line) => {
          if (!(await this.respond(envelope.receiptKey, line, { current, limit: 1 })).length) throw new Error('say_first_not_sent');
        },
        learnProject: (data) => learning?.research(data),
        hasReference: !peerTurn && !quoted && source.senderId === envelope.senderId && Boolean(reference),
        image: imageEnabled ? async (args, toolSignal, publicReference) => {
          const generation = models?.mediaChoice?.('image') ? await models.mediaAdapter('image') : this.#imageGeneration;
          if (!generation) return 'unavailable';
          return this.#generateImage(envelope, publicReference ?? (args.use_reference ? reference : null), current, generation, args, toolSignal);
        } : null,
        voice: voiceEnabled ? async (text, toolSignal) => {
          const speech = models?.mediaChoice?.('voice') ? await models.mediaAdapter('voice') : this.#speech;
          if (!speech) return 'unavailable';
          return this.#voiceReply(envelope, text, { key: speechKey }, current, speech, toolSignal);
        } : null,
      });
      // A QQ private chat linked to a Lark / Telegram owner shares that owner's memory; otherwise memory stays per QQ chat.
      const linkedOwner = !test && !peerTurn ? this.#linkedOwner(envelope) : null;
      const ownerMemory = linkedOwner ? this.#ctx.get?.('maomaoPrivate')?.ownerMemory?.(linkedOwner, 'qq') : null;
      if (linkedOwner) this.#ctx.get?.('maomaoPrivate')?.noteOwnerActivity?.(linkedOwner, envelope.text);
      const learningText = envelope.text || (images.length || stickerImages.some((image) => !image.origin) ? '[图片]' : '');
      const learning = !test && !peerTurn && (ownerMemory || this.#config.ordinary?.enabled === true)
        ? this.#ctx.get?.('maomaoLearning')?.open(ownerMemory
          ? { namespace: 'private', scope: ownerMemory.scope, subject: linkedOwner, owner: true, label: ownerMemory.label,
            platform: ownerMemory.platform, text: learningText, sourceId: envelope.receiptKey, current, signal }
          : { namespace: 'qq', scope: qqMemoryScope(envelope),
            subject: envelope.senderId, name: envelope.senderName, owner: this.#isOwner(envelope),
            label: `QQ ${envelope.scope === 'group' ? '群' : '私聊'} · ${envelope.chatId.slice(-8)}`, platform: 'qq',
            // An image-only turn still gets the memory tools, so the model never meets an unknown tool.
            text: learningText, sourceId: envelope.receiptKey, current, signal }) : null;
      const learningService = this.#ctx.get?.('maomaoLearning');
      const stickerTools = !test && learningService?.settings.stickers === true && this.#config.stickers?.enabled !== false
        ? openStickerTools({ current: () => current() && learningService.settings.stickers === true, signal, images: stickerImages,
          note: this.#takeSteals(envelope),
          collect: () => learningService.settings.collectStickers === true && this.#config.stickers?.collect !== false,
          operate: (action, { source: candidateSource, ...args }) => {
            this.#ordinary ??= new OrdinaryBridge(this.#workerOptions);
            return this.#ordinary.media('sticker_tool', ['inspect', 'collect'].includes(action) ? candidateSource ?? visionSource : envelope, { action, ...args });
          },
          describe: async (jpeg, deadline) => {
            const adapter = models?.mediaChoice?.('vision')?.enabled ? await models.mediaAdapter('vision') : this.#stickers;
            return adapter?.describe(jpeg, deadline);
          },
          send: (media, deadline) => this.#sendMedia(envelope, { fileType: MediaFileType.IMAGE, buffer: media.buffer,
            fileName: media.fileName, fingerprint: `sticker-tool:${media.id}` }, () => current() && !deadline.aborted),
        }) : null;
      const groupTools = !test && envelope.scope === 'group' ? this.#groupTools.open({
        bot: this.#bot, groupId: envelope.chatId, speakerId: peerTurn?.senderId ?? envelope.senderId, current,
      }) : null;
      const chatKey = `${envelope.botId}:${envelope.scope}:${envelope.chatId}`;
      const choices = !test && envelope.scope === 'group' && !passive
        && this.#config.markdownSupport !== false && !this.#markdownDenied.has('group') && this.#choiceThrottle.allow(chatKey);
      log('info', 'qq', `${envelope.scope === 'group' ? '群' : '私聊'}回合${peerTurn ? '（接机器人）' : passive ? '（主动接话）' : ''}`,
        { chat: envelope.chatId.slice(-6), text: (peerTurn?.text ?? envelope.text).slice(0, 200), images: images.length, directVision, form: replyForm ?? peerTurn?.form ?? null, choices });
      if (!test && !peerTurn && envelope.scope === 'c2c') void this.#typing(envelope);
      const reply = await this.#harness.ask(envelope, {
        replyForm,
        images,
        imageDescription,
        referencedImage: linkedImage ? { sameSender: linkedImage.senderId === envelope.senderId }
          : quoted ? { quoted: true } : null,
        // For a reply to the other bot, keep the human message it was answering (the anchor) and
        // leave out only the bot's own line, which is the current turn.
        ambient: this.#shadow?.contextFor(peerTurn?.messageId ? { ...envelope, messageId: peerTurn.messageId } : envelope, profile.changedAt) ?? [],
        ordinaryContext,
        profile,
        voice,
        chatTools,
        stickerTools,
        learning,
        groupTools,
        passive,
        peerTurn,
        choices,
        recentReplies: this.#recentReplies.get(`${envelope.botId}:${envelope.scope}:${envelope.chatId}`) ?? [],
        owner: !peerTurn && this.#isOwner(envelope),
        models,
        signal,
      }).then((reply) => {
        this.#diagnostics.model = { outcome: reply || chatTools?.outcome() === 'sent' ? 'ok' : 'empty', at: Date.now() };
        return reply;
      }).catch((error) => {
        test?.('model_failed');
        this.#diagnostics.model = { outcome: 'failed', at: Date.now() };
        apiError('qq-model', error?.code ?? error?.name ?? 'error', 'QQ 对话模型调用失败', errorLabel(error));
        throw error;
      });
      const { text: answer, options } = parseChoiceReply(reply ?? '');
      if (['sent', 'uncertain'].includes(chatTools?.outcome())) {
        // The model may add a line after the image or voice; it decides, and an empty reply is fine.
        const after = answer && current()
          && (await this.respond(envelope.receiptKey, answer, { current, limit: envelope.scope === 'group' ? 2 : 3 }).catch(() => [])).length ? answer : '';
        if (after) this.#recentReplies.set(chatKey, [...(this.#recentReplies.get(chatKey) ?? []), after].slice(-8));
        if (chatTools.outcome() === 'sent') learning?.finish({ answer: [chatTools.transcript(), after].filter(Boolean).join('\n'), tools: chatTools.learningOutcomes() });
        return;
      }
      if (!current()) return;
      if (!answer) {
        test?.('model_empty');
        if (chatTools?.outcome()) await this.respond(envelope.receiptKey, '这次媒体没发出去，等会儿再试一下喵。', { current });
        return;
      }
      const limit = test || choiceProfile || (passive && peer) ? 1 : undefined;
      const card = choices && options.length ? { profile: profile.token, options } : null;
      // Joining in on its own, a person reads the line first and then types; a reply 2 seconds
      // after another bot spoke reads as a script. Time spent thinking already counts.
      if (!test && envelope.scope === 'group' && (passive || peerTurn) && this.#config.typingPace !== false) {
        const pause = joinInPause(peerTurn?.text ?? envelope.text, textBubbles(answer, 1)[0] ?? answer) - (Date.now() - turnStart);
        if (pause > 0) await wait(pause, undefined, { signal: this.#abort.signal }).catch(() => {});
        if (!current()) return;
      }
      test?.('sending');
      const sent = await this.respond(envelope.receiptKey, answer, { current, limit, card, optional: Boolean(peerTurn) }).catch((error) => {
        test?.('delivery_failed');
        throw error;
      });
      test?.(sent.length ? 'sent' : 'delivery_failed');
      if (sent.length) {
        const key = chatKey;
        this.#choiceThrottle.noteReply(key, Boolean(card));
        this.#recentReplies.set(key, [...(this.#recentReplies.get(key) ?? []), answer].slice(-8));
        if (this.#recentReplies.size > 200) this.#recentReplies.delete(this.#recentReplies.keys().next().value);
      }
      if (sent.length) learning?.finish({ answer, tools: [...(chatTools?.learningOutcomes() ?? []), ...(stickerTools?.learningOutcomes() ?? [])] });
      if (!test && !stickerTools && this.#stickers && !card && !choiceProfile && !limit
        && sent.length === textBubbles(answer, envelope.scope === 'group' ? 4 : 3).length
        && sent.length > 0) {
        this.#runMediaJob(() => this.#afterReplySticker(envelope, answer));
      }
    });
    if (test) void queued.then(() => test('interrupted'), () => test('interrupted'));
    return queued;
  }

  async #ambientStickers(envelope, source) {
    if (envelope.scope !== 'group' || this.#ctx.get?.('maomaoLearning')?.settings.collectStickers !== true
      || this.#config.stickers?.collect === false) return [];
    const recent = [...this.#observed.values()].filter((item) => item.receiptKey !== source.receiptKey
      && item.receiptKey !== envelope.receiptKey && !this.#stickerOffered.has(item.receiptKey)
      && item.botId === envelope.botId && item.scope === 'group' && item.chatId === envelope.chatId
      && Date.now() - item.receivedAt < 10 * 60_000 && !item.text?.replace(/【表情[^】]*】/g, '').trim()
      && item.attachments.some((attachment) => attachment.kind === 'image' && attachment.sourceUrl)).slice(-2);
    const found = [];
    for (const item of recent) {
      this.#stickerOffered.add(item.receiptKey);
      if (this.#stickerOffered.size > 500) this.#stickerOffered.delete(this.#stickerOffered.values().next().value);
      const [image] = await this.loadImages(item.receiptKey).catch(() => []);
      if (image) found.push({ ...image, origin: item.senderId === envelope.senderId ? '这个人刚才发的' : '刚才群里有人发的', source: item });
    }
    return found;
  }

  async #generateImage(envelope, reference, current, generation, args, signal) {
    const deadline = envelope.scope === 'group' ? 300_000 : 60_000;
    const remaining = deadline - (Date.now() - envelope.receivedAt) - 10_000;
    if (remaining <= 0 || signal.aborted || !current()) return 'cancelled';
    try {
      if (!await this.#state.reserveImage(envelope)) return 'limit';
      const output = await generation.generate(`为全年龄聊天生成图片。\n${args.prompt.trim()}`, {
        reference, aspectRatio: args.aspect_ratio,
        signal: AbortSignal.any([signal, this.#abort.signal, AbortSignal.timeout(remaining)]),
      });
      if (!output) return 'unavailable';
      return await this.#sendMedia(envelope, { ...output, fileType: MediaFileType.IMAGE,
        fingerprint: 'generated-image:reply' }, () => !signal.aborted && current());
    } catch { return signal.aborted || !current() ? 'cancelled' : 'unavailable'; }
  }

  async #voiceReply(envelope, answer, voice, current, speech, signal) {
    try {
      const text = spokenTranscript(answer);
      const replyWindow = envelope.scope === 'group' ? 300_000 : 60_000;
      const remaining = replyWindow - (Date.now() - envelope.receivedAt) - 8_000;
      if (remaining <= 0) return 'unavailable';
      const audio = await speech.synthesize(text,
        AbortSignal.any([signal, this.#abort.signal, AbortSignal.timeout(remaining)]));
      if (signal.aborted || !current()) return 'cancelled';
      const outcome = await this.#sendMedia(envelope, {
        fileType: MediaFileType.VOICE, buffer: audio, fileName: 'maomao-voice.wav', fingerprint: 'voice:reply',
      }, () => !signal.aborted && current());
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

  // Once per install: hide the judge sessions earlier versions left in the DSH sidebar.
  async #archiveOldJudgeSessions() {
    const marker = join(this.#storageHome, 'integrations', 'maomao-qq', 'judge-sessions-archived');
    if (await stat(marker).then(() => true, () => false)) return;
    const registry = this.#ctx.get?.('workspaceRegistry');
    if (typeof registry?.archiveSession !== 'function') return;
    await archiveJudgeSessions(registry, this.#dshHome);
    await mkdir(dirname(marker), { recursive: true });
    await writeFile(marker, `${new Date().toISOString()}\n`);
  }

  // Once per install: hide 猫猫's chat sessions from before the 猫猫的聊天 group existed.
  async #archiveOldChatSessions() {
    const marker = join(this.#storageHome, 'integrations', 'maomao-qq', 'old-chat-sessions-archived');
    if (await stat(marker).then(() => true, () => false)) return;
    if (!await this.#chatFolder.folder()) return;
    const archived = await this.#chatFolder.archiveOutside();
    log('info', 'plugin', '已归档分组之前的旧聊天会话', { archived });
    await writeFile(marker, `${new Date().toISOString()}\n`);
  }

  #collectsStickers() {
    const settings = this.#ctx.get?.('maomaoLearning')?.settings;
    return settings?.stickers === true ? settings.collectStickers === true && this.#config.stickers?.collect !== false
      : this.#config.stickers?.collect === true;
  }

  // What the cat just kept in this chat; the next turn there (any kind) says so in its own words.
  #takeSteals(envelope) {
    const key = `${envelope.botId}:${envelope.scope}:${envelope.chatId}`;
    const rows = (this.#steals.get(key) ?? []).filter((row) => Date.now() - row.at < 30 * 60_000);
    this.#steals.delete(key);
    return rows.length ? `[你刚把这里刚出现的表情偷偷存进了自己的表情包：${JSON.stringify(rows.map(({ description, reason }) => ({ description, reason })))}。这一轮顺口告诉大家一声，用你自己的说法，一句就够，可以带上打算什么时候用；图的细节大家都看见了，不用再讲。]` : '';
  }

  async #observeImage(envelope) {
    const [image] = await this.loadImages(envelope.receiptKey);
    if (!image || this.#stopped) return;
    this.#ordinary ??= new OrdinaryBridge(this.#workerOptions);
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
      { data: image.data, result, collect: this.#collectsStickers(), first_sight: this.#ctx.get?.('maomaoLearning')?.settings?.stickers === true });
    log('debug', 'sticker', '看了一眼群友的图', { meme: result.is_meme, private: result.personal_or_sensitive, kept: Boolean(collected.notice) });
    if (!collected.notice) return;
    if (this.#ctx.get?.('maomaoLearning')?.settings.stickers === true) {
      // Tool mode: no fixed notice; the next turn learns what was kept and the model decides what to say.
      const key = `${envelope.botId}:${envelope.scope}:${envelope.chatId}`;
      const row = { description: result.description, reason: result.steal_reason, at: Date.now() };
      this.#steals.set(key, [...(this.#steals.get(key) ?? []), row].slice(-3));
      if (this.#steals.size > 200) this.#steals.delete(this.#steals.keys().next().value);
      log('info', 'sticker', '收藏了一张表情', { chat: envelope.chatId.slice(-6), description: result.description });
      await this.#ordinary.media('finish_notice', envelope, { id: collected.id, success: true });
      // No turn picked it up soon: say the short line on its own, as a person would right after saving.
      const timer = setTimeout(() => {
        const pending = this.#steals.get(key);
        if (this.#stopped || !pending?.includes(row)) return;
        this.#steals.delete(key);
        this.#runMediaJob(() => this.#enqueue(envelope, async () => {
          if (this.#stopped || Date.now() - envelope.receivedAt > 90_000) return;
          const sent = (await this.respond(envelope.receiptKey, collected.notice)).length > 0;
          log('info', 'sticker', '偷表情小提醒', { sent, text: collected.notice });
        }));
      }, this.#stealNoticeDelayMs);
      timer.unref?.();
      return;
    }
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
    void queued.catch((error) => {
      this.#logger.error?.('QQ queued action failed:', errorLabel(error));
      log('error', 'qq', '回合出错，没有回复', errorLabel(error));
    });
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
          apiError('qq-media', error.code ?? (error.name === 'TimeoutError' ? 'timeout' : 'network'), 'QQ 图片下载失败', errorLabel(error));
          return [];
        }).finally(() => this.#imageInFlight.delete(receiptKey));
      this.#imageInFlight.set(receiptKey, operation);
    }
    return this.#imageInFlight.get(receiptKey);
  }

  async respond(receiptKey, text, { current = () => true, limit, card = null, optional = false } = {}) {
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
      if (index && this.#config.typingPace !== false) {
        await wait(typingPause(part), undefined, { signal: this.#abort.signal }).catch(() => {});
      }
      if (!stillAllowed()) break;
      const ticket = await this.#state.reserve(anchor, `${envelope.replyAnchor ? envelope.receiptKey : ''}${index}\u0000${part}`, { optional });
      if (!ticket?.fresh) continue;
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
        this.#shadow?.noteReply(envelope, part, messageId);
      } catch (error) {
        this.#diagnostics.reply = { outcome: 'failed', at: Date.now() };
        await this.#state.finish(ticket.key);
        throw error;
      }
    }
    return sent;
  }

  // QQ shows "typing…" only in private chats (msg_type 6). It lasts 60 s and needs no stop call;
  // a high msg_seq keeps it clear of the reply segments.
  async #typing(envelope) {
    const anchor = envelope.replyAnchor ?? envelope;
    try {
      await this.#bot?.send({ target: { scope: 'c2c', targetId: anchor.chatId, msgId: anchor.messageId }, msgType: 6,
        extra: { msg_seq: 90, input_notify: { input_type: 1, input_second: 60 } } });
    } catch (error) { this.#logger.debug?.('QQ typing notice failed', errorLabel(error)); log('debug', 'qq', '输入状态发送失败', errorLabel(error)); }
  }

  async #sendText(envelope, content, seq, current = () => true, keyboard, choices) {
    const options = {
      target: { scope: envelope.scope, targetId: envelope.chatId, msgId: envelope.messageId },
      extra: { msg_seq: seq },
    };
    if (!current()) return '';
    this.#shadow?.noteOutbound(envelope, content);
    const plain = plainChatMarkdown(content);
    // In a group, numbered options as plain text invite people to answer "4"; leave them out there.
    const choiceText = choices && envelope.scope !== 'group' ? '\n\n' + choices.map((label, index) => (index + 1) + '. ' + label).join('\n') + '\n可以直接回复你想选的方向。' : '';
    if ((keyboard || hasChatMarkdown(content, plain)) && this.#config.markdownSupport !== false && !this.#markdownDenied.has(envelope.scope)) {
      try {
        const result = await this.#bot.send({ ...options, msgType: MsgType.MARKDOWN, markdown: { content: keyboard ? content : content + choiceText },
          ...(keyboard ? { keyboard } : {}) });
        return typeof result?.id === 'string' ? result.id : '';
      } catch (error) {
        // A timeout can mean the message landed. Only retry a definite Markdown rejection.
        const code = Number(error instanceof ApiError ? error.bizCode : 0);
        if (![40034012, 40034090].includes(code)) throw error;
        if (code === 40034012) this.#markdownDenied.add(envelope.scope);
        this.#diagnostics.format = { outcome: 'rejected', code, keyboard: Boolean(keyboard), at: Date.now() };
        this.#logger.warn?.('QQ Markdown rejected, using plain text', code);
        apiError('qq', code, keyboard ? 'QQ 拒绝了按钮卡片，改发纯文字' : 'QQ 拒绝了 Markdown，改发纯文字');
        if (!current()) return '';
      }
    }
    const result = await this.#bot.send({ ...options, content: plain + choiceText, msgType: MsgType.TEXT });
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
      saveDirectMessageSettings: (request) => connector.saveDirectMessageSettings(request),
      peerGroups: () => connector.peerGroups(), savePeerGroup: (request) => connector.savePeerGroup(request),
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
