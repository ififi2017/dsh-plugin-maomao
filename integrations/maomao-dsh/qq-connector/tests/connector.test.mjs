import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { ApiError } from '@tencent-connect/qqbot-nodejs';

import { finalAssistantText, HarnessConversation } from '../harness.mjs';
import { allowedInbound, inboundImage, normalizeInbound, recentImageFor, textBubbles } from '../inbound.mjs';
import { loadQqImage, qqMediaUrl } from '../media.mjs';
import { apply, MaomaoQqConnector } from '../index.mjs';
import { ConnectorState } from '../state.mjs';

function rawMessage(overrides = {}) {
  return {
    kind: 'group', rawEventType: 'GROUP_MESSAGE_CREATE', groupOpenid: 'group-one',
    senderId: 'member-one', messageId: 'message-one', content: '你好', timestamp: '2026-11-08T00:00:00Z',
    attachments: [{ content_type: 'image/png', url: 'https://example.invalid/cat.png', filename: 'cat.png' }],
    ...overrides,
  };
}

test('QQ renders formatted replies and falls back on a definite Markdown rejection only', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'maomao-qq-markdown-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sent = [];
  let receiptKey;
  let stop;
  const bot = {
    use() {}, on() {}, start() { return new Promise((resolve) => { stop = resolve; }); },
    stop() { stop?.(); },
    async send(options) {
      sent.push(options);
      if (options.msgType === 2 && options.target.msgId === 'denied') {
        throw new ApiError('Markdown denied', 400, '/messages', 40034012);
      }
      if (options.target.msgId === 'timeout') throw new ApiError('Request timed out', 0, '/messages');
      return { id: 'delivered' };
    },
  };
  const connector = new MaomaoQqConnector(
    { sessionController: {}, emit: (_, value) => { receiptKey = value.receiptKey; }, logger: {} },
    { groupAllowlist: ['group-one'], respondToMentions: false, statePath: join(directory, 'state.json') },
    { managedCredential: { appId: 'test-app', secret: 'test-secret' }, botFactory: () => bot },
  );
  await connector.start();
  try {
    async function reply(messageId, text) {
      await connector.accept(rawMessage({ messageId }));
      return connector.respond(receiptKey, text);
    }
    await reply('native', '拍鸟最难的是**找鸟**。');
    assert.equal(sent[0].msgType, 2);
    assert.deepEqual(sent[0].markdown, { content: '拍鸟最难的是**找鸟**。' });
    const table = '| 项目 | 状态 |\n| --- | --- |\n| 找鸟 | 完成 |';
    await reply('native-table', table);
    assert.equal(sent[1].msgType, 2);
    assert.deepEqual(sent[1].markdown, { content: table });
    await assert.rejects(reply('timeout', '**投递未知**'), /timed out/);
    assert.equal(sent.length, 3);
    await reply('denied', '## 要点\n- **找鸟** 和 `a * b`，比 2 * 3 * 4 难。');
    assert.equal(sent[3].msgType, 2);
    assert.equal(sent[4].msgType, 0);
    assert.equal(sent[4].content, '要点\n• 找鸟 和 a * b，比 2 * 3 * 4 难。');
    assert.deepEqual(sent[3].target, sent[4].target);
    assert.deepEqual(sent[3].extra, sent[4].extra);
    await reply('after-denial', '还有**第二句**。');
    assert.equal(sent.length, 6);
    assert.equal(sent[5].content, '还有第二句。');
    await reply('table-fallback', '| 项目 | 状态 |\n| --- | --- |\n| 找鸟 | 完成 |');
    assert.equal(sent[6].msgType, 0);
    assert.equal(sent[6].content, '| 项目 | 状态 |\n| 找鸟 | 完成 |');
  } finally {
    await connector.stop();
  }
});

