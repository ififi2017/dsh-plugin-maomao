import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MaomaoQqConnector } from '../integrations/maomao-dsh/qq-connector/index.mjs';
import { ConnectorState } from '../integrations/maomao-dsh/qq-connector/state.mjs';
import { normalizeInbound } from '../integrations/maomao-dsh/qq-connector/inbound.mjs';
import { PrivateConnector } from '../integrations/maomao-dsh/private-connector/index.mjs';
import { telegramInbound, feishuInbound } from '../integrations/maomao-dsh/private-connector/identity.mjs';

async function until(check) {
  for (let i = 0; i < 200 && !check(); i++) await delay(10);
  assert.ok(check(), 'expected pairing outcome');
}

async function fixture(t, platform, { wait } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'maomao-pair-greeting-'));
  const sent = [], prompts = [], mounted = [], memories = [], selected = [], sessions = new Map();
  let version = 'custom-v1', stopped;
  const ctx = {
    logger: {}, emit() {},
    get(name) {
      if (name === 'maomaoPersonas') return { use: () => ({ name: '小舟', prompt: '你是温柔的旅行家小舟。', token: version, changedAt: 0 }),
        current: () => ({ token: version }) };
      if (name === 'maomaoModels') return { async useChat(_controller, id) { selected.push(id); } };
    },
    sessionController: {
      async create({ agentPreset }) {
        const sessionId = `session-${sessions.size}`;
        sessions.set(sessionId, { agentPreset, messages: [] });
        return { sessionId };
      },
      async projections({ sessionId }) { return { values: { agentPreset: sessions.get(sessionId).agentPreset } }; },
      async resolveAgent() { return { agent: { ctx: { get(name) {
        assert.equal(name, 'systemPrompt');
        return { getSectionOrder() {}, section({ text }) { mounted.push(text); return () => {}; } };
      } } } }; },
      async state() { return { cursor: 0 }; },
      async prompt(value) { prompts.push(value); sessions.get(value.sessionId).messages.push({ role: 'host-or-user', content: value.content }); },
      async wait({ sessionId }) {
        await wait?.();
        const session = sessions.get(sessionId);
        const text = session.messages.some(m => m.role === 'assistant') ? '刚才是小舟向你问好呀。' : '你好呀，我是小舟，很高兴遇见你。';
        session.messages.push({ role: 'assistant', text });
        return { reason: 'idle', output: { records: [{ event: { type: 'assistant/message',
          data: { message: { content: [{ type: 'text', text }] } } } }] } };
      },
    },
  };
  let connector, message, start;
  if (platform === 'qq' || platform === 'qq-group') {
    const group = platform === 'qq-group';
    const handlers = new Map();
    const bot = { use() {}, on: (name, fn) => handlers.set(name, fn),
      start: () => new Promise(resolve => { stopped = resolve; }), stop: () => stopped?.(),
      async send(value) { sent.push({ text: value.content, target: value.target }); return { id: `out-${sent.length}` }; } };
    connector = new MaomaoQqConnector(ctx, { statePath: join(root, 'qq.json'), ordinary: { enabled: true } }, {
      managedCredential: { appId: 'bot-test', secret: 'synthetic' }, botFactory: () => bot,
      ordinary: { async observe(e) { memories.push(e.text); }, async stop() {} },
    });
    await connector.start(); handlers.get('ready')();
    message = (id, text) => ({ kind: group ? 'group' : 'c2c', rawEventType: group ? 'GROUP_AT_MESSAGE_CREATE' : 'C2C_MESSAGE_CREATE',
      groupOpenid: group ? 'group-test' : undefined, messageId: String(id), content: text, senderId: 'user-test', attachments: [] });
    start = () => connector.pair({ action: 'start', scope: group ? 'group' : 'c2c' });
  } else {
    const transport = { ready: () => true, async reply(event, text) { sent.push({ text, target: event.chatId }); return `out-${sent.length}`; } };
    connector = new PrivateConnector(ctx, { stateRoot: root, [platform]: { accountId: platform === 'telegram' ? '2000' : 'cli_test', debounceMs: 0 } }, {
      routes: new Map([[platform, transport]]), memory: { async run(op, value) { memories.push([op, value]); return {}; } },
    });
    message = (id, text) => platform === 'telegram' ? telegramInbound('2000', { update_id: id,
      message: { message_id: id, text, date: Math.floor(Date.now() / 1000), from: { id: 1001, is_bot: false }, chat: { id: 1001, type: 'private' } } })
      : feishuInbound('cli_test', { sender: { sender_type: 'user', sender_id: { open_id: 'ou_test' } },
        message: { message_id: String(id), chat_id: 'oc_test', chat_type: 'p2p', create_time: String(Date.now()),
          message_type: 'text', content: JSON.stringify({ text }) } });
    start = () => connector.pair({ action: 'start', platform });
  }
  t.after(async () => { await connector.stop(); await rm(root, { recursive: true, force: true }); });
  const claim = async () => {
    const pair = await start();
    await connector.accept(message(1, pair.command));
    await until(() => sent.length === 1);
    const proof = sent[0].text.match(/[a-f0-9]{8}/)[0];
    return { pair, proof, confirm: value => connector.pair({ action: 'confirm', platform, id: pair.id, proof: value ?? proof }) };
  };
  return { connector, claim, sent, prompts, mounted, memories, sessions, selected, message,
    changePersona: () => { version = 'custom-v2'; } };
}

