import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const DAY = 86_400_000;
const GROUP_REPLIES = 5;
export const GROUP_REPLY_MS = 300_000;
const EMPTY = () => ({ version: 1, sessions: {}, receipts: {}, sends: {} });
const sendCount = (state, receiptKey) => Object.keys(state.sends).filter((key) => key.startsWith(`${receiptKey}:`)).length;

function digestOf(text) {
  return createHash('sha256').update(text).digest('hex');
}

export const routeKey = (botId, scope, chatId) => digestOf(JSON.stringify([botId, scope, chatId]));
export function qqStorageHome(root, profileDir) {
  // Desktop keeps the original home to preserve existing bindings and memory.
  return !profileDir || resolve(profileDir) === resolve(root, 'profiles', 'desktop') ? root : resolve(profileDir);
}
const ownerKey = (botId, chatId, senderId) => digestOf(JSON.stringify([botId, 'owner', chatId, senderId]));
const groupMemory = (botId, chatId) => ({ directory: digestOf(chatId), scope: digestOf(['qq', botId, 'group', chatId].join('\0')) });

export class ConnectorState {
  #path;
  #clock;
  #data = EMPTY();
  #pending = Promise.resolve();

  constructor(path, { clock = Date.now } = {}) {
    this.#path = path;
    this.#clock = clock;
  }

