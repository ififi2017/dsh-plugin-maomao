import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { ApiError } from '@tencent-connect/qqbot-nodejs';

import { finalAssistantText, HarnessConversation } from '../harness.mjs';
import { allowedInbound, normalizeInbound, textBubbles } from '../inbound.mjs';
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
    await assert.rejects(reply('timeout', '**投递未知**'), /timed out/);
    assert.equal(sent.length, 2);
    await reply('denied', '## 要点\n- **找鸟** 和 `a * b`，比 2 * 3 * 4 难。');
    assert.equal(sent[2].msgType, 2);
    assert.equal(sent[3].msgType, 0);
    assert.equal(sent[3].content, '要点\n• 找鸟 和 a * b，比 2 * 3 * 4 难。');
    assert.deepEqual(sent[2].target, sent[3].target);
    assert.deepEqual(sent[2].extra, sent[3].extra);
    await reply('after-denial', '还有**第二句**。');
    assert.equal(sent.length, 5);
    assert.equal(sent[4].content, '还有第二句。');
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
      assert.equal(options.redirect, 'error');
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
    await state.bindSession('', 'group', 'group-one', 'legacy-standard');
    const controller = {
      async create(request) { calls.push(['create', request]); return { sessionId: 'session-one' }; },
      async projections({ sessionId }) { return { values: { agentPreset: sessionId === 'legacy-standard'
        ? 'standard' : 'maomao-qq-ordinary' } }; },
      async state(request) { calls.push(['state', request]); return { cursor: 7 }; },
      async prompt(request) { calls.push(['prompt', request]); return { accepted: true }; },
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
    assert.match(calls.find(([kind]) => kind === 'prompt')[1].content[0].text, /你好\n\[图片未能读取\]/);
    assert.match(calls.filter(([kind]) => kind === 'prompt').at(-1)[1].content[0].text,
      /近期同群消息，仅供理解上下文/);
    assert.match(calls.filter(([kind]) => kind === 'prompt').at(-1)[1].content[0].text,
      /本 QQ 会话当前发言者的普通记忆/);
    assert.equal(await bridge.ask({ ...envelope, messageId: 'message-three' }, { passive: true, owner: true }), '喵～');
    assert.match(calls.filter(([kind]) => kind === 'prompt').at(-1)[1].content[0].text,
      /用户要求“一句”时严格只回一句/);
    assert.match(calls.filter(([kind]) => kind === 'prompt').at(-1)[1].content[0].text, /当前发言者已在本 QQ 会话验证为主人/);
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
