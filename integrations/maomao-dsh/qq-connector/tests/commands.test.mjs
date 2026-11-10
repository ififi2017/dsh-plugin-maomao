import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { qqCommand, sidReply, statusReply } from '../commands.mjs';
import { MaomaoQqConnector } from '../index.mjs';
import { ConnectorState, routeKey } from '../state.mjs';
import { ChannelPersonas } from '../../personas.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition) {
  const deadline = Date.now() + 1_000;
  while (!condition() && Date.now() < deadline) await delay(10);
  assert.ok(condition(), 'timed out waiting for connector replies');
}
const message = (id, content, addressed = true) => ({ kind: 'group',
  rawEventType: addressed ? 'GROUP_AT_MESSAGE_CREATE' : 'GROUP_MESSAGE_CREATE',
  groupOpenid: 'group-one', senderId: 'member-one', messageId: id, content, attachments: [] });

test('commands require a directly addressed exact command and keep IDs inert', () => {
  assert.equal(qqCommand({ addressed: true, text: ' /SID ' }), '/sid');
  assert.equal(qqCommand({ addressed: true, text: '<@1234567890abcdef1234567890abcdef> /sid' }), '/sid');
  assert.equal(qqCommand({ addressed: true, text: '<@!1234567890abcdef1234567890abcdef> /status' }), '/status');
  assert.equal(qqCommand({ addressed: false, text: '/sid' }), null);
  assert.equal(qqCommand({ addressed: false, text: '<@1234567890abcdef1234567890abcdef> /sid' }), null);
  assert.equal(qqCommand({ addressed: true, text: '/sid please' }), null);
  assert.equal(sidReply({ senderId: 'member\nspoof', scope: 'group', chatId: 'group-one' }),
    'QQ 发送者 OpenID：不可用\nQQ群 OpenID：group-one\n本群主人身份：未绑定\n在本群 @猫猫 发送 /pair 查看主人绑定方法。');
  assert.match(statusReply({ ready: true }), /API 剩余额度：当前模型接口未提供统一查询/);
});