test('normalizes immutable per-message identity and observes unmentioned media', () => {
  const message = normalizeInbound(rawMessage());
  assert.equal(message.channel, 'qq');
  assert.equal(message.chatId, 'group-one');
  assert.equal(message.senderId, 'member-one');
  assert.equal(message.addressed, false);
  assert.equal(message.addressedToOther, false);
  assert.equal(message.attachments[0].kind, 'image');
  assert.ok(Object.isFrozen(message) && Object.isFrozen(message.attachments[0]));
  assert.equal(allowedInbound(message, { groupAllowlist: ['group-one'] }), true);
  assert.equal(allowedInbound(message, { groupAllowlist: [] }), false);
  assert.equal(normalizeInbound(rawMessage({ senderId: '' })), null);
  assert.equal(normalizeInbound(rawMessage({ senderIsBot: true })), null);
  assert.equal(normalizeInbound(rawMessage({ rawEventType: 'GROUP_AT_MESSAGE_CREATE' })).addressed, true);
  assert.equal(normalizeInbound(rawMessage({ mentions: [{ is_you: false }] })).addressedToOther, true);
  const otherMention = normalizeInbound(rawMessage({
    rawEventType: 'GROUP_AT_MESSAGE_CREATE', content: '<@other> 你好',
    raw: { content: '<@bot> <@other> 你好' },
  }));
  assert.equal(otherMention.text, '<@other> 你好');
  assert.notEqual(normalizeInbound(rawMessage(), 100, 'app-a').receiptKey,
    normalizeInbound(rawMessage(), 100, 'app-b').receiptKey);
});

test('resolves only the quoted QQ message and keeps its media separate from direct uploads', () => {
  const quoted = { msg_idx: '100', attachments: [{ content_type: 'image/jpeg', url: '//img.qpic.cn/quoted' }] };
  const other = { msg_idx: '101', attachments: [{ content_type: 'image/png', url: '//img.qpic.cn/other' }] };
  const input = { attachments: [], refMsgIdx: '100', raw: { message_type: 103, msg_elements: [other, quoted] } };
  const envelope = normalizeInbound(rawMessage(input));
  assert.deepEqual(envelope.attachments, []);
  assert.equal(inboundImage(envelope).sourceUrl, quoted.attachments[0].url);
  assert.ok(Object.isFrozen(envelope.quotedImages));
  assert.equal(inboundImage(normalizeInbound(rawMessage({ ...input, refMsgIdx: '102' }))), undefined);
  assert.equal(inboundImage(normalizeInbound(rawMessage({ ...input, msgType: 0 }))), undefined);
  const withDirect = normalizeInbound(rawMessage({ ...input, attachments: other.attachments }));
  assert.equal(inboundImage(withDirect), withDirect.attachments[0]);
});

test('split QQ image pairing is short-lived and scoped to the same sender, group and bot', () => {
  const at = normalizeInbound(rawMessage({ messageId: 'at', rawEventType: 'GROUP_AT_MESSAGE_CREATE',
    content: '帮我看看', attachments: [] }), 10_000, 'test-app');
  const photo = normalizeInbound(rawMessage({ messageId: 'photo', content: '' }), 10_500, 'test-app');
  assert.equal(recentImageFor(at, [photo]), photo);
  for (const changes of [{ senderId: 'other' }, { chatId: 'other' }, { botId: 'other' },
    { addressed: true }, { addressedToOther: true }, { receivedAt: 10_751 }, { receivedAt: 6_999 }]) {
    assert.equal(recentImageFor(at, [{ ...photo, ...changes }]), null);
  }
});

