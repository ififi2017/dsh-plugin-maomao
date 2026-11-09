import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { desktopMemoryHook, desktopMemorySource } from '../desktop-memory.mjs';
import { OwnerMemory } from '../memory.mjs';
import { digest } from '../identity.mjs';

test('desktop cat recalls an ordinary preference across sessions; injected and private content is not learned', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maomao-desktop-memory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worker = new OwnerMemory({ root });
  const run = desktopMemoryHook(worker, (message) => message);
  const signal = new AbortController().signal;
  const message = (kind, text) => ({ source: { kind }, content: [{ type: 'text', text }] });
  const step = (id, input, kind = 'user') => {
    const messages = [message(kind, input)];
    return run({ agent: { id }, messages, turn: 1, signal }, async () => ({ kind: 'enter', messages }));
  };
  await step('first', '我最喜欢青柠苏打');
  const { scope } = desktopMemorySource();
  const db = new DatabaseSync(join(root, scope, 'dialogue.sqlite3'));
  try {
    const insert = db.prepare('INSERT INTO historical_notes VALUES (?, ?, ?, ?, ?)');
    insert.run(scope, 'reviewed', '2026-11-03 聊过修理银色收音机。', 'synthetic-reviewed', 1);
    insert.run(digest(['different-owner']), 'other', '2026-11-03 聊过修理蓝色收音机。', 'synthetic-other', 1);
  } finally {
    db.close();
  }
  await step('injection', '我最喜欢红枣冰糕', 'agent-instructions');
  await step('private', '我最喜欢私密模式');
  const output = await step('new session', '你记得我最喜欢什么吗？');
  assert.equal(output.messages.length, 2);
  assert.match(output.messages[1].content[0].text, /青柠苏打/);
  assert.doesNotMatch(output.messages[1].content[0].text, /红枣冰糕|私密模式|收音机/);
  const history = await step('history', '我们以前聊过收音机吗？');
  assert.match(history.messages[1].content[0].text, /银色收音机/);
  assert.doesNotMatch(history.messages[1].content[0].text, /蓝色收音机/);
  const elsewhere = await worker.run('desktop', {
    owner: digest(['different-owner']), turnId: digest(['different-turn']), text: '我喜欢什么？',
  }, signal);
  assert.deepEqual(elsewhere, {});
  assert.deepEqual(desktopMemorySource().platforms, ['desktop']);
});
