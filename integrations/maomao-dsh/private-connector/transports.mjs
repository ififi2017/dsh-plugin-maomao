import { setTimeout as pause } from 'node:timers/promises';
import { feishuInbound, telegramInbound } from './identity.mjs';
import { identifyTelegramBot, telegramBotId, telegramCall } from './telegram-api.mjs';
import { choiceData, parseChoiceData } from '../choices.mjs';
import { hasChatMarkdown, plainChatMarkdown } from '../message-markdown.mjs';

const MAX_IMAGE = 5_000_000;
const bounded = (signal, ms) => AbortSignal.any([signal, AbortSignal.timeout(ms)]);
const jsonHeaders = { 'content-type': 'application/json' };
const safeError = (code) => Object.assign(new Error(code), { code });
const LARK_ORIGINS = { feishu: 'https://open.feishu.cn', lark: 'https://open.larksuite.com' };
const quietLogger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };
const positiveId = (value) => Number.isSafeInteger(value) && value > 0;
const larkId = (value, prefix) => typeof value === 'string' && value.startsWith(prefix) && /^[\w-]{1,128}$/.test(value);
const larkCard = (text, options = [], token) => ({
  schema: '2.0',
  body: { elements: [
    hasChatMarkdown(text) ? { tag: 'markdown', content: text }
      : { tag: 'div', text: { tag: 'plain_text', content: text } },
    ...options.map((label, index) => ({ tag: 'button', type: 'default',
      text: { tag: 'plain_text', content: label },
      behaviors: [{ type: 'callback', value: { choice: choiceData(token, index) } }],
    })),
  ] },
});

async function imageFrom(response) {
  if (!response.ok) throw safeError(response.status === 404 || response.status === 410 ? 'private_media_missing'
    : response.status === 401 || response.status === 403 ? 'private_media_permission'
      : response.status === 429 ? 'private_media_rate_limit' : 'private_media_http');
  if (!response.body) throw safeError('private_media_empty');
  if (Number(response.headers.get('content-length')) > MAX_IMAGE) {
    await response.body.cancel().catch(() => undefined);
    throw safeError('private_media_size');
  }
  const reader = response.body.getReader();
  let length = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_IMAGE) throw safeError('private_media_size');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = Buffer.concat(chunks, length);
  const mediaType = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? 'image/png'
    : bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')) ? 'image/jpeg'
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp'
        : /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6)) ? 'image/gif' : null;
  if (!mediaType) throw safeError(length ? 'private_media_format' : 'private_media_empty');
  return { type: 'image', mediaType, data: bytes.toString('base64'), name: 'private-image' };
}

export class TelegramTransport {
  #token;
  #botId;
  #fetch;
  #ready = false;
  username = '';

  constructor({ token, botId, fetchImpl = fetch }) {
    if (!botId || telegramBotId(token) !== botId) {
      throw safeError('telegram_credentials_or_bot_id_invalid');
    }
    this.#token = token;
    this.#botId = botId;
    this.#fetch = fetchImpl;
  }