  async load() {
    try {
      const data = JSON.parse(await readFile(this.#path, 'utf8'));
      if (data?.version !== 1 || !data.sessions || !data.receipts || !data.sends) {
        throw new Error('unsupported QQ connector state');
      }
      this.#data = data;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return this;
  }

  #write(mutator) {
    const operation = this.#pending.then(async () => {
      const next = structuredClone(this.#data);
      const value = mutator(next);
      const cutoff = this.#clock() - DAY;
      for (const [key, receipt] of Object.entries(next.receipts)) {
        if (receipt.at < cutoff) delete next.receipts[key];
      }
      for (const [key, send] of Object.entries(next.sends)) {
        if (send.at < cutoff) delete next.sends[key];
      }
      for (const [key, call] of Object.entries(next.imageCalls ?? {})) {
        if (call.at < cutoff) delete next.imageCalls[key];
      }
      for (const [token, card] of Object.entries(next.choiceCards ?? {})) {
        if (card.expires <= this.#clock()) delete next.choiceCards[token];
      }
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      const temporary = `${this.#path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
      await rename(temporary, this.#path);
      this.#data = next;
      return value;
    });
    this.#pending = operation.catch(() => undefined);
    return operation;
  }

  async recordReceipt(envelope) {
    return this.#write((next) => {
      if (next.receipts[envelope.receiptKey]) return false;
      next.receipts[envelope.receiptKey] = {
        at: envelope.receivedAt,
        botId: envelope.botId,
        scope: envelope.scope,
        chatId: envelope.chatId,
        messageId: envelope.messageId,
      };
      if (envelope.scope === 'group') {
        const route = routeKey(envelope.botId, 'group', envelope.chatId);
        const account = digestOf(envelope.botId);
        const current = next.panelRoutes?.[route];
        if ((current?.account ?? current) === account && (!current.memory || !current.groupOpenId)) {
          next.panelRoutes[route] = { account, scope: 'group', memory: groupMemory(envelope.botId, envelope.chatId),
            groupOpenId: envelope.chatId };
        }
      }
      return true;
    });
  }

  async saveChoiceCard(token, envelope, profile, options) {
    return this.#write((next) => {
      const { botId, scope, chatId, senderId, messageId, receiptKey, receivedAt } = envelope;
      const expires = receivedAt + GROUP_REPLY_MS - 30_000;
      if (scope !== 'group' || expires <= this.#clock() || sendCount(next, receiptKey) >= GROUP_REPLIES) return false;
      next.choiceCards ??= {};
      for (const [key, card] of Object.entries(next.choiceCards)) {
        if (card.botId === botId && card.chatId === chatId && card.senderId === senderId) delete next.choiceCards[key];
      }
      next.choiceCards[token] = { botId, chatId, senderId, profile, options, expires,
        anchor: { botId, scope, chatId, senderId, messageId, receiptKey, receivedAt } };
      return true;
    });
  }

  async takeChoice({ token, index }, envelope, profile) {
    return this.#write((next) => {
      const { botId, chatId, senderId, messageId, receiptKey, receivedAt } = envelope;
      const card = next.choiceCards?.[token];
      if (!card?.anchor || card.expires <= this.#clock() || next.receipts[receiptKey]) return { code: 3 };
      if (card.botId !== botId || card.chatId !== chatId || card.senderId !== senderId) return { code: 4 };
      const label = card.options[index];
      if (card.profile !== profile || !label) return { code: 3 };
      if (sendCount(next, card.anchor.receiptKey) >= GROUP_REPLIES) return { code: 2 };
      delete next.choiceCards[token];
      next.receipts[receiptKey] = { at: receivedAt, botId, scope: 'group', chatId, messageId };
      return { code: 0, label, anchor: card.anchor };
    });
  }

  sessionId(botId, scope, chatId, profile) {
    const key = `${botId}:${scope}:${chatId}`;
    if (profile && this.#data.sessionProfiles?.[key] !== profile) return null;
    return this.#data.sessions[key] ?? null;
  }

  // How long a model session has been in use. Long-lived chats are rotated so the model
  // stops imitating hundreds of its own earlier replies.
  sessionMeta(botId, scope, chatId) {
    return this.#data.sessionMeta?.[`${botId}:${scope}:${chatId}`] ?? null;
  }

  async noteSessionTurn(botId, scope, chatId, sessionId) {
    return this.#write((next) => {
      const key = `${botId}:${scope}:${chatId}`;
      if (next.sessions[key] !== sessionId) return;
      next.sessionMeta ??= {};
      const meta = next.sessionMeta[key] ??= { startedAt: this.#clock(), turns: 0 };
      meta.turns += 1;
    });
  }

  panelAllowed(botId, scope, chatId) {
    return Boolean(this.#data.panelRoutes?.[routeKey(botId, scope, chatId)]);
  }

  panelRouteCount(botId) {
    return this.panelRoutes(botId).length;
  }

  directMessageSettings(botId) {
    return this.#data.directMessageSettings?.[digestOf(botId)] ?? null;
  }

  saveDirectMessageSettings(botId, settings) {
    return this.#write((next) => {
      next.directMessageSettings ??= {};
      next.directMessageSettings[digestOf(botId)] = { acceptStrangers: settings.acceptStrangers };
    });
  }

  peerSettings(botId, chatId) {
    return this.#data.peerSettings?.[routeKey(botId, 'group', chatId)];
  }

  savePeerSettings(botId, chatId, settings) {
    return this.#write((next) => {
      next.peerSettings ??= {};
      const key = routeKey(botId, 'group', chatId);
      next.peerSettings[key] = { ...next.peerSettings[key], ...settings };
      return next.peerSettings[key];
    });
  }

  panelRoutes(botId) {
    const account = digestOf(botId);
    const prefix = `${botId}:group:`;
    const observed = [...Object.keys(this.#data.sessions).filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length)),
      ...Object.values(this.#data.receipts).filter((row) => row.botId === botId && row.scope === 'group').map((row) => row.chatId)];
    const known = new Map(observed.map((chatId) => [routeKey(botId, 'group', chatId), chatId]));
    return Object.entries(this.#data.panelRoutes ?? {}).filter(([, entry]) => (entry?.account ?? entry) === account)
      .map(([id, entry]) => ({ id, scope: entry?.scope ?? (known.has(id) ? 'group' : null),
        groupOpenId: entry?.groupOpenId ?? known.get(id), userOpenId: entry?.userOpenId }));
  }

  async allowPanelRoute(botId, scope, chatId) {
    return this.#write((next) => {
      next.panelRoutes ??= {};
      next.panelRoutes[routeKey(botId, scope, chatId)] = { account: digestOf(botId), scope,
        ...(scope === 'group' ? { memory: groupMemory(botId, chatId), groupOpenId: chatId } : { userOpenId: chatId }) };
    });
  }

  memoryGroups(botId, configured = []) {
    const groups = new Map();
    for (const chatId of configured) {
      if (typeof chatId === 'string' && chatId) groups.set(routeKey(botId, 'group', chatId), groupMemory(botId, chatId));
    }
    const account = digestOf(botId);
    for (const [id, entry] of Object.entries(this.#data.panelRoutes ?? {})) {
      if (entry?.account === account && entry.scope === 'group' && !groups.has(id)) groups.set(id, entry.memory ?? {});
    }
    const prefix = `${botId}:group:`;
    const known = [...Object.keys(this.#data.sessions).filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length)),
      ...Object.values(this.#data.receipts).filter((row) => row.botId === botId && row.scope === 'group').map((row) => row.chatId)];
    for (const chatId of known) {
      const route = routeKey(botId, 'group', chatId);
      if (!groups.get(route)?.scope && this.panelAllowed(botId, 'group', chatId)) groups.set(route, groupMemory(botId, chatId));
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, memory]) => ({ key, ...memory }));
  }

  panelOwnsGroup(botId, chatId, senderId) {
    return Boolean(this.#data.panelOwners?.[ownerKey(botId, chatId, senderId)]);
  }

  panelOwnerBindings(botId) {
    const account = digestOf(botId);
    return Object.entries(this.#data.panelOwners ?? {}).filter(([, entry]) => entry.account === account)
      .map(([id]) => ({ id, scope: 'owner' }));
  }

  async bindPanelOwner(botId, chatId, senderId, configured) {
    return this.#write((next) => {
      const route = routeKey(botId, 'group', chatId);
      if (!configured && !next.panelRoutes?.[route]) return false;
      next.panelOwners ??= {};
      next.panelOwners[ownerKey(botId, chatId, senderId)] = { account: digestOf(botId), route };
      return true;
    });
  }

  async removePanelRoute(botId, id) {
    return this.#write((next) => {
      const entry = next.panelRoutes?.[id];
      const account = digestOf(botId);
      if (next.panelOwners?.[id]?.account === account) {
        delete next.panelOwners[id];
        return true;
      }
      if ((entry?.account ?? entry) !== account) return false;
      delete next.panelRoutes[id];
      if (next.peerSettings) delete next.peerSettings[id];
      for (const [key, owner] of Object.entries(next.panelOwners ?? {})) {
        if (owner.route === id && owner.account === account) delete next.panelOwners[key];
      }
      return true;
    });
  }

  async reserveImage(envelope) {
    return this.#write((next) => {
      const now = this.#clock();
      const receipt = next.receipts[envelope.receiptKey];
      if (!receipt || receipt.botId !== envelope.botId || receipt.chatId !== envelope.chatId
        || receipt.messageId !== envelope.messageId || receipt.scope !== envelope.scope
        || now < receipt.at || now - receipt.at > (envelope.scope === 'group' ? 300_000 : 60_000)) return false;
      next.imageCalls ??= {};
      const scope = JSON.stringify([envelope.botId, envelope.scope, envelope.chatId]);
      const used = Object.values(next.imageCalls).filter((call) => call.scope === scope && call.at >= now - DAY);
      if (next.imageCalls[envelope.receiptKey] || used.length >= 5) return false;
      next.imageCalls[envelope.receiptKey] = { scope, at: now };
      return true;
    });
  }

  async bindSession(botId, scope, chatId, sessionId, profile, replaced) {
    return this.#write((next) => {
      const key = `${botId}:${scope}:${chatId}`;
      if (next.sessions[key] && next.sessions[key] !== replaced
        && (!profile || next.sessionProfiles?.[key] === profile)) return next.sessions[key];
      next.sessions[key] = sessionId;
      next.sessionMeta ??= {};
      next.sessionMeta[key] = { startedAt: this.#clock(), turns: 0 };
      if (profile) {
        next.sessionProfiles ??= {};
        next.sessionProfiles[key] = profile;
      }
      return sessionId;
    });
  }

  async reserve(envelope, text, { optional = false } = {}) {
    if (typeof text !== 'string' || !text.trim()) throw new TypeError('send text must be nonempty');
    const fingerprint = digestOf(text);
    const key = `${envelope.receiptKey}:${fingerprint}`;
    return this.#write((next) => {
      const prior = next.sends[key];
      if (prior) return { ...prior, fresh: false, key };
      const receipt = next.receipts[envelope.receiptKey];
      // Official C2C reply window is 60 minutes (not 60 seconds). In particular,
      // a user may spend a few minutes confirming pairing in the panel.
      // https://github.com/tencent-connect/bot-docs/blob/main/docs/develop/api-v2/server-inter/message/send-receive/send.md
      const windowMs = envelope.scope === 'group' ? GROUP_REPLY_MS : 60 * 60_000;
      if (!receipt || receipt.botId !== envelope.botId
        || receipt.chatId !== envelope.chatId || receipt.messageId !== envelope.messageId
        || receipt.scope !== envelope.scope || this.#clock() - receipt.at > windowMs
        || this.#clock() < receipt.at) throw new Error('QQ reply anchor unavailable or expired');
      const max = envelope.scope === 'group' ? GROUP_REPLIES : 4;
      const count = sendCount(next, envelope.receiptKey);
      if (count >= max) {
        if (optional) return null;
        throw new Error('QQ passive reply budget exhausted');
      }
      const ticket = { seq: count + 1, at: this.#clock(), status: 'reserved', messageId: '' };
      next.sends[key] = ticket;
      return { ...ticket, fresh: true, key };
    });
  }

  async finish(key, messageId = '') {
    return this.#write((next) => {
      const ticket = next.sends[key];
      if (!ticket || ticket.status !== 'reserved') return false;
      ticket.status = messageId ? 'sent' : 'uncertain';
      ticket.messageId = messageId;
      return true;
    });
  }
}
