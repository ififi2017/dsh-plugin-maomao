import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { feishuInbound, telegramInbound } from '../identity.mjs';
import { PrivateConnector, PRESET } from '../index.mjs';
import { digest } from '../identity.mjs';
import { PrivateLedger } from '../ledger.mjs';
import { FeishuTransport, TelegramTransport } from '../transports.mjs';

const feishu = (id, text, senderId = 'ou_owner', chatId = 'oc_owner', type = 'p2p') => ({
  sender: { sender_type: 'user', sender_id: { open_id: senderId } },
  message: { message_id: id, chat_id: chatId, chat_type: type, create_time: String(Date.now()),
    message_type: 'text', content: JSON.stringify({ text }) },
});
const telegram = (id, text, senderId = 1001, type = 'private') => ({
  update_id: id, message: { message_id: id, chat: { id: senderId, type },
    from: { id: senderId, is_bot: false }, date: Math.floor(Date.now() / 1000), text },
});

test('private admissions share ordinary owner memory and isolate sessions, accounts and owners', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maomao-private-test-'));
  const received = [];
  const prompts = [];
  let nextSession = 0;
  const transport = { ready: () => true, async reply(event, text) {
    received.push({ platform: event.platform, messageId: event.messageId, text });
    return 'delivered';
  } };
  const controller = {
    async create({ agentPreset }) { assert.equal(agentPreset, PRESET); return { sessionId: `session-${++nextSession}` }; },
    async projections() { return { values: { agentPreset: PRESET,
      modelSelection: { lastUsed: { provider: 'google', model: 'synthetic' } },
      contextPressure: { pressureTokens: 320, contextWindow: 1000 } } }; },
    async state() { return { cursor: 0 }; },
    async prompt(value) { prompts.push(value); },
    async wait() { return { reason: 'idle', output: { records: [{ event: { type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '猫猫记下啦。<|bubble|>喵。' }] } } } }] } }; },
  };
  const config = {
    stateRoot: root, memory: { enabled: true }, feishu: { accountId: 'cli_test', enrollment: true },
    telegram: { accountId: '2000', enrollment: true }, bindings: [
      { owner: 'owner-a', endpoints: [
        { platform: 'feishu', accountId: 'cli_test', chatId: 'oc_owner', senderId: 'ou_owner' },
        { platform: 'telegram', accountId: '2000', chatId: '1001', senderId: '1001' },
      ] },
      { owner: 'owner-b', endpoints: [
        { platform: 'telegram', accountId: '2000', chatId: '1002', senderId: '1002' },
      ] },
    ],
  };
  const connector = new PrivateConnector({
    sessionController: controller,
    get agentDefaultModel() { throw new Error('Cordis requires injection for direct service access'); },
    get(service) {
      if (['maomaoModels', 'maomaoPersonas', 'web', 'maomaoBrowser'].includes(service)) return undefined;
      assert.equal(service, 'agentDefaultModel');
      return { currentSelection: () => ({ provider: 'google', model: 'synthetic' }) };
    },
  }, config, {
    routes: new Map([['feishu', transport], ['telegram', transport]]),
  });
  const wait = async (count) => {
    const end = Date.now() + 15_000;
    while (received.length < count && Date.now() < end) await pause(12);
    assert.equal(received.length, count);
  };
  try {
    assert.equal(feishuInbound('cli_test', feishu('om_group', '/sid', 'ou_owner', 'oc_owner', 'group')), null);
    assert.equal(telegramInbound('2000', telegram(3, '/sid', 1001, 'supergroup')), null);
    const unbound = (id, text) => feishuInbound('cli_test', feishu(id, text, 'ou_unknown', 'oc_unknown'));
    assert.equal(connector.accept(unbound('om_a', '不应进模型')), false);
    assert.equal(connector.accept(unbound('om_b', '/status')), false);
    assert.equal(connector.accept(unbound('om_c', '/sid')), true);
    await wait(1);
    assert.match(received[0].text, /未绑定/);
    assert.equal(prompts.length, 0);
    assert.deepEqual((await readdir(root)).filter((name) => name === 'ordinary'), []);
    const first = feishuInbound('cli_test', feishu('om_d', '我喜欢拍翠鸟'));
    assert.equal(connector.accept(first), true);
    assert.equal(connector.accept(first), false);
    assert.equal(connector.accept(telegramInbound('9000', telegram(4, '错误机器人'))), false);
    assert.equal(connector.accept(telegramInbound('2000', telegram(5, '你记得我喜欢什么吗？'))), true);
    await wait(5);
    assert.notEqual(prompts[0].sessionId, prompts[1].sessionId);
    assert.match(prompts[1].content[0].text, /翠鸟/);
    assert.equal(connector.accept(telegramInbound('2000', telegram(6, '你记得我喜欢什么吗？', 1002))), true);
    await wait(7);
    assert.doesNotMatch(prompts[2].content[0].text, /翠鸟/);
    assert.equal(connector.accept(telegramInbound('2000', telegram(7, '/status'))), true);
    await wait(8);
    assert.match(received.at(-1).text, /google\/synthetic/);
    assert.match(received.at(-1).text, /320 \/ 1000 tokens/);
    assert.equal(prompts.length, 3);
  } finally {
    await connector.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('Telegram polling recovers from a transient reload conflict and anchors its text reply', async () => {
  const methods = [];
  const active = new AbortController();
  const t = new TelegramTransport({ botId: '2000', token: '2000:synthetic',
    fetchImpl: async (url, request) => {
      const method = url.split('/').at(-1);
      const args = JSON.parse(request.body);
      methods.push(method);
      if (method === 'getUpdates' && methods.length === 3) {
        return Response.json({ ok: false, error_code: 409 }, { status: 409 });
      }
      const result = method === 'getWebhookInfo' ? { url: '' }
        : method === 'getMe' ? { id: 2000, is_bot: true, username: 'synthetic_bot' }
          : method === 'getUpdates' ? [telegram(4, 'hello')]
            : { message_id: 90 };
      if (method === 'sendMessage') assert.deepEqual(args.reply_parameters, { message_id: 4 });
      return Response.json({ ok: true, result });
    } });
  await t.run(async (event) => {
    assert.equal(event.senderId, '1001');
    assert.equal(await t.reply(event, 'hi', 'ticket', active.signal), '90');
    active.abort();
  }, active.signal);
  assert.deepEqual(methods, ['getWebhookInfo', 'getMe', 'getUpdates', 'getUpdates', 'sendMessage']);
  const webhook = new TelegramTransport({ botId: '2000', token: '2000:synthetic',
    fetchImpl: async () => Response.json({ ok: true, result: { url: 'https://example.invalid' } }) });
  await assert.rejects(webhook.run(() => {}, AbortSignal.timeout(1000)), /telegram_webhook/);
});

test('Feishu dispatches only private user events and replies with an idempotency UUID', async () => {
  const abort = new AbortController();
  let stopped = false;
  let posts = 0;
  const sdk = {
    Domain: { Feishu: 0 },
    EventDispatcher: class { register(events) { this.events = events; return this; } },
    WSClient: class {
      async start({ eventDispatcher }) {
        const receive = eventDispatcher.events['im.message.receive_v1'];
        await receive(feishu('om_group', 'ignore', 'ou_owner', 'oc_owner', 'group'));
        await receive(feishu('om_reply', 'hello'));
      }
      close() { stopped = true; }
    },
  };
  const t = new FeishuTransport({ appId: 'cli_test', secret: 'synthetic', sdk,
    fetchImpl: async (url, request) => {
      if (url.endsWith('/tenant_access_token/internal')) {
        return Response.json({ code: 0, tenant_access_token: 'synthetic-token', expire: 7200 });
      }
      if (url.endsWith('/resources/img_test?type=image')) {
        assert.equal(request.method, 'GET');
        return Response.json({ code: 99991672 }, { status: 400 });
      }
      posts++;
      assert.ok(url.endsWith('/messages/om_reply/reply'));
      const body = JSON.parse(request.body);
      assert.deepEqual(JSON.parse(body.content), { text: 'hi' });
      assert.equal(body.uuid, 'ticket');
      return Response.json({ code: 0, data: { message_id: 'om_sent' } });
    } });
  await t.run(async (event) => {
    await assert.rejects(t.image({ ...event, media: { id: 'img_test' } }, abort.signal), { code: 'feishu_media_permission' });
    assert.equal(await t.reply(event, 'hi', 'ticket', abort.signal), 'om_sent');
    abort.abort();
  }, abort.signal);
  assert.ok(stopped);
  assert.equal(posts, 1);
});

test('sharing uses only the verified opted-in private destination and recent cross-channel activity blocks it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maomao-private-share-'));
  const f = { platform: 'feishu', accountId: 'cli_test', chatId: 'oc_owner', senderId: 'ou_owner' };
  const t = { platform: 'telegram', accountId: '2000', chatId: '1001', senderId: '1001' };
  const sends = [];
  const contactOps = [];
  const controller = {
    async create() { return { sessionId: 'session-a' }; },
    async projections() { return { values: { agentPreset: PRESET } }; },
    async state() { return { cursor: 0 }; },
    async prompt() {},
    async wait() { return { reason: 'idle' }; },
  };
  const contact = {
    async run(op, input) {
      contactOps.push(op);
      if (op === 'contact_reserve') {
        assert.equal(input.details.url, 'https://example.org/birds');
        return { ticket: 'a'.repeat(64) };
      }
      if (op === 'contact_dispatch') return { allowed: true };
      if (op === 'contact_finish') assert.equal(input.details.outcome, 'sent');
      return {};
    },
  };
  const config = { stateRoot: root, bindings: [{ owner: 'owner', endpoints: [f, t] }],
    feishu: { accountId: f.accountId }, telegram: { accountId: t.accountId },
    memory: { enabled: false }, sharing: { enabled: true, destination: f } };
  const transport = { ready: () => true, async send(chat, text) { sends.push({ chat, text }); return 'sent'; } };
  const routes = new Map([['feishu', transport], ['telegram', { ready: () => true,
    async send() { assert.fail('unexpected Telegram destination'); } }]]);
  const request = { requestId: 'public-birds', source: 'activity', text: '刚看到一篇观鸟入门。', url: 'https://example.org/birds' };
  const first = new PrivateConnector({ sessionController: controller }, config, { routes, contact });
  try {
    assert.deepEqual(await first.share(request), { status: 'unavailable' });
    first.accept({ ...f, messageId: 'om_verified', text: '你好', receivedAt: Date.now() - 120 * 60_000 });
    await pause(10);
  } finally { await first.stop(); }
  const restored = new PrivateConnector({ sessionController: controller }, config, { routes, contact });
  try {
    assert.deepEqual(await restored.share(request), { status: 'sent' });
    assert.deepEqual(sends, [{ chat: 'oc_owner', text: '刚看到一篇观鸟入门。\nhttps://example.org/birds' }]);
    assert.deepEqual(contactOps.slice(-3), ['contact_reserve', 'contact_dispatch', 'contact_finish']);
    restored.accept({ ...t, messageId: '30', text: '我回来了', receivedAt: Date.now() });
    assert.deepEqual(await restored.share({ ...request, requestId: 'next' }), { status: 'unavailable' });
    assert.equal(sends.length, 1);
  } finally {
    await restored.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('scheduled private contact simulates first, alternates sources and shares only to its Telegram target', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maomao-private-schedule-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = { platform: 'feishu', accountId: 'cli_test', chatId: 'oc_owner', senderId: 'ou_owner' };
  const tg = { platform: 'telegram', accountId: '2000', chatId: '1001', senderId: '1001' };
  const owner = digest(['ordinary-owner', 'owner']);
  const ledgerPath = join(root, 'delivery.sqlite3');
  const ledger = new PrivateLedger(ledgerPath);
  ledger.verifyRoute(digest([tg.platform, tg.accountId, tg.chatId, owner]));
  ledger.recordActivity(owner, Date.now() - 2 * 3600_000);
  ledger.close();
  const sends = [];
  let acknowledged = 0;
  let state = { allowed: true, last_incoming: 1, unanswered: 0, max_chars: 120 };
  const article = { requestId: 'a'.repeat(64), source: 'activity', text: '读到一篇公开文章', url: 'https://www.nasa.gov/news/' };
  const contact = { async run(op) {
    if (op === 'contact_check') return state;
    if (op === 'activity_candidate') return article;
    if (op === 'contact_reserve') return { ticket: 'ticket' };
    if (op === 'contact_dispatch') return { allowed: true };
    if (op === 'activity_shared') acknowledged++;
    return {};
  } };
  const routes = new Map([['telegram', { ready: () => true, send(chat, text) { sends.push({ chat, text }); return '1'; } }],
    ['feishu', { send() { assert.fail('wrong destination'); } }]]);
  const make = (mode) => new PrivateConnector({}, { stateRoot: root, bindings: [{ owner: 'owner', endpoints: [f, tg] }],
    feishu: { accountId: f.accountId }, telegram: { accountId: tg.accountId }, memory: { enabled: false },
    sharing: { enabled: true, destination: tg, schedule: { enabled: true, mode, browse: true, lonely: true } },
  }, { routes, contact });
  const shadow = make('shadow');
  assert.deepEqual(await shadow.runScheduled(), { status: 'shadow', source: 'activity' });
  assert.equal(sends.length, 0);
  await shadow.stop();
  const live = make('send');
  try {
    for (const reason of ['dnd', 'goodnight', 'daily_limit']) {
      state = { ...state, allowed: false, reason };
      assert.deepEqual(await live.runScheduled(), { status: 'unavailable' });
      assert.deepEqual(await live.runScheduled({ preview: true }), { status: 'unavailable', reason });
    }
    assert.equal(sends.length, 0);
    state = { ...state, allowed: true };
    assert.deepEqual(await live.runScheduled({ preview: true }),
      { status: 'shadow', source: 'activity', text: article.text, url: article.url });
    assert.equal(sends.length, 0);
    assert.equal(acknowledged, 0);
    assert.deepEqual(await live.runScheduled(), { status: 'sent', source: 'activity' });
    assert.equal(acknowledged, 1);
    state = { ...state, last_source: 'activity' };
    assert.deepEqual(await live.runScheduled(), { status: 'sent', source: 'lonely' });
    assert.equal(acknowledged, 1);
    assert.deepEqual(sends.map(({ chat }) => chat), [tg.chatId, tg.chatId]);
  } finally { await live.stop(); }
});

