import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const learningKey = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
export const qqMemoryScope = ({ botId, scope, chatId }) => createHash('sha256').update(['qq', botId, scope, chatId].join('\0')).digest('hex');
const kinds = new Set(['profile', 'episode', 'skill', 'style', 'meme', 'followup', 'diary']);
const bounded = (s, n) => typeof s === 'string' && s.trim().length > 0 && s.length <= n;
// A second boundary in addition to the ordinary-only model instructions. Never archive credentials or private-mode passages.
export const ordinaryLearningText = s => typeof s === 'string' && !/\x00|-----BEGIN .*PRIVATE KEY|\b(?:sk|AIza)[-_A-Za-z0-9]{20,}|\b\d{6,}:[A-Za-z0-9_-]{25,}|(?:api.?key|token|password|密码|密钥)\s*[:=：]\s*\S+|R[- ]?18|NSFW|色情|私密模式|私有模式|性交|裸体|性器官/iu.test(s);

export class LearningStore {
  constructor(root, id, clock = Date.now) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('invalid_learning_scope');
    this.directory = join(root, id); this.clock = clock;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
    this.path = join(this.directory, 'learning.sqlite3');
    this.db(db => db.exec(`
      CREATE TABLE IF NOT EXISTS entries(id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL,
        body TEXT NOT NULL, subject TEXT NOT NULL, certainty TEXT NOT NULL, quote TEXT NOT NULL,
        source TEXT NOT NULL, updated INTEGER NOT NULL, expires INTEGER, version INTEGER NOT NULL,
        status TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, last_used INTEGER);
      CREATE TABLE IF NOT EXISTS revisions(id TEXT, version INTEGER, snapshot TEXT NOT NULL, PRIMARY KEY(id,version));
      CREATE TABLE IF NOT EXISTS evidence(id TEXT PRIMARY KEY, subject TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS evidence_origins(id TEXT PRIMARY KEY, kind TEXT NOT NULL, links TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reviews(id TEXT PRIMARY KEY, at INTEGER NOT NULL, outcome TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS entry_subject ON entries(subject,status);
      CREATE TABLE IF NOT EXISTS vectors(id TEXT PRIMARY KEY, model TEXT NOT NULL, signature TEXT NOT NULL, vector TEXT NOT NULL);
    `));
    chmodSync(this.path, 0o600);
  }
  db(fn) { const db = new DatabaseSync(this.path); try { db.exec('PRAGMA busy_timeout=2000'); return fn(db); } finally { db.close(); } }
  transaction(fn) { return this.db(db => { db.exec('BEGIN IMMEDIATE'); try { const out = fn(db); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; } }); }
  observe(id, subject, text, { kind = 'user', links = [] } = {}) {
    if (!bounded(id, 150) || !bounded(subject, 100) || !bounded(text, 6000) || !ordinaryLearningText(text)) return false;
    return this.db(db => {
      db.prepare('INSERT OR IGNORE INTO evidence VALUES (?,?,?,?)').run(id, subject, text, this.clock());
      db.prepare('INSERT OR IGNORE INTO evidence_origins VALUES (?,?,?)').run(id, kind, JSON.stringify(links));
      db.prepare('DELETE FROM evidence WHERE at<? OR id NOT IN (SELECT id FROM evidence ORDER BY at DESC LIMIT 300)').run(this.clock() - 30 * 86400000);
      db.prepare('DELETE FROM evidence_origins WHERE id NOT IN (SELECT id FROM evidence)').run();
      return true;
    });
  }
  evidence(subject) { return this.db(db => db.prepare("SELECT e.*,coalesce(o.kind,'user') AS origin,o.links FROM evidence e LEFT JOIN evidence_origins o ON o.id=e.id WHERE subject=? ORDER BY at DESC LIMIT 8").all(subject)); }
  list({ query = '', kind = '', page = 0, active = false } = {}) {
    const now = this.clock();
    // Models search with several keywords ("周末 拍鸟"); every keyword must appear somewhere in title or body.
    const terms = String(query).split(/[\s,，、;；]+/).filter(Boolean).slice(0, 6);
    const where = `WHERE (?='' OR kind=?) ${terms.map(() => "AND instr(lower(title||' '||body),lower(?))>0").join(' ')}
      AND (?=0 OR (status='active' AND (expires IS NULL OR expires>?)))`;
    const args = [kind, kind, ...terms, active ? 1 : 0, now];
    return this.db(db => ({ total: db.prepare(`SELECT count(*) AS n FROM entries ${where}`).get(...args).n,
      items: db.prepare(`SELECT * FROM entries ${where} ORDER BY updated DESC,id LIMIT 20 OFFSET ?`).all(...args, page * 20)
        .map(row => ({ ...row, status: row.status === 'active' && row.expires !== null && row.expires <= now ? 'expired' : row.status })), pageSize: 20 }));
  }
  get(id, use = false) {
    return this.db(db => {
      const row = db.prepare('SELECT * FROM entries WHERE id=?').get(id);
      if (!row || row.status !== 'active' || (row.expires !== null && row.expires <= this.clock())) return null;
      if (use) db.prepare('UPDATE entries SET used=used+1,last_used=? WHERE id=?').run(this.clock(), id);
      return row;
    });
  }
  save(input, { subject, owner = false, manual = false } = {}) {
    const { kind, title, body, quote = '', source = '', certainty = 'tentative', ttlDays = { episode: 30, followup: 14, diary: 60 }[kind] ?? 365 } = input ?? {};
    if (!kinds.has(kind) || !bounded(title, 100) || !bounded(body, kind === 'skill' ? 5000 : 1000)
      || !bounded(subject, 100) || !['confirmed', 'tentative'].includes(certainty)
      || !Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > 730
      || !ordinaryLearningText(`${title}\n${body}\n${quote}`)) return { status: 'invalid' };
    return this.transaction(db => {
      const previous = input.id ? db.prepare('SELECT * FROM entries WHERE id=?').get(input.id)
        : db.prepare('SELECT * FROM entries WHERE title=? AND subject=? AND kind=? ORDER BY updated DESC LIMIT 1').get(title, subject, kind);
      if (input.id && !previous) return { status: 'missing' };
      if (previous && ((!owner && previous.subject !== subject) || previous.kind !== kind)) return { status: 'denied' };
      if (previous && previous.status === 'forgotten') return { status: 'forgotten' };
      if (previous && (!Number.isSafeInteger(input.version) || input.version !== previous.version)) return { status: 'conflict', id: previous.id, version: previous.version };
      let links = [];
      let externalProject = false;
      if (!manual) {
        const evidence = db.prepare('SELECT * FROM evidence WHERE id=? AND subject=?').get(source, subject);
        const origin = db.prepare('SELECT * FROM evidence_origins WHERE id=?').get(source);
        if (origin?.kind === 'research' && kind !== 'meme') return { status: 'denied' };
        if (origin?.kind === 'project' && kind !== 'skill') return { status: 'denied' };
        externalProject = origin?.kind === 'project';
        if (!bounded(quote, 600) || quote.trim().length < (['style', 'meme', 'diary'].includes(kind) ? 1 : 4) || !evidence?.text.includes(quote)
          || evidence.at < this.clock() - 30 * 86400000) return { status: 'unverified' };
        if (['research', 'project'].includes(origin?.kind)) links = JSON.parse(origin.links);
      }
      if (!previous && db.prepare('SELECT count(*) AS n FROM entries').get().n >= 500) return { status: 'limit' };
      const row = { id: previous?.id ?? randomUUID(), kind, title: title.trim(), body: body.trim() + (links.length ? '\n\n查询来源：\n' + links.join('\n') : ''), subject: previous?.subject ?? subject,
        certainty: externalProject ? 'tentative' : certainty, quote: manual ? '' : quote, source: manual ? 'panel-owner' : source,
        updated: this.clock(), expires: this.clock() + ttlDays * 86400000, version: (previous?.version ?? 0) + 1,
        status: 'active', used: previous?.used ?? 0, last_used: previous?.last_used ?? null };
      this.write(db, row);
      return { status: 'saved', id: row.id, version: row.version };
    });
  }
  write(db, row) {
    db.prepare('INSERT OR REPLACE INTO entries VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...['id','kind','title','body','subject','certainty','quote','source','updated','expires','version','status','used','last_used'].map(k => row[k]));
    db.prepare('INSERT INTO revisions VALUES (?,?,?)').run(row.id, row.version, JSON.stringify(row));
    db.prepare('DELETE FROM revisions WHERE id=? AND version<?').run(row.id, row.version - 19);
  }
  change(id, version, action, { subject, owner = false, revision } = {}) {
    return this.transaction(db => {
      const row = db.prepare('SELECT * FROM entries WHERE id=?').get(id);
      if (!row) return { status: 'missing' };
      if (!owner && row.subject !== subject) return { status: 'denied' };
      // Hand back the current version so the model can retry in one step instead of loading first.
      if (row.version !== version) return { status: 'conflict', id: row.id, version: row.version };
      let next = row;
      if (action === 'restore') {
        if (!owner || !Number.isSafeInteger(revision)) return { status: 'denied' };
        const old = db.prepare('SELECT snapshot FROM revisions WHERE id=? AND version=?').get(id, revision);
        if (!old) return { status: 'missing' };
        next = JSON.parse(old.snapshot);
      } else if (action !== 'forget') return { status: 'invalid' };
      if (action === 'forget') {
        // A queued review may still carry an old snapshot. Revoking the original
        // evidence prevents it from recreating the forgotten fact under a new title.
        const sources = db.prepare('SELECT snapshot FROM revisions WHERE id=?').all(id).map(r => JSON.parse(r.snapshot).source);
        for (const source of sources) db.prepare('DELETE FROM evidence WHERE id=?').run(source);
      }
      this.write(db, { ...next, status: action === 'forget' ? 'forgotten' : next.status, version: row.version + 1, updated: this.clock() });
      return { status: 'saved' };
    });
  }
  // Vector index over active entries. A vector counts only for the current model and the
  // entry's current text, so an edit or a model switch re-indexes that entry.
  vectorDocs() {
    return this.db(db => db.prepare("SELECT id,kind,title,body FROM entries WHERE status='active' AND (expires IS NULL OR expires>?)").all(this.clock()))
      .map(row => { const text = `${row.title}。${row.body}`.slice(0, 1500); return { id: row.id, text, signature: learningKey(text) }; });
  }
  vectorProgress(model) {
    const docs = this.vectorDocs();
    const saved = new Map(this.db(db => db.prepare('SELECT id,signature FROM vectors WHERE model=?').all(model)).map(r => [r.id, r.signature]));
    return { total: docs.length, indexed: docs.filter(d => saved.get(d.id) === d.signature).length };
  }
  missingVectors(model, limit = 16) {
    const saved = new Map(this.db(db => db.prepare('SELECT id,signature FROM vectors WHERE model=?').all(model)).map(r => [r.id, r.signature]));
    return this.vectorDocs().filter(d => saved.get(d.id) !== d.signature).slice(0, limit);
  }
  saveVectors(model, rows) {
    this.transaction(db => {
      for (const { id, signature, vector } of rows) db.prepare('INSERT OR REPLACE INTO vectors VALUES (?,?,?,?)').run(id, model, signature, JSON.stringify(vector));
      db.prepare("DELETE FROM vectors WHERE id NOT IN (SELECT id FROM entries WHERE status='active')").run();
    });
  }
  nearest(model, query, { limit = 5, threshold = 0.5 } = {}) {
    const docs = new Map(this.vectorDocs().map(d => [d.id, d]));
    return this.db(db => db.prepare('SELECT id,signature,vector FROM vectors WHERE model=?').all(model))
      .filter(r => docs.get(r.id)?.signature === r.signature)
      .map(r => ({ id: r.id, score: JSON.parse(r.vector).reduce((sum, x, i) => sum + x * query[i], 0) }))
      .filter(r => r.score >= threshold).sort((a, b) => b.score - a.score).slice(0, limit);
  }
  history(id) { return this.db(db => db.prepare('SELECT snapshot FROM revisions WHERE id=? ORDER BY version DESC LIMIT 20').all(id).map(r => JSON.parse(r.snapshot))); }
  claimReview(id, limit) {
    return this.transaction(db => {
      if (db.prepare('SELECT id FROM reviews WHERE id=?').get(id)) return false;
      db.prepare('DELETE FROM reviews WHERE at<?').run(this.clock() - 30 * 86400000);
      if (db.prepare('SELECT count(*) AS n FROM reviews WHERE at>=?').get(Math.floor(this.clock() / 86400000) * 86400000).n >= limit) return false;
      db.prepare('INSERT INTO reviews VALUES (?,?,?)').run(id, this.clock(), 'running'); return true;
    });
  }
  reviewDone(id, outcome) { this.db(db => db.prepare('UPDATE reviews SET outcome=? WHERE id=?').run(outcome, id)); }
  reviewStatus() { return this.db(db => db.prepare('SELECT at,outcome FROM reviews ORDER BY at DESC LIMIT 1').get() ?? null); }
  markdown(kind = '') {
    const rows = this.db(db => db.prepare("SELECT * FROM entries WHERE status='active' AND expires>? ORDER BY kind,title").all(this.clock()));
    if (kind) {
      const row = rows.find(r => r.id === kind && r.kind === 'skill');
      return row ? `---\nname: learned-${row.id}\ndescription: ${JSON.stringify(row.title)}\n---\n\n${row.body}\n` : null;
    }
    return '# 普通聊天记忆\n\n' + rows.filter(r => r.kind !== 'skill').map(r => `## ${r.title}\n\n${r.body}\n\n- 对象：${r.subject}\n- 状态：${r.certainty}\n- 更新：${new Date(r.updated).toISOString()}\n`).join('\n');
  }
}
