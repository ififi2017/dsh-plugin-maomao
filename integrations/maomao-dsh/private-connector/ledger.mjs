import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { digest } from './identity.mjs';

export class PrivateLedger {
  #db;

  constructor(path) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.#db.exec(`
      PRAGMA busy_timeout=4000;
      CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY, received INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, session TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sends(id TEXT PRIMARY KEY, created INTEGER NOT NULL, state TEXT NOT NULL, platform_id TEXT);
      CREATE TABLE IF NOT EXISTS choice_cards(
        route TEXT PRIMARY KEY, token TEXT NOT NULL, message TEXT NOT NULL, body TEXT NOT NULL,
        options TEXT NOT NULL, expires INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS verified_routes(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS verified_endpoints(
        route TEXT PRIMARY KEY, platform TEXT NOT NULL, accountId TEXT NOT NULL, chatId TEXT NOT NULL, senderId TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS contact_activity(id TEXT PRIMARY KEY, received INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS panel_bindings(
        route TEXT PRIMARY KEY, peer TEXT NOT NULL, account TEXT NOT NULL, owner TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS owner_labels(owner TEXT PRIMARY KEY, label TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS media_checks(
        platform TEXT PRIMARY KEY, outcome TEXT NOT NULL, checked INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS diagnostics(
        platform TEXT NOT NULL, kind TEXT NOT NULL, outcome TEXT NOT NULL, at INTEGER NOT NULL,
        PRIMARY KEY(platform,kind)
      );
    `);
  }

  admit(event) {
    const key = digest([event.platform, event.accountId, event.chatId, event.messageId]);
    const cutoff = Date.now() - 7 * 86_400_000;
    this.#db.prepare('DELETE FROM receipts WHERE received < ?').run(cutoff);
    this.#db.prepare('DELETE FROM sends WHERE created < ?').run(cutoff);
    return this.#db.prepare('INSERT OR IGNORE INTO receipts VALUES (?,?)').run(key, event.receivedAt).changes ? key : null;
  }

  session(route) { return this.#db.prepare('SELECT session FROM sessions WHERE id=?').get(route)?.session ?? null; }

  bind(route, session) {
    this.#db.prepare('INSERT OR IGNORE INTO sessions VALUES (?,?)').run(route, session);
    return this.session(route);
  }

  reserve(receipt, segment) {
    const key = digest([receipt, segment]);
    return this.#db.prepare("INSERT OR IGNORE INTO sends VALUES (?,?,'reserved',NULL)")
      .run(key, Date.now()).changes ? key : null;
  }

  finish(ticket, platformId) {
    this.#db.prepare("UPDATE sends SET state=?,platform_id=? WHERE id=? AND state='reserved'")
      .run(platformId ? 'sent' : 'uncertain', platformId ?? null, ticket);
  }

  saveChoices(route, token, message, body, options) {
    const now = Date.now();
    this.#db.prepare('DELETE FROM choice_cards WHERE expires <= ?').run(now);
    this.#db.prepare('INSERT OR REPLACE INTO choice_cards VALUES (?,?,?,?,?,?)')
      .run(route, token, message, body, JSON.stringify(options), now + 10 * 60_000);
  }

  takeChoice(route, message, { token, index }) {
    const card = this.#db.prepare(`DELETE FROM choice_cards
      WHERE route=? AND message=? AND token=? AND expires>? AND json_array_length(options)>?
      RETURNING body, options`).get(route, message, token, Date.now(), index);
    return card ? { body: card.body, label: JSON.parse(card.options)[index] } : null;
  }

  clearChoices(route) {
    this.#db.prepare('DELETE FROM choice_cards WHERE route=?').run(route);
  }

  close() { this.#db.close(); }

  verifyRoute(route, event) {
    this.#db.prepare('INSERT OR IGNORE INTO verified_routes VALUES (?)').run(route);
    if (event) this.#db.prepare('INSERT OR IGNORE INTO verified_endpoints VALUES (?,?,?,?,?)')
      .run(route, event.platform, event.accountId, event.chatId, event.senderId);
  }

  verifiedEndpoints() {
    return this.#db.prepare('SELECT route,platform,accountId,chatId,senderId FROM verified_endpoints ORDER BY route').all();
  }

  verifiedRoute(route) { return Boolean(this.#db.prepare('SELECT 1 FROM verified_routes WHERE id=?').get(route)); }

  recordActivity(owner, received) {
    this.#db.prepare('INSERT INTO contact_activity VALUES (?,?) ON CONFLICT(id) DO UPDATE SET received=max(received,excluded.received)')
      .run(owner, received);
  }

  lastActivity(owner) { return this.#db.prepare('SELECT received FROM contact_activity WHERE id=?').get(owner)?.received ?? null; }

  panelBinding(route) {
    return this.#db.prepare('SELECT peer, owner FROM panel_bindings WHERE route=?').get(route);
  }

  addPanelBinding({ route, peer, account, owner }) {
    return this.#db.prepare('INSERT OR IGNORE INTO panel_bindings VALUES (?,?,?,?)')
      .run(route, peer, account, owner).changes === 1;
  }

  reassignPanelBinding({ route, peer, account, previousOwner, owner }) {
    return this.#db.prepare('UPDATE panel_bindings SET owner=? WHERE route=? AND peer=? AND account=? AND owner=?')
      .run(owner, route, peer, account, previousOwner).changes === 1;
  }

  panelOwners(account) {
    return this.#db.prepare('SELECT DISTINCT owner FROM panel_bindings WHERE account=?').all(account).map(({ owner }) => owner);
  }

  panelBindings(account) {
    return this.#db.prepare('SELECT route AS id,owner FROM panel_bindings WHERE account=? ORDER BY route').all(account);
  }

  ownerLabels() {
    return new Map(this.#db.prepare('SELECT owner,label FROM owner_labels').all().map(({ owner, label }) => [owner, label]));
  }

  setOwnerLabel(owner, label) {
    if (!label) this.#db.prepare('DELETE FROM owner_labels WHERE owner=?').run(owner);
    else this.#db.prepare('INSERT OR REPLACE INTO owner_labels VALUES (?,?)').run(owner, label);
  }

  removePanelBinding(id, account) {
    return this.#db.prepare('DELETE FROM panel_bindings WHERE route=? AND account=?').run(id, account).changes === 1;
  }

  recordMedia(platform, outcome, at = Date.now()) {
    this.#db.prepare(`INSERT INTO media_checks VALUES (?,?,?)
      ON CONFLICT(platform) DO UPDATE SET outcome=excluded.outcome, checked=excluded.checked`)
      .run(platform, outcome, at);
  }

  mediaStatus() {
    return Object.fromEntries(this.#db.prepare('SELECT platform, outcome, checked AS at FROM media_checks').all()
      .map(({ platform, ...result }) => [platform, result]));
  }

  recordDiagnostic(platform, kind, outcome) {
    this.#db.prepare(`INSERT INTO diagnostics VALUES (?,?,?,?)
      ON CONFLICT(platform,kind) DO UPDATE SET outcome=excluded.outcome, at=excluded.at`)
      .run(platform, kind, outcome, Date.now());
  }

  diagnostics() {
    const result = {};
    for (const { platform, kind, ...event } of this.#db.prepare('SELECT platform,kind,outcome,at FROM diagnostics').all()) {
      (result[platform] ??= {})[kind] = event;
    }
    return result;
  }
}
