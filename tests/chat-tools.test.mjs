import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openChatTools, publicUrl } from '../integrations/maomao-dsh/chat-tools.mjs';
import { opusVoice } from '../integrations/maomao-dsh/voice-media.mjs';

function bind(options = {}) {
  const defs = new Map();
  const turn = openChatTools({ current: () => true, signal: AbortSignal.timeout(5000), ...options });
  const close = turn.bind('test-session', { register(def) { defs.set(def.name, def); return () => defs.delete(def.name); } });
  let concluded = 0;
  const exec = { agent: { id: 'test-session' }, concludeTurn() { concluded++; } };
  return { turn, close, defs, exec, get concluded() { return concluded; },
    run: (name, args, override = {}) => defs.get(name).execute(args, { ...exec, ...override }) };
}
const imageArgs = { prompt: 'test image', aspect_ratio: '1:1', use_reference: false };

test('project reference is inspected, passed byte-for-byte to generation, and never shared across turns', async () => {
  const supplied = { data: Buffer.from('image bytes').toString('base64'), mediaType: 'image/png', bytes: 11, url: 'https://example.com/cat.png' };
  let received;
  const t = bind({ image: async (_args, _signal, ref) => { received = ref; return 'sent'; },
    resourceImage: async () => supplied });
  const exec = { agent: { id: 'test-session', options: { provider: 'google', model: 'vision' }, ctx: { get(name) {
    return name === 'llm' ? { resolveModelInfo: async () => ({ inputModalities: ['image'] }) }
      : name === 'attachments' ? { saveImage: async ({ data }) => {
        assert.equal(data.toString(), 'image bytes'); return { attachmentId: 'reference-art' };
      } } : undefined;
  } } } };
  const found = await t.run('maomao_reference_image', { url: supplied.url }, exec);
  assert.equal(found.status, 'ok'); assert.equal(JSON.parse(found.data).visual_input, true);
  assert.equal(found.image.attachmentId, 'reference-art');
  const { reference_id } = JSON.parse(found.data);
  const other = bind({ image: async () => assert.fail('foreign reference used') });
  assert.equal((await other.run('maomao_generate_image', { ...imageArgs, reference_id })).status, 'denied');
  assert.equal((await t.run('maomao_generate_image', { ...imageArgs, reference_id })).status, 'sent');
  assert.equal(received.data, supplied.data); assert.equal(received.url, supplied.url);
  assert.equal(t.turn.learningOutcomes()[0].reference_source, supplied.url);
  const oldTool = t.defs.get('maomao_generate_image');
  await t.close();
  assert.equal((await oldTool.execute({ ...imageArgs, reference_id }, t.exec)).status, 'denied');
  await other.close();
});

test('project evidence comes only from a completed read and reference failures do not consume generation', async () => {
  let evidence = 0, calls = 0, current = true;
  const t = bind({ current: () => current, image: async () => { calls++; return 'sent'; },
    learnProject: data => { evidence++; assert.equal(data.sha, 'a'.repeat(40)); return { source: 'project-source' }; },
    resourceProject: async () => ({ kind: 'text', content: 'white cat ears', url: 'https://example.com/design.md', sha: 'a'.repeat(40) }),
    resourceImage: async () => { throw Object.assign(Error('credential details'), { code: 'RESOURCE_INACCESSIBLE' }); },
  });
  const found = await t.run('maomao_project_read', { repository: 'https://github.com/example/art' });
  assert.equal(JSON.parse(found.data).learning_source.source, 'project-source'); assert.equal(evidence, 1);
  const missing = await t.run('maomao_reference_image', { url: 'https://example.com/private.png' });
  assert.equal(missing.status, 'unavailable'); assert.doesNotMatch(missing.data, /credential details/);
  assert.equal((await t.run('maomao_generate_image', { ...imageArgs, reference_id: 'invented' })).status, 'denied');
  assert.equal(calls, 0);
  assert.equal((await t.run('maomao_generate_image', imageArgs)).status, 'sent');
  current = false;
  assert.equal((await t.run('maomao_project_read', { repository: 'https://github.com/example/art' })).status, 'denied');
  assert.equal(evidence, 1); await t.close();
});

test('media tools are leased to one turn, validate references and share a concurrent send budget', async () => {
  const actions = [];
  const t = bind({ image: async () => { actions.push('image'); return 'sent'; }, voice: async () => { actions.push('voice'); return 'sent'; } });
  const voice = t.defs.get('maomao_speak');
  assert.equal((await t.run('maomao_generate_image', imageArgs, { agent: { id: 'other-session' } })).status, 'denied');
  assert.equal((await t.run('maomao_generate_image', { ...imageArgs, use_reference: true })).status, 'denied');
  const values = await Promise.all([t.run('maomao_speak', { text: 'おやすみ。' }), t.run('maomao_generate_image', imageArgs)]);
  assert.deepEqual(values.map(v => v.status), ['sent', 'limit']);
  assert.deepEqual(actions, ['voice']);
  assert.equal(t.turn.transcript(), 'おやすみ。');
  // Sending media no longer ends the turn: the model may add a line afterwards, or nothing.
  assert.equal(t.concluded, 0);
  t.close();
  assert.equal(t.defs.size, 0);
  assert.equal((await voice.execute({ text: 'again' }, t.exec)).status, 'denied');
});