test('panel pairing verifies private ingress before linking a durable owner and records safe media outcomes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maomao-private-pairing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const delivered = [];
  const route = { platform: 'feishu', accountId: 'cli_test', chatId: 'oc_owner', senderId: 'ou_owner' };
  const transport = { ready: () => true,
    async image() { throw Object.assign(new Error('platform details'), { code: 'feishu_media_permission' }); },
    async reply(_event, text) { delivered.push(text); return 'delivered'; },
  };
  const config = { stateRoot: root, feishu: { accountId: route.accountId },
    telegram: { accountId: '2000', debounceMs: 0 }, bindings: [{ owner: 'owner', endpoints: [route] }] };
  const options = { routes: new Map([['feishu', transport], ['telegram', transport]]) };
  const ctx = { logger: {}, sessionController: { async create() { throw new Error('model unavailable'); } } };
  let connector = new PrivateConnector(ctx, config, options);
  const wait = async (count) => {
    for (let i = 0; i < 100 && delivered.length < count; i++) await pause(10);
    assert.equal(delivered.length, count);
  };
  try {
    const owner = connector.status().owners[0].id;
    assert.equal(connector.status().sharedMemoryState, 'waiting_owner');
    assert.equal(connector.pair({ platform: 'telegram', action: 'start' }).status, 'choose_owner');
    const independent = connector.pair({ platform: 'telegram', action: 'start', owner: '' });
    assert.equal(independent.status, 'waiting');
    assert.equal(connector.pair({ platform: 'telegram', action: 'cancel', id: independent.id }).status, 'cancelled');
    assert.equal(connector.renameOwner('f'.repeat(64), '别人').status, 'invalid');
    assert.equal(connector.renameOwner(owner, '  我的私聊  ').status, 'saved');
    const start = connector.pair({ platform: 'telegram', action: 'start', owner });
    const current = () => connector.pair({ platform: 'telegram', action: 'current' });
    const confirm = (proof) => connector.pair({ platform: 'telegram', action: 'confirm', id: start.id, proof });
    assert.deepEqual(current(), start);
    assert.equal(connector.pair({ platform: 'telegram', action: 'start', owner }).status, 'busy');
    assert.equal(confirm('00000000').status, 'waiting');
    assert.equal(connector.accept(telegramInbound('2000', telegram(20, '还没有绑定'))), false);
    assert.equal(connector.accept(telegramInbound('2000', telegram(21, start.command))), true);
    assert.equal(connector.accept(telegramInbound('2000', telegram(22, start.command, 1002))), false);
    await wait(1);
    assert.equal(current().status, 'claimed');
    assert.equal(current().delivery, 'sent');
    const proof = delivered[0].match(/[a-f0-9]{8}/)[0];
    assert.equal(confirm(proof === '00000000' ? '11111111' : '00000000').status, 'invalid');
    const binding = confirm(proof);
    assert.equal(binding.status, 'bound');
    assert.equal(confirm(proof).status, 'expired');
    assert.equal(connector.status().sharedMemory, true);
    assert.equal(connector.status().sharedMemoryState, 'active');
    assert.equal(connector.status().owners[0].label, '我的私聊');
    assert.equal(connector.status().panelBindings[0].ownerId, owner);
    assert.equal(connector.memorySources()[0].label, '我的私聊');
    const check = (action) => connector.replyCheck({ platform: 'telegram', route: binding.route, action });
    const sample = check('start');
    assert.equal(connector.accept(telegramInbound('2000', telegram(24, sample.text, 1002))), false);
    assert.equal(check('read').status, 'waiting');
    assert.equal(connector.accept(telegramInbound('2000', telegram(25, sample.text))), true);
    assert.equal(check('read').status, 'received');
    for (let i = 0; i < 100 && check('read').status === 'received'; i++) await pause(10);
    assert.equal(check('read').status, 'model_failed');
    Object.assign(ctx.sessionController, {
      async create() { return { sessionId: 'test-session' }; },
      async projections() { return { values: { agentPreset: PRESET } }; },
      async state() { return { cursor: 0 }; },
      async prompt() {},
      async wait() {
        return { reason: 'idle', output: { records: [{ event: { type: 'assistant/message',
          data: { message: { content: [{ type: 'text', text: '你好喵。' }] } } } }] } };
      },
    });
    const retry = check('start');
    assert.equal(connector.accept(telegramInbound('2000', telegram(26, retry.text))), true);
    await wait(2);
    assert.equal(check('read').status, 'sent');
    assert.equal(delivered[1], '你好喵。');
    assert.equal(connector.accept({ ...route, messageId: 'image', receivedAt: Date.now(),
      text: '', media: { id: 'img_test' } }), true);
    await wait(3);
    assert.equal(connector.status().media.feishu.outcome, 'lark_permission');
    assert.match(delivered[2], /缺少下载图片的权限/);
    await connector.stop();
    connector = new PrivateConnector({}, config, options);
    assert.equal(connector.status().owners[0].id, owner);
    assert.equal(connector.status().owners[0].label, '我的私聊');
    assert.equal(connector.renameOwner(owner, '').status, 'saved');
    assert.equal(connector.status().owners[0].label, '主人 1');
    assert.equal(connector.status().sharedMemory, true);
    assert.equal(connector.status().media.feishu.outcome, 'lark_permission');
    assert.equal(connector.unbind('feishu', connector.status().panelBindings[0].id), false);
    assert.equal(connector.unbind('telegram', connector.status().panelBindings[0].id), true);
    assert.equal(connector.status().sharedMemory, false);
    assert.equal(connector.status().sharedMemoryState, 'waiting_owner');
    assert.equal(connector.accept(telegramInbound('2000', telegram(23, '解除绑定后不得接收'))), false);
  } finally { await connector.stop(); }
});