  ready() { return this.#ready; }

  async #call(method, data, signal, ms = 12_000) {
    return telegramCall(this.#token, method, data, signal, { fetchImpl: this.#fetch, ms });
  }

  verify(signal) { return identifyTelegramBot(this.#call.bind(this), this.#botId, signal); }

  async run(receive, signal, choose) {
    const me = await identifyTelegramBot(this.#call.bind(this), this.#botId, signal);
    this.username = typeof me.username === 'string' ? me.username.toLowerCase() : '';
    let offset;
    let retry = 1000;
    let conflictUntil;
    try {
      while (!signal.aborted) {
        let updates;
        try {
          updates = await this.#call('getUpdates', { offset, timeout: 25, limit: 20,
            allowed_updates: choose ? ['message', 'callback_query'] : ['message'] }, signal, 35_000);
          if (!Array.isArray(updates)) throw safeError('telegram_invalid_updates');
          this.#ready = true;
          retry = 1000;
          conflictUntil = undefined;
        } catch (error) {
          this.#ready = false;
          if (signal.aborted) break;
          if (['telegram_http_401', 'telegram_http_403'].includes(error.code)) throw error;
          if (error.code === 'telegram_http_409') {
            // Telegram may still be holding the previous instance's long poll after a local reload.
            conflictUntil ??= Date.now() + 35_000;
            if (Date.now() >= conflictUntil) throw error;
          }
          await pause(retry, undefined, { signal }).catch(() => undefined);
          retry = Math.min(retry * 2, 30_000);
          continue;
        }
        for (const update of updates) {
          if (signal.aborted) break;
          if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) continue;
          const event = telegramInbound(this.#botId, update, Date.now(), this.username);
          if (event) await receive(event);
          if (choose && update.callback_query) await this.#callback(update.callback_query, choose, signal);
          offset = Math.max(offset ?? 0, update.update_id + 1);
        }
      }
    } finally { this.#ready = false; }
  }

  async reply(event, text, _ticket, signal) {
    const result = await this.#call('sendMessage', { chat_id: event.chatId, text,
      reply_parameters: { message_id: Number(event.messageId) },
    }, signal);
    return Number.isSafeInteger(result?.message_id) ? String(result.message_id) : null;
  }

  async replyMedia(event, media, _ticket, signal, current = () => true) {
    if (!current() || signal.aborted) return null;
    const voice = media.kind === 'voice';
    const animation = !voice && media.mediaType === 'image/gif';
    const sticker = !voice && !animation && media.kind === 'sticker' && ['image/webp', 'image/png'].includes(media.mediaType);
    const form = new FormData();
    form.set('chat_id', event.chatId);
    form.set('reply_parameters', JSON.stringify({ message_id: Number(event.messageId) }));
    form.set(voice ? 'voice' : animation ? 'animation' : sticker ? 'sticker' : 'photo', new Blob([media.buffer], { type: media.mediaType }), media.fileName);
    const sent = await this.#call(voice ? 'sendVoice' : animation ? 'sendAnimation' : sticker ? 'sendSticker' : 'sendPhoto', form, signal, 30_000);
    return positiveId(sent?.message_id) ? String(sent.message_id) : null;
  }

  async replyChoices(event, text, options, token, ticket, signal) {
    let result;
    try {
      result = await this.#call('sendMessage', { chat_id: event.chatId, text,
        reply_parameters: { message_id: Number(event.messageId) },
        reply_markup: { inline_keyboard: options.map((label, index) => [
          { text: label, callback_data: choiceData(token, index) },
        ]) },
      }, signal);
    } catch (error) {
      if (error.code !== 'telegram_http_400') throw error;
      return { messageId: await this.reply(event, text, ticket, signal), interactive: false };
    }
    return { messageId: positiveId(result?.message_id) ? String(result.message_id) : null, interactive: true };
  }

  async #callback(query, choose, signal) {
    const { id, from, message } = query;
    if (typeof id !== 'string' || !id || !parseChoiceData(query.data)) return;
    const chat = message?.chat;
    const event = chat?.type === 'private' && positiveId(chat.id) && from?.is_bot === false && from.id === chat.id
      && positiveId(message.message_id)
      ? { platform: 'telegram', accountId: this.#botId, chatId: String(chat.id), senderId: String(from.id),
          messageId: String(message.message_id) } : null;
    const selected = event ? choose(event, query.data) : null;
    await this.#call('answerCallbackQuery', { callback_query_id: id,
      text: selected ? `已选：${selected.label}` : '这个选项已失效。' }, signal, 3000).catch(() => undefined);
    if (selected) {
      void this.#call('editMessageText', { chat_id: event.chatId, message_id: message.message_id,
        text: `${selected.body}\n\n已选：${selected.label}`, reply_markup: { inline_keyboard: [] },
      }, signal, 5000).catch(() => undefined);
    }
  }

  async send(chatId, text, _ticket, signal) {
    const result = await this.#call('sendMessage', { chat_id: chatId, text }, signal);
    return Number.isSafeInteger(result?.message_id) ? String(result.message_id) : null;
  }

  async image(event, signal) {
    const file = await this.#call('getFile', { file_id: event.media.id }, signal);
    const path = file?.file_path;
    if (file?.file_size > MAX_IMAGE) throw safeError('private_media_size');
    if (typeof path !== 'string' || path.length > 256 || !/^[A-Za-z0-9_./-]+$/.test(path)
      || path.split('/').some((part) => !part || part === '.' || part === '..')) throw safeError('private_media_missing');
    const response = await this.#fetch(`https://api.telegram.org/file/bot${this.#token}/${path}`,
      { signal: bounded(signal, 12_000), redirect: 'error' });
    return imageFrom(response);
  }
}

