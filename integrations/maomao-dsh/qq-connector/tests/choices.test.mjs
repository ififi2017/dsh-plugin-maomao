import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ApiError, MsgType } from '@tencent-connect/qqbot-nodejs';
import { MaomaoQqConnector } from '../index.mjs';
import { ConnectorState } from '../state.mjs';

const user = { kind: 'group', groupOpenid: 'group-one', senderId: 'member-one', messageId: 'human-one',
  content: '给我两个探险选项', rawEventType: 'GROUP_AT_MESSAGE_CREATE' };
const branches = ['钻进竹林', '去雨后的温室'];
const modelAnswer = `雨停啦。往哪边走？\n<|maomao_choices|>${JSON.stringify(branches)}`;

async function until(predicate) {
  for (let i = 0; i < 120 && !predicate(); i++) await delay(10);
  assert.ok(predicate());
}

async function setup(t, send) {
  const root = await mkdtemp(join(tmpdir(), 'qq-choices-'));
  const prompts = [];
  const sends = [];
  const acks = [];
  const memory = [];
  const sections = [];
  const listeners = new Map();
  let stop;
  let sessionCount = 0;
  const bot = {
    on(name, cb) { listeners.set(name, cb); },
    start: () => new Promise((resolve) => { stop = resolve; }),
    stop: () => stop?.(),
    async send(message) { sends.push(message); return send?.(message) ?? { id: `bot-${sends.length}` }; },
    async acknowledgeInteraction(id, code) { acks.push({ id, code }); },
  };
  const sessionController = {
    async create() { return { sessionId: `qq-session-${++sessionCount}` }; },
    async projections() { return { values: { agentPreset: 'maomao-qq-ordinary' } }; },
    async resolveAgent() {
      return { agent: { ctx: { get: () => ({ getSectionOrder() {}, section({ text }) {
        sections.push(text);
        return () => {};
      } }) } } };
    },
    async state() { return { cursor: 0 }; },
    async prompt(value) { prompts.push(value); },
    async wait() {
      const text = prompts.length === 1 ? modelAnswer : '那就去温室看看。';
      return { reason: 'idle', output: { records: [{ event: { type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text }] } },
      } }] } };
    },
  };
  const connector = new MaomaoQqConnector({ sessionController, emit() {} }, {
    groupAllowlist: ['group-one', 'group-two'], statePath: join(root, 'state.json'), ordinary: { enabled: true },
  }, { botFactory: () => bot, managedCredential: { appId: 'qq-test', secret: 'test' },
    ordinary: { async observe(event) { memory.push(event.text); }, async stop() {} } });
  t.after(async () => { await connector.stop(); await rm(root, { recursive: true, force: true }); });
  await connector.start();
  return { connector, sends, acks, prompts, memory, sections, click: (event) => listeners.get('interaction')({}, event) };
}

test('QQ addressed turns send model-generated native buttons and continue once on the authorized click', async (t) => {
  const { connector, sends, acks, prompts, memory, sections, click } = await setup(t);
  assert.equal(await connector.accept(user), true);
  await until(() => sends.length === 1);
  const [card] = sends;
  assert.equal(card.msgType, MsgType.MARKDOWN);
  assert.equal(card.markdown.content, '雨停啦。往哪边走？');
  const buttons = card.keyboard.content.rows.map((row) => row.buttons[0]);
  assert.deepEqual(buttons.map((button) => button.render_data.label), branches);
  assert.deepEqual(buttons[1].action.permission, { type: 0, specify_user_ids: [user.senderId] });
  assert.equal(buttons[1].action.type, 1);
  const event = { id: 'event-one', scene: 'group', chat_type: 1, type: 11, group_openid: user.groupOpenid,
    group_member_openid: user.senderId, data: { resolved: { button_id: '1', button_data: buttons[1].action.data } } };
  await click({ ...event, id: 'other-user', group_member_openid: 'member-two' });
  await click({ ...event, id: 'other-group', group_openid: 'group-two' });
  await click({ ...event, id: 'other-index', data: { resolved: { ...event.data.resolved, button_id: '0' } } });
  assert.deepEqual(acks.map(({ code }) => code), [4, 4, 4]);
  assert.equal(prompts.length, 1);
  await Promise.all([click(event), click({ ...event, id: 'repeat-event' })]);
  assert.deepEqual(acks.map(({ code }) => code), [4, 4, 4, 0, 3]);
  await until(() => sends.length === 2);
  assert.deepEqual(sends[1].target, { scope: 'group', targetId: user.groupOpenid, msgId: user.messageId });
  assert.deepEqual(sends[1].extra, { msg_seq: 2 });
  assert.equal(sends[1].content, '那就去温室看看。');
  assert.equal(prompts[0].sessionId, prompts[1].sessionId);
  assert.match(prompts[1].content[0].text, /已选择的聊天分支.*去雨后的温室/);
  assert.match(sections[0], /聊天选项/);
  assert.doesNotMatch(sections.at(-1), /聊天选项/, 'right after a card the option guidance is not offered again');
  assert.deepEqual(memory, [user.content]);
});

test('QQ keeps the text after a definite native Markdown rejection, without a numbered option list in groups', async (t) => {
  const { connector, sends } = await setup(t, (message) => {
    if (message.keyboard) throw new ApiError('Markdown rejected', 400, '/v2/groups/test/messages', 40034012);
    return { id: 'fallback' };
  });
  await connector.accept(user);
  await until(() => sends.length === 2);
  assert.equal(sends[1].msgType, MsgType.TEXT);
  assert.match(sends[1].content, /\S/);
  assert.doesNotMatch(sends[1].content, /1\. 钻进竹林/, 'people in a group answered "4" to a plain-text list');
  assert.deepEqual(sends[0].extra, sends[1].extra);
});

test('a QQ button expires and cannot cross a persona revision', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'qq-choice-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'state.json');
  let time = 100_000;
  const state = await new ConnectorState(path, { clock: () => time }).load();
  const envelope = { botId: 'bot', scope: 'group', chatId: 'group', senderId: 'user', receiptKey: 'click-one',
    messageId: 'event-one', receivedAt: time };
  const button = { token: 'card', index: 0 };
  assert.equal(await state.saveChoiceCard(button.token, envelope, 'persona-one', branches), true);
  const restored = await new ConnectorState(path, { clock: () => time }).load();
  assert.deepEqual(await restored.takeChoice(button, envelope, 'persona-two'), { code: 3 });
  time += 300_000;
  assert.deepEqual(await restored.takeChoice(button, envelope, 'persona-one'), { code: 3 });
});

test('QQ cards cannot spend beyond the original group message reply budget', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'qq-choice-quota-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = await new ConnectorState(join(root, 'state.json')).load();
  const anchor = { botId: 'bot', scope: 'group', chatId: 'group', senderId: 'user', receiptKey: 'human',
    messageId: 'human-message', receivedAt: Date.now() };
  await state.recordReceipt(anchor);
  for (let i = 0; i < 4; i++) await state.reserve(anchor, `message ${i}`);
  assert.equal(await state.saveChoiceCard('card', anchor, 'persona', branches), true);
  await state.reserve(anchor, 'message 4');
  assert.equal(await state.saveChoiceCard('new-card', anchor, 'persona', branches), false);
  assert.deepEqual(await state.takeChoice({ token: 'card', index: 0 }, {
    ...anchor, receiptKey: 'click', messageId: 'event',
  }, 'persona'), { code: 2 });
});
