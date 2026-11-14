import { createHash } from 'node:crypto';
import { appendFile, chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { plainChatMarkdown } from '../message-markdown.mjs';
import { GROUP_REPLY_MS } from './state.mjs';

const CONTEXT_MS = 8 * 60_000;
const FOLLOWUP_MS = 5 * 60_000;
const TOPIC_GAP_MS = 15 * 60_000;
const REPLY_GAP_MS = 4_000;
const HOUR_MS = 60 * 60_000;
const PEER_SETTLE_MS = 1_500;
const MAX_PEER_RECHECKS = 2;
export const PEER_ROUNDS_WITHOUT_HUMANS = 2;
const LIVELY_WINDOW_MS = 5 * 60_000;
// Replies to another bot, counted across human messages: one person egging both bots on must not
// turn them into an endless exchange. Per group: at most 3 in ten minutes while a single person
// is watching, and 8 in an hour in any case.
const PEER_BURST_MS = 10 * 60_000;
const PEER_BURST_LIMIT = 3;
const PEER_HOURLY_LIMIT = 8;
const NAME_HINT = /猫猫|lxc|小猫|喵/i;
const QUESTION_HINT = /[?？]|吗$|么$|呢$|有人(?:知道|懂|会|用过|拍过)|求(?:推荐|助|问)|怎么|为啥|为什么|哪(?:里|儿|个|款)|是什么|是啥|啥鸟|什么鸟|有多/;

function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 20);
}

function oneLine(value, limit = 200) {
  return String(value ?? '').replace(/\s*\n\s*/g, ' / ').trim().slice(0, limit);
}

function displayText(envelope) {
  const kinds = envelope.attachments.map((item) => item.kind === 'image' ? '[图片]'
    : item.kind === 'audio' ? '[语音]' : item.kind === 'video' ? '[视频]' : '[文件]');
  return oneLine([envelope.text, ...kinds].filter(Boolean).join(' '));
}

export class PassiveShadow {
  #path;
  #clock;
  #delay;
  #judge;
  #ownerIds;
  #isOwner;
  #groups = new Map();
  #writes = Promise.resolve();
  #pending = new Set();
  #closed = false;

  constructor(path, { clock = Date.now, debounceMs = 1_500, ownerIds = [], isOwner = () => false, judge = null } = {}) {
    this.#path = path;
    this.#clock = clock;
    this.#delay = debounceMs;
    this.#judge = judge;
    this.#ownerIds = new Set(ownerIds);
    this.#isOwner = isOwner;
  }

