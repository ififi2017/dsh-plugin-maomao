import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { browserError, browserUrl, createPublicProxy } from './browser-network.mjs';

const executables = () => process.platform === 'darwin'
  ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
  : process.platform === 'win32'
    ? [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean)
      .flatMap(root => [`${root}/Google/Chrome/Application/chrome.exe`, `${root}/Microsoft/Edge/Application/msedge.exe`])
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
export const browserExecutable = () => executables().find(existsSync) ?? null;

export class PublicBrowser {
  #engine; #starting; #proxy; #idle; #closed = false; #leases = new Set(); #last = null;
  constructor({ enabled = true, launch, proxy = createPublicProxy, executable = browserExecutable, idleMs = 30_000 } = {}) {
    this.enabled = enabled; this.launch = launch; this.proxy = proxy; this.executable = executable; this.idleMs = idleMs;
  }
  status() { return { enabled: this.enabled, installed: Boolean(this.executable()), running: Boolean(this.#engine),
    active: this.#leases.size, last: this.#last }; }
  async #start() {
    clearTimeout(this.#idle);
    if (!this.enabled || this.#closed) throw browserError('BROWSER_DISABLED');
    if (this.#engine?.isConnected()) return this.#engine;
    if (!this.#starting) this.#starting = (async () => {
      const executablePath = this.executable();
      if (!executablePath) throw browserError('BROWSER_MISSING');
      const proxy = await this.proxy();
      try {
        const launch = this.launch ?? ((opts) => import('playwright-core').then(({ chromium }) => chromium.launch(opts)));
        const engine = await launch({ executablePath, headless: true, chromiumSandbox: true, timeout: 15_000,
          proxy: proxy.config, args: ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
            '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
        if (this.#closed) { await engine.close(); throw browserError('BROWSER_DISABLED'); }
        this.#proxy = proxy; this.#engine = engine;
        return engine;
      } catch (error) { await proxy.close(); throw error; }
    })().finally(() => { this.#starting = null; });
    return this.#starting;
  }
  lease(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) throw browserError('BROWSER_BLOCKED');
    let page, context, pending, released = false, busy = false;
    let snapshotId = '', links = [];
    const close = async () => {
      if (released) return;
      released = true; links = [];
      if (pending) await pending.catch(() => {});
      await context?.close().catch(() => {});
      this.#leases.delete(close);
      if (!this.#leases.size && !this.#closed) {
        clearTimeout(this.#idle);
        this.#idle = setTimeout(() => { void this.#stop(); }, this.idleMs); this.#idle.unref();
      }
    };
    const ensure = async () => {
      if (released) throw browserError('BROWSER_DISABLED');
      if (page) return page;
      if (this.#leases.size >= 3) throw browserError('BROWSER_BUSY');
      this.#leases.add(close);
      pending = (async () => {
        const engine = await this.#start();
        if (released) throw browserError('BROWSER_DISABLED');
        context = await engine.newContext({ viewport: { width: 1100, height: 780 }, acceptDownloads: false,
          serviceWorkers: 'block', permissions: [], locale: 'zh-CN' });
        await context.route('**/*', async (route) => {
          const req = route.request();
          // No form submission, file URLs, private endpoints, workers or streaming sockets.
          if (!browserUrl(req.url()) || !['GET', 'HEAD'].includes(req.method())
            || ['media', 'websocket'].includes(req.resourceType())) return route.abort('blockedbyclient');
          return route.continue();
        });
        await context.routeWebSocket('**/*', ws => ws.close());
        context.on('page', p => { if (page && p !== page) void p.close(); });
        page = await context.newPage();
        page.on('dialog', dialog => void dialog.dismiss());
        page.on('download', download => void download.cancel());
        page.setDefaultTimeout(8000);
        return page;
      })();
      return pending;
    };
    const snapshot = async () => {
      if (!page || !browserUrl(page.url())) throw browserError('BROWSER_PAGE_MISSING');
      const data = await page.evaluate(() => ({ title: document.title.slice(0, 180),
        text: (document.body?.innerText ?? '').slice(0, 12_000),
        links: Array.from(document.querySelectorAll('a[href]')).filter(a => a.getClientRects().length && a.innerText.trim())
          .slice(0, 80).map(a => ({ url: a.href, text: a.innerText.trim().slice(0, 120) })) }));
      snapshotId = randomUUID();
      links = data.links.filter(l => browserUrl(l.url)).slice(0, 30).map((l, i) => ({ ...l, id: i + 1 }));
      return { url: page.url(), title: data.title, content: data.text, truncated: data.text.length >= 12_000, snapshot: snapshotId, links };
    };
    return { close, async run(action, args, signal) {
      if (released) throw browserError('BROWSER_DISABLED');
      if (busy) throw browserError('BROWSER_BUSY');
      signal.throwIfAborted(); busy = true;
      const cancel = () => { void close(); };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        if (action === 'open' || action === 'follow') {
          const url = action === 'open' ? browserUrl(args.url)
            : args.snapshot === snapshotId && links.find(l => l.id === args.link)?.url;
          if (!url) throw browserError(action === 'open' ? 'BROWSER_BLOCKED' : 'BROWSER_CHANGED');
          const target = await ensure(); signal.throwIfAborted();
          links = []; snapshotId = '';
          const response = await target.goto(url, { waitUntil: 'domcontentloaded', timeout: 18_000 });
          await target.waitForLoadState('load', { timeout: 2500 }).catch(() => {});
          if (response && !response.ok()) throw browserError('BROWSER_HTTP_ERROR');
          return await snapshot();
        }
        if (!page) throw browserError('BROWSER_PAGE_MISSING');
        if (action === 'read') return await snapshot();
        if (action === 'screenshot') {
          if (!browserUrl(page.url())) throw browserError('BROWSER_BLOCKED');
          return { url: page.url(), data: await page.screenshot({ type: 'jpeg', quality: 75, timeout: 8000 }) };
        }
        throw browserError('BROWSER_BLOCKED');
      } finally { busy = false; signal.removeEventListener('abort', cancel); }
    } };
  }
  record(status) { this.#last = { at: Date.now(), status }; }
  async #stop() {
    clearTimeout(this.#idle);
    const engine = this.#engine, proxy = this.#proxy;
    this.#engine = null; this.#proxy = null;
    await engine?.close().catch(() => {}); await proxy?.close().catch(() => {});
  }
  async close() {
    this.#closed = true; clearTimeout(this.#idle);
    await Promise.allSettled([...this.#leases].map(close => close()));
    await this.#starting?.catch(() => {}); await this.#stop();
  }
}
