// Local diagnostics for the cat: a rolling debug log for the current run (last 24 hours, cleared
// at start-up) and a persistent table of platform/API errors. Everything stays on this machine
// under the owner's DSH folder; secrets are masked before anything is written.
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const LEVELS = ['error', 'warn', 'info', 'debug', 'trace'];
const DAY = 86_400_000;
const API_KEEP_MS = 90 * DAY;
const API_KEEP_ROWS = 2000;
const ROLLING_KEEP_ROWS = 20_000;
const SECRET = /(?:sk|AIza|ghp|xox[bp])[-_A-Za-z0-9]{16,}|\b\d{6,}:[A-Za-z0-9_-]{25,}|(?:token|secret|password|api[_-]?key|authorization)(["'\s:=]+)(?:Bearer\s+)?[^\s"',}]{6,}/gi;

export function redact(value, max = 4000) {
  let text;
  try { text = typeof value === 'string' ? value : JSON.stringify(value); } catch { text = String(value); }
  text = String(text ?? '').replace(SECRET, (match, sep) => (sep ? match.slice(0, match.indexOf(sep) + sep.length) : '') + '«redacted»');
  return text.length > max ? `${text.slice(0, max)}…（截断，共 ${text.length} 字）` : text;
}

export class DebugLog {
  #db = null;
  #level = 3;
  #timer = null;
  #listeners = new Set();

  constructor(root = join(process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh'), 'integrations', 'maomao-logs'), { clock = Date.now } = {}) {
    this.clock = clock;
    try {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const path = join(root, 'logs.sqlite3');
      this.#db = new DatabaseSync(path);
      chmodSync(path, 0o600);
      this.#db.exec(`PRAGMA busy_timeout=2000; PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS rolling(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, level TEXT NOT NULL,
          source TEXT NOT NULL, event TEXT NOT NULL, detail TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS api_errors(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, source TEXT NOT NULL,
          code TEXT NOT NULL, message TEXT NOT NULL, detail TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY, level TEXT NOT NULL);
        DELETE FROM rolling;`);
      const saved = this.#db.prepare('SELECT level FROM settings WHERE id=1').get()?.level;
      if (LEVELS.includes(saved)) this.#level = LEVELS.indexOf(saved);
      this.#timer = setInterval(() => this.prune(), 15 * 60_000);
      this.#timer.unref?.();
    } catch { this.#db = null; }
    this.startedAt = this.clock();
  }

  get level() { return LEVELS[this.#level]; }

  setLevel(level) {
    if (!LEVELS.includes(level)) return false;
    this.#level = LEVELS.indexOf(level);
    this.#db?.prepare('INSERT OR REPLACE INTO settings VALUES (1,?)').run(level);
    return true;
  }

  enabled(level) { return LEVELS.indexOf(level) <= this.#level; }

  write(level, source, event, detail = '') {
    if (!this.#db || !LEVELS.includes(level) || !this.enabled(level)) return;
    try {
      const row = { at: this.clock(), level, source: String(source).slice(0, 40), event: String(event).slice(0, 120), detail: redact(detail) };
      this.#db.prepare('INSERT INTO rolling(at,level,source,event,detail) VALUES (?,?,?,?,?)').run(row.at, row.level, row.source, row.event, row.detail);
      for (const listener of this.#listeners) listener(row);
    } catch { /* Logging must never break a chat turn. */ }
  }

  // Persistent record of a failed platform or model API call; also mirrored into the rolling log.
  apiError(source, code, message = '', detail = '') {
    this.write('error', source, `API 报错 ${code}`, { message, detail });
    if (!this.#db) return;
    try {
      this.#db.prepare('INSERT INTO api_errors(at,source,code,message,detail) VALUES (?,?,?,?,?)')
        .run(this.clock(), String(source).slice(0, 40), String(code).slice(0, 80), redact(message, 500), redact(detail, 2000));
      this.#db.prepare('DELETE FROM api_errors WHERE at<? OR id NOT IN (SELECT id FROM api_errors ORDER BY id DESC LIMIT ?)')
        .run(this.clock() - API_KEEP_MS, API_KEEP_ROWS);
    } catch { /* Logging must never break a chat turn. */ }
  }

  prune() {
    try {
      this.#db?.prepare('DELETE FROM rolling WHERE at<? OR id NOT IN (SELECT id FROM rolling ORDER BY id DESC LIMIT ?)')
        .run(this.clock() - DAY, ROLLING_KEEP_ROWS);
    } catch { /* ignore */ }
  }

  read({ after = 0, level = 'trace', source = '', query = '', limit = 300 } = {}) {
    if (!this.#db) return [];
    const levels = LEVELS.slice(0, Math.max(0, LEVELS.indexOf(level)) + 1);
    const rows = this.#db.prepare(`SELECT * FROM rolling WHERE id>? AND level IN (${levels.map(() => '?').join(',')})
      AND (?='' OR source=?) AND (?='' OR instr(lower(event||' '||detail), lower(?))>0) ORDER BY id DESC LIMIT ?`)
      .all(after, ...levels, source, source, query, query, Math.min(Math.max(limit, 1), 1000));
    return rows.reverse().map((row) => ({ ...row }));
  }

  sources() {
    return this.#db ? this.#db.prepare('SELECT DISTINCT source FROM rolling ORDER BY source').all().map((row) => row.source) : [];
  }

  apiErrors({ limit = 200, source = '' } = {}) {
    if (!this.#db) return [];
    return this.#db.prepare("SELECT * FROM api_errors WHERE (?='' OR source=?) ORDER BY id DESC LIMIT ?")
      .all(source, source, Math.min(Math.max(limit, 1), 1000)).map((row) => ({ ...row }));
  }

  clearApiErrors() { this.#db?.exec('DELETE FROM api_errors'); }

  onWrite(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }

  close() { clearInterval(this.#timer); try { this.#db?.close(); } catch { /* ignore */ } this.#db = null; }
}

// One log per plugin process; modules write through these helpers so no context has to be threaded.
let current = null;
export const installLog = (log) => { current = log; return log; };
export const debugLog = () => current;
export const log = (level, source, event, detail) => current?.write(level, source, event, detail);
export const apiError = (source, code, message, detail) => current?.apiError(source, code, message, detail);
