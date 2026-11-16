import { createHash } from 'node:crypto';

export const digest = (values) => createHash('sha256').update(JSON.stringify(values)).digest('hex');
export const larkHistoryScope = (accountId, owner) => digest(['lark-reviewed-history-v1', accountId, owner]);
const id = (value) => typeof value === 'string' && /^[\w-]{1,128}$/.test(value) ? value : '';
const integerId = (value) => Number.isSafeInteger(value) && value > 0 ? String(value) : '';
const text = (value) => typeof value === 'string' ? value.trim().slice(0, 12_000) : '';
const fresh = (sent, now) => Number.isFinite(sent) && sent > 0 && sent <= now + 120_000 && now - sent <= 900_000;

// Group chats are accepted only when the bot is @-mentioned; botOpenId comes from Lark's bot info.
export function feishuInbound(accountId, event, now = Date.now(), botOpenId = '') {
  const { message, sender } = event ?? {};
  const group = message?.chat_type === 'group';
  if ((!group && message?.chat_type !== 'p2p') || sender?.sender_type !== 'user') return null;
  const mentions = Array.isArray(message.mentions) ? message.mentions : [];
  const addressed = group && Boolean(botOpenId) && mentions.some((item) => item?.id?.open_id === botOpenId);
  if (group && !addressed) return null;
  const sentAt = Number(message.create_time);
  if (!fresh(sentAt, now)) return null;
  const senderId = id(sender.sender_id?.open_id);
  const chatId = id(message.chat_id);
  const messageId = id(message.message_id);
  if (!senderId || !chatId || !messageId || !/^ou_/.test(senderId)) return null;
  let body;
  try { body = JSON.parse(message.content); } catch { return null; }
  let content = message.message_type === 'text' ? text(body?.text) : '';
  // Lark writes mentions as @_user_N placeholders; drop the bot's, name the others.
  for (const item of mentions) {
    if (typeof item?.key !== 'string') continue;
    content = content.split(item.key).join(item.id?.open_id === botOpenId ? '' : `@${text(item.name).slice(0, 32) || '群友'}`);
  }
  content = content.trim();
  const imageKey = message.message_type === 'image' ? id(body?.image_key) : '';
  const stickerLabel = message.message_type === 'sticker' ? '飞书表情包（没有可下载的原图）' : '';
  if (!content && !imageKey && !stickerLabel) return null;
  return Object.freeze({ platform: 'feishu', accountId, senderId, chatId, messageId, text: content,
    receivedAt: now, sentAt, media: imageKey ? Object.freeze({ id: imageKey, type: 'image' }) : null, stickerLabel,
    ...(group ? { scope: 'group' } : {}) });
}

// In groups the bot answers only to an @username mention, a /command@bot or a reply to its own message.
export function telegramInbound(accountId, update, now = Date.now(), username = '') {
  const message = update?.message;
  const group = ['group', 'supergroup'].includes(message?.chat?.type);
  if ((!group && message?.chat?.type !== 'private') || message.from?.is_bot !== false
    || message.forward_origin || message.sender_chat || message.business_connection_id) return null;
  const raw = typeof (message.text ?? message.caption) === 'string' ? (message.text ?? message.caption) : '';
  const handle = username ? `@${username}`.toLowerCase() : '';
  const entities = [...(message.entities ?? []), ...(message.caption_entities ?? [])];
  const mentioned = Boolean(handle) && entities.some((entity) => (entity?.type === 'mention' || entity?.type === 'bot_command')
    && raw.slice(entity.offset, entity.offset + entity.length).toLowerCase().endsWith(handle))
    || entities.some((entity) => entity?.type === 'text_mention' && String(entity.user?.id) === accountId);
  const repliedToBot = String(message.reply_to_message?.from?.id ?? '') === accountId;
  if (group && !mentioned && !repliedToBot) return null;
  const sentAt = message.date * 1000;
  if (!fresh(sentAt, now)) return null;
  const senderId = integerId(message.from.id);
  // Telegram group and supergroup ids are negative.
  const chatId = group ? (Number.isSafeInteger(message.chat.id) && message.chat.id < 0 ? String(message.chat.id) : '') : integerId(message.chat.id);
  const messageId = integerId(message.message_id);
  if (!senderId || !chatId || !messageId || (!group && senderId !== chatId)) return null;
  const sticker = message.sticker;
  const photo = Array.isArray(message.photo) ? message.photo.at(-1) : null;
  const staticSticker = sticker && !sticker.is_animated && !sticker.is_video ? sticker : null;
  const fileId = id(photo?.file_id ?? staticSticker?.file_id);
  // Usernames are [A-Za-z0-9_], so the handle needs no regex escaping.
  const content = text(handle ? raw.replace(new RegExp(handle, 'ig'), '') : raw);
  const label = sticker ? text(sticker.emoji).slice(0, 16) : '';
  if (!content && !fileId && !label) return null;
  return Object.freeze({ platform: 'telegram', accountId, senderId, chatId, messageId, text: content,
    receivedAt: now, sentAt, media: fileId ? Object.freeze({ id: fileId, type: 'image' }) : null, stickerLabel: label,
    ...(group ? { scope: 'group', chatTitle: text(message.chat.title).slice(0, 60) } : {}) });
}

