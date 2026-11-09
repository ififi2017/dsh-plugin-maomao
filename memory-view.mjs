import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { desktopMemorySource } from './integrations/maomao-dsh/private-connector/desktop-memory.mjs';

const pageSize = 20;
const kinds = ['preference', 'project', 'historical_note'];

function sources(ctx) {
  return [desktopMemorySource(), ...['maomaoPrivate', 'maomaoQq'].flatMap((service) =>
    (ctx.get(service)?.memorySources?.() ?? []).map(({ scope, key = scope, ...rest }) => ({
      id: `${service}:${key}`, scope, ...rest,
    })))];
}

export function readMemoryView(ctx, request) {
  const available = sources(ctx);
  if (request?.action === 'list') {
    return { status: 'ok', sources: available.map(({ id, label, platforms }) => ({ id, label, platforms })) };
  }
  const { sourceId, query = '', kind = '', page = 0 } = request ?? {};
  if (request?.action !== 'read' || typeof query !== 'string' || query.length > 100
    || (kind !== '' && !kinds.includes(kind)) || !Number.isSafeInteger(page) || page < 0 || page > 5000) {
    return { status: 'invalid' };
  }
  const source = available.find(({ id }) => id === sourceId);
  if (!source) return { status: 'unavailable' };
  if (!source.path || !existsSync(source.path)) {
    return { status: 'ok', items: [], total: 0, ...(source.platforms.includes('qq') ? { recentTurns: 0 } : {}) };
  }
  try {
    return readPage(source, query.trim(), kind, page);
  } catch {
    return { status: 'failed' };
  }
}

function readPage({ path, scope, platforms, historical }, query, kind, page) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=1000; BEGIN');
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
    const now = Date.now();
    const activity = platforms.includes('qq') ? { recentTurns: tables.has('turns')
      ? db.prepare('SELECT count(*) AS count FROM turns WHERE scope=? AND received>=?')
        .get(scope, now / 1000 - 7 * 86400).count : 0 } : {};
    const selects = [];
    const params = [];
    if (tables.has('memory_items')) {
      selects.push(`SELECT id,kind,key AS title,statement,quote,speaker_id AS speaker,
        updated,expires_at AS expires,status FROM memory_items WHERE scope=?`);
      params.push(scope);
    }
    if (historical && platforms.length === 1 && ['desktop', 'feishu'].includes(platforms[0])
      && tables.has('historical_notes')) {
      selects.push(`SELECT 'note:'||id AS id,'historical_note' AS kind,'' AS title,quote AS statement,
        '' AS quote,'' AS speaker,imported AS updated,NULL AS expires,'active' AS status FROM historical_notes WHERE scope=?`);
      params.push(scope);
    }
    if (!selects.length) return { status: 'ok', items: [], total: 0, ...activity };
    const base = `FROM (${selects.join(' UNION ALL ')}) WHERE (?='' OR kind=?)
      AND (?='' OR instr(lower(title||' '||statement||' '||quote),lower(?))>0)`;
    params.push(kind, kind, query, query);
    const total = db.prepare(`SELECT count(*) AS count ${base}`).get(...params).count;
    const items = db.prepare(`SELECT * ${base} ORDER BY updated DESC,id DESC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, page * pageSize).map((row) => ({
        id: row.id, kind: row.kind, title: row.title, statement: row.statement, quote: row.quote,
        speaker: platforms.includes('qq') && /^[a-f0-9]{12}$/.test(row.speaker) ? row.speaker.slice(0, 6) : '',
        updated: row.updated * 1000, expires: row.expires === null ? null : row.expires * 1000,
        status: row.status === 'active' && row.expires !== null && row.expires * 1000 <= now ? 'expired' : row.status,
      }));
    return { status: 'ok', items, total, pageSize, ...activity };
  } finally { db.close(); }
}