export class FeishuTransport {
  #appId;
  #secret;
  #fetch;
  #socket;
  #token;
  #refresh;
  #sdk;
  #brand;
  #botOpenId = '';

  constructor({ appId, secret, brand = 'feishu', fetchImpl = fetch, sdk }) {
    if (!/^cli_[\w-]+$/.test(appId ?? '') || !secret) throw safeError('feishu_credentials_invalid');
    if (!Object.hasOwn(LARK_ORIGINS, brand)) throw safeError('feishu_brand_invalid');
    this.#appId = appId;
    this.#secret = secret;
    this.#fetch = fetchImpl;
    this.#sdk = sdk;
    this.#brand = brand;
  }

  ready() { return this.#socket?.getConnectionStatus().state === 'connected'; }

  async verify(signal) { await this.#accessToken(signal); }

  async run(receive, signal, choose) {
    const sdk = this.#sdk ?? await import('@larksuiteoapi/node-sdk');
    if (signal.aborted) return;
    // Needed to tell an @mention of this bot apart from other mentions in group chats.
    this.#botOpenId = await this.#ownOpenId(signal).catch(() => '');
    const socket = new sdk.WSClient({ appId: this.#appId, appSecret: this.#secret,
      domain: this.#brand === 'lark' ? sdk.Domain.Lark : sdk.Domain.Feishu,
      logger: quietLogger, autoReconnect: true, handshakeTimeoutMs: 12_000 });
    this.#socket = socket;
    const dispatcher = new sdk.EventDispatcher({ logger: quietLogger }).register({
      'im.message.receive_v1': async (payload) => {
        const event = feishuInbound(this.#appId, payload, Date.now(), this.#botOpenId);
        if (event && !signal.aborted) await receive(event);
      },
      ...(choose ? { 'card.action.trigger': (payload) => {
        if (signal.aborted) return;
        const chatId = payload.context?.open_chat_id;
        const messageId = payload.context?.open_message_id;
        const senderId = payload.operator?.open_id;
        const data = payload.action?.value?.choice;
        if (!parseChoiceData(data) || !larkId(chatId, 'oc_') || !larkId(messageId, 'om_') || !larkId(senderId, 'ou_')) return;
        const selected = choose({ platform: 'feishu', accountId: this.#appId, chatId, messageId, senderId }, data);
        return selected
          ? { toast: { type: 'success', content: `已选：${selected.label}` },
              card: { type: 'raw', data: larkCard(`${selected.body}\n\n已选：${selected.label}`) } }
          : { toast: { type: 'info', content: '这个选项已失效。' } };
      } } : {}),
    });
    const stop = () => socket.close({ force: true });
    signal.addEventListener('abort', stop, { once: true });
    try {
      await socket.start({ eventDispatcher: dispatcher });
      if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    } finally {
      signal.removeEventListener('abort', stop);
      stop();
      this.#socket = null;
    }
  }

  async #accessToken(signal) {
    if (this.#token?.expires > Date.now()) return this.#token.value;
    this.#refresh ??= (async () => {
      const response = await this.#fetch(`${LARK_ORIGINS[this.#brand]}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: 'POST', redirect: 'error', headers: jsonHeaders, signal: bounded(signal, 12_000),
        body: JSON.stringify({ app_id: this.#appId, app_secret: this.#secret }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || result?.code !== 0 || typeof result.tenant_access_token !== 'string') {
        throw safeError('feishu_token_unavailable');
      }
      this.#token = { value: result.tenant_access_token, expires: Date.now() + Math.max(0, (result.expire - 90) * 1000) };
      return this.#token.value;
    })().finally(() => { this.#refresh = null; });
    return this.#refresh;
  }

  async #ownOpenId(signal) {
    const token = await this.#accessToken(signal);
    const response = await this.#fetch(`${LARK_ORIGINS[this.#brand]}/open-apis/bot/v3/info`, {
      method: 'GET', redirect: 'error', signal: bounded(signal, 12_000), headers: { ...jsonHeaders, authorization: `Bearer ${token}` },
    });
    const result = await response.json().catch(() => null);
    const openId = result?.bot?.open_id;
    return response.ok && result?.code === 0 && typeof openId === 'string' && /^ou_[\w-]{1,120}$/.test(openId) ? openId : '';
  }

  async #request(path, data, signal) {
    const token = await this.#accessToken(signal);
    const response = await this.#fetch(`${LARK_ORIGINS[this.#brand]}/open-apis/im/v1/messages${path}`, {
      method: data ? 'POST' : 'GET', redirect: 'error', signal: bounded(signal, 12_000),
      headers: { ...jsonHeaders, authorization: `Bearer ${token}` },
      body: data ? JSON.stringify(data) : undefined,
    });
    if (response.status === 401) this.#token = null;
    return response;
  }

