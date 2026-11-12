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

test('mounting chat guidance for the default cat keeps her full persona in the replaced prefix', async () => {
  const sections = [];
  const registry = { getSectionOrder: () => 10, section: (value) => { sections.push(value); return () => {}; } };
  const controller = { resolveAgent: async () => ({ agent: { ctx: { get: () => registry } } }) };
  const { mountChannelPersona: mount } = await import('../integrations/maomao-dsh/personas.mjs');
  await mount(controller, 's', { name: '猫猫', prompt: '' }, '[聊天工具] 指引');
  assert.equal(sections[0].name, 'deployment:persona-prefix');
  assert.match(sections[0].text, /你是猫猫，一只原创的成年河南猫娘/);
  assert.match(sections[0].text, /## 运行规则/);
  assert.match(sections[0].text, /\[聊天工具\] 指引$/);
  await mount(controller, 's', { name: '小狗', prompt: '你是小狗。' }, '');
  assert.doesNotMatch(sections[1].text, /河南猫娘/, 'a custom persona replaces the cat');
});
