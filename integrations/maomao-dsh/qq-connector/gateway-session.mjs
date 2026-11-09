import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function gatewaySessionPath(root, appId) {
  const account = createHash('sha256').update(appId).digest('hex').slice(0, 24);
  return join(root, 'integrations', 'maomao-qq', 'gateway', `${account}.json`);
}

function valid(session) {
  return session && typeof session.sessionId === 'string'
    && session.sessionId.length > 0 && session.sessionId.length <= 512
    && !/[\x00-\x1f]/.test(session.sessionId)
    && (session.lastSeq === null || Number.isSafeInteger(session.lastSeq) && session.lastSeq >= 0);
}

export class GatewaySessionFile {
  #path;
  #appId;
  #warn;

  constructor(path, appId, { warn = () => {} } = {}) {
    this.#path = path;
    this.#appId = appId;
    this.#warn = warn;
  }

  load() {
    try {
      const row = JSON.parse(readFileSync(this.#path, 'utf8'));
      return row?.appId === this.#appId && valid(row)
        ? { sessionId: row.sessionId, lastSeq: row.lastSeq } : null;
    } catch (error) {
      if (error?.code !== 'ENOENT') this.#warn('gateway_session_load_failed');
      return null;
    }
  }

  save(session) {
    if (!valid(session)) return;
    const temporary = `${this.#path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
      writeFileSync(temporary, JSON.stringify({ appId: this.#appId,
        sessionId: session.sessionId, lastSeq: session.lastSeq }), { mode: 0o600 });
      renameSync(temporary, this.#path);
    } catch {
      this.#warn('gateway_session_save_failed');
      try { rmSync(temporary, { force: true }); } catch { /* best effort */ }
    }
  }

  clear() {
    try { rmSync(this.#path, { force: true }); }
    catch { this.#warn('gateway_session_clear_failed'); }
  }
}
