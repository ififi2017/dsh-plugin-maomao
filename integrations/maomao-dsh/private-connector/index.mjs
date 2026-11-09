import { randomBytes, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { PrivateBindings, digest, larkHistoryScope } from './identity.mjs';
import { PrivateLedger } from './ledger.mjs';
import { OwnerMemory } from './memory.mjs';
import { FeishuTransport, TelegramTransport } from './transports.mjs';
import { provisionFeishu } from './setup-feishu.mjs';
import { provisionTelegram } from './setup-telegram.mjs';
import { telegramBotId } from './telegram-api.mjs';
import { choiceGuidance, parseChoiceData, parseChoiceReply } from '../choices.mjs';
import { channelPersona, mountChannelPersona } from '../personas.mjs';
import { ReplyCheck } from '../onboarding.mjs';

export const name = 'maomao-dsh-private';
export const inject = ['sessionController'];
export const PRESET = 'maomao-private-ordinary';

const safeError = (error) => /^(?:telegram|feishu|private)_[a-z0-9_]{1,80}$/.test(error?.code ?? '')
  ? error.code : 'private_operation_failed';
const labels = { feishu: '飞书', telegram: 'Telegram' };
const scopedRoute = (event, owner) => digest([event.platform, event.accountId, event.chatId, owner]);
const accountKey = (platform, accountId) => digest([platform, accountId]);
const bindingRoute = (event) => scopedRoute(event, null);
const personaIdFor = (binding, owner) => digest([binding, owner]);
const bindingPeer = (event) => digest([bindingRoute(event), event.senderId]);
const PAIRING_MS = 5 * 60_000;
const mediaCodes = {
  feishu_media_permission: 'lark_permission',
  feishu_token_unavailable: 'permission',
  private_media_permission: 'permission',
  private_media_missing: 'missing',
  private_media_rate_limit: 'rate_limit',
  private_media_http: 'http',
  private_media_size: 'size',
  private_media_format: 'format',
  private_media_empty: 'empty',
  telegram_http_400: 'missing',
  telegram_http_401: 'permission',
  telegram_http_403: 'permission',
  telegram_http_429: 'rate_limit',
  telegram_network: 'network',
};
const limitText = (text) => Array.from(text).slice(0, 1800).join('');
const LONELY_LINES = [
  '猫猫路过，来给主人留个小爪印喵。',
  '猫猫在窗边伸了个懒腰。等你有空再聊喵。',
  '俺先自己找点乐子，回头见喵。',
  '猫猫来报个平安，尾巴好好的喵。',
  '猫猫安静趴一会儿喵。',
  '给你留个小爪印，等你回来喵。',
];

function commandFor(text, username) {
  const match = /^\/(sid|status|pair)(?:@([a-z0-9_]+))?$/i.exec(text);
  return match && (!match[2] || match[2].toLowerCase() === username) ? match[1].toLowerCase() : null;
}

function answerFrom(result) {
  for (const record of [...(result?.output?.records ?? [])].reverse()) {
    if (record?.event?.type !== 'assistant/message') continue;
    const parts = record.event.data?.message?.content;
    if (!Array.isArray(parts) || parts.some((part) => part.type === 'tool-call')) continue;
    return parts.filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text).join('\n').trim();
  }
  return '';
}

function bubbles(text) {
  if (text.includes('```')) return [limitText(text.replaceAll('<|bubble|>', '\n\n'))];
  const parts = text.replace(/(?:<\|){2,}bubble\|>/g, '<|bubble|>').split('<|bubble|>').map((part) => part.trim()).filter(Boolean);
  return [...parts.slice(0, 2), parts.slice(2).join('\n\n')].filter(Boolean).map(limitText);
}

export class PrivateConnector {
  #ctx;
  #config;
  #routes;
  #bindings;
  #ledger;
  #memory;
  #memoryRoot;
  #contact;
  #destination;
  #sharing = new Set();
  #schedule;
  #timer;
  #scheduled;
  #lastSchedule = null;
  #pairings = new Map();
  #replyChecks = new Map(Object.keys(labels).map((platform) => [platform, new ReplyCheck()]));
  #logger;
  #abort = new AbortController();
  #running = [];
  #indexJob = null;
  #jobs = new Map();
  #bursts = new Map();
  #pending = 0;
  #enrollment = new Map();

  constructor(ctx, config, { routes, ledger, memory, contact, secrets } = {}) {
    this.#ctx = ctx;
    this.#config = config;
    this.#logger = typeof ctx.logger === 'function' ? ctx.logger(name) : (ctx.logger ?? console);
    this.#bindings = new PrivateBindings(config.bindings ?? []);
    const root = resolve(config.stateRoot ?? join(process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh'),
      'integrations', 'maomao-private-ordinary'));
    this.#memoryRoot = join(root, 'ordinary');
    this.#routes = routes ?? this.#makeRoutes(config, secrets);
    this.#ledger = ledger ?? new PrivateLedger(join(root, 'delivery.sqlite3'));
    const worker = new OwnerMemory({
      ...config.memory, quietHours: config.sharing?.quietHours, root: this.#memoryRoot, modelSelection: () => ctx.get?.('maomaoModels'),
    });
    this.#memory = config.memory?.enabled !== false ? memory ?? worker : null;
    if (config.sharing?.enabled === true) {
      const endpoint = config.sharing.destination;
      const owner = endpoint ? this.#ownerFor(endpoint) : null;
      if (!owner || config[endpoint.platform]?.accountId !== endpoint.accountId || !this.#routes.has(endpoint.platform)) return;
      this.#destination = Object.freeze({ ...endpoint, owner, route: scopedRoute(endpoint, owner) });
      this.#contact = contact ?? worker;
      const schedule = config.sharing.schedule;
      if (schedule?.enabled === true) {
        if (!['shadow', 'send'].includes(schedule.mode) || (schedule.browse !== true && schedule.lonely !== true)) {
          throw new Error('Scheduled private sharing requires a mode and a source');
        }
        this.#schedule = { ...schedule };
      }
    }
  }

  #makeRoutes(config, secrets) {
    const routes = new Map();
    if (config.feishu?.enabled) {
      const appId = config.feishu.credentialRef ? config.feishu.accountId : process.env.MAOMAO_DSH_FEISHU_APP_ID;
      if (appId !== config.feishu.accountId) throw Object.assign(new Error('Feishu app mismatch'), { code: 'feishu_wrong_app' });
      routes.set('feishu', new FeishuTransport({ appId,
        secret: config.feishu.credentialRef ? secrets?.feishu : process.env.MAOMAO_DSH_FEISHU_APP_SECRET,
        brand: config.feishu.brand ?? process.env.MAOMAO_DSH_FEISHU_BRAND }));
    }
    if (config.telegram?.enabled) {
      routes.set('telegram', new TelegramTransport({
        token: config.telegram.credentialRef ? secrets?.telegram : process.env.MAOMAO_DSH_TELEGRAM_TOKEN,
        botId: config.telegram.accountId }));
    }
    return routes;
  }

