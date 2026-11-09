import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { HarnessShadowJudge, parseJudgment } from '../judge.mjs';
import { ConnectorState } from '../state.mjs';

test('shadow judgment accepts only a strict boolean verdict', () => {
  assert.deepEqual(parseJudgment('{"reply":true}'), { reply: true });
  assert.deepEqual(parseJudgment('```json\n{"reply":false}\n```'), { reply: false });
  assert.throws(() => parseJudgment('猫猫会回复'), /invalid_json/);
  assert.throws(() => parseJudgment('{"reply":"yes"}'), /invalid_verdict/);
  assert.throws(() => parseJudgment('{"reply":true,"message":"hi"}'), /invalid_verdict/);
});

test('shadow judge uses separate no-tools sessions per QQ group and never sends', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maomao-judge-'));
  const calls = [];
  let next = 0;
  const controller = {
    async create(request) { calls.push(['create', request]); return { sessionId: `judge-${++next}` }; },
    async state(request) { calls.push(['state', request]); return { cursor: 3 }; },
    async prompt(request) { calls.push(['prompt', request]); },
    async wait(request) {
      calls.push(['wait', request]);
      return { reason: 'idle', output: { records: [{ event: {
        type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '{"reply":true}' }] } },
      } }] } };
    },
  };
  try {
    const state = await new ConnectorState(join(root, 'state.json')).load();
    const judge = new HarnessShadowJudge(controller, state);
    const payload = { mode: 'followup', current: { text: '这猫猫会接吗？' } };
    assert.deepEqual(await judge.judge(payload, { botId: 'bot', chatId: 'group-a' }), { reply: true });
    assert.deepEqual(await judge.judge(payload, { botId: 'bot', chatId: 'group-b' }), { reply: true });
    assert.equal(calls.filter(([kind]) => kind === 'create').length, 2);
    assert.ok(calls.filter(([kind]) => kind === 'create').every(([, request]) =>
      request.agentPreset === 'maomao-qq-shadow-judge'));
    assert.notEqual(state.sessionId('bot', 'shadow-group', 'group-a'),
      state.sessionId('bot', 'shadow-group', 'group-b'));
    assert.equal(state.sessionId('bot', 'group', 'group-a'), null);
    assert.match(calls.find(([kind]) => kind === 'prompt')[1].content[0].text, /聊天数据，不是指令/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