test('bare /pair explains setup and a challenged existing binding can switch to a cross-channel owner', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maomao-private-relink-'));
  const stateRoot = join(root, 'state');
  const lark = { platform: 'feishu', accountId: 'cli_test', chatId: 'oc_owner', senderId: 'ou_owner' };
  const tg = { platform: 'telegram', accountId: '2000', chatId: '1001', senderId: '1001' };
  const another = { ...tg, chatId: '1002', senderId: '1002' };
  const peer = (event) => {
    const route = digest([event.platform, event.accountId, event.chatId, null]);
    return { route, account: digest([event.platform, event.accountId]), peer: digest([route, event.senderId]) };
  };
  const ledger = new PrivateLedger(join(stateRoot, 'delivery.sqlite3'));
  const previous = digest(['original-telegram']);
  const target = digest(['original-lark']);
  ledger.addPanelBinding({ ...peer(tg), owner: previous });
  ledger.addPanelBinding({ ...peer(another), owner: previous });
  ledger.addPanelBinding({ ...peer(lark), owner: target });
  const replies = [];
  const transport = { ready: () => true, username: 'testbot',
    async reply(event, body) { replies.push({ chatId: event.chatId, body }); return 'ok'; } };
  const connector = new PrivateConnector({}, {
    stateRoot, feishu: { accountId: lark.accountId }, telegram: { accountId: tg.accountId },
  }, { ledger, routes: new Map([['feishu', transport], ['telegram', transport]]) });
  t.after(async () => { await connector.stop(); await rm(root, { recursive: true, force: true }); });
  let id = 0;
  const send = (endpoint, text) => connector.accept({ ...endpoint, messageId: String(++id), text, receivedAt: Date.now() });
  const wait = async (count) => {
    for (let i = 0; i < 100 && replies.length < count; i++) await pause(5);
    assert.equal(replies.length, count);
  };
  assert.equal(send(tg, '/pair'), true);
  await wait(1);
  assert.match(replies[0].body, /完整指令/);
  assert.equal(connector.status().sharedMemoryState, 'waiting_owner');
  const bindingId = peer(tg).route;
  const start = connector.pair({ action: 'start', platform: 'telegram', owner: target, bindingId });
  assert.equal(send(another, start.command), true);
  await wait(2);
  assert.match(replies[1].body, /选中的那个私聊/);
  assert.equal(connector.pair({ action: 'confirm', platform: 'telegram', id: start.id, proof: '00000000' }).status, 'waiting');
  assert.equal(send(tg, start.command.replace('/pair ', '/pair@testbot ')), true);
  await wait(3);
  const proof = replies[2].body.match(/[a-f0-9]{8}/)[0];
  assert.equal(ledger.panelBinding(bindingId).owner, previous);
  assert.equal(connector.pair({ action: 'confirm', platform: 'telegram', id: start.id, proof }).status, 'reassigned');
  assert.equal(ledger.panelBinding(bindingId).owner, target);
  assert.equal(ledger.panelBinding(peer(another).route).owner, previous);
  assert.equal(connector.status().sharedMemoryState, 'active');
});