// WeChat ClawBot (iLink) private messages. IDs look like "xxxx@im.wechat"; groups are not offered.
const weixinId = (value) => typeof value === 'string' && /^[\w.@-]{1,128}$/.test(value) ? value : '';
export function weixinInbound(accountId, message, now = Date.now()) {
  if (!message || message.message_type !== 1 || message.group_id) return null;
  const senderId = weixinId(message.from_user_id);
  const messageId = /^[\w-]{1,64}$/.test(String(message.message_id ?? '')) ? String(message.message_id)
    : Number.isSafeInteger(message.seq) ? `seq-${message.seq}` : '';
  const sentAt = Number(message.create_time_ms) || now;
  if (!senderId || !messageId || !fresh(sentAt, now)) return null;
  const items = Array.isArray(message.item_list) ? message.item_list : [];
  const parts = [];
  let image = null;
  for (const item of items) {
    if (item?.type === 1 && typeof item.text_item?.text === 'string') parts.push(item.text_item.text);
    else if (item?.type === 3) parts.push(item.voice_item?.text ? `[语音] ${item.voice_item.text}` : '[语音，没有转写]');
    else if (item?.type === 2 && !image && (item.image_item?.media?.encrypt_query_param || item.image_item?.media?.full_url)) {
      image = { ...item.image_item.media, ...(item.image_item.aeskey ? { aeskey: item.image_item.aeskey } : {}) };
    } else if (item?.type === 4) parts.push(`[文件：${text(item.file_item?.file_name).slice(0, 80) || '未命名'}]`);
    else if (item?.type === 5) parts.push('[视频]');
    const quoted = item?.ref_msg?.message_item?.text_item?.text ?? item?.ref_msg?.title;
    if (typeof quoted === 'string' && quoted.trim()) parts.unshift(`[引用] ${text(quoted).slice(0, 300)}`);
  }
  const content = text(parts.join('\n'));
  if (!content && !image) return null;
  return Object.freeze({ platform: 'weixin', accountId, senderId, chatId: senderId, messageId, text: content,
    receivedAt: now, sentAt, media: image ? Object.freeze({ id: messageId, type: 'image', weixin: Object.freeze(image) }) : null,
    stickerLabel: '' });
}

export class PrivateBindings {
  #owners = new Map();
  #senders = new Map();

  constructor(bindings = []) {
    if (!Array.isArray(bindings)) throw new TypeError('private_bindings_invalid');
    const destinations = new Set();
    for (const entry of bindings) {
      const owner = id(entry?.owner);
      if (!owner || !Array.isArray(entry.endpoints) || !entry.endpoints.length) {
        throw new TypeError('private_binding_invalid');
      }
      for (const endpoint of entry.endpoints) {
        const { platform, accountId, senderId, chatId } = endpoint ?? {};
        if (!['feishu', 'telegram', 'weixin'].includes(platform)
          || ![accountId, senderId, chatId].every(platform === 'weixin' ? weixinId : id)
          || (platform === 'telegram' && (!/^\d+$/.test(accountId) || !/^\d+$/.test(senderId) || senderId !== chatId))
          || (platform === 'feishu' && (!accountId.startsWith('cli_') || !senderId.startsWith('ou_') || !chatId.startsWith('oc_')))
          || (platform === 'weixin' && senderId !== chatId)) {
          throw new TypeError('private_binding_endpoint_invalid');
        }
        const destination = digest([platform, accountId, chatId]);
        if (destinations.has(destination)) throw new TypeError('private_binding_endpoint_duplicate');
        destinations.add(destination);
        this.#owners.set(digest([platform, accountId, chatId, senderId]), digest(['ordinary-owner', owner]));
        this.#senders.set(digest([platform, accountId, senderId]), digest(['ordinary-owner', owner]));
      }
    }
  }

  // The owner speaking anywhere on this bot account, e.g. in a group they added the bot to.
  ownerBySender({ platform, accountId, senderId }) {
    return this.#senders.get(digest([platform, accountId, senderId])) ?? null;
  }

  ownerFor({ platform, accountId, chatId, senderId }) {
    return this.#owners.get(digest([platform, accountId, chatId, senderId])) ?? null;
  }
}
