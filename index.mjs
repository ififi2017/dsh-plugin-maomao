import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { ChannelSetup } from './channel-setup.mjs';
import { manageChatModel } from './model-config.mjs';
import { manageMediaModel } from './model-media.mjs';
import { manageMemorySettings } from './memory-settings.mjs';
import { manageStickers } from './integrations/maomao-dsh/sticker-library.mjs';
import { LearningRuntime } from './integrations/maomao-dsh/learning.mjs';
import { PublicBrowser } from './integrations/maomao-dsh/browser-runtime.mjs';
import { manageWeb } from './web-settings.mjs';
import { ChannelPersonas } from './integrations/maomao-dsh/personas.mjs';
import { DebugLog, LEVELS, installLog } from './integrations/maomao-dsh/debug-log.mjs';

const channelStates = new Set(['ready', 'waiting', 'off']);
const sharedMemoryStates = new Set(['off', 'active', 'waiting_channels', 'waiting_owner']);
const shareModes = new Set(['off', 'manual', 'shadow', 'send']);
const shareResults = new Set(['unavailable', 'shadow', 'denied', 'cancelled', 'uncertain', 'sent']);
const previewReasons = new Set(['disabled', 'busy', 'offline', 'route_unverified', 'recent_chat', 'policy',
  'failed', 'goodnight', 'dnd', 'future_activity', 'pending', 'daily_limit', 'waiting_for_reply', 'cooldown', 'no_candidate']);
const mediaOutcomes = new Set(['ok', 'lark_permission', 'permission', 'missing', 'rate_limit', 'http',
  'size', 'format', 'empty', 'network', 'timeout', 'unsafe_source']);
const diagnosticOutcomes = new Set(['ok', 'empty', 'failed']);
const initializers = [];

function requireOwner(ctx) {
  if (ctx.invocation?.peer.principal?.kind !== 'owner') {
    throw new RemoteError('remote-access/denied', 'The Maomao panel is available to the Harness owner.', {});
  }
}

function mediaCheck(check) {
  return Number.isFinite(check?.at) && mediaOutcomes.has(check.outcome) ? { at: check.at, outcome: check.outcome } : null;
}

function diagnostics(checks) {
  return Object.fromEntries(['receive', 'reply', 'model'].map((kind) => {
    const check = checks?.[kind];
    return [kind, Number.isFinite(check?.at) && diagnosticOutcomes.has(check.outcome)
      ? { at: check.at, outcome: check.outcome } : null];
  }));
}

class MaomaoPanel extends TypertRemoteService {
  constructor(ctx, setup) {
    super(ctx, 'maomaoPanel');
    this.setup = setup;
    for (const initialize of initializers) initialize.call(this);
  }

  status() {
    requireOwner(this.ctx);
    const privateStatus = this.ctx.get('maomaoPrivate')?.status?.();
    const qq = this.ctx.get('maomaoQq')?.status?.();
    const model = this.ctx.get('agentDefaultModel')?.currentSelection?.();
    const share = privateStatus?.sharing;
    const last = share?.last;
    return {
      channels: {
        feishu: channelStates.has(privateStatus?.channels?.feishu) ? privateStatus.channels.feishu : 'off',
        telegram: channelStates.has(privateStatus?.channels?.telegram) ? privateStatus.channels.telegram : 'off',
        qq: qq?.ready ? 'ready' : (qq?.running ? 'waiting' : 'off'),
      },
      channelSetup: this.setup.status(),
      qqDirectMessages: qq?.directMessages ?? { acceptStrangers: false, lastInbound: null },
      qqPeerGroups: this.ctx.get('maomaoQq')?.peerGroups?.() ?? [],
      bindings: {
        private: privateStatus?.owners ?? [],
        qq: Number.isSafeInteger(qq?.panelRoutes) ? qq.panelRoutes : 0,
        managed: [...(privateStatus?.panelBindings ?? []), ...(qq?.panelBindings ?? []).map((route) => ({ ...route, platform: 'qq' }))],
      },
      media: {
        feishu: mediaCheck(privateStatus?.media?.feishu),
        telegram: mediaCheck(privateStatus?.media?.telegram),
        qq: mediaCheck(qq?.media),
      },
      diagnostics: {
        feishu: diagnostics(privateStatus?.diagnostics?.feishu),
        telegram: diagnostics(privateStatus?.diagnostics?.telegram),
        qq: diagnostics(qq?.diagnostics),
      },
      // The last time QQ refused a Markdown or button message, so the panel can show the code.
      formats: { qq: Number.isFinite(qq?.diagnostics?.format?.at) ? { at: qq.diagnostics.format.at,
        code: Number.isSafeInteger(qq.diagnostics.format.code) ? qq.diagnostics.format.code : null, keyboard: qq.diagnostics.format.keyboard === true } : null },
      memory: {
        private: privateStatus?.memory === true,
        shared: privateStatus?.sharedMemory === true,
        sharedState: sharedMemoryStates.has(privateStatus?.sharedMemoryState) ? privateStatus.sharedMemoryState : 'off',
        embedding: privateStatus?.embedding === true,
        qq: qq?.ordinary?.enabled === true,
      },
      sharing: {
        mode: shareModes.has(share?.mode) ? share.mode : 'off',
        destination: ['feishu', 'telegram'].includes(share?.destination) ? share.destination : null,
        browse: share?.browse === true,
        lonely: share?.lonely === true,
        last: Number.isFinite(last?.at) && shareResults.has(last.status) ? { at: last.at, status: last.status } : null,
      },
      model: typeof model?.provider === 'string' && typeof model?.model === 'string'
        ? { provider: model.provider.slice(0, 100), model: model.model.slice(0, 120) } : null,
    };
  }

