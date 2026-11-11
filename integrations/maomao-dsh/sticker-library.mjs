// Read-mostly view of the stickers the cat has collected, for the panel. Each chat scope
// keeps its own MemeStore (gallery/groups/<key>/memes.sqlite3); this module only finds,
// lists and removes collected stickers and never touches chat memory.
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const PAGE = 24;
const THUMB_BYTES = 1_500_000;
const mediaType = (buffer) => buffer.subarray(0, 3).toString() === 'GIF' ? 'image/gif'
  : buffer.subarray(0, 4).toString() === 'RIFF' ? 'image/webp'
    : buffer[0] === 0x89 ? 'image/png' : 'image/jpeg';

export function stickerRoots(home = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')) {
  return [join(home, 'integrations', 'maomao-qq', 'ordinary'), join(home, 'integrations', 'maomao-private-ordinary', 'ordinary')];
}

function findStores(root, depth = 0, found = []) {
  if (depth > 8 || !existsSync(root)) return found;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) findStores(path, depth + 1, found);
    else if (entry.name === 'memes.sqlite3' && path.includes(`${sep}gallery${sep}groups${sep}`)) found.push(path);
  }
  return found;
}

// A label people can recognise; the path only carries hashed chat identifiers.
function describe(path, root) {
  const parts = relative(root, path).split(sep);
  const id = createHash('sha256').update(path).digest('hex').slice(0, 24);
  if (parts[0] === 'qq') {
    const scope = parts[2] === 'group' ? 'QQ 群' : 'QQ 私聊';
    return { id, label: `${scope} · ${parts[3].slice(0, 6)}`, platform: 'qq' };
  }
  return { id, label: `飞书 / Telegram · ${parts[0].slice(0, 6)}`, platform: 'private' };
}

export function stickerSources(roots = stickerRoots()) {
  return roots.flatMap((root) => findStores(root).map((path) => ({ ...describe(path, root), path })));
}

function open(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout=2000; CREATE TABLE IF NOT EXISTS removed(id TEXT PRIMARY KEY, removed REAL NOT NULL);');
  return db;
}

const collected = "FROM images LEFT JOIN semantics USING(id) WHERE eligible=1 AND path IS NOT NULL AND id NOT IN (SELECT id FROM removed)";

export function manageStickers(request, { roots = stickerRoots() } = {}) {
  const sources = stickerSources(roots);
  if (request?.action === 'list') {
    return { status: 'ok', sources: sources.map(({ id, label, platform, path }) => {
      try {
        const db = open(path);
        try { return { id, label, platform, count: db.prepare(`SELECT count(*) AS n ${collected}`).get().n }; } finally { db.close(); }
      } catch { return { id, label, platform, count: null }; }
    }) };
  }
  const source = sources.find(({ id }) => id === request?.sourceId);
  if (!source) return { status: 'unavailable' };
  const root = dirname(source.path);
  if (request.action === 'read') {
    const page = request.page ?? 0;
    if (!Number.isSafeInteger(page) || page < 0 || page > 500) return { status: 'invalid' };
    const db = open(source.path);
    try {
      const total = db.prepare(`SELECT count(*) AS n ${collected}`).get().n;
      const rows = db.prepare(`SELECT id,description,ocr,category,path,created,last_sent,steal_reason ${collected} ORDER BY created DESC LIMIT ? OFFSET ?`)
        .all(PAGE, page * PAGE);
      const items = rows.map((row) => {
        const file = resolve(row.path);
        let image = null;
        // Only files inside this library's own folder are read.
        if (file.startsWith(root + sep) && existsSync(file) && statSync(file).size <= THUMB_BYTES) {
          const buffer = readFileSync(file);
          image = `data:${mediaType(buffer)};base64,${buffer.toString('base64')}`;
        }
        return { id: row.id, description: row.description, text: row.ocr, category: row.category,
          reason: row.steal_reason ?? '', collected: Math.round(row.created * 1000),
          lastSent: row.last_sent ? Math.round(row.last_sent * 1000) : null, image };
      });
      return { status: 'ok', items, total, pageSize: PAGE };
    } finally { db.close(); }
  }
  if (request.action === 'remove') {
    if (typeof request.id !== 'string' || !/^[a-f0-9]{64}$/.test(request.id)) return { status: 'invalid' };
    const db = open(source.path);
    try {
      const row = db.prepare('SELECT path FROM images WHERE id=?').get(request.id);
      if (!row) return { status: 'missing' };
      // Remembering the fingerprint keeps the cat from quietly collecting the same picture again.
      db.prepare('INSERT OR REPLACE INTO removed VALUES (?,?)').run(request.id, Date.now() / 1000);
      db.prepare('UPDATE images SET eligible=0, path=NULL, vector=NULL WHERE id=?').run(request.id);
      const file = row.path && resolve(row.path);
      if (file && file.startsWith(root + sep)) rmSync(file, { force: true });
      return { status: 'removed' };
    } finally { db.close(); }
  }
  return { status: 'invalid' };
}
