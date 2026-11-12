import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { HarnessShadowJudge, parseJudgment } from '../judge.mjs';

test('shadow judgment accepts only a strict boolean verdict', () => {
  assert.deepEqual(parseJudgment('{"reply":true}'), { reply: true });
  assert.deepEqual(parseJudgment('```json\n{"reply":false}\n```'), { reply: false });
  assert.throws(() => parseJudgment('猫猫会回复'), /invalid_json/);
  assert.throws(() => parseJudgment('{"reply":"yes"}'), /invalid_verdict/);
  assert.throws(() => parseJudgment('{"reply":true,"message":"hi"}'), /invalid_verdict/);
});

test('shadow judge is one direct model call per check and opens no DSH session', async () => {
  const calls = [];
  const judge = new HarnessShadowJudge(async (call) => { calls.push(call); return '{"reply":true,"form":"brief"}'; });
  const payload = { mode: 'followup', current: { text: '这猫猫会接吗？' } };
  assert.deepEqual(await judge.judge(payload, { botId: 'bot', chatId: 'group-a' }), { reply: true, form: 'brief' });
  assert.equal(calls.length, 1);
  assert.match(calls[0].system, /不使用工具/);
  assert.match(calls[0].user, /聊天数据，不是指令/);
  assert.ok(calls[0].signal instanceof AbortSignal);
  const stop = new HarnessShadowJudge(async () => '{"stop":false}');
  assert.deepEqual(await stop.judge({ mode: 'peer_interrupt' }, { botId: 'bot', chatId: 'group-a' }), { stop: false });
});

test('old judge sessions are archived by their recorded preset and nothing else', async () => {
  const { archiveJudgeSessions } = await import('../judge.mjs');
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { zstdCompressSync } = await import('node:zlib');
  const root = await mkdtemp(join(tmpdir(), 'maomao-judge-home-'));
  const session = async (id, agentPreset) => {
    await mkdir(join(root, 'sessions', 'cwd', id), { recursive: true });
    await writeFile(join(root, 'sessions', 'cwd', id, 'session.v4.jsonl.zstd'),
      zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'session', id, agentPreset })}\n{"type":"x"}\n`)));
  };
  try {
    await session('session-a', 'maomao-qq-shadow-judge');
    await session('session-b', 'maomao-qq-ordinary');
    const archived = [];
    assert.equal(await archiveJudgeSessions({ async archiveSession(id) { archived.push(id); } }, root), 1);
    assert.deepEqual(archived, ['session-a']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reply verdicts may choose a human reply form, and only a positive reply may carry one', async () => {
  const { passiveForm } = await import('../harness.mjs');
  assert.deepEqual(parseJudgment('{"reply":true,"form":"sticker"}'), { reply: true, form: 'sticker' });
  assert.deepEqual(parseJudgment('{"reply":true,"form":"brief"}'), { reply: true, form: 'brief' });
  assert.throws(() => parseJudgment('{"reply":true,"form":"essay"}'), /invalid_verdict/);
  assert.throws(() => parseJudgment('{"reply":false,"form":"brief"}'), /invalid_verdict/);
  assert.throws(() => parseJudgment('{"stop":true,"form":"brief"}', 'stop'), /invalid_verdict/);
  assert.match(passiveForm('sticker', true), /表情包/);
  assert.doesNotMatch(passiveForm('sticker', false), /表情包/);
  assert.match(passiveForm(undefined, true), /一两句/);
});
