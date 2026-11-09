import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { readMemoryView } from '../memory-view.mjs';

test('memory view only reads current authorized scopes and keeps ordinary notes and QQ members separate', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maomao-memory-view-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'dialogue.sqlite3');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE memory_items(id TEXT, scope TEXT, kind TEXT, key TEXT, statement TEXT, quote TEXT,
    speaker_id TEXT, updated REAL, expires_at REAL, status TEXT);
    CREATE TABLE historical_notes(id TEXT, scope TEXT, quote TEXT, imported REAL);
    CREATE TABLE turns(scope TEXT, received REAL)`);
  const insert = db.prepare('INSERT INTO memory_items VALUES (?,?,?,?,?,?,?,?,?,?)');
  const now = Date.now() / 1000;
  for (let i = 0; i < 22; i++) {
    insert.run(String(i), 'own', 'preference', '鸟', `喜欢拍鸟 ${i}`, '偏好摘录', '', now + i, now + 60, 'active');
  }
  insert.run('secret', 'another-owner', 'project', 'private', 'out-of-scope', '', '', now, now + 60, 'active');
  insert.run('qq', 'group', 'project', '相机', '正在研究新相机', '', 'abcdef123456', now, now - 10, 'active');
  const turn = db.prepare('INSERT INTO turns VALUES (?,?)');
  turn.run('group', now);
  turn.run('group', now - 8 * 86400);
  turn.run('other-group', now);
  db.prepare('INSERT INTO historical_notes VALUES (?,?,?,?)').run('reviewed', 'own', '审核过的普通旧资料', now - 100);
  db.close();

  let privateSource = [{ scope: 'own', path, label: '主人 1', platforms: ['feishu', 'telegram'] },
    { scope: 'own', key: 'lark-only', path, label: 'Hermes 旧记忆', platforms: ['feishu'], historical: true }];
  const ctx = { get: (name) => ({ memorySources: () => name === 'maomaoPrivate' ? privateSource
    : [{ scope: 'group', path, label: 'QQ群 1', platforms: ['qq'] }] }) };
  const sources = readMemoryView(ctx, { action: 'list' }).sources;
  assert.deepEqual(sources.map(({ label, platforms }) => [label, platforms]),
    [['猫猫', ['desktop']], ['主人 1', ['feishu', 'telegram']], ['Hermes 旧记忆', ['feishu']], ['QQ群 1', ['qq']]]);
  assert(!JSON.stringify(sources).includes(path));
  const read = (source, filters = {}) => readMemoryView(ctx, { action: 'read', sourceId: source.id, ...filters });
  assert.equal(read(sources[1]).total, 22);
  assert.equal(read(sources[1]).items.length, 20);
  assert.equal(read(sources[1], { page: 1 }).items.length, 2);
  assert.equal(read(sources[1], { query: '偏好摘录' }).total, 22);
  assert.equal(read(sources[1], { kind: 'historical_note' }).total, 0);
  assert.equal(read(sources[2], { kind: 'historical_note' }).items[0].statement, '审核过的普通旧资料');
  assert.equal(read(sources[1], { query: 'out-of-scope' }).total, 0);
  assert.deepEqual(read(sources[3]).items.map(({ status, speaker }) => [status, speaker]), [['expired', 'abcdef']]);
  assert.equal(read(sources[3], { kind: 'historical_note' }).total, 0);
  assert.equal(read(sources[3]).recentTurns, 1);
  privateSource = [];
  assert.equal(read(sources[1]).status, 'unavailable');
});
