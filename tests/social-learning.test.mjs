import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LearningRuntime } from '../integrations/maomao-dsh/learning.mjs';
import { openStickerTools } from '../integrations/maomao-dsh/sticker-tools.mjs';
import { OwnerMemory } from '../integrations/maomao-dsh/private-connector/memory.mjs';
import { OrdinaryBridge } from '../integrations/maomao-dsh/qq-connector/ordinary.mjs';
import { PrivateConnector, PRESET } from '../integrations/maomao-dsh/private-connector/index.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=';
const picture = { data: png, mediaType: 'image/png' };
const description = { description: '得意的小猫', text: '中', category: '赞同', is_meme: true,
  confidence: .6, personal_or_sensitive: false, steal_reason: '表示赞同' };
const ownerA = 'a'.repeat(64), ownerB = 'b'.repeat(64), turn = 'c'.repeat(64);
const bind = (lease, signal) => {
  let definition;
  const close = lease.bind('session', { register(d) { definition = d; return () => {}; } });
  return { close, run: args => definition.execute(args, { agent: { id: 'session' }, signal }), definition };
};

test('style is scoped, search evidence can teach memes but cannot become personal facts, and failure is not evidence', async t => {
  const root = await mkdtemp(join(tmpdir(), 'social-learning-'));
  const queries = [];
  const runtime = new LearningRuntime({ get: name => name === 'web' ? { async search({ query }) {
    queries.push(query); return { sources: [{ url: 'https://example.com/explanation', title: '梗用法', summary: '测试梗表示善意赞同，也可能是反讽，要看语境。' }] };
  } } : null }, { root });
  t.after(async () => { runtime.close(); await rm(root, { recursive: true, force: true }); });
  const signal = new AbortController().signal;
  const options = { namespace: 'qq', scope: 'group-a', subject: 'member-a', platform: 'qq', owner: false,
    text: '中，俺觉得可以。这个测试梗是什么意思？', sourceId: 'turn-a', current: () => true, signal };
  const lease = runtime.open(options), definitions = new Map();
  lease.bind('one', { register(d) { definitions.set(d.name, d); return () => {}; } });
  const run = (name, args) => definitions.get(name).execute(args, { agent: { id: 'one' }, signal });
  const style = await run('maomao_memory', { action: 'save', kind: 'style', title: '赞同时的说话习惯',
    body: '常用简短的“中”表示赞同，可以偶尔接这种口语；仍保持自己的猫猫语气。', quote: '中', source: lease.source });
  assert.equal(style.status, 'saved');
  const found = JSON.parse((await run('maomao_meme', { term: '测试梗' })).data);
  assert.deepEqual(queries, ['测试梗 是什么梗 含义 用法']);
  const entry = { action: 'save', kind: 'meme', title: '测试梗', body: '表达赞同或反讽，使用前结合上下文。',
    quote: '测试梗表示善意赞同', source: found.source, certainty: 'tentative', ttlDays: 30 };
  assert.equal((await run('maomao_memory', { ...entry, kind: 'profile' })).status, 'denied');
  const saved = await run('maomao_memory', entry);
  assert.equal(saved.status, 'saved');
  const row = runtime.store(lease.scopeId).get(JSON.parse(saved.data).id);
  assert.match(row.body, /https:\/\/example.com\/explanation/);
  assert.match(runtime.open({ ...options, sourceId: 'turn-b', text: '再接个梗' }).context(), /测试梗/);
  assert.doesNotMatch(runtime.open({ ...options, scope: 'group-b' }).context(), /表达赞同或反讽/);
  assert.equal(runtime.panel({ action: 'read', sourceId: lease.scopeId, kind: 'style' }).total, 1);
});

