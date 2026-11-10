import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { MaomaoQqConnector } from '../index.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const inbound = (id, content = '猫猫，你觉得呢？') => ({
  kind: 'group', rawEventType: 'GROUP_MESSAGE_CREATE', groupOpenid: 'test-group',
  senderId: 'member-a', messageId: id, content, attachments: [],
});

async function withConnector(delivery, judge, harness, run, ordinary) {
  const root = await mkdtemp(join(tmpdir(), 'maomao-qq-delivery-'));
  const old = [process.env.MAOMAO_QQ_APP_ID, process.env.MAOMAO_QQ_APP_SECRET, process.env.MAOMAO_QQ_CONNECT];
  process.env.MAOMAO_QQ_APP_ID = 'test-app';
  process.env.MAOMAO_QQ_APP_SECRET = 'test-secret';
  process.env.MAOMAO_QQ_CONNECT = 'I_STOPPED_HERMES_QQ';
  const sends = [];
  const { promise: firstSend, resolve: recordSend } = Promise.withResolvers();
  let finishRun;
  const bot = { use() {}, on() {}, start() { return new Promise((resolve) => { finishRun = resolve; }); },
    stop() { finishRun?.(); }, async send(request) {
      sends.push(request);
      recordSend();
      return { id: `sent-${sends.length}` };
    } };
  const connector = new MaomaoQqConnector(
    { sessionController: {}, emit() {}, logger: { warn() {}, error() {} } },
    { statePath: join(root, 'state.json'), groupAllowlist: ['test-group'], dmAllowlist: [],
      shadow: { enabled: true, path: join(root, 'shadow.jsonl'), debounceMs: 1,
        semantic: { enabled: true }, delivery }, ordinary: { enabled: Boolean(ordinary) } },
    { botFactory: () => bot, shadowJudge: judge, harness, ordinary });
  try {
    await connector.start();
    await run(connector, sends, firstSend);
  } finally {
    await connector.stop();
    [process.env.MAOMAO_QQ_APP_ID, process.env.MAOMAO_QQ_APP_SECRET, process.env.MAOMAO_QQ_CONNECT] = old;
    for (const name of ['MAOMAO_QQ_APP_ID', 'MAOMAO_QQ_APP_SECRET', 'MAOMAO_QQ_CONNECT']) {
      if (process.env[name] === 'undefined') delete process.env[name];
    }
    await rm(root, { recursive: true, force: true });
  }
}

test('passive delivery needs an explicit group allowlist and positive model verdict', { timeout: 4_000 }, async () => {
  const harness = { async ask() { return '猫猫在'; } };
  await withConnector({ enabled: false, groupAllowlist: ['test-group'] },
    async () => ({ reply: true }), harness, async (connector, sends) => {
      await connector.accept(inbound('off'));
      await delay(20);
      assert.equal(sends.length, 0);
    });
  await withConnector({ enabled: true, groupAllowlist: [] },
    async () => ({ reply: true }), harness, async (connector, sends) => {
      await connector.accept(inbound('not-allowlisted'));
      await delay(20);
      assert.equal(sends.length, 0);
    });
  await withConnector({ enabled: true, groupAllowlist: ['test-group'] },
    async () => ({ reply: false }), harness, async (connector, sends) => {
      await connector.accept(inbound('negative'));
      await delay(20);
      assert.equal(sends.length, 0);
    });
  await withConnector({ enabled: true, groupAllowlist: ['test-group'] },
    async () => ({ reply: true }), harness, async (connector, sends, firstSend) => {
      await connector.accept(inbound('positive'));
      await firstSend;
      assert.equal(sends.length, 1);
      assert.equal(sends[0].target.msgId, 'positive');
    });
});

test('a newer group message cancels an older passive answer before sending', async () => {
  let begin;
  const started = new Promise((resolve) => { begin = resolve; });
  let finish;
  const answer = new Promise((resolve) => { finish = resolve; });
  await withConnector({ enabled: true, groupAllowlist: ['test-group'] },
    async (_payload, envelope) => ({ reply: envelope.messageId === 'old' }),
    { async ask() { begin(); return answer; } }, async (connector, sends) => {
      await connector.accept(inbound('old'));
      await started;
      await connector.accept(inbound('new', '新的话题'));
      finish('过时的回答');
      await delay(30);
      assert.equal(sends.length, 0);
    });
});

