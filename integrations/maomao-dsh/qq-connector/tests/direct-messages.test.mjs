import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { MaomaoQqConnector } from '../index.mjs';
import { ConnectorState } from '../state.mjs';

const dm = (messageId, content, senderId = 'user-a') => ({ kind: 'c2c', rawEventType: 'C2C_MESSAGE_CREATE',
  messageId, content, senderId, attachments: [] });
const group = (messageId, content, groupOpenid = 'group-a') => ({ kind: 'group', rawEventType: 'GROUP_AT_MESSAGE_CREATE',
  messageId, content, groupOpenid, senderId: 'user-a', attachments: [] });
async function until(check) {
  for (let i = 0; i < 150 && !check(); i++) await pause(10);
  assert.ok(check(), 'expected connector outcome');
}
async function fixture(t, config = {}, ask, services = {}) {
  const root = await mkdtemp(join(tmpdir(), 'maomao-dm-'));
  const file = join(root, 'state.json');
  const state = await new ConnectorState(file).load();
  const sent = [], typing = [], observed = [], model = [], emitted = [];
  const handlers = new Map();
  let finish;
  const bot = { use() {}, on: (key, callback) => handlers.set(key, callback),
    start: () => new Promise(resolve => { finish = resolve; }), stop() { finish?.(); },
    // Typing notices (msg_type 6) are not replies; keep them out of the reply count.
    async send(value) { if (value.msgType === 6) { typing.push(value); return {}; } sent.push(value); return { id: `out-${sent.length}` }; } };
  const connector = new MaomaoQqConnector({ sessionController: {}, logger: {},
    emit: (_name, envelope) => emitted.push(envelope), get: (key) => services[key],
  }, { statePath: file, ordinary: { enabled: true }, ...config }, {
    state, managedCredential: { appId: 'bot-a', secret: 'synthetic' }, botFactory: () => bot,
    ordinary: { async observe(value) { observed.push(value); return {}; }, async stop() {} },
    harness: { async ask(value, options) { model.push([value, options]); return ask ? ask(value, options) : '你好喵'; } },
  });
  await connector.start(); handlers.get('ready')();
  t.after(async () => { await connector.stop(); await rm(root, { recursive: true, force: true }); });
  return { connector, state, file, sent, typing, observed, model, emitted };
}

test('unpaired QQ private chat receives bounded onboarding and /sid without model or memory access', async t => {
  const f = await fixture(t);
  assert.equal(f.connector.status().directMessages.acceptStrangers, false);
  assert.equal(await f.connector.accept(dm('hello', '你好')), true);
  assert.match(f.sent.at(-1).content, /尚未|还没有获准/);
  await f.connector.accept(dm('sid', '/sid'));
  assert.match(f.sent.at(-1).content, /user-a/);
  assert.match(f.sent.at(-1).content, /尚未配对/);
  assert.match(f.sent.at(-1).content, /主人身份：未配置/);
  await f.connector.accept(dm('pair', '/pair'));
  assert.match(f.sent.at(-1).content, /QQ 私聊/);
  assert.equal(await f.connector.accept(dm('sid-again', '/sid')), false);
  assert.equal(await f.connector.accept(dm('hello-again', '你好')), false);
  assert.equal(f.sent.length, 3);
  assert.ok(f.sent.every(v => v.target.scope === 'c2c' && v.target.targetId === 'user-a'));
  assert.equal(f.observed.length, 0);
  assert.equal(f.model.length, 0);
  assert.equal(f.emitted.length, 0);
  assert.equal(f.connector.status().directMessages.lastInbound.outcome, 'needs_pairing');
  assert.equal(await f.connector.accept(group('no-group', '/sid')), false);
});

