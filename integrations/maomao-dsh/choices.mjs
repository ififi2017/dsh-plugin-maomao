const marker = '<|maomao_choices|>';

// Options are an exception: a card on every reply reads like a form, not a person.
export const choiceGuidance = '[聊天选项] 极少使用。只有对方必须在几个具体、互斥的方案里挑一个，你才能继续时（例如画哪种形态、用哪个方案、先做哪件事），'
  + '才在正文后另起一行输出 ' + marker + '["选项一","选项二"]，2 至 3 个简短、有区别的选项，每项最多 24 个字。'
  + '闲聊、接梗、斗嘴、问候、夸奖、讲完一件事或你只是想延续话题时都不要加；绝大多数回复都不该有选项。'
  + '不要在正文重复列出按钮。收到「已选择的聊天分支」时，从该选项自然接着聊。';

// After a card, the option instructions are not offered again for a while in that chat.
export class ChoiceThrottle {
  #chats = new Map();
  constructor({ replies = 8, minutes = 15, clock = Date.now } = {}) { this.replies = replies; this.ms = minutes * 60_000; this.clock = clock; }
  allow(key) {
    const chat = this.#chats.get(key);
    return !chat || (chat.since >= this.replies && this.clock() - chat.at >= this.ms);
  }
  noteReply(key, card = false) {
    if (card) this.#chats.set(key, { at: this.clock(), since: 0 });
    else if (this.#chats.has(key)) this.#chats.get(key).since += 1;
    if (this.#chats.size > 500) this.#chats.delete(this.#chats.keys().next().value);
  }
}

export function parseChoiceReply(answer) {
  const index = answer.indexOf(marker);
  if (index < 0) return { text: answer, options: [] };
  const text = answer.slice(0, index).trim();
  let options;
  try { options = JSON.parse(answer.slice(index + marker.length).trim()); }
  catch { return { text, options: [] }; }
  if (!Array.isArray(options) || options.length < 2 || options.length > 3
    || options.some((label) => typeof label !== 'string' || !label.trim() || [...label.trim()].length > 24
      || /[\p{Cc}\p{Cf}<>{}\[\]]/u.test(label))) return { text, options: [] };
  options = options.map((label) => label.trim());
  return { text, options: new Set(options).size === options.length ? options : [] };
}

export const choiceData = (token, index) => `mc:${token}:${index}`;

export function parseChoiceData(data) {
  const match = typeof data === 'string' && /^mc:([a-f0-9]{32}):([0-2])$/.exec(data);
  return match ? { token: match[1], index: Number(match[2]) } : null;
}
