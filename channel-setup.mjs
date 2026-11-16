import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';

const privateId = 'maomao-dsh-private';
const qqId = 'maomao-dsh-qq';
const routes = { feishu: privateId, telegram: privateId, weixin: privateId, qq: qqId };
const duration = 12 * 60_000;
const secretPattern = /^[A-Za-z0-9_=-]{8,512}$/;
const terminal = new Set(['connected', 'disconnected', 'verified', 'failed', 'cancelled']);
const knownFailures = new Set(['credentials_rejected', 'telegram_http_409', 'telegram_webhook_or_status_unknown',
  'telegram_management_disabled', 'telegram_wrong_bot', 'feishu_token_unavailable', 'wrong_edition',
  'setup_missing', 'managed_credentials_required', 'configuration_unavailable', 'configuration_rejected',
  'invalid_qr', 'expired_token', 'access_denied', 'weixin_already_bound', 'weixin_verify_code_required',
  'weixin_session_expired']);
const failure = (code) => Object.assign(new Error(code), { code });
const referencePrefix = (platform) => `MAOMAO_PANEL_${platform.toUpperCase()}_`;

function validateAuthorizationUrl(platform, raw) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.href.length > 3000) {
    throw failure('invalid_qr');
  }
  const allowed = platform === 'feishu'
    ? ['open.feishu.cn', 'open.larksuite.com'].includes(url.hostname) && ['/page/launcher', '/page/cli'].includes(url.pathname)
    : platform === 'telegram' ? url.hostname === 't.me' && /^\/(?:newbot\/)?[a-z0-9_/]{5,98}$/i.test(url.pathname)
      : platform === 'weixin' ? /(^|\.)qq\.com$/.test(url.hostname)
      : url.hostname === 'q.qq.com' && url.pathname === '/qqbot/openclaw/connect.html';
  if (!allowed) throw failure('invalid_qr');
  return url.href;
}

export class ChannelSetup {
  #ctx;
  #jobs = new Map();

  constructor(ctx) { this.#ctx = ctx; }

  #entry(platform) {
    const editor = this.#ctx.get('configEditor');
    const entry = editor?.entries().find((row) => row.options.id === routes[platform]);
    if (!entry || !this.#setup(platform)) return {};
    return { editor, entry };
  }

  #setup(platform) {
    return this.#ctx.get(platform === 'qq' ? 'maomaoQqSetup' : 'maomaoPrivateSetup');
  }