test('failed media permits text fallback; ambiguous delivery never sends twice', async () => {
  for (const status of ['unavailable', 'uncertain', 'sent']) {
    const t = bind({ voice: async () => status });
    assert.equal((await t.run('maomao_speak', { text: '晚安。' })).status, status);
    assert.equal(t.concluded, 0);
    assert.equal(t.turn.outcome(), status);
    assert.equal((await t.run('maomao_speak', { text: '再次' })).status, 'limit');
    t.close();
  }
});

test('a revoke while claiming does not start provider work; cleanup revokes all tools', async () => {
  let current = true;
  let calls = 0;
  const t = bind({ current: () => current, claim: async () => { current = false; return true; }, voice: async () => { calls++; return 'sent'; } });
  assert.equal((await t.run('maomao_speak', { text: 'hi' })).status, 'cancelled');
  assert.equal(calls, 0);
  t.close();
});

test('web tools reuse DSH providers, cap output and requests, block non-public URL forms', async () => {
  const requests = [];
  const t = bind({ web: {
    async search(req) { requests.push(req); return { sources: [{ url: 'https://example.com/news', title: 'News', summary: 'x'.repeat(5000) }] }; },
    async fetch(req) { requests.push(req); return { url: req.url, statusCode: 200,
      body: { kind: 'html', content: '<script>secret()</script><p>public page</p>' } }; },
  } });
  for (const url of ['file:///etc/passwd', 'http://127.0.0.1', 'http://0x7f000001', 'http://[::1]', 'http://host.local', 'https://u:p@example.com', 'https://example.com:8000']) {
    assert.equal(publicUrl(url), null);
    assert.equal((await t.run('maomao_web_fetch', { url })).status, 'denied');
  }
  const found = await t.run('maomao_web_search', { query: 'public topic' });
  assert.equal(JSON.parse(found.data).sources[0].summary.length, 800);
  const page = await t.run('maomao_web_fetch', { url: 'https://example.com/news' });
  assert.match(page.data, /public page/);
  assert.doesNotMatch(page.data, /secret/);
  await t.run('maomao_web_search', { query: 'another public topic' });
  assert.equal((await t.run('maomao_web_search', { query: 'extra' })).status, 'limit');
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[0], { query: 'public topic', maxResults: 5 });
  t.close();
  const missing = bind({ web: { search: async () => { throw Object.assign(new Error('secret credential detail'), { code: 'WEB_PROVIDER_CREDENTIAL_MISSING' }); } } });
  const unavailable = await missing.run('maomao_web_search', { query: 'test' });
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(JSON.parse(unavailable.data).code, 'WEB_PROVIDER_CREDENTIAL_MISSING');
  assert.match(JSON.parse(unavailable.data).message, /凭据/);
  assert.doesNotMatch(unavailable.data, /secret/);
  missing.close();
});

test('web diagnostics distinguish configuration failures without leaking unknown errors', async () => {
  for (const code of ['WEB_PROVIDER_CONFIGURED_MISSING', 'WEB_PROVIDER_AMBIGUOUS', 'UNKNOWN_SECRET']) {
    const t = bind({ web: { search: async () => { throw Object.assign(new Error('key=private-secret'), { code }); } } });
    const value = await t.run('maomao_web_search', { query: 'public topic' });
    assert.equal(value.status, 'unavailable');
    assert.equal(JSON.parse(value.data).code, code === 'UNKNOWN_SECRET' ? 'WEB_PROVIDER_ERROR' : code);
    assert.doesNotMatch(value.data, /private-secret|UNKNOWN_SECRET/);
    t.close();
  }
});

test('registration rollback closes partially registered tools', () => {
  let closeCount = 0;
  const t = openChatTools({ current: () => true, signal: AbortSignal.timeout(500), image() {}, voice() {} });
  assert.throws(() => t.bind('session', { register(def) {
    if (def.name === 'maomao_speak') throw new Error('register failed');
    return () => closeCount++;
  } }), /register failed/);
  assert.equal(closeCount, 1);
});

test('fixed voice conversion creates playable Ogg Opus from PCM WAV', async () => {
  const pcm = Buffer.alloc(4800);
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40);
  const audio = await opusVoice(wav, AbortSignal.timeout(3000));
  assert.equal(audio.buffer.toString('ascii', 0, 4), 'OggS');
  assert.ok(audio.buffer.includes(Buffer.from('OpusHead')));
  await assert.rejects(opusVoice(Buffer.alloc(1), AbortSignal.timeout(500)), /invalid_wav/);
});

