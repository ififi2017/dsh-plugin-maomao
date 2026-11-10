import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { publicResource, projectRequest, readPublicProject, loadPublicImage, pageResources } from '../integrations/maomao-dsh/project-resources.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=', 'base64');
const resolve = async () => [{ address: '8.8.8.8', family: 4 }];
const signal = () => AbortSignal.timeout(3000);
function network(rows, calls) {
  return (url, options, callback) => {
    calls.push({ url: url.href, options });
    const row = rows.shift();
    const res = Readable.from(row.body ?? []);
    res.statusCode = row.status ?? 200; res.headers = row.headers ?? {};
    queueMicrotask(() => callback(res));
    return new EventEmitter();
  };
}

test('public resources pin checked DNS, recheck redirects, never send ambient credentials and bound bytes', async () => {
  const calls = [];
  const value = await publicResource('https://example.com/art', { signal: signal(), maxBytes: 200,
    accept: 'image/png', resolve, request: network([
      { status: 302, headers: { location: 'https://cdn.example.com/art.png' } },
      { body: [png] },
    ], calls) });
  assert.deepEqual(value.buffer, png); assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.options.headers.authorization, undefined);
    assert.equal(call.options.headers.cookie, undefined);
    call.options.lookup('ignored.example', { all: true }, (_err, addresses) => assert.deepEqual(addresses, awaitAddress()));
  }
  function awaitAddress() { return [{ address: '8.8.8.8', family: 4 }]; }
  await assert.rejects(publicResource('https://example.com', { signal: signal(), maxBytes: 10, resolve,
    request: network([{ status: 302, headers: { location: 'https://127.0.0.1/secret' } }], []) }), { code: 'BROWSER_BLOCKED' });
  await assert.rejects(publicResource('https://example.com', { signal: signal(), maxBytes: 10,
    resolve: async () => [{ address: '127.0.0.1', family: 4 }], request: () => assert.fail('private DNS dialed') }), { code: 'BROWSER_BLOCKED' });
  for (const row of [{ headers: { 'content-length': '11' } }, { body: [Buffer.alloc(11)] }]) {
    await assert.rejects(publicResource('https://example.com', { signal: signal(), maxBytes: 10, resolve,
      request: network([row], []) }), { code: 'RESOURCE_TOO_LARGE' });
  }
});

test('public project reads expose actual paths, versions, prompt text and image URLs without following links', async () => {
  const repository = 'https://github.com/example/art';
  for (const args of [{ repository: repository + '/tree/main' }, { repository, path: '../secrets' },
    { repository, path: '/tmp/file' }, { repository, offset: -1 }, { repository: 'https://example.com/a/b' }]) assert.equal(projectRequest(args), null);
  const row = { type: 'file', name: '角色.md', path: '角色.md', size: 100, sha: 'a'.repeat(40),
    html_url: repository + '/blob/main/角色.md', download_url: 'https://raw.githubusercontent.com/example/art/main/角色.md',
    encoding: 'base64', content: Buffer.from('# Cat\nWhite ears.\n![reference](参考图/猫.png)\n[Prompt](prompt.md)').toString('base64') };
  const read = async (url) => { assert.match(url, /api.github.com\/repos\/example\/art\/contents/); return { buffer: Buffer.from(JSON.stringify(row)) }; };
  const doc = await readPublicProject({ repository, path: '角色.md' }, { signal: signal(), read });
  assert.equal(doc.kind, 'text'); assert.match(doc.content, /White ears/); assert.equal(doc.sha, row.sha);
  assert.match(decodeURI(doc.images[0].url), /main\/参考图\/猫.png/);
  const listing = await readPublicProject({ repository }, { read: async () => ({ buffer: Buffer.from(JSON.stringify([
    { ...row, name: 'cat.png', path: 'art/cat.png', download_url: 'https://raw.githubusercontent.com/example/art/main/art/cat.png' },
  ])) }) });
  assert.equal(listing.entries[0].path, 'art/cat.png');
  assert.match(listing.entries[0].image_url, /cat.png$/);
  const symlink = await readPublicProject({ repository, path: 'other' }, { read: async () => ({ buffer: Buffer.from(JSON.stringify({ ...row, type: 'symlink' })) }) });
  assert.equal(symlink.kind, 'unsupported');
});

test('page resources resolve actual Markdown and HTML images, omit embedded scripts and reject non-public forms', () => {
  const resources = pageResources('<script><img src="https://evil.example/no.png"></script>\n'
    + '![cat](art/cat.png)\n<img src="../hair.png" alt="hair"><a href="prompt.md">Prompt</a>'
    + '<img src="file:///tmp/secret.png"><img src="https://127.0.0.1/no.png">', 'https://example.com/project/README.md');
  assert.deepEqual(resources.images.map(i => i.url), ['https://example.com/project/art/cat.png', 'https://example.com/hair.png']);
  assert.equal(resources.links[0].url, 'https://example.com/project/prompt.md');
});

test('reference loader checks actual bytes instead of trusting a PNG filename or MIME header', async () => {
  const url = 'https://example.com/cat.png';
  const good = await loadPublicImage(url, { read: async () => ({ url, buffer: png, mediaType: 'image/png' }) });
  assert.equal(good.data, png.toString('base64')); assert.equal(good.bytes, png.length);
  for (const buffer of [Buffer.from('<html>login</html>'), Buffer.alloc(5_000_001)]) {
    await assert.rejects(loadPublicImage(url, { read: async () => ({ url, buffer, mediaType: 'image/png' }) }), { code: 'RESOURCE_NOT_IMAGE' });
  }
});
