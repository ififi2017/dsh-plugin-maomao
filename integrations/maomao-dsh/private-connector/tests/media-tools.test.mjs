import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { PrivateConnector, PRESET } from '../index.mjs';
import { FeishuTransport, TelegramTransport } from '../transports.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=', 'base64');
const media = { kind: 'image', buffer: png, mediaType: 'image/png', fileName: 'maomao-image.png' };
const event = { chatId: '1001', messageId: '2' };

test('Telegram media uses multipart native photo or voice reply with a fixed admitted destination', async () => {
  const requests = [];
  const tg = new TelegramTransport({ botId: '2000', token: '2000:synthetic', async fetchImpl(url, req) {
    requests.push(url.split('/').at(-1));
    assert.equal(req.body.get('chat_id'), '1001');
    assert.deepEqual(JSON.parse(req.body.get('reply_parameters')), { message_id: 2 });
    assert.equal(req.headers['content-type'], undefined);
    assert.ok(req.body.get(url.endsWith('sendVoice') ? 'voice' : 'photo') instanceof Blob);
    return Response.json({ ok: true, result: { message_id: 3 } });
  } });
  const signal = AbortSignal.timeout(5000);
  assert.equal(await tg.replyMedia(event, media, 'ticket', signal), '3');
  assert.equal(await tg.replyMedia(event, { ...media, kind: 'voice', mediaType: 'audio/ogg', fileName: 'voice.ogg' }, 'ticket2', signal), '3');
  assert.equal(await tg.replyMedia(event, media, 'revoked', signal, () => false), null);
  assert.deepEqual(requests, ['sendPhoto', 'sendVoice']);
});

test('Lark uploads native image/Opus then replies, with revocation checked between upload and send', async () => {
  const sent = [];
  const uploads = [];
  let current = true;
  let revoke = false;
  const lark = new FeishuTransport({ appId: 'cli_synthetic', secret: 'synthetic', brand: 'lark', async fetchImpl(url, req) {
    assert.ok(url.startsWith('https://open.larksuite.com/'));
    if (url.includes('/auth/')) return Response.json({ code: 0, tenant_access_token: 'synthetic-token', expire: 3600 });
    assert.equal(req.headers.authorization, 'Bearer synthetic-token');
    if (url.endsWith('/images') || url.endsWith('/files')) {
      const voice = url.endsWith('/files');
      uploads.push(voice ? req.body.get('file_type') : req.body.get('image_type'));
      if (revoke) current = false;
      return Response.json({ code: 0, data: voice ? { file_key: 'file_test' } : { image_key: 'img_test' } });
    }
    assert.ok(url.endsWith('/im/v1/messages/om_test/reply'));
    sent.push(JSON.parse(req.body));
    return Response.json({ code: 0, data: { message_id: 'om_sent' } });
  } });
  const signal = AbortSignal.timeout(5000);
  const input = { messageId: 'om_test', chatId: 'oc_test' };
  assert.equal(await lark.replyMedia(input, media, 'ticket', signal, () => current), 'om_sent');
  assert.equal(await lark.replyMedia(input, { ...media, kind: 'voice' }, 'voice-ticket', signal, () => current), 'om_sent');
  revoke = true;
  assert.equal(await lark.replyMedia(input, media, 'cancelled-ticket', signal, () => current), null);
  assert.deepEqual(uploads, ['message', 'opus', 'message']);
  assert.deepEqual(sent.map(row => row.msg_type), ['image', 'audio']);
  assert.deepEqual(JSON.parse(sent[1].content), { file_key: 'file_test' });
});

test('both private connectors expose native tools with no keyword gate and suppress duplicate text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maomao-private-tools-'));
  const sent = [];
  const active = new Map();
  let nextSession = 0;
  const toolsFor = (id) => ({ register(def) {
    const key = `${id}/${def.name}`; active.set(key, def); return () => active.delete(key);
  } });
  const controller = {
    async create() { return { sessionId: `session-${++nextSession}` }; },
    async projections() { return { values: { agentPreset: PRESET } }; },
    async resolveAgent(id) { return { agent: { id, ctx: { get: () => toolsFor(id) } } }; },
    async state() { return { cursor: 0 }; },
    async prompt(req) {
      assert.match(req.content[0].text, /聊天工具/);
      const tool = active.get(`${req.sessionId}/maomao_generate_image`);
      assert.ok(tool);
      const value = await tool.execute({ prompt: 'a flower', aspect_ratio: '1:1', use_reference: false },
        { agent: { id: req.sessionId }, signal: AbortSignal.timeout(2000), concludeTurn() {} });
      assert.equal(value.status, 'sent');
    },
    async wait() { return { reason: 'idle', output: { records: [{ event: { type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'do not duplicate' }] } } } }] } }; },
  };
  const transport = { ready: () => true,
    async replyMedia(event, output) { sent.push([event.platform, event.chatId, output.kind]); return 'sent'; },
    async reply() { assert.fail('must not send duplicate text after media'); },
  };
  const models = { mediaChoice: (role) => role === 'image' ? { enabled: true } : null,
    async mediaAdapter() { return { generate: async () => media }; } };
  const bindings = [{ owner: 'same-owner', endpoints: [
    { platform: 'feishu', accountId: 'cli_test', chatId: 'oc_test', senderId: 'ou_test' },
    { platform: 'telegram', accountId: '2000', chatId: '1001', senderId: '1001' },
  ] }];
  const connector = new PrivateConnector({ sessionController: controller,
    get: (key) => key === 'maomaoModels' ? models : undefined,
  }, { stateRoot: root, memory: { enabled: false }, bindings,
    feishu: { accountId: 'cli_test' }, telegram: { accountId: '2000', debounceMs: 0 },
  }, { routes: new Map([['feishu', transport], ['telegram', transport]]) });
  try {
    for (const endpoint of bindings[0].endpoints) {
      assert.equal(connector.accept({ ...endpoint, messageId: `msg-${endpoint.platform}`, text: '来个水彩风的吧', receivedAt: Date.now() }), true);
    }
    for (let i = 0; i < 300 && sent.length < 2; i++) await pause(10);
    await pause(20);
    assert.deepEqual(sent, [['feishu', 'oc_test', 'image'], ['telegram', '1001', 'image']]);
    assert.equal(active.size, 0);
    assert.equal(nextSession, 2);
  } finally { await connector.stop(); await rm(root, { recursive: true, force: true }); }
});