test('browser tools are bound to the admitted session, bounded per turn, and disposed on revoke', async () => {
  const calls = []; let closed = 0;
  const browser = { enabled: true, lease(id) { calls.push(['lease', id]); return {
    async run(action, args) { calls.push([action, args]); return { url: 'https://example.com', content: 'public text' }; },
    async close() { closed++; },
  }; } };
  const t = bind({ browser });
  const def = t.defs.get('maomao_browser_open');
  assert.equal((await t.run(def.name, { url: 'https://example.com' }, { agent: { id: 'other' } })).status, 'denied');
  assert.equal((await t.run(def.name, { url: 'https://127.0.0.1' })).status, 'denied');
  assert.equal(calls.length, 0);
  assert.equal((await t.run(def.name, { url: 'https://example.com' })).status, 'ok');
  assert.deepEqual(calls[0], ['lease', 'test-session']);
  assert.equal((await t.run('maomao_browser_screenshot', {})).status, 'unavailable');
  await t.run('maomao_browser_read', {}); await t.run('maomao_browser_read', {});
  assert.equal((await t.run('maomao_browser_read', {})).status, 'limit');
  await t.close(); assert.equal(closed, 1);
  assert.equal((await def.execute({ url: 'https://example.com' }, t.exec)).status, 'denied');
});

test('screenshot returns a DSH image attachment only to an image-capable calling route', async () => {
  const ref = { attachmentId: 'image-1', mediaType: 'image/jpeg', bytes: 4, width: 10, height: 10 };
  const t = bind({ browser: { enabled: true, lease() { return { run: async () => ({ url: 'https://example.com', data: Buffer.from('jpeg') }), close() {} }; } } });
  const exec = { agent: { id: 'test-session', options: { provider: 'google', model: 'vision-model' }, ctx: { get: name => ({
    llm: { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) },
    attachments: { saveImage: async ({ data }) => { assert.equal(data.toString(), 'jpeg'); return ref; } },
  })[name] } } };
  const value = await t.run('maomao_browser_screenshot', {}, exec);
  assert.equal(value.status, 'ok'); assert.deepEqual(value.image, ref);
  assert.deepEqual(t.defs.get('maomao_browser_screenshot').output.render({}, value)[1], { type: 'image', attachment: ref });
  await t.close();
});

test('malformed arguments come back as invalid with a fix, while blocked targets stay denied with a reason', async () => {
  const t = bind({ image: async () => 'sent', web: { search: async () => ({ sources: [] }), fetch: async () => ({}) } });
  const reason = (value) => JSON.parse(value.data).reason;
  const empty = await t.run('maomao_web_search', { query: '' });
  assert.equal(empty.status, 'invalid'); assert.match(reason(empty), /query/);
  const ratio = await t.run('maomao_generate_image', { ...imageArgs, aspect_ratio: '4:3' });
  assert.equal(ratio.status, 'invalid'); assert.match(reason(ratio), /1:1/);
  const issue = await t.run('maomao_project_read', { repository: 'https://github.com/o/r/issues/3' });
  assert.equal(issue.status, 'invalid'); assert.match(reason(issue), /tree\/blob/);
  const local = await t.run('maomao_web_fetch', { url: 'http://127.0.0.1' });
  assert.equal(local.status, 'denied'); assert.match(reason(local), /公开/);
  const reference = await t.run('maomao_generate_image', { ...imageArgs, reference_id: 'invented' });
  assert.equal(reference.status, 'denied'); assert.match(reason(reference), /maomao_reference_image/);
  // None of these consumed the single media send for the turn.
  assert.equal((await t.run('maomao_generate_image', imageArgs)).status, 'sent');
  t.close();
});

test('an optional say_first line goes out before the media is made, and a bad one is refused', async () => {
  const order = [];
  const t = bind({ say: async (line) => { order.push(['say', line]); },
    voice: async (text) => { order.push(['voice', text]); return 'sent'; } });
  assert.equal((await t.run('maomao_speak', { text: '晚安。', say_first: 'https://x.invalid' })).status, 'invalid');
  assert.equal((await t.run('maomao_speak', { text: '晚安。', say_first: '等俺清清嗓子' })).status, 'sent');
  assert.deepEqual(order, [['say', '等俺清清嗓子'], ['voice', '晚安。']]);
  t.close();
  const quiet = bind({ say: async () => { throw new Error('offline'); }, voice: async () => 'sent' });
  assert.equal((await quiet.run('maomao_speak', { text: '晚安。', say_first: '来了' })).status, 'sent', 'a failed opener never blocks the media');
  quiet.close();
});