test('Telegram rapid text and image messages become one ordered model turn and one reply', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maomao-private-burst-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const endpoint = { platform: 'telegram', accountId: '2000', chatId: '1001', senderId: '1001' };
  const prompts = [];
  const replies = [];
  const image = { type: 'image', mediaType: 'image/webp', data: 'dGVzdA==' };
  const controller = {
    async create() { return { sessionId: 'session-a' }; },
    async projections() { return { values: { agentPreset: PRESET, modelSelection: { next: { provider: 'google' } } } }; },
    async state() { return { cursor: 0 }; },
    async prompt(request) { prompts.push(request); },
    async wait() { return { reason: 'idle', output: { records: [{ event: { type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '收到图片和问题。' }] } } } }] } }; },
  };
  const route = { async image() { return image; }, async reply(event) { replies.push(event.messageId); return '90'; } };
  const connector = new PrivateConnector({ sessionController: controller }, {
    stateRoot: root, memory: { enabled: false }, telegram: { accountId: '2000', debounceMs: 120 },
    bindings: [{ owner: 'owner', endpoints: [endpoint] }],
  }, { routes: new Map([['telegram', route]]) });
  try {
    connector.accept({ ...endpoint, messageId: '1', text: '', media: { id: 'file1' }, receivedAt: Date.now() });
    connector.accept({ ...endpoint, messageId: '2', text: '看看这张图', receivedAt: Date.now() });
    connector.accept({ ...endpoint, messageId: '3', text: '只说主体', receivedAt: Date.now() });
    const end = Date.now() + 2000;
    while (!replies.length && Date.now() < end) await pause(20);
    assert.deepEqual(replies, ['3']);
    assert.equal(prompts.length, 1);
    assert.deepEqual(prompts[0].content, [{ type: 'text', text: '用户发送了一张图片。' }, image,
      { type: 'text', text: '看看这张图' }, { type: 'text', text: '只说主体' }]);
  } finally { await connector.stop(); }
});
