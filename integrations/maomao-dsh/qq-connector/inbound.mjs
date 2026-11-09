const NON_EMPTY = (value) => typeof value === 'string' ? value.trim() : '';
const LEADING_MENTION = /^<@!?([A-Za-z0-9_-]{1,128})>\s*/;
const IMAGE_REFERENCE = /这(?:张|幅|图|个(?:图|表情))|那(?:张|幅|图|个(?:图|表情))|(?:刚才|刚发|上面|之前)(?:的)?(?:图|表情)|(?:看|识别|评价|认认)(?:一下|一眼|看|下)?(?:这|那|图)/;
export const SPLIT_IMAGE_WAIT_MS = 750;

export function inboundImage(envelope) {
  return envelope.attachments.find((item) => item.kind === 'image') ?? envelope.quotedImages?.[0];
}

export function waitsForSplitImage(envelope) {
  return envelope.scope === 'group' && envelope.addressed && !envelope.replyIndex && !inboundImage(envelope)
    && !envelope.attachments.some((item) => item.asrText)
    && /^(?:(?:帮我)?看(?:看|一下|下)[。！!？?]?)?$/.test(envelope.text);
}

export function recentImageFor(envelope, receipts) {
  if (inboundImage(envelope)) return null;
  const split = waitsForSplitImage(envelope);
  if (!envelope.replyIndex && !split && !IMAGE_REFERENCE.test(envelope.text)) return null;
  let ownImage = null;
  let lastImage = null;
  let multiple = false;
  for (const source of receipts) {
    const age = envelope.receivedAt - source.receivedAt;
    if (source.receiptKey === envelope.receiptKey || age < (split ? -SPLIT_IMAGE_WAIT_MS : 0)
      || age > (split ? 3_000 : 120_000)
      || source.botId !== envelope.botId || source.scope !== envelope.scope || source.chatId !== envelope.chatId
      || !source.attachments.some((item) => item.kind === 'image' && item.sourceUrl)) continue;
    if (split && (source.senderId !== envelope.senderId || source.addressed || source.addressedToOther || source.text)) continue;
    if (envelope.replyIndex) {
      if (source.messageIndex === envelope.replyIndex) return source;
      continue;
    }
    if (lastImage) multiple = true;
    lastImage = source;
    if (source.senderId === envelope.senderId) ownImage = source;
  }
  return ownImage ?? (multiple ? null : lastImage);
}

function attachmentKind(mime) {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'file';
}

function normalizeAttachments(items) {
  return (Array.isArray(items) ? items : []).slice(0, 20).map((item) => {
    item = item && typeof item === 'object' ? item : {};
    const mime = NON_EMPTY(item.content_type || item.contentType).toLowerCase();
    return Object.freeze({
      kind: attachmentKind(mime),
      mime,
      name: NON_EMPTY(item.filename || item.fileName).slice(0, 256),
      sourceUrl: NON_EMPTY(item.url),
      asrText: NON_EMPTY(item.asr_refer_text).slice(0, 2000),
    });
  });
}

function quotedImages(message, replyIndex) {
  if (Number(message.msgType ?? message.raw?.message_type) !== 103) return [];
  const elements = message.msgElements ?? message.raw?.msg_elements;
  if (!Array.isArray(elements)) return [];
  // QQ embeds the referenced message in the first element. Prefer its index
  // when available and ignore unrelated elements with their own indices.
  const head = elements.slice(0, 20);
  const matched = replyIndex ? head.find((element) => NON_EMPTY(element?.msg_idx) === replyIndex) : null;
  const quoted = matched ?? head[0];
  if (replyIndex && !matched && NON_EMPTY(quoted?.msg_idx)) return [];
  return normalizeAttachments(quoted?.attachments).filter((item) => item.kind === 'image' && item.sourceUrl);
}

function stripLeadingBotMention(message, text, botId) {
  const tag = LEADING_MENTION.exec(text);
  if (!tag || message.kind !== 'group') return text;
  const identified = message.mentions?.find?.((mention) => mention
    && [mention.id, mention.user_openid, mention.member_openid].includes(tag[1]));
  if (identified) return identified.is_you === true ? text.slice(tag[0].length) : text;
  // GROUP_AT can prepend the bot's OpenID, which the SDK's AppID stripper misses.
  const rawTag = LEADING_MENTION.exec(NON_EMPTY(message.raw?.content));
  if (message.rawEventType === 'GROUP_AT_MESSAGE_CREATE'
    && (tag[1] === botId || (!message.raw?.content || rawTag?.[1] === tag[1]))) {
    return text.slice(tag[0].length);
  }
  return text;
}