  async #sendText(path, text, ticket, signal, fields = {}) {
    const uuid = ticket.slice(0, 40);
    const post = async (msgType, content) => {
      const response = await this.#request(path, {
        ...fields, msg_type: msgType, content: JSON.stringify(content), uuid,
      }, signal);
      const result = await response.json().catch(() => null);
      const messageId = response.ok && result?.code === 0 && typeof result.data?.message_id === 'string'
        ? result.data.message_id : null;
      return { messageId, formatRejected: response.status === 400 && [230001, 4000].includes(result?.code) };
    };
    const plain = plainChatMarkdown(text);
    if (hasChatMarkdown(text, plain)) {
      const rich = await post('post', { zh_cn: { content: [[{ tag: 'md', text }]] } });
      // A lost response may still mean the message was sent. Retry only after a definite bad request.
      if (rich.messageId || !rich.formatRejected || signal.aborted) return rich.messageId;
      return (await post('text', { text: plain })).messageId;
    }
    return (await post('text', { text })).messageId;
  }

  reply(event, text, ticket, signal) {
    return this.#sendText('/' + event.messageId + '/reply', text, ticket, signal);
  }

  async replyMedia(event, media, ticket, signal, current = () => true) {
    const voice = media.kind === 'voice';
    const token = await this.#accessToken(signal);
    if (!current() || signal.aborted) return null;
    const form = new FormData();
    if (voice) {
      form.set('file_type', 'opus');
      form.set('file_name', 'maomao-voice.opus');
    } else form.set('image_type', 'message');
    form.set(voice ? 'file' : 'image', new Blob([media.buffer], { type: media.mediaType }), voice ? 'maomao-voice.opus' : media.fileName);
    const upload = await this.#fetch(`${LARK_ORIGINS[this.#brand]}/open-apis/im/v1/${voice ? 'files' : 'images'}`, {
      method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${token}` },
      body: form, signal: bounded(signal, 30_000),
    });
    const payload = await upload.json().catch(() => null);
    const key = voice ? 'file_key' : 'image_key';
    if (!upload.ok || payload?.code !== 0 || typeof payload.data?.[key] !== 'string') return null;
    if (!current() || signal.aborted) return null;
    const response = await this.#request(`/${event.messageId}/reply`, {
      msg_type: voice ? 'audio' : 'image', content: JSON.stringify({ [key]: payload.data[key] }), uuid: ticket.slice(0, 40),
    }, signal);
    const sent = await response.json().catch(() => null);
    return response.ok && sent?.code === 0 && typeof sent.data?.message_id === 'string' ? sent.data.message_id : null;
  }

  async replyChoices(event, text, options, token, ticket, signal) {
    const response = await this.#request(`/${event.messageId}/reply`, {
      msg_type: 'interactive', content: JSON.stringify(larkCard(text, options, token)), uuid: ticket.slice(0, 40),
    }, signal);
    const result = await response.json().catch(() => null);
    if (response.status === 400 && typeof result?.code === 'number' && result.code !== 0) {
      return { messageId: await this.reply(event, text, ticket, signal), interactive: false };
    }
    return { messageId: response.ok && result?.code === 0 && typeof result.data?.message_id === 'string'
      ? result.data.message_id : null, interactive: true };
  }

  send(chatId, text, ticket, signal) {
    return this.#sendText('?receive_id_type=chat_id', text, ticket, signal, { receive_id: chatId });
  }

  async image(event, signal) {
    const response = await this.#request(`/${event.messageId}/resources/${event.media.id}?type=image`, null, signal);
    if (response.headers.get('content-type')?.includes('application/json')) {
      const result = await response.clone().json().catch(() => null);
      if (result?.code === 99991672) throw safeError('feishu_media_permission');
    }
    return imageFrom(response);
  }
}