test('a group participant needs no preconfigured identity and the interjection uses a human receipt', async () => {
  const peer = { waitMs: 35 };
  const judged = [];
  const answers = [];
  const delivery = { enabled: true, groupAllowlist: ['test-group'], peers: { 'test-group': peer } };
  await withConnector(delivery, async (payload) => {
    judged.push(payload);
    return { reply: true };
  }, { async ask(envelope, options) {
    answers.push([envelope.messageId, options]);
    return '我来补一句。<|bubble|>尾巴已经翘起来了。';
  } }, async (connector, sends, firstSend) => {
    assert.equal(await connector.accept({ ...inbound('self', '自己发的'),
      senderIsBot: true, senderId: 'test-app' }), false);
    await connector.accept({ ...inbound('other-human'), mentions: [{ member_openid: 'friend' }] });
    await connector.accept({ ...inbound('peer-topic', '两只都可以聊这个梗'),
      mentions: [{ member_openid: 'partner' }] });
    assert.equal(await connector.accept({ ...inbound('peer-reply', '我先说我的看法。'),
      senderIsBot: true, senderId: 'unknown' }), true);
    await firstSend;
    assert.deepEqual(judged.map(({ mode }) => mode), ['group_interjection']);
    assert.ok(judged[0].recent_messages.some((row) => row.role === 'participant' && row.text === '我先说我的看法。'));
    assert.equal(answers[0][0], 'peer-topic');
    assert.equal(sends.length, 1);
    assert.equal(sends[0].target.msgId, 'peer-topic');
  });
});

test('a peer reply arriving during judgment triggers a fresh verdict on the original human message', { timeout: 5_000 }, async () => {
  const peer = { name: '猫猫', selfName: '猫猫 2 号', memberId: 'partner', waitMs: 1 };
  const { promise: started, resolve: begin } = Promise.withResolvers();
  const { promise: firstVerdict, resolve: finish } = Promise.withResolvers();
  const judged = [];
  const delivery = { enabled: true, groupAllowlist: ['test-group'], peers: { 'test-group': peer } };
  await withConnector(delivery, async (payload) => {
    judged.push(payload);
    if (judged.length === 1) {
      begin();
      return firstVerdict;
    }
    return { reply: true };
  }, { async ask() { return '我补一个不同的角度喵。'; } }, async (connector, sends, firstSend) => {
    await connector.accept({ ...inbound('invitation', '你先说，2 号也可以补充'),
      mentions: [{ member_openid: 'partner' }] });
    await started;
    for (const [id, text] of [['peer-one', '找鸟得看习性。'], ['peer-two', '先到水边蹲点。']]) {
      await connector.accept({ ...inbound(id, text), senderIsBot: true, senderId: 'partner' });
    }
    finish({ reply: false });
    await firstSend;
    assert.equal(judged.length, 2);
    assert.deepEqual(judged[1].recent_messages.filter((row) => row.role === 'participant').map((row) => row.text),
      ['找鸟得看习性。', '先到水边蹲点。']);
    assert.deepEqual(sends.map((send) => send.target.msgId), ['invitation']);
  });
});

test('the model decides whether an invitation to the paired cat should be answered', { timeout: 4_000 }, async () => {
  const peer = { name: '伙伴', selfName: '团子', memberId: 'partner', waitMs: 1 };
  const delivery = { enabled: true, groupAllowlist: ['test-group'], peers: { 'test-group': peer } };
  const judgments = [];
  await withConnector(delivery, async (payload, envelope) => {
    judgments.push(payload.current.text);
    return { reply: envelope.messageId === 'requested' };
  }, { async ask() { return '我在喵！'; } }, async (connector, sends, firstSend) => {
    const mention = [{ member_openid: 'partner' }];
    await connector.accept({ ...inbound('optional', '你自己先说'), mentions: mention });
    await delay(20);
    await connector.accept({ ...inbound('requested', '叫她也来聊会儿'), mentions: mention });
    await firstSend;
    assert.deepEqual(judgments, ['你自己先说', '叫她也来聊会儿']);
    assert.deepEqual(sends.map((send) => send.target.msgId), ['requested']);
  });
});

const incomingPeer = (id, content) => ({ ...inbound(id, content),
  senderId: 'partner', senderIsBot: true, raw: { author: { nickname: '伙伴' } } });

const until = async (check) => {
  for (let i = 0; i < 100 && !check(); i++) await delay(10);
  assert.ok(check());
};

