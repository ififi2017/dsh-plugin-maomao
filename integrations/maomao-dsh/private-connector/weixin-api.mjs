// WeChat ClawBot (iLink) protocol: QR login, long-poll updates, replies, typing and encrypted media.
// Endpoints, headers and the AES-128-ECB media scheme follow Tencent's openclaw-weixin (MIT,
// Copyright (C) 2026 Tencent), https://github.com/Tencent/openclaw-weixin.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';

export const WEIXIN_BASE_URL = 'https://ilinkai.weixin.qq.com';
export const WEIXIN_CDN_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
const BOT_TYPE = '3';
const CHANNEL_VERSION = '2.4.10';
const CLIENT_VERSION = String((2 << 16) | (4 << 8) | 10);
const BOT_AGENT = 'MaomaoDSH/0.2';
export const STALE_TOKEN = -14;
export const MessageItem = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 };
export const UploadMedia = { IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 };

const failure = (code) => Object.assign(new Error(code), { code });
const baseInfo = () => ({ channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT });
const uin = () => Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString('base64');

// message_id and similar uint64 fields lose precision as JS numbers; read them as strings.
export function parseIlinkJson(raw) {
  return JSON.parse(raw.replace(/"(message_id|msg_id|svr_id)"\s*:\s*(-?\d+)/g, '"$1":"$2"'));
}

export function httpsBase(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || !/(^|\.)qq\.com$/.test(url.hostname)) throw failure('weixin_base_url_invalid');
  return url.origin;
}

export class IlinkClient {
  #fetch;
  constructor({ token, baseUrl = WEIXIN_BASE_URL, fetchImpl = fetch }) {
    this.token = token;
    this.baseUrl = httpsBase(baseUrl);
    this.#fetch = fetchImpl;
  }

  async post(endpoint, body, signal, ms = 15_000) {
    const response = await this.#fetch(`${this.baseUrl}/${endpoint}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(ms)]),
      headers: { 'content-type': 'application/json', AuthorizationType: 'ilink_bot_token', 'X-WECHAT-UIN': uin(),
        'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': CLIENT_VERSION,
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify({ ...body, base_info: baseInfo() }),
    });
    const raw = await response.text();
    if (!response.ok) throw failure(response.status === 401 || response.status === 403 ? 'weixin_session_expired' : `weixin_http_${response.status}`);
    const value = raw ? parseIlinkJson(raw) : {};
    if (value.ret === STALE_TOKEN || value.errcode === STALE_TOKEN) throw failure('weixin_session_expired');
    return value;
  }

  // Long poll: the server holds the request until messages arrive; a client timeout just means none.
  async updates(cursor, signal, ms = 38_000) {
    try {
      return await this.post('ilink/bot/getupdates', { get_updates_buf: cursor ?? '' }, signal, ms);
    } catch (error) {
      if (error?.name === 'TimeoutError' && !signal.aborted) return { ret: 0, msgs: [], get_updates_buf: cursor };
      throw error;
    }
  }

  async send(msg, signal) {
    const value = await this.post('ilink/bot/sendmessage', { msg }, signal);
    if (value.ret && value.ret !== 0) throw failure('weixin_send_rejected');
    return value;
  }

  config(userId, contextToken, signal) {
    return this.post('ilink/bot/getconfig', { ilink_user_id: userId, context_token: contextToken }, signal, 10_000);
  }

  typing(userId, ticket, status, signal) {
    return this.post('ilink/bot/sendtyping', { ilink_user_id: userId, typing_ticket: ticket, status }, signal, 10_000);
  }

  // Encrypt with a fresh AES key, upload to WeChat's CDN, and return the item fields a message needs.
  async upload(buffer, { toUserId, mediaType, signal }) {
    const key = randomBytes(16);
    const filekey = randomBytes(16).toString('hex');
    const cipher = createCipheriv('aes-128-ecb', key, null);
    const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
    const target = await this.post('ilink/bot/getuploadurl', { filekey, media_type: mediaType, to_user_id: toUserId,
      rawsize: buffer.length, rawfilemd5: createHash('md5').update(buffer).digest('hex'), filesize: encrypted.length,
      no_need_thumb: true, aeskey: key.toString('hex') }, signal);
    const url = target.upload_full_url?.trim()
      || (target.upload_param ? `${WEIXIN_CDN_URL}/upload?encrypted_query_param=${encodeURIComponent(target.upload_param)}&filekey=${filekey}` : '');
    if (!url || new URL(url).protocol !== 'https:') throw failure('weixin_upload_unavailable');
    let downloadParam = null;
    for (let attempt = 1; attempt <= 3 && !downloadParam; attempt++) {
      const response = await this.#fetch(url, { method: 'POST', redirect: 'error', body: encrypted,
        headers: { 'content-type': 'application/octet-stream' }, signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
      if (response.status >= 400 && response.status < 500) throw failure('weixin_upload_rejected');
      downloadParam = response.ok ? response.headers.get('x-encrypted-param') : null;
      if (!downloadParam && attempt < 3) await pause(500 * attempt, undefined, { signal });
    }
    if (!downloadParam) throw failure('weixin_upload_failed');
    return { media: { encrypt_query_param: downloadParam, aes_key: Buffer.from(key.toString('hex')).toString('base64'), encrypt_type: 1 },
      size: encrypted.length };
  }

  // Download and decrypt an inbound image or file.
  async download(media, signal, maxBytes = 5_000_000) {
    const keyText = media?.aeskey ? Buffer.from(media.aeskey, 'hex').toString('base64') : media?.aes_key;
    const url = media?.full_url || (media?.encrypt_query_param
      ? `${WEIXIN_CDN_URL}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}` : '');
    if (!url || new URL(url).protocol !== 'https:') throw failure('private_media_missing');
    const response = await this.#fetch(url, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
    if (!response.ok) throw failure(response.status === 404 ? 'private_media_missing' : 'private_media_http');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes + 16) throw failure('private_media_size');
    if (!keyText) return bytes;
    let key = Buffer.from(keyText, 'base64');
    if (key.length === 32 && /^[0-9a-f]{32}$/i.test(key.toString('ascii'))) key = Buffer.from(key.toString('ascii'), 'hex');
    if (key.length !== 16) throw failure('private_media_format');
    const decipher = createDecipheriv('aes-128-ecb', key, null);
    return Buffer.concat([decipher.update(bytes), decipher.final()]);
  }
}