test('QQ downloads native quoted and split images and delivers the recognition to the addressed turn', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'maomao-qq-inbound-images-'));
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const downloads = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    downloads.push([url, options.headers.Authorization]);
    return new Response(png);
  });
  const asks = [];
  const claims = [];
  const inspected = [];
  let finish;
  const bot = {
    api: { async getToken() { return 'fake-token'; } },
    use() {}, on() {}, start() { return new Promise((resolve) => { finish = resolve; }); },
    stop() { finish(); }, async send() { return { id: 'sent' }; },
  };
  const models = {
    mediaChoice: (kind) => kind === 'vision' ? { enabled: true } : null,
    async mediaAdapter() {
      return { async inspect(image) { inspected.push(image); return `识图结果 ${image.name}`; } };
    },
  };
  const connector = new MaomaoQqConnector(
    { sessionController: {}, emit() {}, logger: {}, get: (key) => key === 'maomaoModels' ? models : undefined },
    { groupAllowlist: ['group-one'], statePath: join(directory, 'state.json') },
    { managedCredential: { appId: 'test-app', secret: 'test-secret' }, botFactory: () => bot,
      ordinary: { async media(op, envelope) { claims.push([op, envelope.messageId, envelope.attachments[0]?.kind]);
        return { allowed: true }; }, async stop() {} },
      harness: { async ask(envelope, options) { asks.push([envelope.messageId, options]); return '看到了'; } } },
  );
  const image = (name) => ({ content_type: 'image/png', url: `//img.qpic.cn/${name}`, filename: name });
  const at = (messageId, content = '', extra = {}) => rawMessage({ messageId, rawEventType: 'GROUP_AT_MESSAGE_CREATE',
    attachments: [], content, ...extra });
  const photo = (messageId) => rawMessage({ messageId, content: '', attachments: [image(messageId)] });
  const untilAsked = async (count) => {
    for (let i = 0; i < 250 && asks.length < count; i++) await pause(10);
    assert.equal(asks.length, count);
  };
  try {
    await connector.start();
    await connector.accept(at('quote', '这是什么？', {
      msgType: 103, refMsgIdx: '100', msgElements: [{ msg_idx: '100', attachments: [image('quoted')] }],
    }));
    await untilAsked(1);
    await connector.accept(photo('photo-before'));
    await connector.accept(at('at-after', '看一下'));
    await untilAsked(2);
    await connector.accept(at('at-before'));
    await connector.accept(photo('photo-after'));
    await untilAsked(3);
    await connector.accept(at('direct', '', { attachments: [image('direct')] }));
    await untilAsked(4);
    assert.deepEqual(asks.map(([id, options]) => [id, options.imageDescription, options.referencedImage]), [
      ['quote', '识图结果 quoted', { quoted: true }],
      ['at-after', '识图结果 photo-before', { sameSender: true }],
      ['at-before', '识图结果 photo-after', { sameSender: true }],
      ['direct', '识图结果 direct', null],
    ]);
    assert.deepEqual(claims, ['quote', 'photo-before', 'photo-after', 'direct'].map((id) => ['vision_claim', id, 'image']));
    assert.deepEqual(inspected.map(({ data }) => data), Array(4).fill(png.toString('base64')));
    assert.deepEqual(downloads, ['quoted', 'photo-before', 'photo-after', 'direct']
      .map((name) => [`https://img.qpic.cn/${name}`, 'QQBot fake-token']));
  } finally {
    await connector.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('panel pairing admits exactly the verified QQ scope without emitting the pairing message', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'maomao-qq-pairing-'));
  const env = { MAOMAO_QQ_APP_ID: 'test-app', MAOMAO_QQ_APP_SECRET: 'test-secret',
    MAOMAO_QQ_CONNECT: 'I_STOPPED_HERMES_QQ' };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  });
  const sent = [];
  const events = [];
  const callbacks = new Map();
  let finishRun;
  const bot = { use() {}, on(name, callback) { callbacks.set(name, callback); },
    start() { return new Promise((resolve) => { finishRun = resolve; }); },
    stop() { finishRun(); }, async send(value) { sent.push(value); return { id: 'sent' }; } };
  const statePath = join(directory, 'state.json');
  const connector = new MaomaoQqConnector({ sessionController: {}, emit: (_name, value) => events.push(value) },
    { statePath, groupAllowlist: [], dmAllowlist: [] },
    { botFactory: () => bot, harness: { async ask() { return '你好喵。'; } } });
  await connector.start();
  try {
    callbacks.get('ready')();
    const start = await connector.pair({ action: 'start', scope: 'group' });
    assert.deepEqual(await connector.pair({ action: 'current' }), start);
    assert.equal(await connector.accept(rawMessage({ content: start.command })), false);
    const addressed = { rawEventType: 'GROUP_AT_MESSAGE_CREATE', content: `<@bot> ${start.command}` };
    assert.equal(await connector.accept(rawMessage(addressed)), true);
    assert.equal(events.length, 0);
    assert.equal(sent.length, 1);
    assert.equal((await connector.pair({ action: 'read', id: start.id })).delivery, 'sent');
    const proof = sent[0].content.match(/[a-f0-9]{8}/)[0];
    const binding = await connector.pair({ action: 'confirm', id: start.id, proof });
    assert.equal(binding.status, 'bound');
    assert.equal(await connector.accept(rawMessage({ messageId: 'admitted' })), true);
    assert.equal(await connector.accept(rawMessage({ groupOpenid: 'group-other', messageId: 'denied' })), false);
    assert.equal(events.length, 1);
    const check = (action) => connector.replyCheck({ action, route: binding.route });
    const sample = check('start');
    assert.equal(await connector.accept(rawMessage({ messageId: 'sample-without-mention', content: sample.text })), true);
    assert.equal(check('read').status, 'waiting');
    assert.equal(await connector.accept(rawMessage({ messageId: 'sample', attachments: [],
      rawEventType: 'GROUP_AT_MESSAGE_CREATE', content: `<@bot> ${sample.text}` })), true);
    for (let i = 0; i < 100 && check('read').status !== 'sent'; i++) await pause(10);
    assert.equal(check('read').status, 'sent');
    assert.equal(sent.at(-1).target.msgId, 'sample');
    assert.match(sent.at(-1).content, /你好喵/);
    const owner = await connector.pair({ action: 'start', scope: 'owner' });
    const ownerMessage = { rawEventType: 'GROUP_AT_MESSAGE_CREATE', content: `<@bot> ${owner.command}` };
    assert.equal(await connector.accept(rawMessage({ ...ownerMessage, groupOpenid: 'group-other', messageId: 'owner-denied' })), false);
    assert.equal(await connector.accept(rawMessage({ ...ownerMessage, messageId: 'owner-proof' })), true);
    const ownerProof = sent.at(-1).content.match(/[a-f0-9]{8}/)[0];
    assert.equal((await connector.pair({ action: 'confirm', id: owner.id, proof: ownerProof })).status, 'bound');
    const state = await new ConnectorState(statePath).load();
    assert.equal(state.panelAllowed('test-app', 'group', 'group-one'), true);
    assert.equal(state.panelAllowed('other-app', 'group', 'group-one'), false);
    assert.equal(state.panelAllowed('test-app', 'c2c', 'group-one'), false);
    assert.equal(state.memoryGroups('test-app').length, 1);
    assert.deepEqual(state.memoryGroups('other-app'), []);
    assert.equal(state.panelOwnsGroup('test-app', 'group-one', 'member-one'), true);
    assert.equal(state.panelOwnsGroup('test-app', 'group-one', 'member-two'), false);
    assert.equal(state.panelOwnsGroup('test-app', 'group-other', 'member-one'), false);
    assert.equal(state.panelOwnsGroup('other-app', 'group-one', 'member-one'), false);
    assert.equal(await connector.unbind(state.panelOwnerBindings('test-app')[0].id), true);
    await state.load();
    assert.equal(state.panelOwnsGroup('test-app', 'group-one', 'member-one'), false);
    assert.equal(state.panelAllowed('test-app', 'group', 'group-one'), true);
    assert.equal(await connector.unbind(state.panelRoutes('test-app')[0].id), true);
    await state.load();
    assert.deepEqual(state.memoryGroups('test-app'), []);
  } finally { await connector.stop(); }
});