test('stranger admission is persisted per bot, is not ownership, and never opens groups', async t => {
  const f = await fixture(t, { respondToMentions: false });
  assert.equal((await f.connector.saveDirectMessageSettings({ acceptStrangers: 'yes' })).status, 'invalid');
  assert.equal((await f.connector.saveDirectMessageSettings({ acceptStrangers: true })).status, 'saved');
  await f.connector.accept(dm('first', '你好'));
  await f.connector.accept(dm('second', '你好', 'user-b'));
  await until(() => f.sent.length === 2);
  assert.equal(f.model.length, 2);
  assert.deepEqual(f.observed.map(e => [e.scope, e.chatId, e.senderId]), [['c2c', 'user-a', 'user-a'], ['c2c', 'user-b', 'user-b']]);
  // Each private reply is preceded by one QQ "typing…" notice tied to the inbound message.
  assert.deepEqual(f.typing.map((v) => [v.target.scope, v.extra.input_notify.input_second]), [['c2c', 60], ['c2c', 60]]);
  assert.ok(f.model.every(([, options]) => !options.owner));
  assert.notEqual(f.model[0][1].profile.token, undefined);
  assert.equal(await f.connector.accept(group('blocked-group', '你好')), false);
  assert.equal(f.connector.status().panelRoutes, 0);
  const reloaded = await new ConnectorState(f.file).load();
  assert.equal(reloaded.directMessageSettings('bot-a').acceptStrangers, true);
  assert.equal(reloaded.directMessageSettings('bot-b'), null);
  await f.connector.saveDirectMessageSettings({ acceptStrangers: false });
  await f.connector.accept(dm('closed', 'hi', 'user-c'));
  assert.equal(f.model.length, 2);
  assert.match(f.sent.at(-1).content, /配对/);
});

test('private pairing works with stranger mode enabled; after closing it only the paired user chats', async t => {
  const f = await fixture(t, { respondToMentions: false });
  await f.connector.saveDirectMessageSettings({ acceptStrangers: true });
  const pair = await f.connector.pair({ action: 'start', scope: 'c2c' });
  assert.equal(await f.connector.accept(group('wrong-scope', pair.command)), false);
  await f.connector.accept(dm('claim', pair.command));
  assert.equal(f.observed.length, 0);
  const proof = f.sent.at(-1).content.match(/[a-f0-9]{8}/)[0];
  assert.equal((await f.connector.pair({ action: 'confirm', id: pair.id, proof: 'wrong' })).status, 'invalid');
  assert.equal(f.state.panelAllowed('bot-a', 'c2c', 'user-a'), false);
  const bound = await f.connector.pair({ action: 'confirm', id: pair.id, proof });
  assert.equal(bound.status, 'bound');
  assert.equal(f.state.panelAllowed('bot-a', 'c2c', 'user-a'), true);
  assert.equal(f.state.panelAllowed('bot-b', 'c2c', 'user-a'), false);
  assert.equal(f.state.panelAllowed('bot-a', 'group', 'user-a'), false);
  assert.equal(f.state.panelAllowed('bot-a', 'c2c', 'user-b'), false);
  assert.equal(f.connector.status().panelBindings[0].userOpenId, 'user-a');
  await until(() => f.model.length === 1 && f.sent.length === 2);
  assert.match(f.model[0][0].text, /宿主事件.*配对/);
  assert.equal(f.observed.length, 0);
  await f.connector.saveDirectMessageSettings({ acceptStrangers: false });
  await f.connector.accept(dm('chat', '你好'));
  await until(() => f.model.length === 2 && f.sent.length === 3);
  await f.connector.accept(dm('bound-sid', '/sid'));
  await until(() => f.sent.length === 4);
  assert.match(f.sent.at(-1).content, /已配对或加入白名单/);
  await f.connector.accept(dm('bound-status', '/status'));
  await until(() => f.sent.length === 5);
  assert.match(f.sent.at(-1).content, /QQ 连接/);
  assert.equal(f.model.length, 2);
  assert.equal(f.observed.length, 1);
  assert.equal(await f.connector.unbind(bound.route), true);
  await f.connector.accept(dm('unbound', 'hello'));
  assert.equal(f.model.length, 2);
  assert.match(f.sent.at(-1).content, /配对/);
});

test('turn in progress is prevented from sending after stranger admission is disabled', async t => {
  const gate = Promise.withResolvers();
  const f = await fixture(t, {}, () => gate.promise);
  await f.connector.saveDirectMessageSettings({ acceptStrangers: true });
  await f.connector.accept(dm('pending', '你好'));
  await until(() => f.model.length === 1);
  await f.connector.saveDirectMessageSettings({ acceptStrangers: false });
  gate.resolve('不应发送');
  await pause(30);
  assert.equal(f.sent.length, 0);
});