test('/sid and /status use trusted envelope and recorded projections without model turns', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maomao-qq-commands-'));
  const old = [process.env.MAOMAO_QQ_APP_ID, process.env.MAOMAO_QQ_APP_SECRET, process.env.MAOMAO_QQ_CONNECT];
  process.env.MAOMAO_QQ_APP_ID = 'test-app';
  process.env.MAOMAO_QQ_APP_SECRET = 'test-secret';
  process.env.MAOMAO_QQ_CONNECT = 'I_STOPPED_HERMES_QQ';
  const sent = [];
  const reads = [];
  let observed = 0;
  let turns = 0;
  let finishRun;
  const bot = { use() {}, on() {}, start() { return new Promise((resolve) => { finishRun = resolve; }); },
    stop() { finishRun?.(); }, async send(value) { sent.push(value); return { id: `reply-${sent.length}` }; } };
  try {
    const state = await new ConnectorState(join(root, 'state.json')).load();
    await state.bindSession('test-app', 'group', 'group-one', 'session-one');
    const connector = new MaomaoQqConnector({
      sessionController: { async projections(request) {
        reads.push(request);
        return { kind: 'sequenced', values: {
          modelSelection: { next: null, lastUsed: { provider: 'google', model: 'gemini-test' } },
          contextPressure: { projectedTokens: 1234, contextWindow: 10000 },
        } };
      } },
      agentDefaultModel: { currentSelection: () => ({ provider: 'google', model: 'default-test' }) },
      emit() {}, logger: { warn() {}, error() {} },
    }, { groupAllowlist: ['group-one'], dmAllowlist: [], statePath: join(root, 'state.json'),
      ordinary: { enabled: true } }, {
      state, botFactory: () => bot,
      ordinary: { async observe() { observed += 1; return {}; }, async stop() {} },
      harness: { async ask() { turns += 1; return 'model'; } },
    });
    await connector.start();
    await connector.accept(message('one', '<@1234567890abcdef1234567890abcdef> /sid'));
    await connector.accept(message('two', '<@1234567890abcdef1234567890abcdef> /status'));
    await until(() => sent.length === 2);
    assert.equal(sent.length, 2);
    assert.match(sent[0].content, /member-one/);
    assert.match(sent[0].content, /group-one/);
    assert.match(sent[1].content, /会话模型：google\/gemini-test/);
    assert.match(sent[1].content, /约 1,234 \/ 10,000 tokens/);
    assert.equal(reads[0].sessionId, 'session-one');
    assert.equal(observed, 0);
    assert.equal(turns, 0);
    await connector.accept(message('three', '/sid', false));
    await delay(10);
    assert.equal(sent.length, 2);
    const beforePair = observed;
    await connector.accept(message('pair-help', '/pair'));
    assert.match(sent.at(-1).content, /QQ群主人身份/);
    assert.equal(observed, beforePair);
    assert.equal(turns, 0);
    await connector.stop();
  } finally {
    [process.env.MAOMAO_QQ_APP_ID, process.env.MAOMAO_QQ_APP_SECRET, process.env.MAOMAO_QQ_CONNECT] = old;
    for (const name of ['MAOMAO_QQ_APP_ID', 'MAOMAO_QQ_APP_SECRET', 'MAOMAO_QQ_CONNECT']) {
      if (process.env[name] === 'undefined') delete process.env[name];
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('unmentioned QQ persona commands are group scoped and require a bound owner', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maomao-qq-persona-'));
  const book = new ChannelPersonas(join(root, 'personas.sqlite3'));
  t.after(async () => { book.close(); await rm(root, { recursive: true, force: true }); });
  const state = await new ConnectorState(join(root, 'state.json')).load();
  const target = { id: routeKey('test-app', 'group', 'group-one'), kind: 'qq-group' };
  await state.allowPanelRoute('test-app', 'group', 'group-one');
  await state.bindPanelOwner('test-app', 'group-one', 'member-one', false);
  const custom = book.manage({ action: 'save', name: '小舟', prompt: '测试专用人设' }, [target]);
  const sent = [];
  let stop;
  const bot = { use() {}, on() {}, start: () => new Promise((resolve) => { stop = resolve; }),
    stop() { stop?.(); }, async send(value) { sent.push(value.content); return { id: 'synthetic-reply' }; } };
  const connector = new MaomaoQqConnector({
    get: (id) => id === 'maomaoPersonas' ? book : undefined, emit() {}, sessionController: {},
  }, {}, { state, botFactory: () => bot, managedCredential: { appId: 'test-app', secret: 'synthetic' },
    harness: { async ask() { assert.fail('slash command went to the model'); } } });
  await connector.start();
  try {
    await connector.accept(message('owner-sid', '/sid'));
    await until(() => sent.some(text => text.includes('本群主人身份：已验证')));
    await connector.accept({ ...message('other-sid', '/sid'), senderId: 'other-member' });
    await until(() => sent.some(text => text.includes('本群主人身份：未绑定')));
    await connector.accept({ ...message('one', '/切换人设 小舟', false), senderId: 'other-member' });
    assert.match(sent.at(-1), /群主人/);
    assert.equal(book.current(target).id, 'maomao');
    await connector.accept(message('two', '/切换人设', false));
    assert.match(sent.at(-1), /小舟/);
    assert.doesNotMatch(sent.at(-1), /测试专用人设/);
    await connector.accept(message('three', '/切换人设 小舟', false));
    assert.equal(book.current(target).id, custom.personaId);
    const token = book.current(target).token;
    await connector.accept(message('four', '/reset', false));
    assert.notEqual(book.current(target).token, token);
    assert.match(sent.at(-1), /重开/);
    assert.equal(connector.status().panelBindings.find((binding) => binding.scope === 'group').groupOpenId, 'group-one');
  } finally { await connector.stop(); }
});