test('shadow receives QQ ingress and passes only same-group ambient context to Harness', { timeout: 4_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maomao-qq-shadow-bridge-'));
  const old = [process.env.MAOMAO_QQ_APP_ID, process.env.MAOMAO_QQ_APP_SECRET, process.env.MAOMAO_QQ_CONNECT];
  process.env.MAOMAO_QQ_APP_ID = 'test-app';
  process.env.MAOMAO_QQ_APP_SECRET = 'test-secret';
  process.env.MAOMAO_QQ_CONNECT = 'I_STOPPED_HERMES_QQ';
  const asks = [];
  const sent = [];
  const { promise: firstSent, resolve: noteSend } = Promise.withResolvers();
  let finishRun;
  const bot = { use() {}, on() {}, start() { return new Promise((resolve) => { finishRun = resolve; }); },
    stop() { finishRun?.(); }, async send(value) {
      sent.push(value);
      noteSend();
      return { id: `reply-${sent.length}` };
    } };
  try {
    const connector = new MaomaoQqConnector(
      { sessionController: {}, emit() {}, logger: console },
      { groupAllowlist: ['group-one', 'group-two'], dmAllowlist: [],
        statePath: join(directory, 'state.json'),
        shadow: { enabled: true, path: join(directory, 'shadow.jsonl'), debounceMs: 1 } },
      { botFactory: () => bot, harness: { async ask(envelope, options) {
        asks.push({ envelope, options }); return '猫猫在';
      } } },
    );
    await connector.start();
    await connector.accept(rawMessage({ messageId: 'ambient-one', content: '这只鸟真漂亮', attachments: [] }));
    await connector.accept(rawMessage({ messageId: 'ambient-other', groupOpenid: 'group-two',
      content: '另一个群的私事', attachments: [] }));
    await connector.accept(rawMessage({ messageId: 'direct-one', rawEventType: 'GROUP_AT_MESSAGE_CREATE',
      content: '猫猫，那只鸟呢？', attachments: [] }));
    await firstSent;
    assert.equal(asks.length, 1);
    assert.equal(asks[0].options.ambient.length, 1);
    assert.match(asks[0].options.ambient[0].text, /这只鸟真漂亮/);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].target.msgId, 'direct-one');
    await connector.stop();
  } finally {
    [process.env.MAOMAO_QQ_APP_ID, process.env.MAOMAO_QQ_APP_SECRET, process.env.MAOMAO_QQ_CONNECT] = old;
    for (const name of ['MAOMAO_QQ_APP_ID', 'MAOMAO_QQ_APP_SECRET', 'MAOMAO_QQ_CONNECT']) {
      if (process.env[name] === 'undefined') delete process.env[name];
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('ordinary context reaches addressed Harness turn and memory failure does not block reply', { timeout: 4_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maomao-qq-ordinary-integration-'));
  const old = [process.env.MAOMAO_QQ_APP_ID, process.env.MAOMAO_QQ_APP_SECRET, process.env.MAOMAO_QQ_CONNECT];
  process.env.MAOMAO_QQ_APP_ID = 'test-app';
  process.env.MAOMAO_QQ_APP_SECRET = 'test-secret';
  process.env.MAOMAO_QQ_CONNECT = 'I_STOPPED_HERMES_QQ';
  let finishRun;
  const bot = { use() {}, on() {}, start() { return new Promise((resolve) => { finishRun = resolve; }); },
    stop() { finishRun?.(); }, async send() { return { id: 'sent' }; } };
  const asks = [];
  const seen = [];
  const { promise: bothAsked, resolve: recordBothAsks } = Promise.withResolvers();
  try {
    const connector = new MaomaoQqConnector({ sessionController: {}, emit() {}, logger: console },
      { groupAllowlist: ['group-one'], dmAllowlist: [], statePath: join(directory, 'state.json'),
        ordinary: { enabled: true } },
      { botFactory: () => bot,
        ordinary: { async observe(envelope) {
          seen.push(envelope.messageId);
          if (envelope.messageId === 'failure') throw new Error('storage_unavailable');
          return { context: { user_preferences: [{ topic: '拍鸟' }] } };
        }, async stop() {} },
        harness: { async ask(_envelope, options) {
          asks.push(options);
          if (asks.length === 2) recordBothAsks();
          return '喵';
        } } });
    await connector.start();
    await connector.accept(rawMessage({ messageId: 'unmentioned', attachments: [] }));
    await connector.accept(rawMessage({ messageId: 'addressed', rawEventType: 'GROUP_AT_MESSAGE_CREATE', attachments: [] }));
    await connector.accept(rawMessage({ messageId: 'failure', rawEventType: 'GROUP_AT_MESSAGE_CREATE', attachments: [] }));
    await bothAsked;
    assert.deepEqual(seen, ['unmentioned', 'addressed', 'failure']);
    assert.equal(asks.length, 2);
    assert.deepEqual(asks[0].ordinaryContext.user_preferences, [{ topic: '拍鸟' }]);
    assert.equal(asks[1].ordinaryContext, null);
    await connector.stop();
  } finally {
    [process.env.MAOMAO_QQ_APP_ID, process.env.MAOMAO_QQ_APP_SECRET, process.env.MAOMAO_QQ_CONNECT] = old;
    for (const name of ['MAOMAO_QQ_APP_ID', 'MAOMAO_QQ_APP_SECRET', 'MAOMAO_QQ_CONNECT']) {
      if (process.env[name] === 'undefined') delete process.env[name];
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('dry-run Host service exposes reply operations but not synthetic ingress', () => {
  let service;
  apply({ sessionController: {}, provide(name, value) { assert.equal(name, 'maomaoQq'); service = value; } },
    { enabled: true, dryRun: true });
  assert.deepEqual(Object.keys(service).sort(), ['loadImages', 'respond', 'status']);
  assert.equal(service.status().running, false);
});

test('preserves natural short bubbles and keeps code blocks together', () => {
  assert.deepEqual(textBubbles('一<|bubble|>二<|bubble|>三', 2), ['一', '二\n\n三']);
  assert.deepEqual(textBubbles('```js\na()\n```<|bubble|>解释'), ['```js\na()\n```\n\n解释']);
});

test('image reader accepts only bounded QQ media and checks file bytes', async () => {
  assert.equal(qqMediaUrl('http://qpic.cn/cat'), null);
  assert.equal(qqMediaUrl('https://qpic.cn.evil.test/cat'), null);
  assert.equal(qqMediaUrl('https://127.0.0.1/cat'), null);
  assert.equal(qqMediaUrl('https://img.qpic.cn/cat'), 'https://img.qpic.cn/cat');
  assert.equal(qqMediaUrl('https://multimedia.nt.qq.com.cn/cat'), 'https://multimedia.nt.qq.com.cn/cat');
  assert.equal(qqMediaUrl('https://multimedia.nt.qq.com.cn.evil.test/cat'), null);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X4XcAAAAASUVORK5CYII=', 'base64');
  let auth = '';
  const image = await loadQqImage({ kind: 'image', sourceUrl: 'https://img.qpic.cn/cat', name: 'cat.png' }, {
    getToken: async () => 'synthetic-token',
    fetchImpl: async (_url, options) => {
      auth = options.headers.Authorization;
      assert.equal(options.redirect, 'manual');
      return new Response(png, { status: 200 });
    },
  });
  assert.equal(auth, 'QQBot synthetic-token');
  assert.equal(image.mediaType, 'image/png');
  assert.equal(image.data, png.toString('base64'));
  assert.equal(await loadQqImage({ kind: 'image', sourceUrl: 'https://evil.test/cat' }), null);
  await assert.rejects(loadQqImage({ kind: 'image', sourceUrl: 'https://img.qpic.cn/cat' }, {
    fetchImpl: async () => new Response(Buffer.alloc(5_000_001), { status: 200 }),
  }), /size limit/);
});

test('reply reservation is durable, bounded, and never resends an uncertain segment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maomao-qq-state-'));
  let now = 1_000_000;
  const path = join(directory, 'state.json');
  try {
    const state = await new ConnectorState(path, { clock: () => now }).load();
    const envelope = normalizeInbound(rawMessage(), now);
    assert.equal(await state.recordReceipt(envelope), true);
    assert.equal(await state.recordReceipt(envelope), false);
    const first = await state.reserve(envelope, '0\u0000第一条');
    assert.equal(first.seq, 1);
    await state.finish(first.key);
    const restored = await new ConnectorState(path, { clock: () => now }).load();
    const repeated = await restored.reserve(envelope, '0\u0000第一条');
    assert.equal(repeated.fresh, false);
    assert.equal(repeated.status, 'uncertain');
    for (let index = 1; index < 5; index++) {
      const ticket = await restored.reserve(envelope, `${index}\u0000第${index}条`);
      assert.equal(ticket.seq, index + 1);
      await restored.finish(ticket.key, `sent-${index}`);
    }
    await assert.rejects(restored.reserve(envelope, '5\u0000第六条'), /budget exhausted/);
    now += 5 * 60_000 + 1;
    await assert.rejects(restored.reserve(envelope, '6\u0000过期'), /expired/);
    await restored.bindSession('app-a', 'group', 'group-one', 'session-a');
    assert.equal(restored.sessionId('app-a', 'group', 'group-one'), 'session-a');
    assert.equal(restored.sessionId('app-b', 'group', 'group-one'), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Harness bridge keeps one session per QQ chat and reads only new assistant output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maomao-qq-harness-'));
  try {
    const state = await new ConnectorState(join(directory, 'state.json')).load();
    const calls = [];
    const sections = [];
    await state.bindSession('', 'group', 'group-one', 'legacy-standard');
    const controller = {
      async create(request) { calls.push(['create', request]); return { sessionId: 'session-one' }; },
      async projections({ sessionId }) { return { values: { agentPreset: sessionId === 'legacy-standard'
        ? 'standard' : 'maomao-qq-ordinary' } }; },
      async state(request) { calls.push(['state', request]); return { cursor: 7 }; },
      async prompt(request) { calls.push(['prompt', request]); return { accepted: true }; },
      async resolveAgent() { return { agent: { ctx: { get: (name) => name === 'systemPrompt'
        ? { getSectionOrder: () => 0, section: (value) => { sections.push(value.text); return () => {}; } } : undefined } } }; },
      async wait(request) {
        calls.push(['wait', request]);
        return { reason: 'idle', output: { records: [{ event: {
          type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '喵～' }] } },
        } }] } };
      },
    };
    const bridge = new HarnessConversation(controller, state, { workspace: directory });
    const envelope = normalizeInbound(rawMessage({ rawEventType: 'GROUP_AT_MESSAGE_CREATE' }));
    assert.equal(await bridge.ask(envelope), '喵～');
    assert.equal(await bridge.ask({ ...envelope, messageId: 'message-two' }, {
      ambient: [{ role: 'user', speaker: 'member-hash', text: '刚才提到的鸟', age_seconds: 5 }],
      ordinaryContext: { user_preferences: [{ topic: '拍翠鸟' }] },
    }), '喵～');
    assert.equal(calls.filter(([kind]) => kind === 'create').length, 1);
    assert.equal(calls.find(([kind]) => kind === 'create')[1].agentPreset, 'maomao-qq-ordinary');
    assert.equal(calls.find(([kind]) => kind === 'prompt')[1].sessionId, 'session-one');
    assert.equal(calls.find(([kind]) => kind === 'wait')[1].afterSeq, 7);
    // The stored message keeps only what was said; this turn's reference material rides in the
    // turn's system section, which is removed afterwards, so it never piles up in history.
    assert.match(calls.find(([kind]) => kind === 'prompt')[1].content[0].text, /^\[\d{1,2}月\d{1,2}日周. \d{2}:\d{2}\] 你好$/);
    assert.match(sections[0], /本轮参考资料[\s\S]*\[这次你没看清对方发的图/);
    const second = calls.filter(([kind]) => kind === 'prompt').at(-1)[1].content[0].text;
    assert.doesNotMatch(second, /近期同群消息|普通记忆/);
    assert.match(sections.at(-1), /近期同群消息，仅供理解上下文/);
    assert.match(sections.at(-1), /本 QQ 会话当前发言者的普通记忆[\s\S]*拍翠鸟/);
    assert.equal(await bridge.ask({ ...envelope, messageId: 'message-three' }, { passive: true, owner: true }), '喵～');
    assert.match(sections.at(-1), /用户要求“一句”时严格只回一句/);
    assert.match(sections.at(-1), /当前发言者已在本 QQ 会话验证为主人/);
    const quote = { ...envelope, messageId: 'message-quote', text: '', attachments: [] };
    assert.equal(await bridge.ask(quote, { referencedImage: { quoted: true }, imageDescription: '一只翠鸟' }), '喵～');
    assert.match(calls.filter(([kind]) => kind === 'prompt').at(-1)[1].content[0].text,
      /图片来自用户在 QQ 引用的消息。[\s\S]*识别摘要[\s\S]*一只翠鸟/);
    assert.equal(await bridge.ask(quote, { referencedImage: { quoted: true } }), '这张图片我暂时没读取到，能再发一次吗？');
    assert.equal(finalAssistantText([{ event: { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call' }] } } } }]), '');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('connector emits unmentioned messages and sends only with a valid receipt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maomao-qq-connector-'));
  const old = [process.env.MAOMAO_QQ_APP_ID, process.env.MAOMAO_QQ_APP_SECRET, process.env.MAOMAO_QQ_CONNECT];
  process.env.MAOMAO_QQ_APP_ID = 'test-app';
  process.env.MAOMAO_QQ_APP_SECRET = 'test-secret';
  process.env.MAOMAO_QQ_CONNECT = 'I_STOPPED_HERMES_QQ';
  const sent = [];
  const events = [];
  let finishRun;
  const bot = {
    use() {}, on() {}, start() { return new Promise((resolve) => { finishRun = resolve; }); }, stop() { finishRun?.(); },
    async send(value) {
      sent.push(value);
      if (value.content === '失败') throw new Error('network result unknown');
      return { id: `out-${sent.length}` };
    },
  };
  try {
    const connector = new MaomaoQqConnector(
      { sessionController: {}, emit: (_name, value) => events.push(value), logger: console },
      { groupAllowlist: ['group-one'], dmAllowlist: [], respondToMentions: false, statePath: join(directory, 'state.json') },
      { botFactory: () => bot },
    );
    await connector.start();
    assert.equal(await connector.accept(rawMessage()), true);
    assert.equal(await connector.accept(rawMessage()), false);
    assert.equal(events.length, 1);
    assert.equal(sent.length, 0);
    await assert.rejects(connector.respond('qq:group:other:message-one', '喵'), /unavailable/);
    assert.deepEqual(await connector.respond(events[0].receiptKey, '第一条<|bubble|>第二条'), ['out-1', 'out-2']);
    assert.equal(sent[0].extra.msg_seq, 1);
    assert.equal(sent[1].extra.msg_seq, 2);
    assert.equal(sent[0].target.msgId, 'message-one');
    assert.deepEqual(await connector.respond(events[0].receiptKey, '第一条<|bubble|>第二条'), []);
    assert.equal(await connector.accept(rawMessage({ senderId: 'member-two', messageId: 'message-two' })), true);
    assert.equal(events[0].senderId, 'member-one');
    assert.equal(events[1].senderId, 'member-two');
    await assert.rejects(connector.respond(events[1].receiptKey, '失败'), /network result unknown/);
    assert.deepEqual(await connector.respond(events[1].receiptKey, '失败'), []);
    assert.equal(sent.filter((value) => value.content === '失败').length, 1);
    await connector.stop();
  } finally {
    [process.env.MAOMAO_QQ_APP_ID, process.env.MAOMAO_QQ_APP_SECRET, process.env.MAOMAO_QQ_CONNECT] = old;
    for (const name of ['MAOMAO_QQ_APP_ID', 'MAOMAO_QQ_APP_SECRET', 'MAOMAO_QQ_CONNECT']) {
      if (process.env[name] === 'undefined') delete process.env[name];
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('QQ image download follows one QQ-hosted redirect and retries a transient failure once', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X4XcAAAAASUVORK5CYII=', 'base64');
  const attachment = { kind: 'image', sourceUrl: 'https://multimedia.nt.qq.com.cn/cat', name: 'cat.png' };
  const seen = [];
  const redirected = await loadQqImage(attachment, { fetchImpl: async (url) => {
    seen.push(url);
    return seen.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://img.qpic.cn/cdn/cat' } })
      : new Response(png, { status: 200 });
  } });
  assert.equal(redirected.mediaType, 'image/png');
  assert.deepEqual(seen, ['https://multimedia.nt.qq.com.cn/cat', 'https://img.qpic.cn/cdn/cat']);
  await assert.rejects(loadQqImage(attachment, { fetchImpl: async () =>
    new Response(null, { status: 302, headers: { location: 'https://evil.example/cat' } }) }), { code: 'unsafe_source' });
  let calls = 0;
  const retried = await loadQqImage(attachment, { retryDelayMs: 1, fetchImpl: async () => {
    calls++;
    if (calls === 1) throw new TypeError('fetch failed');
    return new Response(png, { status: 200 });
  } });
  assert.equal(retried.mediaType, 'image/png'); assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(loadQqImage(attachment, { retryDelayMs: 1, fetchImpl: async () => { calls++; return new Response(null, { status: 404 }); } }), { code: 'missing' });
  assert.equal(calls, 1, 'a missing image is not retried');
});

test('a follow-up question picks up the same sender\'s recent pictures, oldest first, at most three', async () => {
  const { recentImagesFrom } = await import('../inbound.mjs');
  const base = { botId: 'b', scope: 'group', chatId: 'g' };
  const photo = (i, senderId = 'u', at = 1000 + i) => ({ ...base, receiptKey: `p${i}`, senderId, receivedAt: at, text: '',
    attachments: [{ kind: 'image', sourceUrl: 'https://img.qpic.cn/x' }] });
  const receipts = [photo(1), photo(2), photo(3), photo(4), photo(5, 'other'), photo(6, 'u', -500_000)];
  const question = { ...base, receiptKey: 'q', senderId: 'u', receivedAt: 2000, text: '分析一下是谁全责', attachments: [] };
  assert.deepEqual(recentImagesFrom(question, receipts).map((r) => r.receiptKey), ['p2', 'p3', 'p4']);
  assert.deepEqual(recentImagesFrom({ ...question, senderId: 'nobody' }, receipts), []);
});

test('QQ chat and judge sessions rotate after their turn or age limit, and old unrecorded sessions start fresh', async () => {
  const { sessionIsStale, SESSION_TURNS } = await import('../harness.mjs');
  const now = 10_000_000;
  assert.equal(sessionIsStale(null, now), true, 'a session from before turn counting is replaced');
  assert.equal(sessionIsStale({ startedAt: now - 1000, turns: 3 }, now), false);
  assert.equal(sessionIsStale({ startedAt: now - 1000, turns: SESSION_TURNS }, now), true);
  assert.equal(sessionIsStale({ startedAt: now - 13 * 3_600_000, turns: 1 }, now), true);
  const root = await mkdtemp(join(tmpdir(), 'maomao-qq-meta-'));
  try {
    let clock = 5_000;
    const state = await new ConnectorState(join(root, 'state.json'), { clock: () => clock }).load();
    await state.bindSession('bot', 'group', 'g', 'old');
    assert.deepEqual(state.sessionMeta('bot', 'group', 'g'), { startedAt: 5_000, turns: 0 });
    await state.noteSessionTurn('bot', 'group', 'g', 'old');
    await state.noteSessionTurn('bot', 'group', 'g', 'someone-else');
    assert.equal(state.sessionMeta('bot', 'group', 'g').turns, 1);
    clock = 9_000;
    assert.equal(await state.bindSession('bot', 'group', 'g', 'new', undefined, 'old'), 'new');
    assert.deepEqual(state.sessionMeta('bot', 'group', 'g'), { startedAt: 9_000, turns: 0 });
    const reloaded = await new ConnectorState(join(root, 'state.json')).load();
    assert.equal(reloaded.sessionMeta('bot', 'group', 'g').startedAt, 9_000);
  } finally { await rm(root, { recursive: true, force: true }); }
});