test('private sticker tools collect once by model choice, share authorized owner library, send only listed IDs and refuse photos', async t => {
  const root = await mkdtemp(join(tmpdir(), 'private-sticker-tools-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const memory = new OwnerMemory({ root });
  const signal = AbortSignal.timeout(20000), sent = [];
  const operate = (owner) => (action, args, deadline = signal) => memory.run('sticker_tool', { owner, turnId: turn, details: { action, ...args } }, deadline);
  let current = true;
  const lease = openStickerTools({ current: () => current, signal, images: [picture],
    operate: operate(ownerA), describe: async () => description, send: async media => { sent.push(media); return 'sent'; } });
  const tools = bind(lease, signal);
  assert.equal((await tools.run({ action: 'send', id: '../../other/file' })).status, 'missing');
  const collected = await tools.run({ action: 'collect', id: 'image-1', reason: '这个得意脸适合回一句中' });
  assert.equal(collected.status, 'saved');
  assert.equal(JSON.parse(collected.data).new, true, 'no repeated-sighting heuristic on model-decided collection');
  assert.equal((await tools.run({ action: 'collect', id: 'image-1', reason: '重复' })).status, 'already_collected');
  const shared = await operate(ownerA)('search', { query: '赞同' });
  assert.equal(shared.items.length, 1);
  assert.equal((await operate(ownerB)('search', { query: '赞同' })).items.length, 0);
  const sentResult = await tools.run({ action: 'send', id: shared.items[0].id });
  assert.equal(sentResult.status, 'sent'); assert.equal(sent[0].mediaType, 'image/png');
  assert.equal(sent[0].buffer.subarray(1, 4).toString(), 'PNG');
  assert.equal((await tools.run({ action: 'send', id: shared.items[0].id })).status, 'limit');
  current = false; assert.equal((await tools.run({ action: 'search' })).status, 'denied'); tools.close();
  const privatePhoto = bind(openStickerTools({ current: () => true, signal, images: [picture], operate: operate(ownerB),
    describe: async () => ({ ...description, personal_or_sensitive: true }), send: async () => assert.fail('private photo sent') }), signal);
  assert.equal((await privatePhoto.run({ action: 'collect', id: 'image-1', reason: '不能偷照片' })).status, 'not_collectible');
  privatePhoto.close();
});

test('QQ model-owned library uses the existing isolated storage and cannot send another group sticker', async t => {
  const root = await mkdtemp(join(tmpdir(), 'qq-sticker-tools-'));
  const bridge = new OrdinaryBridge({ root });
  t.after(async () => { await bridge.stop(); await rm(root, { recursive: true, force: true }); });
  const envelope = { channel: 'qq', scope: 'group', botId: 'bot-a', chatId: 'group-a', senderId: 'person', messageId: 'image', receivedAt: Date.now(), text: '', attachments: [{ kind: 'image' }] };
  const collected = await bridge.media('sticker_tool', envelope, { action: 'collect', data: png, description });
  assert.equal(collected.status, 'saved');
  const found = await bridge.media('sticker_tool', envelope, { action: 'search', query: '赞同' });
  assert.equal(found.items[0].id, collected.id);
  const other = { ...envelope, chatId: 'group-b' };
  assert.equal((await bridge.media('sticker_tool', other, { action: 'search', query: '赞同' })).items.length, 0);
  assert.equal((await bridge.media('sticker_tool', other, { action: 'resolve', id: collected.id })).status, 'missing');
});

test('Lark collects through the actual model tool and Telegram reuses it without a repeated picture or fixed notice', async t => {
  const root = await mkdtemp(join(tmpdir(), 'social-private-integration-'));
  const runtime = new LearningRuntime({ get() {} }, { root: join(root, 'learning'), reviewer: async () => ({ ordinary: true, updates: [] }) });
  const active = new Map(), sent = []; let seq = 0, task = 'collect';
  const controller = {
    async create() { return { sessionId: `session-${++seq}` }; },
    async projections() { return { values: { agentPreset: PRESET } }; },
    async resolveAgent(id) { return { agent: { id, ctx: { get: () => ({ register(d) { active.set(`${id}/${d.name}`, d); return () => active.delete(`${id}/${d.name}`); } }) } } }; },
    async state() { return { cursor: 0 }; },
    async prompt(req) {
      assert.match(req.content[0].text, /表情工具/);
      const tool = active.get(`${req.sessionId}/maomao_stickers`);
      assert.ok(tool, 'native tool must be registered before the model call');
      const exec = { agent: { id: req.sessionId }, signal: AbortSignal.timeout(10000) };
      if (task === 'collect') {
        const result = await tool.execute({ action: 'collect', id: 'image-1', reason: '这个得意脸以后表示赞同很合适' }, exec);
        assert.equal(result.status, 'saved');
      } else {
        const found = JSON.parse((await tool.execute({ action: 'search', query: '赞同' }, exec)).data);
        assert.equal(found.items.length, 1);
        assert.equal((await tool.execute({ action: 'send', id: found.items[0].id }, exec)).status, 'sent');
      }
    },
    async wait() { return { reason: 'idle', output: { records: [{ event: { type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: task === 'collect' ? '这个得意脸留下啦，下次赞同你就用它。' : '中，就用这个。' }] } } } }] } }; },
  };
  const transport = { ready: () => true, image: async () => picture,
    async reply(event, text) { sent.push({ platform: event.platform, text }); return `sent-${sent.length}`; },
    async replyMedia(event, media) { sent.push({ platform: event.platform, kind: media.kind }); return `sent-${sent.length}`; } };
  const models = { mediaChoice: role => role === 'vision' ? { enabled: true } : null,
    mediaAdapter: async () => ({ inspect: async () => '得意的小猫', describe: async () => description }) };
  const bindings = [{ owner: 'same-owner', endpoints: [
    { platform: 'feishu', accountId: 'cli_test', chatId: 'oc_test', senderId: 'ou_test' },
    { platform: 'telegram', accountId: '2000', chatId: '1001', senderId: '1001' },
  ] }];
  const connector = new PrivateConnector({ sessionController: controller,
    get: key => key === 'maomaoModels' ? models : key === 'maomaoLearning' ? runtime : undefined },
  { stateRoot: root, memory: { shared: true }, bindings, feishu: { accountId: 'cli_test', debounceMs: 0 }, telegram: { accountId: '2000', debounceMs: 0 } },
  { routes: new Map([['feishu', transport], ['telegram', transport]]) });
  t.after(async () => { await connector.stop(); runtime.close(); await rm(root, { recursive: true, force: true }); });
  async function until(count) {
    for (let i = 0; i < 200 && sent.length < count; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(sent.length, count);
  }
  connector.accept({ ...bindings[0].endpoints[0], messageId: 'om_photo', text: '看看这个表情', media: {}, receivedAt: Date.now() });
  await until(1);
  assert.match(sent[0].text, /得意脸留下/);
  task = 'reuse';
  connector.accept({ ...bindings[0].endpoints[1], messageId: '2', text: '发一个赞同表情吧', receivedAt: Date.now() });
  await until(3);
  assert.deepEqual(sent.slice(1).map(v => [v.platform, v.kind ?? 'text']), [['telegram', 'sticker'], ['telegram', 'text']]);
  assert.equal(active.size, 0);
});
