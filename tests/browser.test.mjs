import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { browserUrl, globalAddress, publicAddress, createPublicProxy } from '../integrations/maomao-dsh/browser-network.mjs';
import { PublicBrowser } from '../integrations/maomao-dsh/browser-runtime.mjs';
import { manageWeb } from '../web-settings.mjs';

test('browser URL and DNS policy rejects local, mixed, mapped, reserved and credential-bearing targets', async () => {
  for (const url of ['file:///etc/passwd', 'http://example.com', 'https://127.0.0.1', 'https://0x7f000001',
    'https://[::ffff:127.0.0.1]', 'https://user:pass@example.com', 'https://x.local', 'https://example.com:8443', 'https://example.com.']) {
    assert.equal(browserUrl(url), null, url);
  }
  for (const ip of ['0.0.0.1', '127.0.0.1', '10.1.1.1', '172.31.1.1', '192.168.1.1', '100.64.1.1',
    '169.254.169.254', '198.18.1.1', '192.0.2.1', '224.0.0.1', '255.255.255.255', '::1',
    '::ffff:8.8.8.8', 'fe80::1', 'fc00::1', '2002::1', '2001:db8::1']) assert.equal(globalAddress(ip), false, ip);
  for (const ip of ['8.8.8.8', '2606:4700:4700::1111']) assert.equal(globalAddress(ip), true);
  await assert.rejects(publicAddress('example.com', async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]), { code: 'BROWSER_BLOCKED' });
});

test('proxy denies private DNS before opening a socket, and requires its ephemeral credential', async () => {
  let dialed = 0;
  const proxy = await createPublicProxy({ resolve: async () => [{ address: '127.0.0.1', family: 4 }], dial() { dialed++; throw Error('must not dial'); } });
  const request = auth => new Promise((resolve, reject) => {
    const url = new URL(proxy.config.server);
    const socket = connect(Number(url.port), url.hostname, () => socket.write(`CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n${auth ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.config.username}:${proxy.config.password}`).toString('base64')}\r\n` : ''}\r\n`));
    socket.once('error', reject); socket.once('data', data => { socket.destroy(); resolve(data.toString()); });
  });
  try { assert.match(await request(false), /407/); assert.match(await request(true), /403/); assert.equal(dialed, 0); }
  finally { await proxy.close(); }
});

function fakeEngine() {
  const contexts = []; let closes = 0;
  return { contexts, get closes() { return closes; }, isConnected: () => true, async close() { closes++; },
    async newContext(options) {
      const id = contexts.length + 1;
      const item = { options, closed: false, routes: [], async route(_pattern, fn) { this.routes.push(fn); },
        async routeWebSocket(_pattern, fn) { this.websocket = fn; }, on() {}, async close() { this.closed = true; },
        async newPage() {
          let url = 'about:blank';
          return { url: () => url, on() {}, setDefaultTimeout() {},
            async goto(next) { url = next; return { ok: () => true }; }, async waitForLoadState() {},
            async evaluate() { return { title: `context ${id}`, text: `isolated ${id}`, links: [{ url: 'https://example.com/next', text: 'Next' }] }; },
            async screenshot() { return Buffer.from('jpeg'); } };
        } };
      contexts.push(item); return item;
    } };
}

test('isolated contexts are lazy, bounded, reject stale links, and dispose with each conversation turn', async () => {
  const engine = fakeEngine(); let launches = 0, proxiesClosed = 0;
  const runtime = new PublicBrowser({ executable: () => '/fake/chrome', launch: async options => {
    launches++; assert.equal(options.chromiumSandbox, true); assert.ok(options.proxy); return engine;
  }, proxy: async () => ({ config: { server: 'http://127.0.0.1:1' }, async close() { proxiesClosed++; } }) });
  const a = runtime.lease('qq-a'), b = runtime.lease('tg-b'), c = runtime.lease('lark-c'), d = runtime.lease('qq-d');
  const signal = AbortSignal.timeout(5000);
  try {
    assert.equal(launches, 0);
    const first = await a.run('open', { url: 'https://example.com' }, signal);
    await assert.rejects(b.run('read', {}, signal), { code: 'BROWSER_PAGE_MISSING' });
    const second = await b.run('open', { url: 'https://example.com' }, signal);
    assert.notEqual(first.content, second.content); assert.equal(launches, 1);
    await assert.rejects(b.run('follow', { snapshot: first.snapshot, link: 1 }, signal), { code: 'BROWSER_CHANGED' });
    assert.match((await a.run('follow', { snapshot: first.snapshot, link: 1 }, signal)).url, /next/);
    await assert.rejects(a.run('follow', { snapshot: first.snapshot, link: 1 }, signal), { code: 'BROWSER_CHANGED' });
    await c.run('open', { url: 'https://example.com' }, signal);
    await assert.rejects(d.run('open', { url: 'https://example.com' }, signal), { code: 'BROWSER_BUSY' });
    await a.close(); assert.equal(engine.contexts[0].closed, true); assert.equal(engine.contexts[1].closed, false);
    await assert.rejects(a.run('read', {}, signal), { code: 'BROWSER_DISABLED' });
    await d.run('open', { url: 'https://example.com' }, signal);
    let blocked = false;
    await engine.contexts[1].routes[0]({ request: () => ({ url: () => 'https://example.com', method: () => 'POST', resourceType: () => 'fetch' }), abort() { blocked = true; }, continue() { throw Error('POST allowed'); } });
    assert.equal(blocked, true);
  } finally { await runtime.close(); }
  assert.ok(engine.contexts.every(c => c.closed)); assert.equal(engine.closes, 1); assert.equal(proxiesClosed, 1);
});

test('web panel hides credential values, preserves other settings, and returns safe provider errors', async () => {
  let saved, config = { unrelated: true }; const ctx = { get(name) { return ({
    credentials: { describe: async () => ({ configured: true, secret: 'never-return' }), set: async (key, value) => { saved = { key, value }; } },
    web: { searchReady: async () => false, selectSearchProvider: () => ({ id: 'deepseek-official' }),
      search: async () => { throw Object.assign(Error('secret=never-return'), { code: 'WEB_PROVIDER_CREDENTIAL_MISSING' }); } },
    configEditor: { entries: () => [{ options: { id: 'maomao-dsh-panel' } }], edit: async (_entry, fn) => { config = fn(config); } },
  })[name]; } };
  const state = await manageWeb(ctx, { action: 'read' });
  assert.equal(state.deepseekCredential, true); assert.doesNotMatch(JSON.stringify(state), /never-return/);
  assert.equal((await manageWeb(ctx, { action: 'credential', secret: 'test-only-key' })).status, 'saved');
  assert.deepEqual(saved, { key: 'DEEPSEEK_API_KEY', value: 'test-only-key' });
  await manageWeb(ctx, { action: 'browser', enabled: false });
  assert.deepEqual(config, { unrelated: true, browser: { enabled: false } });
  const failure = await manageWeb(ctx, { action: 'test_search' });
  assert.equal(failure.code, 'WEB_PROVIDER_CREDENTIAL_MISSING'); assert.doesNotMatch(JSON.stringify(failure), /never-return/);
});
