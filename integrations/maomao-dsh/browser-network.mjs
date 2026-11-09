import { createServer } from 'node:http';
import { connect, BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { randomBytes } from 'node:crypto';
import { get } from 'node:https';

export const browserError = (code) => Object.assign(new Error(code), { code });
const denied = new BlockList();
for (const [ip, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]]) denied.addSubnet(ip, bits);
for (const [ip, bits] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) denied.addSubnet(ip, bits, 'ipv6');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
export const globalAddress = (ip) => isIP(ip) === 4 ? !denied.check(ip, 'ipv4')
  : isIP(ip) === 6 && globalV6.check(ip, 'ipv6') && !denied.check(ip, 'ipv6');

export function browserUrl(value) {
  try {
    const u = new URL(value);
    if (typeof value !== 'string' || value.length > 2000 || u.protocol !== 'https:' || u.username || u.password
      || u.port || isIP(u.hostname) || !u.hostname.includes('.') || u.hostname.endsWith('.')
      || /(?:^|\.)(?:localhost|local|internal|home|lan|test|invalid|onion)$/.test(u.hostname)) return null;
    return u.href;
  } catch { return null; }
}

export async function publicAddress(host, resolve = lookup) {
  if (!browserUrl(`https://${host}/`)) throw browserError('BROWSER_BLOCKED');
  const addresses = await resolve(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !globalAddress(address))) throw browserError('BROWSER_BLOCKED');
  return addresses.find(({ family }) => family === 4) ?? addresses[0];
}

const fakeRange = new BlockList();
fakeRange.addSubnet('198.18.0.0', 15);
const dnsCache = new Map();
// TUN proxies can return benchmark-range Fake-IP answers. Resolve those names
// using certificate-verified, IP-pinned public DoH, then apply the same IP guard.
// Never connect to the Fake-IP itself or accept a private DoH answer.
export async function browserLookup(host, options) {
  const cached = dnsCache.get(host);
  if (cached?.until > Date.now()) return cached.addresses;
  const system = await lookup(host, options);
  if (!system.length || !system.every(row => row.family === 4 && fakeRange.check(row.address))) return system;
  const addresses = await new Promise((resolve, reject) => {
    const req = get(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`, {
      headers: { accept: 'application/dns-json' },
      lookup: (_host, opts, callback) => callback(null, opts.all ? [{ address: '1.1.1.1', family: 4 }] : '1.1.1.1', 4),
      signal: AbortSignal.timeout(6000),
    }, res => {
      let text = '';
      res.on('error', reject);
      res.on('data', chunk => { text += chunk; if (text.length > 16_384) req.destroy(browserError('BROWSER_BLOCKED')); });
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) throw browserError('BROWSER_BLOCKED');
          const payload = JSON.parse(text);
          resolve((payload.Answer ?? []).filter(row => row.type === 1).map(row => ({ address: row.data, family: 4 })));
        } catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
  });
  if (!addresses.length || addresses.some(row => !globalAddress(row.address))) throw browserError('BROWSER_BLOCKED');
  if (dnsCache.size >= 256) dnsCache.delete(dnsCache.keys().next().value);
  dnsCache.set(host, { addresses, until: Date.now() + 30_000 });
  return addresses;
}

// Resolve once and connect to the checked IP, not the hostname. DNS rebinding and
// redirects cannot turn a public-page request into a request to a private host.
// This proxy has no direct fallback and only permits authenticated HTTPS tunnels.
export async function createPublicProxy({ resolve = browserLookup, dial = connect } = {}) {
  const username = 'maomao';
  const password = randomBytes(24).toString('hex');
  const auth = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const sockets = new Set();
  let closed = false;
  const track = (socket) => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); return socket; };
  const server = createServer((_req, res) => { res.writeHead(403); res.end(); });
  server.on('connection', track);
  server.on('connect', async (req, client, head) => {
    if (req.headers['proxy-authorization'] !== auth) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="maomao"\r\nConnection: close\r\n\r\n'); return;
    }
    const match = /^([a-z0-9.-]+):443$/i.exec(req.url ?? '');
    if (!match) { client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    const deadline = setTimeout(() => client.destroy(), 12_000);
    deadline.unref();
    client.once('close', () => clearTimeout(deadline));
    try {
      const address = await publicAddress(match[1], resolve);
      if (closed || client.destroyed) return;
      const upstream = track(dial({ host: address.address, family: address.family, port: 443 }));
      client.once('close', () => upstream.destroy());
      upstream.once('error', () => client.destroy());
      upstream.once('connect', () => {
        clearTimeout(deadline);
        if (closed || client.destroyed) { upstream.destroy(); return; }
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client);
      });
    } catch { client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }
  });
  await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
  server.unref();
  return {
    config: { server: `http://127.0.0.1:${server.address().port}`, username, password, bypass: '<-loopback>' },
    async close() { closed = true; for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); },
  };
}