for (const platform of ['qq', 'qq-group', 'telegram', 'feishu']) {
  test(`${platform} pairing greets once with the active persona and continues in the same context`, async t => {
    const f = await fixture(t, platform);
    const { confirm, pair, proof } = await f.claim();
    assert.equal(f.prompts.length, 0);
    assert.equal((await confirm('wrong')).status, 'invalid');
    const result = await confirm();
    assert.equal(result.status, 'bound');
    assert.equal((await confirm()).status, 'expired');
    await until(() => f.sent.length === 2);
    assert.equal(f.prompts.length, 1);
    assert.equal(f.memories.length, 0, 'host greeting is not a user fact');
    const prompt = JSON.stringify(f.prompts[0].content);
    assert.match(prompt, /宿主事件.*配对/);
    assert.ok(!prompt.includes(pair.command) && !prompt.includes(proof));
    assert.match(f.mounted[0], /旅行家小舟/);
    assert.equal(f.selected[0], f.prompts[0].sessionId);
    assert.match(f.sent[1].text, /我是小舟/);
    await f.connector.accept(f.message(2, '你刚才怎么跟我打招呼的？'));
    await until(() => f.sent.length === 3);
    assert.equal(f.prompts[1].sessionId, f.prompts[0].sessionId);
    assert.equal(f.sessions.get(f.prompts[0].sessionId).messages.filter(m => m.role === 'assistant').length, 2);
    assert.match(f.sent[2].text, /刚才是小舟/);
    await confirm();
    assert.equal(f.sent.length, 3);
  });
}

for (const platform of ['qq', 'telegram']) {
  test(`${platform} unbinding or a model failure cannot send a greeting or undo pairing`, async t => {
    const gate = Promise.withResolvers();
    const f = await fixture(t, platform, { wait: () => gate.promise });
    const { confirm } = await f.claim();
    const bound = await confirm();
    await until(() => f.prompts.length === 1);
    if (platform === 'qq') await f.connector.unbind(bound.route);
    else f.connector.unbind(platform, bound.route);
    gate.resolve();
    await until(() => f.sessions.values().next().value.messages.length === 2);
    await delay(20);
    assert.equal(f.sent.length, 1);
    const g = await fixture(t, platform, { wait: () => { throw new Error('synthetic model failure'); } });
    const next = await g.claim();
    assert.equal((await next.confirm()).status, 'bound');
    await until(() => g.prompts.length === 1);
    assert.equal(g.connector.status().panelBindings.length, 1);
    await delay(20);
    assert.equal(g.sent.length, 1);
  });
}

test('QQ persona changes while generating cancel the old-persona greeting', async t => {
  const gate = Promise.withResolvers();
  const f = await fixture(t, 'qq', { wait: () => gate.promise });
  const { confirm } = await f.claim();
  await confirm();
  await until(() => f.prompts.length === 1);
  f.changePersona(); gate.resolve();
  await delay(30);
  assert.equal(f.sent.length, 1);
});

test('QQ private pairing reply anchor is usable after one minute without extending group expiry', async t => {
  const root = await mkdtemp(join(tmpdir(), 'maomao-pair-anchor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = 1000;
  const state = await new ConnectorState(join(root, 'qq.json'), { clock: () => now }).load();
  const event = normalizeInbound({ kind: 'c2c', senderId: 'user', messageId: 'pair', content: '/pair synthetic' }, now, 'bot');
  const group = normalizeInbound({ kind: 'group', groupOpenid: 'group', senderId: 'user', messageId: 'group-pair', content: '/pair synthetic' }, now, 'bot');
  await state.recordReceipt(event);
  await state.recordReceipt(group);
  now += 90_000;
  assert.equal((await state.reserve(event, '招呼')).fresh, true);
  now += 5 * 60_000;
  await assert.rejects(state.reserve(group, '超时群招呼'), /expired/);
  now += 60 * 60_000;
  await assert.rejects(state.reserve(event, '超时招呼'), /expired/);
});