  start() {
    this.#running = [...this.#routes].map(([platform, transport]) =>
      transport.run((event) => {
        if (event.platform === platform) this.accept(event);
      }, this.#abort.signal, (event, data) => event.platform === platform && this.acceptChoice(event, data)).catch((error) => {
        if (!this.#abort.signal.aborted) this.#logger.warn?.(`${platform} connector stopped:`, safeError(error));
      }));
    if (this.#schedule) {
      this.#timer = setInterval(async () => {
        const result = await this.runScheduled();
        this.#lastSchedule = { ...result, at: Date.now() };
      }, 5 * 60_000);
      this.#timer.unref();
    }
  }

  async stop() {
    this.#abort.abort();
    clearInterval(this.#timer);
    for (const { timer } of this.#bursts.values()) clearTimeout(timer);
    this.#bursts.clear();
    this.#pairings.clear();
    await Promise.allSettled([...this.#running, ...this.#jobs.values(), ...this.#sharing, this.#scheduled, this.#indexJob?.work]);
    this.#ledger.close();
  }

  status() {
    const channels = {};
    for (const platform of Object.keys(labels)) {
      const transport = this.#routes.get(platform);
      channels[platform] = transport ? (transport.ready() ? 'ready' : 'waiting') : 'off';
    }
    const owners = this.#ownerChannels();
    const nicknames = this.#ledger.ownerLabels();
    const sharingConfigured = Boolean(this.#memory && this.#config.memory?.shared !== false);
    const sharedMemory = sharingConfigured && [...owners.values()].some((platforms) => platforms.size === 2);
    return {
      channels,
      memory: Boolean(this.#memory),
      sharedMemory,
      sharedMemoryState: !sharingConfigured ? 'off' : sharedMemory ? 'active'
        : this.#routes.size < 2 ? 'waiting_channels' : 'waiting_owner',
      embedding: Boolean(this.#memory && (this.#ctx.get?.('maomaoModels')?.mediaChoice?.('embedding')?.enabled
        ?? this.#config.memory?.embedding === true)),
      owners: [...owners].map(([id, platforms], index) => ({
        id, label: nicknames.get(id) ?? `主人 ${index + 1}`, nickname: nicknames.get(id) ?? '', channels: [...platforms],
      })),
      panelBindings: Object.keys(labels).filter((platform) => this.#routes.has(platform)).flatMap((platform) =>
        this.#ledger.panelBindings(accountKey(platform, this.#config[platform].accountId)).map(({ id, owner }) => ({
          id, platform, owner: [...owners.keys()].indexOf(owner) + 1, ownerId: owner,
        }))),
      media: this.#ledger.mediaStatus(),
      diagnostics: this.#ledger.diagnostics(),
      sharing: {
        destination: this.#destination?.platform ?? null,
        destinationId: this.#destination?.route ?? null,
        mode: this.#schedule?.mode ?? (this.#destination ? 'manual' : 'off'),
        browse: this.#schedule?.browse === true,
        lonely: this.#schedule?.lonely === true,
        last: this.#lastSchedule ? { ...this.#lastSchedule } : null,
      },
    };
  }

  unbind(platform, id) {
    if (!this.#routes.has(platform)) return false;
    return this.#ledger.removePanelBinding(id, accountKey(platform, this.#config[platform].accountId));
  }

  renameOwner(owner, label) {
    if (typeof label !== 'string' || label.length > 32 || /[\p{Cc}\p{Cf}]/u.test(label)
      || !this.#ownerChannels().has(owner)) return { status: 'invalid' };
    this.#ledger.setOwnerLabel(owner, label.trim());
    return { status: 'saved' };
  }

  #memoryScope(owner, platform) {
    return this.#config.memory?.shared === false ? digest(['private-channel-memory', platform, owner]) : owner;
  }

  memorySources() {
    const nicknames = this.#ledger.ownerLabels();
    return [...this.#ownerChannels()].flatMap(([owner, channels], index) => {
      const label = nicknames.get(owner) ?? `主人 ${index + 1}`;
      const groups = this.#config.memory?.shared === false ? [...channels].map((platform) => [platform]) : [[...channels]];
      const sources = groups.map((platforms) => {
        const scope = this.#memoryScope(owner, platforms[0]);
        return { scope, path: join(this.#memoryRoot, scope, 'dialogue.sqlite3'), label, platforms };
      });
      if (channels.has('feishu')) {
        const scope = larkHistoryScope(this.#config.feishu.accountId, owner);
        sources.push({ scope, path: join(this.#memoryRoot, scope, 'dialogue.sqlite3'),
          label: `${label} 的 Hermes 旧记忆`, platforms: ['feishu'], historical: true });
      }
      return sources;
    });
  }

  #verifiedDestinations() {
    const endpoints = this.#ledger.verifiedEndpoints();
    if (this.#destination && this.#ledger.verifiedRoute(this.#destination.route)
      && !endpoints.some((endpoint) => endpoint.route === this.#destination.route)) endpoints.push(this.#destination);
    return endpoints.filter((endpoint) => {
      if (!this.#routes.has(endpoint.platform) || this.#config[endpoint.platform]?.accountId !== endpoint.accountId) return false;
      const owner = this.#ownerFor(endpoint);
      return owner && scopedRoute(endpoint, owner) === endpoint.route;
    });
  }

  personaTargets() {
    const targets = new Map();
    for (const platform of this.#routes.keys()) {
      const accountId = this.#config[platform]?.accountId;
      for (const binding of this.#ledger.panelBindings(accountKey(platform, accountId))) {
        const id = personaIdFor(binding.id, binding.owner);
        targets.set(id, { id, kind: platform });
      }
      for (const { endpoints } of this.#config.bindings ?? []) {
        for (const endpoint of endpoints ?? []) {
          if (endpoint.platform !== platform || endpoint.accountId !== accountId) continue;
          const owner = this.#ownerFor(endpoint);
          if (!owner) continue;
          const id = personaIdFor(bindingRoute(endpoint), owner);
          targets.set(id, { id, kind: platform });
        }
      }
    }
    const counts = { feishu: 0, telegram: 0 };
    return [...targets.values()].sort((a, b) => a.id.localeCompare(b.id)).map((target) => ({
      ...target, label: `${labels[target.kind]} 私聊 ${++counts[target.kind]}`,
    }));
  }

  shareTargets() {
    const owners = [...this.#ownerChannels().keys()];
    const nicknames = this.#ledger.ownerLabels();
    return this.#verifiedDestinations().map((endpoint) => {
      const owner = this.#ownerFor(endpoint);
      const number = owners.indexOf(owner) + 1;
      return { id: endpoint.route, platform: endpoint.platform, owner: number,
        label: nicknames.get(owner) ?? `主人 ${number}` };
    });
  }

  shareTarget(id) {
    const endpoint = this.#verifiedDestinations().find((value) => value.route === id);
    if (!endpoint) return null;
    const { platform, accountId, chatId, senderId } = endpoint;
    return { platform, accountId, chatId, senderId };
  }

  async vectorIndex(action) {
    if (!this.#memory) return { status: 'disabled' };
    const models = this.#ctx.get?.('maomaoModels');
    const choice = models?.mediaChoice?.('embedding');
    if (!(choice?.enabled ?? this.#config.memory?.embedding === true)) return { status: 'disabled' };
    const scopes = [...new Set([...this.#ownerChannels()].flatMap(([owner, platforms]) =>
      [...platforms].map((platform) => this.#memoryScope(owner, platform))))];
    if (!scopes.length) return { status: 'no_bindings' };
    if (action === 'cancel') this.#indexJob?.abort.abort();
    if (action === 'start' && !this.#indexJob?.running) {
      const job = { status: 'running', running: true, indexed: 0, total: 0, abort: new AbortController() };
      this.#indexJob = job;
      const signal = AbortSignal.any([this.#abort.signal, job.abort.signal, AbortSignal.timeout(300_000)]);
      job.work = this.#rebuildIndex(scopes, job, signal).catch(() => {
        job.status = signal.aborted ? 'cancelled' : 'failed';
      }).finally(() => { job.running = false; });
    }
    const job = this.#indexJob;
    if (job && (job.running || action !== 'read')) return this.#indexSummary(job);
    try {
      const report = await this.#indexProgress(scopes, this.#abort.signal);
      return { ...this.#indexSummary(report), status: job?.status ?? 'ready' };
    } catch { return { status: 'failed' }; }
  }

  #indexSummary({ status, indexed, total, model }) { return { status, indexed, total, model }; }

  async #indexProgress(scopes, signal) {
    const report = { indexed: 0, total: 0 };
    for (const owner of scopes) {
      const value = await this.#memory.run('index_status', { owner, turnId: digest(['index', owner]) }, signal);
      if (report.model && report.model !== value.model) throw new Error('Embedding model changed during index read');
      report.indexed += value.indexed;
      report.total += value.total;
      report.model = value.model;
    }
    return report;
  }

  async #rebuildIndex(scopes, job, signal) {
    Object.assign(job, await this.#indexProgress(scopes, signal));
    for (const owner of scopes) {
      const request = { owner, turnId: digest(['index', owner]) };
      let previous = await this.#memory.run('index_status', request, signal);
      while (previous.indexed < previous.total) {
        signal.throwIfAborted();
        const choice = this.#ctx.get?.('maomaoModels')?.mediaChoice?.('embedding');
        if ((choice && (!choice.enabled || choice.model !== job.model)) || previous.model !== job.model) {
          throw new Error('Embedding model changed during rebuild');
        }
        const value = await this.#memory.run('index_rebuild', request, signal);
        if (value.model !== job.model) throw new Error('Embedding model changed during rebuild');
        if (value.indexed <= previous.indexed && value.indexed < value.total) throw new Error('No embedding progress');
        job.indexed += value.indexed - previous.indexed;
        job.total += value.total - previous.total;
        previous = value;
      }
    }
    job.status = 'done';
  }

  #ownerFor(event) {
    const configured = this.#bindings.ownerFor(event);
    if (configured) return configured;
    const binding = this.#ledger.panelBinding(bindingRoute(event));
    return binding?.peer === bindingPeer(event) ? binding.owner : null;
  }

  #ownerChannels() {
    const owners = new Map();
    const add = (owner, platform) => {
      if (!owners.has(owner)) owners.set(owner, new Set());
      owners.get(owner).add(platform);
    };
    for (const platform of Object.keys(labels)) {
      if (!this.#routes.has(platform)) continue;
      const accountId = this.#config[platform].accountId;
      for (const { endpoints } of this.#config.bindings ?? []) {
        for (const endpoint of endpoints) {
          if (endpoint.platform === platform && endpoint.accountId === accountId) {
            add(this.#bindings.ownerFor(endpoint), platform);
          }
        }
      }
      for (const owner of this.#ledger.panelOwners(accountKey(platform, accountId))) add(owner, platform);
    }
    return owners;
  }

  pair({ action, platform, owner, id, proof, bindingId }) {
    if (!Object.hasOwn(labels, platform)) return { status: 'unavailable' };
    let pairing = this.#pairings.get(platform);
    if (pairing && pairing.expires <= Date.now()) {
      this.#pairings.delete(platform);
      pairing = null;
    }
    if (action === 'start') {
      if (!this.#routes.get(platform)?.ready()) return { status: 'unavailable' };
      if (pairing) return { status: 'busy' };
      const owners = this.#ownerChannels();
      if (owners.size && typeof owner !== 'string') return { status: 'choose_owner' };
      if (owner && !owners.has(owner)) return { status: 'unavailable' };
      let reassign;
      if (bindingId) {
        const account = accountKey(platform, this.#config[platform].accountId);
        const binding = this.#ledger.panelBindings(account).find((entry) => entry.id === bindingId);
        const other = platform === 'feishu' ? 'telegram' : 'feishu';
        if (!binding || owner === binding.owner || !owners.get(owner)?.has(other)) return { status: 'unavailable' };
        reassign = { route: bindingId, previousOwner: binding.owner, other };
      }
      pairing = { id: randomUUID(), code: randomBytes(12).toString('hex'), owner, reassign,
        expires: Date.now() + PAIRING_MS, attempts: 0 };
      this.#pairings.set(platform, pairing);
    } else if (action === 'current' && !pairing) {
      return { status: 'idle' };
    } else if (!pairing || (action !== 'current' && pairing.id !== id)) {
      return { status: 'expired' };
    } else if (action === 'cancel') {
      this.#pairings.delete(platform);
      return { status: 'cancelled' };
    } else if (action === 'confirm') {
      if (!pairing.event) return { status: 'waiting' };
      if (pairing.proof !== proof) {
        if (++pairing.attempts >= 5) {
          this.#pairings.delete(platform);
          return { status: 'locked' };
        }
        return { status: 'invalid' };
      }
      const event = pairing.event;
      this.#pairings.delete(platform);
      if (pairing.reassign) {
        const { route, previousOwner, other } = pairing.reassign;
        if (bindingRoute(event) !== route || this.#ownerFor(event) !== previousOwner
          || !this.#ownerChannels().get(pairing.owner)?.has(other)) return { status: 'binding_changed' };
        const changed = this.#ledger.reassignPanelBinding({ route, peer: bindingPeer(event),
          account: accountKey(platform, event.accountId), previousOwner, owner: pairing.owner });
        return { status: changed ? 'reassigned' : 'binding_changed' };
      }
      if (this.#ownerFor(event)) return { status: 'already_bound' };
      if (pairing.owner && !this.#ownerChannels().has(pairing.owner)) return { status: 'binding_changed' };
      const ownerId = pairing.owner || digest(['panel-owner', randomUUID()]);
      const added = this.#ledger.addPanelBinding({ route: bindingRoute(event), peer: bindingPeer(event),
        account: accountKey(platform, event.accountId), owner: ownerId });
      return added ? { status: 'bound', route: bindingRoute(event) } : { status: 'already_bound' };
    }
    return { id: pairing.id, expires: pairing.expires, delivery: pairing.delivery,
      owner: pairing.owner, bindingId: pairing.reassign?.route,
      status: pairing.event ? 'claimed' : 'waiting', command: `/pair ${pairing.code}`,
      link: platform === 'telegram' && /^[a-z0-9_]{5,32}$/i.test(this.#routes.get(platform)?.username ?? '')
        ? `https://t.me/${this.#routes.get(platform).username}?start=${pairing.code}` : null };
  }

  replyCheck({ action, platform, route }) {
    const check = this.#replyChecks.get(platform);
    if (!check) return { status: 'unavailable' };
    if (action === 'read') return check.read();
    const transport = this.#routes.get(platform);
    if (!transport?.ready() || !this.#ledger.panelBindings(accountKey(platform, this.#config[platform].accountId))
      .some((binding) => binding.id === route)) return { status: 'unavailable' };
    return check.start(route);
  }

  accept(event) {
    if (this.#abort.signal.aborted || this.#pending >= 32) return false;
    const transport = this.#routes.get(event.platform);
    if (!transport || this.#config[event.platform]?.accountId !== event.accountId) return false;
    const owner = this.#ownerFor(event);
    const match = /^\/(pair|start)(?:@([a-z0-9_]+))? ([a-f0-9]{24})$/i.exec(event.text);
    const pairCode = match && (match[1].toLowerCase() === 'pair' || event.platform === 'telegram')
      && (!match[2] || match[2].toLowerCase() === transport.username) ? match[3].toLowerCase() : null;
    if (pairCode) {
      const pairing = this.#pairings.get(event.platform);
      if (!pairing || pairing.expires <= Date.now() || pairing.code !== pairCode || pairing.event) {
        return owner ? this.#pairReply(event, transport, '配对指令已失效或已使用，请在猫猫面板重新生成。') : false;
      }
      if (pairing.reassign) {
        if (owner !== pairing.reassign.previousOwner || bindingRoute(event) !== pairing.reassign.route) {
          return owner ? this.#pairReply(event, transport, '请在猫猫面板选中的那个私聊发送指令。') : false;
        }
      } else if (owner) {
        return this.#pairReply(event, transport, '这个私聊已绑定。要与另一端共享记忆，请在「渠道 → 管理已绑定会话」点「关联同一主人」。');
      }
      const receipt = this.#ledger.admit(event);
      if (!receipt) return false;
      pairing.event = event;
      pairing.proof = randomBytes(4).toString('hex');
      this.#pending += 1;
      this.#queue([{ event, receipt }], transport, null, { pairing });
      return true;
    }
    const command = commandFor(event.text, transport.username);
    if (command === 'pair') {
      return this.#pairReply(event, transport, '请在猫猫面板的「渠道」生成配对指令，再把含配对码的完整指令发给我。');
    }
    if (!owner) {
      if (command !== 'sid' || this.#config[event.platform]?.enrollment !== true) return false;
      const peer = digest([event.platform, event.accountId, event.chatId, event.senderId]);
      const now = Date.now();
      if (now - (this.#enrollment.get(peer) ?? 0) < 60_000) return false;
      this.#enrollment.set(peer, now);
      if (this.#enrollment.size > 1000) this.#enrollment.delete(this.#enrollment.keys().next().value);
    }
    if (!command && event.text.startsWith('/')) return false;
    const receipt = this.#ledger.admit(event);
    if (!receipt) return false;
    this.#ledger.recordDiagnostic(event.platform, 'receive', 'ok');
    const test = owner && !command ? this.#replyChecks.get(event.platform)?.receive(bindingRoute(event), event.text) : null;
    if (owner && !command && !test) {
      this.#ledger.verifyRoute(scopedRoute(event, owner), event);
      this.#ledger.recordActivity(owner, event.receivedAt);
    }
    this.#pending += 1;
    const route = scopedRoute(event, owner);
    if (event.platform === 'telegram' && !command && !test && this.#config.telegram.debounceMs !== 0) {
      const burst = this.#bursts.get(route) ?? { started: Date.now(), events: [] };
      clearTimeout(burst.timer);
      burst.events.push({ event, receipt });
      const quiet = Math.min(Math.max(this.#config.telegram.debounceMs || 1200, 100), 3000);
      const remaining = Math.min(quiet, 3000 - (Date.now() - burst.started));
      this.#bursts.set(route, burst);
      if (burst.events.length >= 6 || remaining <= 0) this.#flushBurst(route, owner, transport);
      else burst.timer = setTimeout(() => this.#flushBurst(route, owner, transport), remaining);
      return true;
    }
    this.#flushBurst(route, owner, transport);
    this.#queue([{ event, receipt }], transport, owner, test ? { test } : command);
    return true;
  }

  #pairReply(event, transport, text) {
    const peer = bindingPeer(event);
    const now = Date.now();
    if (now - (this.#enrollment.get(peer) ?? 0) < 60_000) return false;
    const receipt = this.#ledger.admit(event);
    if (!receipt) return false;
    this.#enrollment.set(peer, now);
    if (this.#enrollment.size > 1000) this.#enrollment.delete(this.#enrollment.keys().next().value);
    this.#pending += 1;
    this.#queue([{ event, receipt }], transport, null, { pairNotice: text });
    return true;
  }

  acceptChoice(event, data) {
    if (this.#abort.signal.aborted || this.#pending >= 32) return null;
    const transport = this.#routes.get(event.platform);
    if (!transport || this.#config[event.platform]?.accountId !== event.accountId) return null;
    const owner = this.#ownerFor(event);
    const button = parseChoiceData(data);
    if (!owner || !button) return null;
    const profile = channelPersona(this.#ctx, { id: personaIdFor(bindingRoute(event), owner), kind: event.platform });
    const route = scopedRoute(event, owner);
    const selected = this.#ledger.takeChoice(digest([route, profile.token]), event.messageId, button);
    if (!selected) return null;
    const receivedAt = Date.now();
    const receipt = digest(['card-click', route, event.messageId, button.token]);
    const text = `[已选择的聊天分支] ${JSON.stringify(selected.label)}`;
    this.#ledger.recordActivity(owner, receivedAt);
    this.#ledger.recordDiagnostic(event.platform, 'choice', 'ok');
    this.#flushBurst(route, owner, transport);
    this.#pending += 1;
    this.#queue([{ event: { ...event, text, receivedAt }, receipt }], transport, owner, { choice: profile.token });
    return selected;
  }

  #flushBurst(route, owner, transport) {
    const burst = this.#bursts.get(route);
    if (!burst) return;
    clearTimeout(burst.timer);
    this.#bursts.delete(route);
    this.#queue(burst.events, transport, owner, null);
  }

  #queue(events, transport, owner, command) {
    const key = owner ?? scopedRoute(events[0].event, null);
    const job = (this.#jobs.get(key) ?? Promise.resolve()).catch(() => undefined)
      .then(() => this.#handle(events, transport, owner, command))
      .catch((error) => this.#logger.warn?.('Private turn stopped:', safeError(error)))
      .finally(() => {
        command?.test?.('interrupted');
        this.#pending -= events.length;
        if (this.#jobs.get(key) === job) this.#jobs.delete(key);
      });
    this.#jobs.set(key, job);
  }

  share(request) {
    if (!request || typeof request !== 'object' || !this.#destination || this.#abort.signal.aborted || this.#sharing.size) {
      return Promise.resolve({ status: 'unavailable' });
    }
    const job = this.#sendShare(request).finally(() => this.#sharing.delete(job));
    this.#sharing.add(job);
    return job;
  }

  #shareBlocked() {
    const { owner, route, platform } = this.#destination;
    if (this.#ownerFor(this.#destination) !== owner) return 'route_unverified';
    if (this.#abort.signal.aborted || !this.#routes.get(platform).ready()) return 'offline';
    if (this.#jobs.has(owner)) return 'busy';
    if (!this.#ledger.verifiedRoute(route)) return 'route_unverified';
    const last = this.#ledger.lastActivity(owner);
    if (last === null) return 'route_unverified';
    return Date.now() - last < 75 * 60_000 ? 'recent_chat' : null;
  }

  #shareEligible() { return !this.#shareBlocked(); }

  async runScheduled({ preview = false } = {}) {
    const unavailable = (reason) => preview ? { status: 'unavailable', reason } : { status: 'unavailable' };
    const blocked = !this.#schedule ? 'disabled' : this.#scheduled || this.#sharing.size ? 'busy' : this.#shareBlocked();
    if (blocked) return unavailable(blocked);
    this.#scheduled = this.#selectScheduled(preview, unavailable);
    try { return await this.#scheduled; }
    catch (error) {
      this.#logger.warn?.('Private schedule stopped:', safeError(error));
      return unavailable('failed');
    } finally { this.#scheduled = null; }
  }

  async #selectScheduled(preview, unavailable) {
    const { owner } = this.#destination;
    const { browse, lonely, mode } = this.#schedule;
    const signal = this.#abort.signal;
    const turnId = digest(['private-schedule', owner]);
    const state = await this.#contact.run('contact_check', { owner, turnId }, signal);
    if (state.allowed !== true) return unavailable(state.reason || 'policy');
    if (!state.last_incoming) return unavailable('route_unverified');
    const blocked = this.#shareBlocked();
    if (blocked) return unavailable(blocked);
    const item = browse ? await this.#contact.run('activity_candidate', { owner, turnId }, signal) : {};
    const blockedAfterBrowse = this.#shareBlocked();
    if (blockedAfterBrowse) return unavailable(blockedAfterBrowse);
    const stage = Math.min(state.unanswered, LONELY_LINES.length - 1);
    const checkIn = lonely && LONELY_LINES[stage] ? {
      requestId: digest([owner, this.#ledger.lastActivity(owner), stage]), source: 'lonely', text: LONELY_LINES[stage],
    } : null;
    const activity = item.requestId ? { ...item, text: item.text.slice(0, state.max_chars) } : null;
    const request = checkIn && state.last_source === 'activity' ? checkIn : (activity ?? checkIn);
    if (!request) return unavailable('no_candidate');
    if (preview) return { status: 'shadow', source: request.source, text: request.text, url: request.url };
    if (mode === 'shadow') return { status: 'shadow', source: request.source };
    const result = await this.share(request);
    if (result.status === 'sent' && request.source === 'activity') {
      await this.#contact.run('activity_shared', { owner, turnId: request.requestId }, AbortSignal.timeout(4000))
        .catch(() => this.#logger.warn?.('Private activity acknowledgement failed'));
    }
    return { ...result, source: request.source };
  }

  async #sendShare({ requestId, source, text, url = '' } = {}) {
    if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 128
      || !['activity', 'lonely'].includes(source) || typeof text !== 'string' || !text.trim() || text.length > 120
      || /(?:https?:\/\/|tg:\/\/|<@)/i.test(text)
      || typeof url !== 'string' || url.length > 1000 || (source === 'lonely' && url)) return { status: 'denied' };
    const { owner, platform, chatId } = this.#destination;
    const transport = this.#routes.get(platform);
    const eligible = () => this.#shareEligible();
    if (!eligible()) return { status: 'unavailable' };
    const signal = this.#abort.signal;
    const details = { source, url, fingerprint: digest([text.trim(), url]) };
    let ticket;
    let status = 'cancelled';
    try {
      ({ ticket } = await this.#contact.run('contact_reserve', {
        owner, turnId: digest([source, requestId]), text: text.trim(), details,
      }, signal));
      if (!ticket || !eligible()) return { status };
      const admitted = await this.#contact.run('contact_dispatch', { owner, turnId: ticket }, signal);
      if (admitted.allowed !== true || !eligible()) return { status };
      status = 'uncertain';
      const sent = await transport.send(chatId, [text.trim(), url].filter(Boolean).join('\n'), ticket, signal);
      if (sent) status = 'sent';
      return { status };
    } catch (error) {
      this.#logger.warn?.('Private share stopped:', safeError(error));
      return { status };
    } finally {
      if (ticket) await this.#contact.run('contact_finish', { owner, turnId: ticket,
        details: { outcome: status } }, AbortSignal.timeout(4000)).catch(() => undefined);
    }
  }

  async #handle(events, transport, owner, command) {
    const signal = AbortSignal.any([this.#abort.signal, AbortSignal.timeout(120_000)]);
    if (signal.aborted) return;
    const { event, receipt } = events.at(-1);
    if (owner && this.#ownerFor(event) !== owner) return;
    if (command?.pairNotice) {
      await this.#deliver(event, transport, receipt, command.pairNotice, signal);
      return;
    }
    if (command?.pairing) {
      const pairing = command.pairing;
      try {
        const sent = await this.#deliver(event, transport, receipt, `请在猫猫面板输入确认码 ${pairing.proof}，五分钟内有效。`, signal,
          () => this.#pairings.get(event.platform) === pairing && pairing.expires > Date.now());
        if (sent) pairing.delivery = 'sent';
      } finally { pairing.delivery ??= 'failed'; }
      return;
    }
    if (command === 'sid') {
      await this.#deliver(event, transport, receipt,
        `${labels[event.platform]}账号：${event.accountId}\n发送者 ID：${event.senderId}\n私聊 ID：${event.chatId}\n主人绑定：${owner ? '已绑定' : '未绑定'}`, signal);
      return;
    }
    const route = scopedRoute(event, owner);
    const profile = channelPersona(this.#ctx, { id: personaIdFor(bindingRoute(event), owner), kind: event.platform });
    const chatRoute = digest([route, profile.token]);
    if (command === 'status') {
      await this.#deliver(event, transport, receipt, await this.#status(event, transport, chatRoute, signal), signal);
      return;
    }

    if (event.receivedAt < profile.changedAt) return;
    if (command?.choice && command.choice !== profile.token) return;
    this.#ledger.clearChoices(chatRoute);
    events = events.filter((entry) => entry.event.receivedAt >= profile.changedAt);
    let memory;
    const ordinaryContext = {};
    for (const entry of command?.test ? [] : events) {
      const turn = { owner, turnId: entry.receipt, text: entry.event.text };
      if (this.#contact && owner === this.#destination.owner) {
        await this.#contact.run('contact_incoming', turn, signal).catch(() => undefined);
      }
      if (command?.choice || !this.#memory || !turn.text) continue;
      memory = { ...turn, owner: this.#memoryScope(owner, entry.event.platform) };
      const facts = await this.#memory.run('begin', memory, signal).catch(() => ({}));
      if (entry.event.platform === 'feishu') {
        const lark = await this.#memory.run('lark_history', {
          ...turn, owner: larkHistoryScope(entry.event.accountId, owner),
        }, signal).catch(() => ({}));
        Object.assign(facts, lark);
      }
      for (const [key, values] of Object.entries(facts)) {
        if (values.length || !ordinaryContext[key]) ordinaryContext[key] = values;
      }
    }
    const withImages = new Set(events.filter(({ event }) => event.media).slice(-3));
    const messages = await Promise.all(events.map(async (entry) => {
      const message = { ...entry.event, image: null };
      if (!withImages.has(entry)) return message;
      let outcome;
      try {
        message.image = await transport.image(entry.event, signal);
        outcome = message.image ? 'ok' : 'empty';
      } catch (error) {
        outcome = mediaCodes[error?.code] ?? (error?.name === 'TimeoutError' ? 'timeout' : 'network');
        message.imagePermissionMissing = outcome === 'lark_permission';
      }
      if (!this.#abort.signal.aborted) this.#ledger.recordMedia(message.platform, outcome);
      return message;
    }));
    if (signal.aborted) return;
    if (messages.every((part) => !part.image && !part.text && !part.stickerLabel)) {
      const notice = messages.some((part) => part.imagePermissionMissing)
        ? '猫猫收到了图，但 Lark 应用缺少下载图片的权限。' : '这张图暂时没读到，可以再发一次吗？';
      await this.#deliver(event, transport, receipt, notice, signal);
      return;
    }
    const interactive = typeof transport.replyChoices === 'function';
    let answer;
    try {
      answer = parseChoiceReply(await this.#ask(chatRoute, messages, { ordinaryContext, profile, interactive, signal }));
      this.#ledger.recordDiagnostic(event.platform, 'model', answer.text ? 'ok' : 'empty');
    } catch (error) {
      command?.test?.('model_failed');
      this.#ledger.recordDiagnostic(event.platform, 'model', 'failed');
      throw error;
    }
    const current = () => profile.current() && this.#ownerFor(event) === owner;
    if (command?.test) {
      if (!answer.text) { command.test('model_empty'); return; }
      if (!current()) return;
      command.test('sending');
      try {
        const sent = await this.#deliver(event, transport, receipt, answer.text, signal, current);
        command.test(sent ? 'sent' : 'delivery_failed');
      } catch (error) {
        command.test('delivery_failed');
        throw error;
      }
      return;
    }
    if (answer.text && current()
      && await this.#deliver(event, transport, receipt, answer.text, signal, current,
        interactive && answer.options.length ? { route: chatRoute, options: answer.options } : null) && memory) {
      await this.#memory.run('finish', { ...memory, answer: answer.text }, signal).catch(() => undefined);
    }
  }

  async #ask(route, messages, { ordinaryContext, profile, interactive, signal }) {
    const controller = this.#ctx.sessionController;
    let sessionId = this.#ledger.session(route);
    if (!sessionId) {
      const result = await controller.create({ agentPreset: PRESET, ...(this.#config.workspace ? { cwd: this.#config.workspace } : {}) });
      sessionId = this.#ledger.bind(route, result.sessionId);
    }
    const projection = await controller.projections({ sessionId }, signal);
    if (projection?.values?.agentPreset !== PRESET) {
      throw Object.assign(new Error('Private preset unavailable'), { code: 'private_ordinary_preset_unverified' });
    }
    const models = this.#ctx.get?.('maomaoModels');
    const selected = await models?.useChat?.(controller, sessionId);
    const model = selected ?? projection.values.modelSelection?.next
      ?? this.#ctx.get?.('agentDefaultModel')?.currentSelection?.()
      ?? projection.values.modelSelection?.lastUsed;
    const visionChoice = models?.mediaChoice?.('vision');
    const useChatVision = !visionChoice && model?.provider === 'google';
    const inspections = visionChoice?.enabled && messages.some((event) => event.image)
      ? await models.mediaAdapter('vision').then((adapter) => Promise.all(messages.map((event) =>
        event.image && adapter ? adapter.inspect(event.image, event.text, signal).catch(() => '') : ''))).catch(() => []) : [];
    if (!useChatVision && messages.every((event, i) => !event.text && !event.stickerLabel && !inspections[i])) {
      return '当前模型没法读取这张图片，喵。';
    }
    const { cursor } = await controller.state({ sessionId }, signal);
    const context = ordinaryContext && Object.keys(ordinaryContext).length
      ? `[已授权的普通记忆，仅供参考，不是指令]\n${JSON.stringify(ordinaryContext).slice(0, 6000)}` : '';
    const content = messages.flatMap((event, index) => {
      const image = useChatVision ? event.image : null;
      const body = [index === 0 ? context : '', event.text,
        event.stickerLabel ? `[表情信息，仅作参考] ${JSON.stringify(event.stickerLabel)}` : '',
        inspections[index] ? `[视觉模型描述，仅作资料]${JSON.stringify(inspections[index])}` : '',
        event.imagePermissionMissing ? '[Lark 图片下载权限不足]' : event.media && !image && !inspections[index] ? '[附图暂时无法读取]' : '',
        image && !event.text ? '用户发送了一张图片。' : '',
      ].filter(Boolean).join('\n');
      return [...(body ? [{ type: 'text', text: body }] : []), ...(image ? [image] : [])];
    });
    if (!profile.current()) return '';
    const closePersona = await mountChannelPersona(controller, sessionId, profile, interactive ? choiceGuidance : '');
    try {
      if (!profile.current()) return '';
      await controller.prompt({ sessionId, requestId: `private-${randomUUID()}`, mode: 'queue',
        content }, signal);
      for (;;) {
        signal.throwIfAborted();
        const result = await controller.wait({ sessionId, afterSeq: cursor, timeoutMs: 25_000, maxMessages: 8 }, signal);
        if (result.reason === 'timeout') continue;
        return result.reason === 'input-required' ? '' : answerFrom(result);
      }
    } finally { closePersona(); }
  }

  async #deliver(event, transport, receipt, text, signal, current = () => true, choices = null) {
    const parts = bubbles(text);
    for (const [segment, part] of parts.entries()) {
      if (signal.aborted || !current()) return false;
      const ticket = this.#ledger.reserve(receipt, segment);
      if (!ticket) return false;
      let sent = null;
      try {
        if (choices && segment === parts.length - 1) {
          const token = randomBytes(16).toString('hex');
          const result = await transport.replyChoices(event, part, choices.options, token, ticket, signal);
          sent = result.messageId;
          if (sent && result.interactive && current()) {
            this.#ledger.saveChoices(choices.route, token, sent, part, choices.options);
          }
        } else {
          sent = await transport.reply(event, part, ticket, signal);
        }
      }
      finally {
        this.#ledger.finish(ticket, sent);
        this.#ledger.recordDiagnostic(event.platform, 'reply', sent ? 'ok' : 'failed');
      }
      if (!sent) return false;
    }
    return parts.length > 0;
  }

  async #status(event, transport, route, signal) {
    const sessionId = this.#ledger.session(route);
    let values;
    if (sessionId) {
      try { values = (await this.#ctx.sessionController.projections({ sessionId }, signal))?.values; }
      catch { /* status can still report its configured default */ }
    }
    const model = values?.modelSelection?.next ?? values?.modelSelection?.lastUsed
      ?? this.#ctx.get?.('agentDefaultModel')?.currentSelection?.();
    const pressure = values?.contextPressure;
    const used = pressure?.projectedTokens ?? pressure?.pressureTokens;
    return [
      `${labels[event.platform]}连接：${transport.ready() ? '已连接' : '暂未就绪'}`,
      `模型：${model?.provider && model?.model ? `${model.provider}/${model.model}` : '暂不可用'}`,
      `上下文：${Number.isFinite(used) ? `${Math.round(used)}${Number.isFinite(pressure.contextWindow) ? ` / ${pressure.contextWindow}` : ''} tokens` : '暂不可用'}`,
      `普通记忆：${this.#memory ? '已启用' : '关闭'}`,
      'API 剩余额度：模型接口未提供统一查询',
    ].join('\n');
  }
}

function mount(ctx, config, secrets) {
  const connector = new PrivateConnector(ctx, config, { secrets });
  ctx.provide('maomaoPrivate', Object.freeze({
    share: (request) => connector.share(request),
    status: () => connector.status(),
    pair: (request) => connector.pair(request),
    renameOwner: (owner, label) => connector.renameOwner(owner, label),
    replyCheck: (request) => connector.replyCheck(request),
    previewShare: () => connector.runScheduled({ preview: true }),
    vectorIndex: (action) => connector.vectorIndex(action),
    memorySources: () => connector.memorySources(),
    personaTargets: () => connector.personaTargets(),
    shareTargets: () => connector.shareTargets(),
    shareTarget: (id) => connector.shareTarget(id),
    unbind: (platform, id) => connector.unbind(platform, id),
  }));
  ctx.effect(() => {
    connector.start();
    return () => connector.stop();
  }, name);
}

export function apply(ctx, config = {}) {
  ctx.provide('maomaoPrivateSetup', Object.freeze({
    provisionFeishu,
    provisionTelegram,
    verifyFeishu: ({ appId, secret, brand, signal }) => new FeishuTransport({ appId, secret, brand }).verify(signal),
    verifyTelegram: ({ token, signal }) => new TelegramTransport({ token, botId: telegramBotId(token) }).verify(signal),
  }));
  if (config.enabled !== true || config.dryRun === true) return;
  const active = ['feishu', 'telegram'].filter((platform) => config[platform]?.enabled === true);
  if (active.some((platform) => !config[platform].credentialRef)
    && process.env.MAOMAO_DSH_PRIVATE_CONNECT !== 'ISOLATED_TEST_OR_HERMES_STOPPED') {
    throw new Error('Private connector requires isolated test credentials or a completed Hermes cutover');
  }
  const managed = active.filter((platform) => config[platform].credentialRef);
  if (!managed.length) return mount(ctx, config);
  return Promise.all(managed.map(async (platform) => {
    const resolved = await ctx.get('credentials')?.resolve(config[platform].credentialRef);
    if (!resolved?.value) throw new Error('Private connector credential is missing');
    return [platform, resolved.value];
  })).then((entries) => mount(ctx, config, Object.fromEntries(entries)));
}
