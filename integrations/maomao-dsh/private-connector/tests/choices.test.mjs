import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { test } from 'node:test';
import { choiceData, parseChoiceReply } from '../../choices.mjs';
import { PrivateConnector, PRESET } from '../index.mjs';
import { FeishuTransport, TelegramTransport } from '../transports.mjs';

const token = 'a'.repeat(32);
const options = ['沿河找翠鸟', '去林间听鸟'];
const text = '晨光刚好，咱们去哪儿？';
const marker = '<|maomao_choices|>';

test('dynamic choices are optional and a malformed control line never appears in chat', () => {
  assert.deepEqual(parseChoiceReply(text), { text, options: [] });
  assert.deepEqual(parseChoiceReply(`${text}\n${marker}${JSON.stringify(options)}`), { text, options });
  for (const raw of ['["一样","一样"]', '["单个"]', '["正常","多\\n行"]', '{"url":"https://example.com"}', '[oops]']) {
    assert.deepEqual(parseChoiceReply(`${text}\n${marker}${raw}`), { text, options: [] });
  }
});

test('only the original private chat can consume a card once and continue the same model session', async (t) => {
  const sections = [];
  const root = await mkdtemp(join(tmpdir(), 'maomao-card-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const endpoint = { platform: 'telegram', accountId: '2000', chatId: '1001', senderId: '1001' };
  const lark = { platform: 'feishu', accountId: 'cli_test', chatId: 'oc_owner', senderId: 'ou_owner' };
  const turns = [];
  const deliveries = [];
  const transport = {
    async reply(event, body) { deliveries.push({ event, body }); return '22'; },
    async replyChoices(event, body, choices, cardToken) {
      deliveries.push({ event, body, choices, cardToken });
      return { messageId: '21', interactive: true };
    },
  };
  const controller = {
    async create() { return { sessionId: 'same-conversation' }; },
    async projections() { return { values: { agentPreset: PRESET } }; },
    async resolveAgent() {
      return { agent: { ctx: { get: () => ({ getSectionOrder() {}, section({ text: system }) {
        if (!sections.length) assert.match(system, /聊天选项/);
        sections.push(system);
        return () => {};
      } }) } } };
    },
    async state() { return { cursor: 0 }; },
    async prompt(turn) { turns.push(turn); },
    async wait() {
      const reply = turns.length === 1 ? `${text}\n${marker}${JSON.stringify(options)}` : '那咱们沿河出发。';
      return { output: { records: [{ event: { type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: reply }] } },
      } }] } };
    },
  };
  const connector = new PrivateConnector({ sessionController: controller }, {
    stateRoot: root, memory: { enabled: false }, telegram: { accountId: '2000', debounceMs: 0 },
    feishu: { accountId: 'cli_test' }, bindings: [{ owner: 'a', endpoints: [endpoint, lark] }],
  }, { routes: new Map([['telegram', transport], ['feishu', transport]]) });
  t.after(() => connector.stop());
  const waitForDelivery = async (count) => {
    for (let i = 0; i < 40 && deliveries.length < count; i++) await pause(5);
    assert.equal(deliveries.length, count);
  };
  assert.equal(connector.accept({ ...endpoint, messageId: '20', text: '带我去拍鸟', receivedAt: Date.now() }), true);
  await waitForDelivery(1);
  assert.deepEqual(deliveries[0].choices, options);
  const data = choiceData(deliveries[0].cardToken, 0);
  const card = { ...endpoint, messageId: '21' };
  assert.equal(connector.acceptChoice({ ...lark, messageId: '21' }, data), null);
  assert.equal(connector.acceptChoice({ ...card, senderId: '1002' }, data), null);
  assert.equal(connector.acceptChoice({ ...card, messageId: '99' }, data), null);
  assert.equal(connector.acceptChoice(card, choiceData(deliveries[0].cardToken, 2)), null);
  assert.deepEqual(connector.acceptChoice(card, data), { body: text, label: options[0] });
  assert.equal(connector.acceptChoice(card, data), null);
  await waitForDelivery(2);
  assert.equal(turns[1].sessionId, turns[0].sessionId);
  assert.match(turns[1].content[0].text, /已选择的聊天分支.*沿河找翠鸟/);
  assert.equal(deliveries[1].body, '那咱们沿河出发。');
});

