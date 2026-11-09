import { createHash } from 'node:crypto';
import { appendFile, chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

const CONTEXT_MS = 8 * 60_000;
const FOLLOWUP_MS = 5 * 60_000;
const TOPIC_GAP_MS = 15 * 60_000;
const REPLY_GAP_MS = 4_000;
const HOUR_MS = 60 * 60_000;
const PEER_SETTLE_MS = 1_500;
const MAX_PEER_RECHECKS = 2;
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

function asksToCallCat(text, selfName) {
  const compact = (value) => value.normalize('NFKC').replace(/\s+/gu, '');
  const name = compact(selfName ?? '');
  if (!name) return false;
  const shortName = /[0-9]+号$/.exec(name)?.[0];
  const targets = (shortName ? [name, shortName] : [name]).map((value) => RegExp.escape(value)).join('|');
  const request = new RegExp(
    `(?:^|[，。！？,!?；;：:])(?:麻烦你?|能不能|可以|帮我|请你|你)?`
    + `(?:叫(?:一下|一声)?|喊(?:一下|一声)?|问问|让|请)(?:${targets})`
    + '(?=$|[，。！？,!?；;：:]|出来|过来|看看|说|讲|回|答|接|聊|是不是|在不在|有没有|也|一起|来)',
  );
  return request.test(compact(text.replace(/<@!?[A-Za-z0-9_-]+>/g, '')));
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
        latestMessageId: '', botAt: 0, botText: '', recipient: '', lastOpen: 0, openers: [], pending: null, peerVersion: 0 });
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

  async observe(envelope, { hasReferencedImage = false, peer = null, allowJudgment = true } = {}) {
    if (this.#closed || envelope?.channel !== 'qq' || envelope.scope !== 'group') return null;
    const now = this.#clock();
    const state = this.#state(envelope);
    state.gap = state.inboundAt ? now - state.inboundAt : 0;
    state.inboundAt = now;
    state.version += 1;
    state.latestMessageId = envelope.messageId;
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
    if (envelope.addressed) return this.#audit(envelope, 'addressed', 'skip', 'direct_reply_path');
    if (envelope.addressedToOther && !envelope.addressedToPeer) {
      return this.#audit(envelope, 'unsolicited', 'skip', 'addressed_other');
    }
    if (!envelope.text.trim()) return this.#audit(envelope, 'unsolicited', 'skip', 'no_text');

    const named = NAME_HINT.test(envelope.text);
    const followup = state.botAt && now - state.botAt <= FOLLOWUP_MS
      && (envelope.senderId === state.recipient || QUESTION_HINT.test(envelope.text));
    const handoff = envelope.addressedToPeer && asksToCallCat(envelope.text, peer?.selfName);
    const mode = handoff ? 'peer_handoff' : envelope.addressedToPeer ? 'peer_addressed'
      : named ? 'named' : followup ? 'followup' : 'unsolicited';
    if (state.botAt && now - state.botAt < REPLY_GAP_MS) {
      return this.#audit(envelope, mode, 'skip', 'reply_gap');
    }
    const interjection = mode === 'unsolicited' || mode === 'peer_addressed';
    if (interjection) {
      state.openers = state.openers.filter((at) => now - at < HOUR_MS);
      const owner = this.#ownerIds.has(envelope.senderId) || this.#isOwner(envelope);
      const cooldown = owner ? 3 * 60_000 : 10 * 60_000;
      if (now - Math.max(state.lastOpen, state.botAt) < cooldown) {
        return this.#audit(envelope, mode, 'skip', 'cooldown');
      }
      if (state.openers.length >= 5) return this.#audit(envelope, mode, 'skip', 'hourly');
    }

    const version = state.version;
    const payload = () => Object.freeze({ mode, fresh_start: state.gap >= TOPIC_GAP_MS,
      recent_messages: this.contextFor(envelope),
      current: { speaker: digest(envelope.senderId), text: oneLine(envelope.text),
        ...(hasReferencedImage ? { recent_image_available: true } : {}) },
      ...(peer ? { self_name: peer.selfName, other_cat: peer.name } : {}),
      seconds_since_cat_reply: state.botAt ? Math.floor((this.#clock() - state.botAt) / 1000) : null,
      same_recipient: Boolean(envelope.senderId && envelope.senderId === state.recipient) });
    const task = new Promise((resolve) => {
      const timer = setTimeout(async () => {
        state.pending = null;
        try {
          if (this.#closed || state.version !== version) return resolve(null);
          if (!allowJudgment || (!handoff && !this.#judge)) {
            return resolve(await this.#audit(envelope, mode, 'candidate', 'semantic_judge_unavailable'));
          }
          if (handoff) return resolve(await this.#audit(envelope, mode, 'would_reply', 'explicit_handoff'));
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
          resolve(await this.#audit(envelope, mode, reply ? 'would_reply' : 'skip', rechecks ? `${reason}_after_peer` : reason));
        } catch {
          resolve(await this.#audit(envelope, mode, 'skip', 'judge_error'));
        }
      }, peer && mode !== 'followup' ? Math.max(this.#delay, peer.waitMs ?? 12_000) : this.#delay);
      state.pending = { timer, resolve };
    });
    this.#pending.add(task);
    void task.finally(() => this.#pending.delete(task));
    return task;
  }

  notePeer(botId, chatId, name, text, messageId) {
    if (this.#closed || !text || !messageId) return;
    const state = this.#groups.get(this.#key({ botId, chatId }));
    if (!state || state.rows.some((row) => row.messageId === messageId)) return;
    state.peerVersion += 1;
    state.rows.push({ at: this.#clock(), role: 'peer', speaker: name, text: oneLine(text, 400), messageId });
    state.rows = state.rows.slice(-30);
  }

  noteReply(envelope, text) {
    if (this.#closed || envelope?.scope !== 'group') return;
    const state = this.#state(envelope);
    const now = this.#clock();
    state.botAt = now;
    state.botText = oneLine(text, 800);
    state.recipient = envelope.senderId;
    state.rows.push({ at: now, role: 'assistant', speaker: 'cat', text: state.botText });
    state.rows = state.rows.slice(-30);
  }

  isLatest(envelope) {
    return !this.#closed && envelope?.scope === 'group'
      && this.#groups.get(this.#key(envelope))?.latestMessageId === envelope.messageId;
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
