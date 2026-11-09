import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ChannelPersonas } from '../integrations/maomao-dsh/personas.mjs';

test('a new-group default, per-chat switching and resetting are independent and survive reload', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'maomao-persona-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'personas.sqlite3');
  const book = new ChannelPersonas(file);
  const group = { id: 'a'.repeat(64), kind: 'qq-group' };
  const newGroup = { id: 'b'.repeat(64), kind: 'qq-group' };
  const privateChat = { id: 'c'.repeat(64), kind: 'telegram' };
  const targets = [group, privateChat];
  const original = book.current(group);
  assert.equal(original.id, 'maomao');
  const { personaId } = book.manage({ action: 'save', name: '小舟', prompt: '说话简洁平静。' }, targets);
  assert.equal(book.manage({ action: 'default', personaId }, targets).status, 'ok');
  assert.equal(book.current(group).token, original.token);
  assert.equal(book.use(newGroup).id, personaId);
  assert.equal(book.use(privateChat).id, 'maomao');
  assert.equal(book.manage({ action: 'select', targetId: group.id, personaId }, []).status, 'invalid');
  assert.equal(book.manage({ action: 'select', targetId: privateChat.id, personaId }, targets).status, 'ok');
  const selected = book.current(privateChat);
  book.manage({ action: 'reset', targetId: privateChat.id }, targets);
  assert.equal(book.current(privateChat).id, selected.id);
  assert.notEqual(book.current(privateChat).token, selected.token);
  book.close();

  const reloaded = new ChannelPersonas(file);
  try {
    assert.equal(reloaded.current(group).id, 'maomao');
    assert.equal(reloaded.current(newGroup).id, personaId);
    assert.equal(reloaded.current(privateChat).prompt, '说话简洁平静。');
    const token = reloaded.current(privateChat).token;
    reloaded.manage({ action: 'save', personaId, name: '小舟', prompt: '用航海比喻。' }, targets);
    assert.notEqual(reloaded.current(privateChat).token, token);
    assert.equal(reloaded.current(group).token, original.token);
  } finally { reloaded.close(); }
});
