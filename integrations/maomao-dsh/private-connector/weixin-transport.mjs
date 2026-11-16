import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { weixinInbound } from './identity.mjs';
import { IlinkClient, MessageItem, UploadMedia, readWeixinSecret } from './weixin-api.mjs';
import { hasChatMarkdown, plainChatMarkdown } from '../message-markdown.mjs';

const safeError = (code) => Object.assign(new Error(code), { code });
const MAX_TEXT = 1800;
const imageType = (bytes) => bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? 'image/png'
  : bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')) ? 'image/jpeg'
    : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp'
      : /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6)) ? 'image/gif' : null;

// 猫猫's WeChat private chat through Tencent's ClawBot (iLink). Every reply carries the context
// token of the person's latest message; the last token per person is kept so 猫猫 can still
// write first later (sharing, lonely cat) for as long as WeChat accepts it.
export class WeixinTransport {
  #client;
  #ready = false;
  #statePath;
  #state = { cursor: '', tokens: {} };
  // Voice replies need WeChat's SILK encoding, which this transport does not produce.
  voiceNotes = false;
  username = '';
  groupCheck = null;

  constructor({ accountId, secret, statePath = null, fetchImpl = fetch }) {
    if (!/^[\w.@-]{1,128}$/.test(accountId ?? '')) throw safeError('weixin_account_invalid');
    const { token, baseUrl } = readWeixinSecret(secret);
    this.accountId = accountId;
    this.#client = new IlinkClient({ token, baseUrl, fetchImpl });
    this.#statePath = statePath;
    if (statePath) {
      try {
        const saved = JSON.parse(readFileSync(statePath, 'utf8'));
        this.#state = { cursor: typeof saved.cursor === 'string' ? saved.cursor : '', tokens: saved.tokens ?? {} };
      } catch { /* First run. */ }
    }
  }

  ready() { return this.#ready; }

  #save() {
    if (!this.#statePath) return;
    try {
      mkdirSync(dirname(this.#statePath), { recursive: true, mode: 0o700 });
      writeFileSync(`${this.#statePath}.tmp`, JSON.stringify(this.#state), { mode: 0o600 });
      renameSync(`${this.#statePath}.tmp`, this.#statePath);
    } catch { /* Only the resume point and reply tokens; a lost write costs a re-delivery. */ }
  }

  async verify(signal) {
    await this.#client.updates(this.#state.cursor, signal, 8_000);
    return { accountId: this.accountId };
  }

  async run(receive, signal) {
    let retry = 1000;
    try {
      while (!signal.aborted) {
        let response;
        try {
          response = await this.#client.updates(this.#state.cursor, signal);
          if (response.ret && response.ret !== 0) throw safeError(`weixin_updates_${response.ret}`);
          this.#ready = true;
          retry = 1000;
        } catch (error) {
          this.#ready = false;
          if (signal.aborted) break;
          if (error.code === 'weixin_session_expired') throw error;
          await pause(retry, undefined, { signal }).catch(() => undefined);
          retry = Math.min(retry * 2, 30_000);
          continue;
        }
        for (const message of response.msgs ?? []) {
          if (signal.aborted) break;
          if (typeof message?.context_token === 'string' && message.from_user_id) {
            this.#state.tokens[message.from_user_id] = message.context_token;
          }
          const event = weixinInbound(this.accountId, message, Date.now());
          if (event) await receive(event);
        }
        if (typeof response.get_updates_buf === 'string' && response.get_updates_buf !== this.#state.cursor) {
          this.#state.cursor = response.get_updates_buf;
          this.#save();
        } else if (response.msgs?.length) this.#save();
      }
    } finally { this.#ready = false; }
  }

  #token(userId) { return this.#state.tokens[userId] ?? null; }

  typing(event, signal) {
    let stopped = false;
    let ticket = null;
    const tick = async () => {
      try {
        ticket ??= (await this.#client.config(event.senderId, this.#token(event.senderId), signal))?.typing_ticket ?? null;
        if (ticket && !stopped) await this.#client.typing(event.senderId, ticket, 1, signal);
      } catch { /* "typing…" is a nicety. */ }
    };
    void tick();
    const timer = setInterval(tick, 5000);
    timer.unref?.();
    return () => {
      stopped = true;
      clearInterval(timer);
      if (ticket) void this.#client.typing(event.senderId, ticket, 2, signal).catch(() => undefined);
    };
  }

  async #message(toUserId, items, signal) {
    const contextToken = this.#token(toUserId);
    if (!contextToken) throw safeError('weixin_no_context');
    const clientId = `maomao-${randomBytes(8).toString('hex')}`;
    const sent = await this.#client.send({ from_user_id: '', to_user_id: toUserId, client_id: clientId,
      message_type: 2, message_state: 2, item_list: items, context_token: contextToken }, signal);
    return String(sent.message_id ?? clientId);
  }

  async send(chatId, text, _ticket, signal) {
    const body = hasChatMarkdown(text) ? plainChatMarkdown(text) : text;
    let last = null;
    for (let start = 0; start < body.length; start += MAX_TEXT) {
      last = await this.#message(chatId, [{ type: MessageItem.TEXT, text_item: { text: body.slice(start, start + MAX_TEXT) } }], signal);
    }
    return last;
  }

  reply(event, text, ticket, signal) { return this.send(event.chatId, text, ticket, signal); }

  async replyMedia(event, media, _ticket, signal, current = () => true) {
    if (!current() || signal.aborted || media.kind === 'voice') return null;
    const uploaded = await this.#client.upload(media.buffer, { toUserId: event.chatId, mediaType: UploadMedia.IMAGE, signal });
    if (!current()) return null;
    return this.#message(event.chatId, [{ type: MessageItem.IMAGE,
      image_item: { media: uploaded.media, mid_size: uploaded.size } }], signal);
  }

  async image(event, signal) {
    const bytes = await this.#client.download(event.media?.weixin, signal);
    const mediaType = imageType(bytes);
    if (!mediaType) throw safeError(bytes.length ? 'private_media_format' : 'private_media_empty');
    return { type: 'image', mediaType, data: bytes.toString('base64'), name: 'private-image' };
  }
}