test('the model gets same-group memory, can continue without a name, and obeys the configured round cap', async () => {
  const judged = [];
  const memory = { topic: { summary: '正在聊网线的梗' } };
  const ordinary = { async observe() {}, async stop() {}, async media(op, anchor, args) {
    assert.equal(op, 'peer_context');
    assert.equal(anchor.messageId, 'human');
    assert.ok(args.query);
    return memory;
  } };
  const delivery = { enabled: true, groupAllowlist: ['test-group'],
    peers: { 'test-group': { name: '伙伴', selfName: '团子', waitMs: 1 } } };
  await withConnector(delivery, async (payload) => {
    judged.push(payload);
    return { reply: payload.mode === 'peer_banter' };
  }, { async ask(_envelope, options) {
    if (!options.peerTurn) return '再叫杂鱼就嚼网线喵。';
    assert.deepEqual(options.ordinaryContext, memory);
    assert.equal(options.owner, false);
    return `回敬：${options.peerTurn.text}`;
  } }, async (connector, sends, firstSend) => {
    const [{ id }] = connector.peerGroups();
    assert.deepEqual(await connector.savePeerGroup({
      id, enabled: true, paused: false, maxRounds: 2,
    }), { status: 'saved' });
    await connector.accept({ ...inbound('human', '杂鱼猫猫'), rawEventType: 'GROUP_AT_MESSAGE_CREATE' });
    await firstSend;
    await delay(20);
    await connector.accept(incomingPeer('own-echo', '再叫杂鱼就嚼网线喵。'));
    await delay(20);
    assert.equal(judged.length, 0);
    for (const [id, content, sent] of [['one', '这根线也太细了吧！', 2], ['two', '还有路由器呢！', 3]]) {
      await connector.accept(incomingPeer(id, content));
      await until(() => sends.length === sent);
      await delay(20);
    }
    await connector.accept(incomingPeer('three', '再来再来！'));
    await delay(25);
    assert.deepEqual(judged.map((item) => item.rounds), [{ used: 0, remaining: 2, limit: 2 }, { used: 1, remaining: 1, limit: 2 }]);
    assert.deepEqual(judged[0].ordinary_memory, memory);
    assert.deepEqual(sends.map(({ target, extra }) => [target.msgId, extra.msg_seq]), [['human', 1], ['human', 2], ['human', 3]]);
  }, ordinary);
});

test('semantic stop cancels only this exchange while a stop command remains paused', async () => {
  for (const command of [false, true]) {
    const { promise: started, resolve: begin } = Promise.withResolvers();
    const { promise: reply, resolve: finish } = Promise.withResolvers();
    let stopJudged = false;
    const delivery = { enabled: true, groupAllowlist: ['test-group'],
      peers: { 'test-group': { name: '伙伴', selfName: '团子', waitMs: 1 } } };
    await withConnector(delivery, async (payload) => {
      if (payload.mode === 'peer_interrupt') {
        stopJudged = true;
        return { stop: payload.current.text === '你们俩收一收吧' };
      }
      return { reply: payload.mode === 'peer_banter' };
    },
    { async ask(_envelope, options) {
      if (!options.peerTurn) return '开场喵。';
      begin();
      return reply;
    } }, async (connector, sends, firstSend) => {
      await connector.accept({ ...inbound('human', '来聊聊'), rawEventType: 'GROUP_AT_MESSAGE_CREATE' });
      await firstSend;
      await connector.accept(incomingPeer('one', '试试反击！'));
      await started;
      await connector.accept(inbound('stop', command ? '/停止互动' : '你们俩收一收吧'));
      await until(() => command ? connector.peerGroups()[0].paused : stopJudged);
      await delay(20);
      assert.equal(connector.peerGroups()[0].paused, command);
      finish('已经排队的回嘴');
      await delay(25);
      assert.deepEqual(sends.map(({ target }) => target.msgId), command ? ['human', 'stop'] : ['human']);
      await connector.accept(incomingPeer('late', '刚才那轮再回一句'));
      await delay(20);
      assert.equal(sends.length, command ? 2 : 1);
      await connector.accept({ ...inbound('new-topic', '我们聊一个新的轻松话题吧'), rawEventType: 'GROUP_AT_MESSAGE_CREATE' });
      await until(() => sends.at(-1)?.target.msgId === 'new-topic');
      const before = sends.length;
      await connector.accept(incomingPeer('new-peer', '这话题挺有意思！'));
      if (command) { await delay(30); assert.equal(sends.length, before); }
      else await until(() => sends.length === before + 1);
    });
  }
});
