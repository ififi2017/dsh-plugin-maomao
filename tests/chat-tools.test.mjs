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
  assert.equal(t.concluded, 1);
  t.close();
  assert.equal(t.defs.size, 0);
  assert.equal((await voice.execute({ text: 'again' }, t.exec)).status, 'denied');
});

test('failed media permits text fallback; ambiguous delivery concludes without duplicate sends', async () => {
  for (const status of ['unavailable', 'uncertain', 'sent']) {
    const t = bind({ voice: async () => status });
    assert.equal((await t.run('maomao_speak', { text: '晚安。' })).status, status);
    assert.equal(t.concluded, status === 'unavailable' ? 0 : 1);
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
  const missing = bind({ web: { search: async () => { throw new Error('provider credentials missing'); } } });
  assert.deepEqual(await missing.run('maomao_web_search', { query: 'test' }), { status: 'unavailable', data: '' });
  missing.close();
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