function isPeerMention(mention, peer) {
  if (!peer?.name || !mention || mention.is_you === true) return false;
  return peer.memberId ? [mention.member_openid, mention.user_openid, mention.id].includes(peer.memberId)
    : mention.bot !== false && [mention.nickname, mention.username].includes(peer.name);
}

export function normalizeInbound(message, receivedAt = Date.now(), botId = '', peer = null) {
  if (!message || !['group', 'c2c'].includes(message.kind) || message.senderIsBot === true) return null;
  const messageId = NON_EMPTY(message.messageId);
  const senderId = NON_EMPTY(message.senderId);
  const chatId = message.kind === 'group' ? NON_EMPTY(message.groupOpenid) : senderId;
  if (!messageId || !senderId || !chatId) return null;
  const addressed = message.kind === 'c2c'
    || message.rawEventType === 'GROUP_AT_MESSAGE_CREATE'
    || (Array.isArray(message.mentions) && message.mentions.some((mention) => mention?.is_you === true));
  const addressedToOther = message.kind === 'group' && !addressed && (
    (Array.isArray(message.mentions) && message.mentions.some((mention) => mention && mention.is_you !== true))
    || /<@!?[0-9A-Za-z]+>/.test(NON_EMPTY(message.content)));
  const addressedToPeer = addressedToOther && Array.isArray(message.mentions) && message.mentions.length > 0
    && message.mentions.every((mention) => isPeerMention(mention, peer));
  const attachments = normalizeAttachments(message.attachments);
  const replyIndex = NON_EMPTY(message.refMsgIdx).slice(0, 256);
  const scope = message.kind === 'group' ? 'group' : 'c2c';
  const body = addressed ? stripLeadingBotMention(message, NON_EMPTY(message.content), botId) : NON_EMPTY(message.content);
  return Object.freeze({
    channel: 'qq',
    botId,
    scope,
    chatId,
    senderId,
    senderName: NON_EMPTY(message.senderName).slice(0, 128),
    messageId,
    messageIndex: NON_EMPTY(message.msgIdx).slice(0, 256),
    replyIndex,
    receiptKey: `qq:${botId}:${scope}:${chatId}:${messageId}`,
    receivedAt,
    sentAt: NON_EMPTY(message.timestamp),
    addressed,
    addressedToOther,
    addressedToPeer,
    text: (body
      .replace(/<faceType=\d+,faceId="[^"]*",ext="[^"]*">/g, '[QQ 表情]')
      || (/\[<face,id=\d+\/?>\]|<faceType=\d+,faceId=/.test(message.raw?.content ?? '') ? '[QQ 表情]' : ''))
      .slice(0, 12000),
    attachments: Object.freeze(attachments),
    quotedImages: Object.freeze(quotedImages(message, replyIndex)),
  });
}

export function allowedInbound(envelope, config) {
  if (!envelope) return false;
  const list = envelope.scope === 'group' ? config.groupAllowlist : config.dmAllowlist;
  return Array.isArray(list) && list.includes(envelope.chatId);
}

export function textBubbles(text, maximum = 4) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const clean = text.replace(/(?:<\|){2,}bubble\|>/g, '<|bubble|>');
  if (clean.includes('```')) return [clean.replaceAll('<|bubble|>', '\n\n').trim()];
  let parts;
  if (clean.includes('<|bubble|>')) parts = clean.split('<|bubble|>');
  else if (clean.length <= 900 && !/^\s*(?:[-*+]\s|\d+[.)]\s|\|)/m.test(clean)) parts = clean.split(/\n\s*\n/);
  else return [clean.trim()];
  parts = parts.map((part) => part.trim()).filter(Boolean);
  if (parts.length > maximum) parts = [...parts.slice(0, maximum - 1), parts.slice(maximum - 1).join('\n\n')];
  return parts;
}
