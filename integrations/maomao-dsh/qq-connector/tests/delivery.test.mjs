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

async function withConnector(delivery, judge, harness, run) {
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
        semantic: { enabled: true }, delivery } },
    { botFactory: () => bot, shadowJudge: judge, harness });
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

test('only the paired cat can add peer context and a human receipt anchors the interjection', async () => {
  const peer = { name: '猫猫 1 号', selfName: '猫猫 2 号', memberId: 'partner', waitMs: 35 };
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
    assert.equal(await connector.accept({ ...inbound('unknown-bot', '别的机器人'),
      senderIsBot: true, senderId: 'unknown' }), false);
    await connector.accept({ ...inbound('other-human'), mentions: [{ member_openid: 'friend' }] });
    await connector.accept({ ...inbound('peer-topic', '两只都可以聊这个梗'),
      mentions: [{ member_openid: 'partner' }] });
    assert.equal(await connector.accept({ ...inbound('peer-reply', '我先说我的看法。'),
      senderIsBot: true, senderId: 'partner' }), true);
    await firstSend;
    assert.deepEqual(judged.map(({ mode }) => mode), ['peer_addressed']);
    assert.ok(judged[0].recent_messages.some((row) => row.role === 'peer' && row.text === '我先说我的看法。'));
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
    assert.deepEqual(judged[1].recent_messages.filter((row) => row.role === 'peer').map((row) => row.text),
      ['找鸟得看习性。', '先到水边蹲点。']);
    assert.deepEqual(sends.map((send) => send.target.msgId), ['invitation']);
  });
});

test('asking the paired cat to call this cat takes the reply path even if optional interjections are declined', { timeout: 4_000 }, async () => {
  const peer = { name: '猫猫', selfName: '猫猫 2 号', memberId: 'partner', waitMs: 1 };
  const delivery = { enabled: true, groupAllowlist: ['test-group'], peers: { 'test-group': peer } };
  const { promise: optionalJudgment, resolve: judged } = Promise.withResolvers();
  const judgments = [];
  const answers = [];
  await withConnector(delivery, async (_payload, envelope) => {
    judgments.push(envelope.messageId);
    judged();
    return { reply: false };
  }, { async ask(envelope, options) {
    answers.push({ id: envelope.messageId, handoff: options.handoff });
    return '我在喵！';
  } }, async (connector, sends, firstSend) => {
    const mention = [{ member_openid: 'partner' }];
    await connector.accept({ ...inbound('optional', '2 号有不同意见也可以接'), mentions: mention });
    await optionalJudgment;
    await connector.accept({ ...inbound('requested', '<@partner> 叫一下 2 号看看是不是睡着了啊'), mentions: mention });
    await firstSend;
    assert.deepEqual(judgments, ['optional']);
    assert.deepEqual(answers, [{ id: 'requested', handoff: true }]);
    assert.deepEqual(sends.map((send) => send.target.msgId), ['requested']);
  });
});