  webSettings(request, signal) {
    requireOwner(this.ctx);
    return manageWeb(this.ctx, request, signal);
  }

  channelSetup(request) {
    requireOwner(this.ctx);
    return this.setup.request(request);
  }

  qqDirectMessageSettings(request) {
    requireOwner(this.ctx);
    return this.ctx.get('maomaoQq')?.saveDirectMessageSettings?.(request ?? {}) ?? { status: 'unavailable' };
  }

  qqPeerSettings(request) {
    requireOwner(this.ctx);
    return this.ctx.get('maomaoQq')?.savePeerGroup?.(request ?? {}) ?? { status: 'unavailable' };
  }

  chatModel(request, signal) {
    requireOwner(this.ctx);
    return manageChatModel(this.ctx, request, signal);
  }

  mediaModel(request, signal) {
    requireOwner(this.ctx);
    return manageMediaModel(this.ctx, request, signal);
  }

  embeddingIndex(request) {
    requireOwner(this.ctx);
    const { action } = request ?? {};
    if (!['start', 'read', 'cancel'].includes(action)) return { status: 'invalid' };
    return this.ctx.get('maomaoPrivate')?.vectorIndex?.(action) ?? { status: 'disabled' };
  }

  memorySettings(request, signal) {
    requireOwner(this.ctx);
    return manageMemorySettings(this.ctx, request, signal);
  }

  privateGroups(request) {
    requireOwner(this.ctx);
    return this.ctx.get('maomaoPrivate')?.groups?.(request) ?? { status: 'ok', enabled: false, groups: [] };
  }

  // 诊断 → API 报错 / 终端. Owner-only, local data.
  diagnosticLogs(request) {
    requireOwner(this.ctx);
    const debug = this.ctx.get('maomaoLog');
    if (!debug) return { status: 'unavailable' };
    const { action, after = 0, level = 'trace', source = '', query = '' } = request ?? {};
    if (action === 'read') {
      if (!Number.isSafeInteger(after) || !LEVELS.includes(level) || typeof source !== 'string' || typeof query !== 'string' || query.length > 100) return { status: 'invalid' };
      return { status: 'ok', level: debug.level, startedAt: debug.startedAt, sources: debug.sources(), rows: debug.read({ after, level, source, query }) };
    }
    if (action === 'api') return { status: 'ok', rows: debug.apiErrors({ source: typeof source === 'string' ? source : '' }) };
    if (action === 'level') return { status: debug.setLevel(request.level) ? 'saved' : 'invalid', level: debug.level };
    if (action === 'clear_api') { debug.clearApiErrors(); return { status: 'saved' }; }
    return { status: 'invalid' };
  }

  stickers(request) {
    requireOwner(this.ctx);
    try { return manageStickers(request); } catch { return { status: 'failed' }; }
  }

  learning(request) {
    requireOwner(this.ctx);
    return this.ctx.get('maomaoLearning')?.panel(request) ?? { status: 'unavailable' };
  }

  personas(request) {
    requireOwner(this.ctx);
    const targets = ['maomaoQq', 'maomaoPrivate'].flatMap(
      (service) => this.ctx.get(service)?.personaTargets?.() ?? [],
    );
    return this.ctx.get('maomaoPersonas').manage(request, targets);
  }