  #key(envelope) {
    return `${envelope.botId}:${envelope.chatId}`;
  }

  #state(envelope) {
    const key = this.#key(envelope);
    if (!this.#groups.has(key)) {
      this.#groups.set(key, { rows: [], version: 0, inboundAt: 0, gap: 0,
        latestHuman: null, botAt: 0, botText: '', recipient: '', lastOpen: 0, openers: [],
        pending: null, peerVersion: 0, peerJob: null, peerRounds: 0, lastPeerBanterAt: null, peerReplies: [], interrupt: null, outbound: [] });
    }
    return this.#groups.get(key);
  }

  #audit(envelope, mode, decision, reason) {
    const row = { at: new Date(this.#clock()).toISOString(),
      bot: digest(envelope.botId), group: digest(this.#key(envelope)),
      message: digest(envelope.receiptKey), mode, decision, reason };
    if (!this.#path) return Promise.resolve(row);
    const operation = this.#writes.then(async () => {
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      try {
        if ((await stat(this.#path)).size > 256_000) {
          const lines = (await readFile(this.#path, 'utf8')).trim().split('\n').slice(-200);
          const temporary = `${this.#path}.${process.pid}.tmp`;
          await writeFile(temporary, `${lines.join('\n')}\n`, { mode: 0o600 });
          await rename(temporary, this.#path);
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await appendFile(this.#path, `${JSON.stringify(row)}\n`, { mode: 0o600 });
      await chmod(this.#path, 0o600);
      return row;
    });
    this.#writes = operation.catch(() => undefined);
    return operation;
  }

  async observe(envelope, { hasReferencedImage = false, peer = null, allowJudgment = true, onPeerStop } = {}) {
    if (this.#closed || envelope?.channel !== 'qq' || envelope.scope !== 'group') return null;
    const now = this.#clock();
    const state = this.#state(envelope);
    const hadPeerJob = Boolean(state.peerJob);
    const previousInterrupt = state.interrupt;
    state.gap = state.inboundAt ? now - state.inboundAt : 0;
    state.inboundAt = now;
    state.version += 1;
    state.latestHuman = envelope;
    state.peerRounds = 0;
    state.peerJob = null;
    state.rows = state.rows.filter((row) => now - row.at <= CONTEXT_MS);
    const shown = displayText(envelope);
    if (shown) state.rows.push({ at: now, role: 'user', speaker: digest(envelope.senderId),
      senderId: envelope.senderId, text: shown, messageId: envelope.messageId });
    state.rows = state.rows.slice(-30);
    if (state.pending) {
      clearTimeout(state.pending.timer);
      state.pending.resolve(null);
      state.pending = null;
    }
    state.interrupt = previousInterrupt;
    if (peer && !peer.paused && this.#judge && envelope.text.trim()
      && (hadPeerJob || state.lastPeerBanterAt !== null && now - state.lastPeerBanterAt <= GROUP_REPLY_MS)) {
      const payload = {
        mode: 'peer_interrupt',
        recent_messages: this.contextFor(envelope),
        current: { role: 'user', text: oneLine(envelope.text, 400) },
      };
      const interrupt = Promise.resolve(previousInterrupt).then(async (stopped) => {
        if (stopped || this.#closed) return Boolean(stopped);
        const verdict = await this.#judge(payload, envelope);
        if (verdict?.stop !== true || this.#closed) return false;
        this.cancelPeer(envelope);
        await this.#audit(envelope, 'peer_interrupt', 'skip', 'semantic_stop_current_exchange');
        await onPeerStop?.();
        return true;
      }).catch(() => false);
      state.interrupt = interrupt;
      void interrupt.finally(() => { if (state.interrupt === interrupt) state.interrupt = null; });
    }
    if (envelope.addressed) return this.#audit(envelope, 'addressed', 'skip', 'direct_reply_path');
    if (envelope.addressedToOther && (!peer || peer.paused)) {
      return this.#audit(envelope, 'unsolicited', 'skip', 'addressed_other');
    }
    if (!envelope.text.trim()) return this.#audit(envelope, 'unsolicited', 'skip', 'no_text');

    const named = NAME_HINT.test(envelope.text);
    const followup = state.botAt && now - state.botAt <= FOLLOWUP_MS
      && (envelope.senderId === state.recipient || QUESTION_HINT.test(envelope.text));
    const mode = envelope.addressedToOther ? 'group_interjection'
      : named ? 'named' : followup ? 'followup' : 'unsolicited';
    // Judge a human line only where unprompted replies are on; the other bot's lines still anchor on it.
    const canJudge = allowJudgment;
    if (!canJudge) return this.#audit(envelope, mode, 'candidate', 'semantic_judge_unavailable');
    // Coalesce a fast followup instead of silently dropping it before judgment.
    const settleMs = state.botAt ? Math.max(0, REPLY_GAP_MS - (now - state.botAt)) : 0;
    const interjection = mode === 'unsolicited';
    // Activity informs the model; a fixed multi-minute silence must not hide a
    // new invitation. Delivery quotas, debounce and peer round limits still apply.
    state.openers = state.openers.filter((at) => now - at < HOUR_MS);

    const version = state.version;
    const payload = () => Object.freeze({ mode, fresh_start: state.gap >= TOPIC_GAP_MS,
      recent_messages: this.contextFor(envelope),
      current: { speaker: digest(envelope.senderId), text: oneLine(envelope.text),
        ...(hasReferencedImage ? { recent_image_available: true } : {}) },
      seconds_since_cat_reply: state.botAt ? Math.floor((this.#clock() - state.botAt) / 1000) : null,
      recent_interjections: state.openers.length,
      current_is_owner: this.#ownerIds.has(envelope.senderId) || this.#isOwner(envelope),
      same_recipient: Boolean(envelope.senderId && envelope.senderId === state.recipient) });
    const task = new Promise((resolve) => {
      const timer = setTimeout(async () => {
        state.pending = null;
        try {
          if (this.#closed || state.version !== version) return resolve(null);
          if (await state.interrupt || this.#closed || state.version !== version) return resolve(null);
          if (!this.#judge) {
            return resolve(await this.#audit(envelope, mode, 'candidate', 'semantic_judge_unavailable'));
          }
          let verdict;
          let rechecks = 0;
          while (true) {
            const peerVersion = state.peerVersion;
            verdict = await this.#judge(payload(), envelope);
            if (this.#closed || state.version !== version) {
              return resolve(await this.#audit(envelope, mode, 'skip', 'superseded'));
            }
            if (state.peerVersion === peerVersion) break;
            if (rechecks === MAX_PEER_RECHECKS) {
              return resolve(await this.#audit(envelope, mode, 'skip', 'peer_superseded'));
            }
            rechecks += 1;
            await wait(PEER_SETTLE_MS);
            if (this.#closed || state.version !== version) {
              return resolve(await this.#audit(envelope, mode, 'skip', 'superseded'));
            }
          }
          const reply = verdict?.reply === true;
          if (reply && interjection) {
            state.lastOpen = this.#clock();
            state.openers.push(state.lastOpen);
          }
          const reason = reply ? 'semantic_yes' : 'semantic_no';
          const row = await this.#audit(envelope, mode, reply ? 'would_reply' : 'skip', rechecks ? `${reason}_after_peer` : reason);
          resolve(reply && verdict.form ? { ...row, form: verdict.form } : row);
        } catch {
          resolve(await this.#audit(envelope, mode, 'skip', 'judge_error'));
        }
      }, Math.max(settleMs, mode === 'group_interjection' ? Math.max(this.#delay, peer.waitMs ?? 3_000) : this.#delay));
      state.pending = { timer, resolve };
    });
    state.humanJudging = envelope;
    this.#pending.add(task);
    void task.finally(() => {
      if (state.humanJudging === envelope) state.humanJudging = null;
      this.#pending.delete(task);
    });
    return task;
  }

  async notePeer(botId, chatId, peer, message, { enabled, recall } = {}) {
    const { messageId, content, senderId } = message;
    const text = oneLine(content, 400);
    if (this.#closed || !text || !messageId) return null;
    const group = { botId, chatId, scope: 'group' };
    const state = this.#groups.get(this.#key(group));
    if (!state || state.rows.some((row) => row.messageId === messageId)) return null;
    const now = this.#clock();
    if (state.outbound.some((row) => now - row.at < 15_000
      && row.text === oneLine(plainChatMarkdown(content), 400))) return null;
    const speaker = oneLine(message.senderName || message.raw?.author?.nickname, 64) || digest(senderId ?? '');
    state.peerVersion += 1;
    state.rows.push({ at: now, role: 'participant', speaker, senderId, text, messageId });
    state.rows = state.rows.slice(-30);

    if (!enabled?.() || !this.#judge || state.peerJob) return null;
    const anchor = state.latestHuman;
    const audit = (decision, reason) =>
      this.#audit({ ...group, receiptKey: `qq:${botId}:group:${chatId}:${messageId}` }, 'peer_banter', decision, reason);
    if (!anchor || state.humanJudging === anchor) return null;
    if (now - anchor.receivedAt > GROUP_REPLY_MS) {
      await audit('skip', 'qq_reply_window_expired');
      return null;
    }
    // Two bots trading lines in front of a single person reads as a script, not a chat. The
    // full round setting applies only while several people are actually talking.
    const severalPeople = () => new Set(state.rows.filter((row) => row.role === 'user' && now - row.at <= LIVELY_WINDOW_MS)
      .map((row) => row.speaker)).size >= 2;
    const roundLimit = () => severalPeople() ? peer.maxRounds : Math.min(peer.maxRounds, PEER_ROUNDS_WITHOUT_HUMANS);
    if (state.peerRounds >= roundLimit()) {
      await audit('skip', severalPeople() ? 'banter_limit' : 'banter_without_humans');
      return null;
    }
    state.peerReplies = (state.peerReplies ?? []).filter((at) => now - at < HOUR_MS);
    const burst = !severalPeople() && state.peerReplies.filter((at) => now - at < PEER_BURST_MS).length >= PEER_BURST_LIMIT;
    if (burst || state.peerReplies.length >= PEER_HOURLY_LIMIT) {
      await audit('skip', burst ? 'banter_burst_cap' : 'banter_hourly_cap');
      return null;
    }
    const job = {};
    state.peerJob = job;
    const release = () => { if (state.peerJob === job) state.peerJob = null; };
    const expiresAt = anchor.receivedAt + GROUP_REPLY_MS;
    const current = () => state.peerJob === job && this.isLatest(anchor) && this.#clock() <= expiresAt && enabled();
    let selected = false;
    try {
      await wait(this.#delay);
      if (await state.interrupt || !current()) return null;
      let turn;
      let memory;
      let verdict;
      for (let attempt = 0; attempt <= MAX_PEER_RECHECKS; attempt++) {
        const latest = state.rows.findLast((row) => row.role === 'participant');
        if (!latest || !current()) return null;
        turn = { speaker: latest.speaker, senderId: latest.senderId, text: latest.text, messageId: latest.messageId };
        const version = state.peerVersion;
        memory = await recall?.(anchor, turn.text);
        if (!current()) return null;
        verdict = await this.#judge({ mode: 'peer_banter',
          rounds: { used: state.peerRounds, remaining: roundLimit() - state.peerRounds, limit: roundLimit() },
          replies_to_bot_last_hour: state.peerReplies.length,
          several_people: severalPeople(),
          recent_messages: this.contextFor({ ...anchor, messageId: latest.messageId }),
          ordinary_memory: memory ?? null, current: { role: 'participant', speaker: turn.speaker, text: turn.text } }, anchor);
        if (!current()) return null;
        if (state.peerVersion === version) break;
        if (attempt === MAX_PEER_RECHECKS) return null;
      }
      if (verdict?.reply !== true) {
        await audit('skip', 'semantic_no');
        return null;
      }
      state.peerRounds += 1;
      state.lastPeerBanterAt = this.#clock();
      state.peerReplies.push(state.lastPeerBanterAt);
      await audit('would_reply', 'semantic_yes');
      selected = true;
      return { anchor, peerTurn: { ...turn, ...(verdict.form ? { form: verdict.form } : {}) }, memory, current, release };
    } catch {
      await audit('skip', 'judge_error');
      return null;
    } finally {
      if (!selected) release();
    }
  }

  cancelPeer(envelope) {
    const state = this.#groups.get(this.#key(envelope));
    if (state) {
      state.peerJob = null;
      state.latestHuman = null;
      state.lastPeerBanterAt = null;
    }
  }

  noteReply(envelope, text, messageId) {
    if (this.#closed || envelope?.scope !== 'group') return;
    const state = this.#state(envelope);
    const now = this.#clock();
    state.botAt = now;
    state.botText = oneLine(text, 800);
    state.recipient = envelope.senderId;
    state.rows.push({ at: now, role: 'assistant', speaker: 'cat', text: state.botText, messageId });
    state.rows = state.rows.slice(-30);
  }

  noteOutbound(envelope, text) {
    if (this.#closed || envelope.scope !== 'group') return;
    const state = this.#state(envelope);
    state.outbound.push({ at: this.#clock(), text: oneLine(plainChatMarkdown(text), 400) });
    state.outbound = state.outbound.slice(-8);
  }

  isLatest(envelope) {
    return !this.#closed && envelope?.scope === 'group'
      && this.#groups.get(this.#key(envelope))?.latestHuman?.messageId === envelope.messageId;
  }

  contextFor(envelope, since = 0) {
    if (this.#closed || envelope?.scope !== 'group') return [];
    const now = this.#clock();
    return this.#state(envelope).rows.filter((row) => row.messageId !== envelope.messageId && row.at >= since
      && now - row.at <= CONTEXT_MS).slice(-12).map((row) => Object.freeze({
      role: row.role, speaker: row.speaker, text: row.text,
      age_seconds: Math.max(0, Math.floor((now - row.at) / 1000)),
    }));
  }

  status() {
    return Object.freeze({ enabled: !this.#closed, groups: this.#groups.size,
      pending: this.#pending.size, semanticJudge: Boolean(this.#judge) });
  }

  async stop() {
    this.#closed = true;
    for (const state of this.#groups.values()) {
      if (state.pending) {
        clearTimeout(state.pending.timer);
        state.pending.resolve(null);
        state.pending = null;
      }
    }
    await Promise.allSettled([...this.#pending]);
    await this.#writes;
    this.#groups.clear();
  }
}