  #current(platform, config) {
    return platform === 'qq' ? config ?? {} : config?.[platform] ?? {};
  }

  status() {
    return Object.fromEntries(Object.keys(routes).map((platform) => {
      const { entry } = this.#entry(platform);
      const config = this.#current(platform, entry?.options.config);
      return [platform, {
        available: Boolean(entry && this.#ctx.get('credentials')),
        managed: Boolean(config.credentialRef?.startsWith(referencePrefix(platform))),
        enabled: config.enabled === true,
        brand: platform === 'feishu' && config.brand === 'lark' ? 'lark' : 'feishu',
      }];
    }));
  }

  stop() {
    for (const job of this.#jobs.values()) job.abort.abort();
  }

  async request(request) {
    const { platform, action, id } = request ?? {};
    if (!Object.hasOwn(routes, platform)) return { state: 'failed', reason: 'invalid_request' };
    const job = this.#jobs.get(platform);
    if (action === 'current') return job && !terminal.has(job.state) ? this.#snapshot(job) : null;
    if (action === 'read' || action === 'cancel') {
      if (!job || job.id !== id) return { state: 'failed', reason: 'expired' };
      if (action === 'cancel' && !terminal.has(job.state) && job.state !== 'saving') {
        job.abort.abort();
        job.state = 'cancelled';
        job.qr = null;
      }
      return this.#snapshot(job);
    }
    if (!['start', 'enable', 'disable', 'test'].includes(action)) return { state: 'failed', reason: 'invalid_request' };
    if (job && (!terminal.has(job.state) || job.running)) return { state: 'failed', reason: 'busy' };
    const mode = request.mode ?? 'import';
    if ((action === 'start' && !['import', 'scan'].includes(mode))
      || (['start', 'enable'].includes(action) && request.exclusive !== true)) return { state: 'failed', reason: 'confirm_exclusive' };
    const { editor, entry } = this.#entry(platform);
    const vault = this.#ctx.get('credentials');
    if (!editor || !entry || !vault) return { state: 'failed', reason: 'setup_missing' };
    const next = { id: randomUUID(), state: 'preparing', running: true, qr: null, abort: new AbortController(),
      expires: Date.now() + duration };
    this.#jobs.set(platform, next);
    const { brand, secret, accountId } = request;
    void this.#run(next, { platform, action, mode, brand, secret, accountId }, vault).finally(() => { next.running = false; });
    return this.#snapshot(next);
  }

  async #snapshot(job) {
    const qr = job.qr;
    const image = await qr?.image;
    return { id: job.id, state: job.state, reason: job.reason ?? null, expires: job.expires,
      qr: qr && job.qr === qr ? { url: qr.url, step: qr.step, image } : null };
  }

  async #run(job, request, vault) {
    const { platform, action, mode } = request;
    const signal = AbortSignal.any([job.abort.signal, AbortSignal.timeout(duration)]);
    let freshRef;
    let saved = false;
    try {
      const previous = this.#current(platform, this.#entry(platform).entry?.options.config);
      let connection;
      if (action === 'start') {
        connection = await this.#credentials(job, request, signal);
        signal.throwIfAborted();
        job.qr = null;
        job.state = 'verifying';
        if (mode === 'import' || platform !== 'telegram') await this.#verify(platform, connection, signal);
        freshRef = referencePrefix(platform) + randomUUID().replaceAll('-', '').toUpperCase();
        await vault.set(freshRef, connection.secret);
      } else {
        if (!previous.credentialRef?.startsWith(referencePrefix(platform))) throw failure('managed_credentials_required');
        if (action !== 'disable') {
          job.state = 'verifying';
          const secret = (await vault.resolve(previous.credentialRef))?.value;
          if (!secret) throw failure('managed_credentials_required');
          await this.#verify(platform, { accountId: previous.accountId, brand: previous.brand, secret }, signal);
        }
      }
      signal.throwIfAborted();
      if (action === 'test') { job.state = 'verified'; return; }
      job.state = 'saving';
      const { editor, entry } = this.#entry(platform);
      if (!entry) throw failure('configuration_unavailable');
      try {
        await editor.edit(entry, (config) => this.#edit(config, platform, action, connection, freshRef));
      } catch { throw failure('configuration_rejected'); }
      saved = true;
      if (freshRef && previous.credentialRef?.startsWith(referencePrefix(platform))) {
        await vault.unset(previous.credentialRef).catch(() => undefined);
      }
      job.state = action === 'disable' ? 'disconnected' : 'connected';
    } catch (error) {
      job.state = job.abort.signal.aborted ? 'cancelled' : 'failed';
      job.reason = signal.aborted && !job.abort.signal.aborted ? 'expired'
        : knownFailures.has(error?.code) ? error.code : 'credentials_rejected';
    } finally {
      job.qr = null;
      if (freshRef && !saved) await vault.unset(freshRef).catch(() => undefined);
    }
  }

  async #credentials(job, { platform, mode, brand, secret, accountId }, signal) {
    const setup = this.#setup(platform);
    if (!setup) throw failure('setup_missing');
    if (platform === 'feishu' && !['lark', 'feishu'].includes(brand)) throw failure('credentials_rejected');
    if (mode === 'scan') {
      job.state = 'scan';
      const onQr = (info) => {
        if (signal.aborted) return;
        if (!info) { job.qr = null; return; }
        const url = validateAuthorizationUrl(platform, info.url);
        job.qr = { url, step: info.step ?? 'scan',
          image: QRCode.toDataURL(url, { margin: 2, width: 210 }).catch(() => null) };
      };
      if (platform === 'feishu') {
        const value = await setup.provisionFeishu({ brand, images: true, signal, onQr });
        if (value.brand !== brand) throw failure('wrong_edition');
        return { accountId: value.appId, brand, secret: value.secret };
      }
      if (platform === 'qq') {
        const value = await setup.provisionQQ({ signal, onQr });
        return { accountId: value.appId, secret: value.secret };
      }
      if (platform === 'weixin') {
        const value = await setup.provisionWeixin({ signal, onQr });
        return { accountId: value.accountId, secret: value.secret };
      }
      const value = await setup.provisionTelegram({ token: secret, mode: 'managed', signal, onQr });
      return { accountId: String(value.bot.id), secret: value.token };
    }
    // WeChat ClawBot has no app secret to paste: it connects only by scanning.
    if (platform === 'weixin') throw failure('credentials_rejected');
    if (typeof secret !== 'string' || secret.length > 512) throw failure('credentials_rejected');
    if (platform === 'telegram') {
      const id = /^(\d{1,20}):[A-Za-z0-9_-]{8,480}$/.exec(secret)?.[1];
      if (!id) throw failure('credentials_rejected');
      return { accountId: id, secret };
    }
    const pattern = platform === 'qq' ? /^\d{1,32}$/ : /^cli_[A-Za-z0-9_-]{1,120}$/;
    if (typeof accountId !== 'string' || !pattern.test(accountId) || !secretPattern.test(secret)) {
      throw failure('credentials_rejected');
    }
    return { accountId, secret, brand };
  }

  async #verify(platform, { accountId, secret, brand }, signal) {
    const setup = this.#setup(platform);
    if (!setup) throw failure('setup_missing');
    const bound = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    if (platform === 'feishu') return setup.verifyFeishu({ appId: accountId, secret, brand, signal: bound });
    if (platform === 'telegram') return setup.verifyTelegram({ token: secret, signal: bound });
    if (platform === 'weixin') return setup.verifyWeixin({ accountId, secret, signal: bound });
    return setup.verifyQQ({ appId: accountId, secret, signal: bound });
  }

  #edit(config, platform, action, connection, credentialRef) {
    const old = this.#current(platform, config);
    const enabled = action !== 'disable';
    const replacement = connection && old.accountId !== connection.accountId;
    const next = { ...old, enabled, ...(connection ? {
      accountId: connection.accountId, credentialRef, ...(platform === 'feishu' ? { brand: connection.brand } : {}),
    } : {}) };
    if (platform === 'qq') {
      if (replacement) {
        next.groupAllowlist = [];
        next.dmAllowlist = [];
        next.shadow = { ...next.shadow, ownerIds: [],
          delivery: { ...next.shadow?.delivery, enabled: false, groupAllowlist: [] } };
      }
      return next;
    }
    const updated = { ...config, [platform]: next,
      enabled: enabled || ['feishu', 'telegram', 'weixin'].some((other) => other !== platform && config[other]?.enabled === true) };
    if ((!enabled || replacement) && config.sharing?.destination?.platform === platform) {
      updated.sharing = { ...config.sharing, enabled: false };
    }
    return updated;
  }
}