  async pair(request) {
    requireOwner(this.ctx);
    const { platform, action, id, proof, owner, scope, bindingId } = request ?? {};
    if (!['feishu', 'telegram', 'qq'].includes(platform) || !['start', 'current', 'read', 'confirm', 'cancel'].includes(action)
      || (['read', 'confirm', 'cancel'].includes(action) && (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)))
      || (action === 'confirm' && (typeof proof !== 'string' || !/^[a-f0-9]{8}$/.test(proof)))
      || (owner && ((platform === 'qq' && scope !== 'c2c') || typeof owner !== 'string' || !/^[a-f0-9]{64}$/.test(owner)))
      || (bindingId && (action !== 'start' || platform === 'qq' || !owner
        || typeof bindingId !== 'string' || !/^[a-f0-9]{64}$/.test(bindingId)))
      || (platform === 'qq' && action === 'start' && !['group', 'c2c', 'owner'].includes(scope))) return { status: 'invalid' };
    const connector = this.ctx.get(platform === 'qq' ? 'maomaoQq' : 'maomaoPrivate');
    return await connector?.pair?.({ platform, action, id, proof, owner, scope, bindingId }) ?? { status: 'unavailable' };
  }

  replyCheck(request) {
    requireOwner(this.ctx);
    const { platform, action, route } = request ?? {};
    if (!['feishu', 'telegram', 'qq'].includes(platform) || !['start', 'read'].includes(action)
      || (action === 'start' && (typeof route !== 'string' || !/^[a-f0-9]{64}$/.test(route)))) {
      return { status: 'unavailable' };
    }
    const connector = this.ctx.get(platform === 'qq' ? 'maomaoQq' : 'maomaoPrivate');
    return connector?.replyCheck?.({ platform, action, route }) ?? { status: 'unavailable' };
  }

  renameOwner(request) {
    requireOwner(this.ctx);
    const { owner, label } = request ?? {};
    if (typeof owner !== 'string' || !/^[a-f0-9]{64}$/.test(owner)) return { status: 'invalid' };
    return this.ctx.get('maomaoPrivate')?.renameOwner?.(owner, label) ?? { status: 'unavailable' };
  }

  async unbind(request) {
    requireOwner(this.ctx);
    const { platform, id } = request ?? {};
    if (!['feishu', 'telegram', 'qq'].includes(platform) || typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) {
      return { status: 'invalid' };
    }
    const removed = platform === 'qq' ? await this.ctx.get('maomaoQq')?.unbind?.(id)
      : await this.ctx.get('maomaoPrivate')?.unbind?.(platform, id);
    return { status: removed ? 'unbound' : 'unavailable' };
  }

  async previewShare() {
    requireOwner(this.ctx);
    const result = await this.ctx.get('maomaoPrivate')?.previewShare?.();
    if (result?.status === 'shadow' && ['activity', 'lonely'].includes(result.source)) {
      return { status: 'shadow', source: result.source,
        text: typeof result.text === 'string' ? result.text.slice(0, 320) : '',
        url: typeof result.url === 'string' && result.url.startsWith('https://') ? result.url.slice(0, 1024) : null };
    }
    return { status: 'unavailable', reason: previewReasons.has(result?.reason) ? result.reason : 'disabled' };
  }
}

// Register the JavaScript method with Typert's source-mode discovery.
for (const name of ['status', 'pair', 'replyCheck', 'renameOwner', 'unbind', 'previewShare', 'channelSetup', 'qqDirectMessageSettings', 'qqPeerSettings', 'chatModel', 'mediaModel', 'embeddingIndex', 'memorySettings', 'privateGroups', 'stickers', 'diagnosticLogs', 'learning', 'personas', 'webSettings']) {
  Remote(MaomaoPanel.prototype[name], { name, addInitializer: (fn) => initializers.push(fn) });
}

export function apply(ctx, config = {}) {
  // Diagnostics log first, so every service started below can write to it.
  const debug = installLog(new DebugLog());
  ctx.provide('maomaoLog', debug);
  ctx.effect(() => () => debug.close());
  debug.write('info', 'plugin', '猫猫插件启动', { level: debug.level });
  const learning = new LearningRuntime(ctx);
  ctx.provide('maomaoLearning', learning);
  ctx.effect(() => () => learning.close());
  const browser = new PublicBrowser({ enabled: config.browser?.enabled !== false });
  ctx.provide('maomaoBrowser', browser);
  ctx.effect(() => () => browser.close());
  const setup = new ChannelSetup(ctx);
  const personas = new ChannelPersonas();
  ctx.provide('maomaoPersonas', personas);
  ctx.effect(() => () => setup.stop());
  ctx.effect(() => () => personas.close());
  new MaomaoPanel(ctx, setup);
}
