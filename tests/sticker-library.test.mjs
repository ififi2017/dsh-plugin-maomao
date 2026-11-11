import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { manageStickers } from '../integrations/maomao-dsh/sticker-library.mjs';

function library(root, parts, rows) {
  const dir = join(root, ...parts, 'gallery', 'groups', 'k'.repeat(64));
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'memes.sqlite3'));
  db.exec(`CREATE TABLE images(id TEXT PRIMARY KEY,description TEXT NOT NULL,ocr TEXT NOT NULL,category TEXT NOT NULL,seen INTEGER NOT NULL,
    eligible INTEGER NOT NULL,path TEXT,dhash TEXT NOT NULL,model TEXT,vector TEXT,created REAL NOT NULL,last_seen REAL NOT NULL,last_sent REAL);
    CREATE TABLE semantics(id TEXT PRIMARY KEY,steal_reason TEXT NOT NULL);`);
  for (const [id, eligible, file] of rows) {
    const path = file && join(dir, file);
    if (path) writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    db.prepare('INSERT INTO images VALUES (?,?,?,?,?,?,?,?,NULL,NULL,?,?,NULL)').run(id, `描述 ${id.slice(0, 4)}`, '', '开心', 2, eligible, path ?? null, '0', 1000, 1000);
    db.prepare('INSERT INTO semantics VALUES (?,?)').run(id, '打招呼时用');
  }
  db.close();
  return dir;
}

test('the panel lists each chat\'s collected stickers and removal deletes the file and blocks re-collection', () => {
  const home = mkdtempSync(join(tmpdir(), 'maomao-stickers-'));
  try {
    const roots = [join(home, 'qq'), join(home, 'private')];
    const a = 'a'.repeat(64), b = 'b'.repeat(64), c = 'c'.repeat(64);
    const dir = library(roots[0], ['qq', 'bot', 'group', 'chatchat'], [[a, 1, `${a}.png`], [b, 0, null], [c, 1, `${c}.png`]]);
    library(roots[1], ['owner'], []);
    const list = manageStickers({ action: 'list' }, { roots });
    assert.deepEqual(list.sources.map(({ label, count }) => [label, count]).sort(), [['QQ 群 · chatch', 2], ['飞书 / Telegram · owner', 0]]);
    const source = list.sources.find(({ count }) => count === 2);
    const page = manageStickers({ action: 'read', sourceId: source.id }, { roots });
    assert.equal(page.total, 2);
    assert.match(page.items[0].image, /^data:image\/png;base64,/);
    assert.equal(page.items[0].reason, '打招呼时用');
    assert.equal(manageStickers({ action: 'remove', sourceId: source.id, id: 'not-a-hash' }, { roots }).status, 'invalid');
    assert.equal(manageStickers({ action: 'remove', sourceId: source.id, id: a }, { roots }).status, 'removed');
    assert.equal(existsSync(join(dir, `${a}.png`)), false);
    assert.equal(manageStickers({ action: 'read', sourceId: source.id }, { roots }).total, 1);
    const db = new DatabaseSync(join(dir, 'memes.sqlite3'));
    assert.deepEqual({ ...db.prepare('SELECT count(*) AS n FROM removed WHERE id=?').get(a) }, { n: 1 });
    db.close();
    assert.equal(manageStickers({ action: 'read', sourceId: 'unknown' }, { roots }).status, 'unavailable');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('group messages are parsed only when they address the bot', async () => {
  const { telegramInbound, feishuInbound } = await import('../integrations/maomao-dsh/private-connector/identity.mjs');
  const now = Date.now(); const date = Math.floor(now / 1000);
  const tg = (chat, text, extra = {}) => telegramInbound('2000', { message: { message_id: 5, date, chat, from: { id: 1001, is_bot: false }, text, ...extra } }, now, 'maomaobot');
  const g = { id: -100123, type: 'supergroup', title: '测试群' };
  assert.equal(tg(g, '大家好'), null);
  assert.equal(tg(g, '@MaomaoBot 在吗', { entities: [{ type: 'mention', offset: 0, length: 10 }] }).text, '在吗');
  assert.equal(tg(g, '对的', { reply_to_message: { from: { id: 2000 } } }).chatId, '-100123');
  assert.equal(tg(g, '@otherbot 在吗', { entities: [{ type: 'mention', offset: 0, length: 9 }] }), null);
  assert.equal(tg({ id: 1001, type: 'private' }, '你好').scope, undefined);
  const lark = (chat_type, text, mentions, botOpenId = 'ou_bot') => feishuInbound('cli_x', { sender: { sender_type: 'user', sender_id: { open_id: 'ou_a' } },
    message: { message_id: 'om_1', chat_id: 'oc_g', chat_type, create_time: String(now), message_type: 'text', content: JSON.stringify({ text }), mentions } }, now, botOpenId);
  assert.equal(lark('group', '大家好', []), null);
  assert.equal(lark('group', '@_user_1 帮我看看 @_user_2', [{ key: '@_user_1', id: { open_id: 'ou_bot' } }, { key: '@_user_2', id: { open_id: 'ou_b' }, name: '小明' }]).text, '帮我看看 @小明');
  assert.equal(lark('group', '@_user_1 在吗', [{ key: '@_user_1', id: { open_id: 'ou_bot' } }], ''), null, 'without its own open_id the bot cannot be sure it was addressed');
});