test('configured private allowlist remains usable while stranger access and group replies are off', async t => {
  const f = await fixture(t, { dmAllowlist: ['user-a'], respondToMentions: false });
  await f.connector.accept(dm('allowed', '你好'));
  await until(() => f.sent.length === 1);
  assert.equal(f.model.length, 1);
  assert.equal(f.sent[0].target.scope, 'c2c');
  await f.connector.accept(dm('other', '/status', 'user-b'));
  assert.equal(f.model.length, 1);
  assert.doesNotMatch(f.sent.at(-1).content, /模型|tokens/);
});

test('a QQ private chat linked to a Lark / Telegram owner is that owner, shares their memory and counts as their activity', async t => {
  const owner = 'o'.repeat(64);
  const opened = [];
  const activity = [];
  const services = {
    maomaoPrivate: { owners: () => [{ id: owner, label: '主人 1' }],
      ownerMemory: (id, platform) => id === owner ? { scope: 's'.repeat(64), owner: id, label: '主人 1', platform: 'private-shared', requested: platform } : null,
      noteOwnerActivity: (id, text) => activity.push([id, text]) },
    maomaoLearning: { settings: {}, open: (options) => { opened.push(options); return null; } },
  };
  const f = await fixture(t, {}, undefined, services);
  assert.equal((await f.connector.pair({ action: 'start', scope: 'c2c', owner: 'x'.repeat(64) })).status, 'invalid', 'unknown owners are refused');
  assert.equal((await f.connector.pair({ action: 'start', scope: 'group', owner })).status, 'invalid', 'only private chats can be linked');
  assert.match((await f.connector.pair({ action: 'start', scope: 'c2c', owner })).command, /^\/pair /);
  await f.connector.pair({ action: 'cancel', id: (await f.connector.pair({ action: 'current' })).id });
  // What a confirmed pairing with an owner stores:
  await f.state.allowPanelRoute('bot-a', 'c2c', 'user-a', owner);
  await f.connector.accept(dm('linked', '今天面试过了'));
  await until(() => f.model.length === 1);
  assert.equal(f.model[0][1].owner, true, 'the linked owner is addressed as 主人');
  assert.deepEqual([opened[0].namespace, opened[0].scope, opened[0].subject, opened[0].owner], ['private', 's'.repeat(64), owner, true]);
  assert.deepEqual(activity, [[owner, '今天面试过了']], 'chatting on QQ resets the lonely-cat timers');
  assert.equal(f.connector.status().panelBindings.find((route) => route.scope === 'c2c').privateOwner, owner);
  await f.state.allowPanelRoute('bot-a', 'c2c', 'user-b');
  await f.connector.accept(dm('plain', '你好', 'user-b'));
  await until(() => f.model.length === 2);
  assert.equal(f.model[1][1].owner, false);
  assert.equal(opened[1].namespace, 'qq', 'an unlinked QQ private chat keeps its own memory');
});

test('an already-paired QQ private chat can pair again to link an owner, even when only the bare code is sent', async t => {
  const owner = 'o'.repeat(64);
  const services = { maomaoPrivate: { owners: () => [{ id: owner, label: '主人 1' }], ownerMemory: () => null, noteOwnerActivity() {} } };
  const f = await fixture(t, {}, undefined, services);
  await f.state.allowPanelRoute('bot-a', 'c2c', 'user-a');
  const pair = await f.connector.pair({ action: 'start', scope: 'c2c', owner });
  await f.connector.accept(dm('bare', pair.command.replace('/pair ', '')));
  await until(() => f.sent.some((v) => /[a-f0-9]{8}/.test(v.content ?? '')));
  assert.equal(f.model.length, 0, 'the code is not handed to the model as chat');
  const proof = f.sent.at(-1).content.match(/[a-f0-9]{8}/)[0];
  assert.equal((await f.connector.pair({ action: 'confirm', id: pair.id, proof })).status, 'bound');
  assert.equal(f.state.privateOwner('bot-a', 'user-a'), owner);
  // Pairing again without an owner removes the link.
  const unlink = await f.connector.pair({ action: 'start', scope: 'c2c' });
  const before = f.sent.length;
  await f.connector.accept(dm('unlink', unlink.command));
  await until(() => f.sent.length > before);
  const proof2 = f.sent.at(-1).content.match(/[a-f0-9]{8}/)[0];
  assert.equal((await f.connector.pair({ action: 'confirm', id: unlink.id, proof: proof2 })).status, 'bound');
  assert.equal(f.state.privateOwner('bot-a', 'user-a'), null);
});