test('Telegram inline keyboard callback acknowledges and retires only the chosen card', async () => {
  const calls = [];
  const abort = new AbortController();
  const transport = new TelegramTransport({ botId: '2000', token: '2000:test', fetchImpl: async (url, request) => {
    const method = url.split('/').at(-1);
    const body = JSON.parse(request.body);
    calls.push({ method, body });
    const result = {
      sendMessage: { message_id: 21 }, getWebhookInfo: { url: '' },
      getMe: { id: 2000, is_bot: true, username: 'testbot' },
      getUpdates: [{ update_id: 5, callback_query: { id: 'query', data: choiceData(token, 1),
        from: { id: 1001, is_bot: false }, message: { message_id: 21, chat: { id: 1001, type: 'private' } },
      } }],
      answerCallbackQuery: true, editMessageText: true,
    }[method];
    if (method === 'editMessageText') abort.abort();
    return Response.json({ ok: true, result });
  } });
  assert.deepEqual(await transport.replyChoices({ chatId: '1001', messageId: '20' }, text, options, token, 'ticket', abort.signal),
    { messageId: '21', interactive: true });
  await transport.run(() => assert.fail('callback routed as normal message'), abort.signal, (event, data) => {
    assert.equal(event.messageId, '21');
    assert.equal(data, choiceData(token, 1));
    return { body: text, label: options[1] };
  });
  assert.equal(calls[0].body.reply_markup.inline_keyboard[1][0].text, options[1]);
  assert.deepEqual(calls[3].body.allowed_updates, ['message', 'callback_query']);
  assert.equal(calls[4].body.text, `已选：${options[1]}`);
  assert.deepEqual(calls[5].body.reply_markup.inline_keyboard, []);
});

test('Lark SDK dispatches card callbacks and returns an updated card without buttons', async () => {
  const { EventDispatcher, Domain } = await import('@larksuiteoapi/node-sdk');
  const abort = new AbortController();
  const sdk = { EventDispatcher, Domain, WSClient: class {
    async start({ eventDispatcher }) {
      const event = { operator: { open_id: 'ou_owner' }, context: { open_chat_id: 'oc_owner', open_message_id: 'om_card' },
        action: { value: { choice: choiceData(token, 0) } } };
      const ack = await eventDispatcher.invoke({ schema: '2.0', header: { event_type: 'card.action.trigger' }, event }, { needCheck: false });
      assert.equal(ack.toast.content, `已选：${options[0]}`);
      assert.equal(ack.card.type, 'raw');
      assert.deepEqual(ack.card.data.body.elements.map(({ tag }) => tag), ['div']);
      abort.abort();
    }
    close() {}
  } };
  const transport = new FeishuTransport({ appId: 'cli_test', secret: 'test', brand: 'lark', sdk, fetchImpl: async (url, request) => {
    if (url.includes('tenant_access_token')) return Response.json({ code: 0, tenant_access_token: 'test', expire: 7200 });
    const payload = JSON.parse(request.body);
    assert.equal(payload.msg_type, 'interactive');
    const card = JSON.parse(payload.content);
    assert.equal(card.body.elements[1].behaviors[0].value.choice, choiceData(token, 0));
    return Response.json({ code: 0, data: { message_id: 'om_card' } });
  } });
  assert.deepEqual(await transport.replyChoices({ messageId: 'om_user' }, text, options, token, 'ticket', abort.signal),
    { messageId: 'om_card', interactive: true });
  await transport.run(() => assert.fail('callback routed as normal message'), abort.signal, (event, data) => {
    assert.equal(event.senderId, 'ou_owner');
    assert.equal(data, choiceData(token, 0));
    return { body: text, label: options[0] };
  });
});
