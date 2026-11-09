import { createHash } from 'node:crypto';

export const digest = (values) => createHash('sha256').update(JSON.stringify(values)).digest('hex');
export const larkHistoryScope = (accountId, owner) => digest(['lark-reviewed-history-v1', accountId, owner]);
const id = (value) => typeof value === 'string' && /^[\w-]{1,128}$/.test(value) ? value : '';
const integerId = (value) => Number.isSafeInteger(value) && value > 0 ? String(value) : '';
const text = (value) => typeof value === 'string' ? value.trim().slice(0, 12_000) : '';
const fresh = (sent, now) => Number.isFinite(sent) && sent > 0 && sent <= now + 120_000 && now - sent <= 900_000;

export function feishuInbound(accountId, event, now = Date.now()) {
  const { message, sender } = event ?? {};
  if (message?.chat_type !== 'p2p' || sender?.sender_type !== 'user') return null;
  const sentAt = Number(message.create_time);
  if (!fresh(sentAt, now)) return null;
  const senderId = id(sender.sender_id?.open_id);
  const chatId = id(message.chat_id);
  const messageId = id(message.message_id);
  if (!senderId || !chatId || !messageId || !/^ou_/.test(senderId)) return null;
  let body;
  try { body = JSON.parse(message.content); } catch { return null; }
  const content = message.message_type === 'text' ? text(body?.text) : '';
  const imageKey = message.message_type === 'image' ? id(body?.image_key) : '';
  const stickerLabel = message.message_type === 'sticker' ? '飞书表情包（没有可下载的原图）' : '';
  if (!content && !imageKey && !stickerLabel) return null;
  return Object.freeze({ platform: 'feishu', accountId, senderId, chatId, messageId, text: content,
    receivedAt: now, sentAt, media: imageKey ? Object.freeze({ id: imageKey, type: 'image' }) : null, stickerLabel });
}

export function telegramInbound(accountId, update, now = Date.now()) {
  const message = update?.message;
  if (message?.chat?.type !== 'private' || message.from?.is_bot !== false
    || message.forward_origin || message.sender_chat || message.business_connection_id) return null;
  const sentAt = message.date * 1000;
  if (!fresh(sentAt, now)) return null;
  const senderId = integerId(message.from.id);
  const chatId = integerId(message.chat.id);
  const messageId = integerId(message.message_id);
  if (!senderId || senderId !== chatId || !messageId) return null;
  const sticker = message.sticker;
  const photo = Array.isArray(message.photo) ? message.photo.at(-1) : null;
  const staticSticker = sticker && !sticker.is_animated && !sticker.is_video ? sticker : null;
  const fileId = id(photo?.file_id ?? staticSticker?.file_id);
  const content = text(message.text ?? message.caption);
  const label = sticker ? text(sticker.emoji).slice(0, 16) : '';
  if (!content && !fileId && !label) return null;
  return Object.freeze({ platform: 'telegram', accountId, senderId, chatId, messageId, text: content,
    receivedAt: now, sentAt, media: fileId ? Object.freeze({ id: fileId, type: 'image' }) : null, stickerLabel: label });
}

export class PrivateBindings {
  #owners = new Map();

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
        if (!['feishu', 'telegram'].includes(platform) || ![accountId, senderId, chatId].every(id)
          || (platform === 'telegram' && (!/^\d+$/.test(accountId) || !/^\d+$/.test(senderId) || senderId !== chatId))
          || (platform === 'feishu' && (!accountId.startsWith('cli_') || !senderId.startsWith('ou_') || !chatId.startsWith('oc_')))) {
          throw new TypeError('private_binding_endpoint_invalid');
        }
        const destination = digest([platform, accountId, chatId]);
        if (destinations.has(destination)) throw new TypeError('private_binding_endpoint_duplicate');
        destinations.add(destination);
        this.#owners.set(digest([platform, accountId, chatId, senderId]), digest(['ordinary-owner', owner]));
      }
    }
  }

  ownerFor({ platform, accountId, chatId, senderId }) {
    return this.#owners.get(digest([platform, accountId, chatId, senderId])) ?? null;
  }
}
