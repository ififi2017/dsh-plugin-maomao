import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FeishuTransport } from '../transports.mjs';

const signal = AbortSignal.timeout(30000);
const formatted = '先看**重点**。\n\n> 保留引用\n\n- [x] 核对';
const incoming = { messageId: 'om_test' };

function transport(brand, response) {
  const sent = [];
  const bot = new FeishuTransport({ appId: 'cli_test', secret: 'test', brand,
    fetchImpl: async (url, request) => {
      if (url.includes('tenant_access_token')) return Response.json({ code: 0, tenant_access_token: 'test', expire: 7200 });
      const { content, ...payload } = JSON.parse(request.body);
      sent.push({ url, ...payload, body: JSON.parse(content) });
      return response(payload.msg_type, sent.length);
    } });
  return { bot, sent };
}

const delivered = () => Response.json({ code: 0, data: { message_id: 'om_sent' } });

test('Feishu and Lark use native Markdown posts for formatted replies and proactive messages', async () => {
  for (const brand of ['feishu', 'lark']) {
    const { bot, sent } = transport(brand, delivered);
    assert.equal(await bot.reply(incoming, formatted, 'reply-ticket', signal), 'om_sent');
    assert.equal(await bot.send('oc_test', formatted, 'send-ticket', signal), 'om_sent');
    assert.equal(await bot.reply(incoming, '普通聊天 🙂', 'plain-ticket', signal), 'om_sent');
    assert.match(sent[0].url, /\/om_test\/reply$/);
    assert.equal(sent[1].receive_id, 'oc_test');
    for (const request of sent.slice(0, 2)) {
      assert.equal(request.msg_type, 'post');
      assert.deepEqual(request.body, { zh_cn: { content: [[{ tag: 'md', text: formatted }]] } });
    }
    assert.equal(sent[2].msg_type, 'text');
    assert.deepEqual(sent[2].body, { text: '普通聊天 🙂' });
  }
});

test('Lark retries only a definite formatting rejection and keeps the reply UUID', async () => {
  const rejected = (status, code) => () => Response.json({ code }, { status });
  const { bot, sent } = transport('lark', type => type === 'post' ? rejected(400, 230001)() : delivered());
  assert.equal(await bot.reply(incoming, formatted, 'same-ticket', signal), 'om_sent');
  assert.deepEqual(sent.map(r => r.msg_type), ['post', 'text']);
  assert.equal(sent[0].uuid, sent[1].uuid);
  assert.equal(sent[0].url, sent[1].url);
  assert.equal(sent[1].body.text, '先看重点。\n\n保留引用\n\n☑ 核对');
  for (const [status, code] of [[500, 230001], [400, 230013], [429, 99991400]]) {
    const probe = transport('lark', rejected(status, code));
    assert.equal(await probe.bot.reply(incoming, formatted, 'ticket', signal), null);
    assert.equal(probe.sent.length, 1);
  }
});

test('Lark cards render formatted body while keeping the choice label literal', async () => {
  const { bot, sent } = transport('lark', delivered);
  await bot.replyChoices(incoming, formatted, ['*选这个*'], 'a'.repeat(32), 'ticket', signal);
  assert.equal(sent[0].msg_type, 'interactive');
  const [body, button] = sent[0].body.body.elements;
  assert.deepEqual(body, { tag: 'markdown', content: formatted });
  assert.deepEqual(button.text, { tag: 'plain_text', content: '*选这个*' });
});