const qrOrigin = (url) => {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !/(^|\.)qq\.com$/.test(parsed.hostname)) throw failure('invalid_qr');
  return parsed.href;
};

// Scan-to-connect: show a QR code, wait for the owner to scan and confirm in WeChat. The account
// that scans is the one 猫猫 then chats with. Expired codes are refreshed up to three times.
export async function provisionWeixin({ signal, onQr, previousToken = '', fetchImpl = fetch, pollMs = 1000 }) {
  const login = new IlinkClient({ token: '', fetchImpl });
  let baseUrl = WEIXIN_BASE_URL;
  for (let refresh = 0; refresh <= 3; refresh++) {
    const qr = await login.post(`ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`,
      { local_token_list: previousToken ? [previousToken] : [] }, signal);
    if (typeof qr.qrcode !== 'string' || !qr.qrcode || typeof qr.qrcode_img_content !== 'string') throw failure('invalid_qr');
    onQr({ url: qrOrigin(qr.qrcode_img_content.trim()), step: 'scan' });
    for (;;) {
      signal.throwIfAborted();
      const poll = new IlinkClient({ token: '', baseUrl, fetchImpl });
      let status;
      try {
        const response = await fetchImpl(`${poll.baseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr.qrcode)}`, {
          redirect: 'error', headers: { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': CLIENT_VERSION },
          signal: AbortSignal.any([signal, AbortSignal.timeout(38_000)]) });
        status = response.ok ? parseIlinkJson(await response.text()) : { status: 'wait' };
      } catch (error) {
        if (signal.aborted) throw error;
        status = { status: 'wait' };
      }
      if (status.status === 'scaned') onQr({ url: qrOrigin(qr.qrcode_img_content.trim()), step: 'confirm' });
      else if (status.status === 'scaned_but_redirect' && /^[A-Za-z0-9.-]+$/.test(status.redirect_host ?? '')) baseUrl = httpsBase(`https://${status.redirect_host}`);
      else if (status.status === 'expired') break;
      else if (status.status === 'binded_redirect') throw failure('weixin_already_bound');
      else if (['confirmed_but_need_verifycode', 'verify_code_blocked'].includes(status.status)) throw failure('weixin_verify_code_required');
      else if (status.status === 'confirmed') {
        if (typeof status.bot_token !== 'string' || !status.bot_token || !/^[\w.@-]{1,128}$/.test(status.ilink_bot_id ?? '')
          || !/^[\w.@-]{1,128}$/.test(status.ilink_user_id ?? '')) throw failure('credentials_rejected');
        const tokenBase = status.baseurl ? httpsBase(status.baseurl) : baseUrl;
        return { accountId: status.ilink_bot_id, ownerId: status.ilink_user_id,
          secret: JSON.stringify({ token: status.bot_token, baseUrl: tokenBase, userId: status.ilink_user_id }) };
      }
      await pause(pollMs, undefined, { signal });
    }
  }
  throw failure('expired_token');
}

export function readWeixinSecret(secret) {
  let value;
  try { value = JSON.parse(secret); } catch { throw failure('credentials_rejected'); }
  if (typeof value?.token !== 'string' || !value.token || !/^[\w.@-]{1,128}$/.test(value.userId ?? '')) throw failure('credentials_rejected');
  return { token: value.token, baseUrl: httpsBase(value.baseUrl || WEIXIN_BASE_URL), userId: value.userId };
}
