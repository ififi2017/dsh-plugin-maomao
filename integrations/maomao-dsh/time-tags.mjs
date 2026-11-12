// Each stored chat message starts with when it arrived, so the model can tell that a night has
// passed or that someone took two hours to answer. A full date and weekday appear on the first
// message after a restart, on a new day, or after a long gap; otherwise just the time.
const LONG_GAP_MS = 3 * 60 * 60 * 1000;
const zone = () => process.env.TZ || undefined;
const day = (at) => new Intl.DateTimeFormat('en-CA', { timeZone: zone(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
const time = (at) => new Intl.DateTimeFormat('zh-CN', { timeZone: zone(), hour: '2-digit', minute: '2-digit', hour12: false }).format(at);
const date = (at) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('zh-CN', { timeZone: zone(), month: 'numeric', day: 'numeric', weekday: 'short' })
    .formatToParts(at).map(({ type, value }) => [type, value]));
  return `${parts.month}月${parts.day}日${parts.weekday}`;
};

export const TIME_TAG_NOTE = '用户消息开头方括号里的时间（如 [11月12日周四 22:51] 或 [22:51]）是那条消息送到的时间，只用来感知时间流逝：隔了多久、是不是第二天、现在大概什么时候。别复述或主动报时，自己的回复里不要带这种时间标记。';

export function timeTag(at, previousAt) {
  const when = new Date(Number.isFinite(at) ? at : Date.now());
  const full = !Number.isFinite(previousAt) || day(when) !== day(new Date(previousAt)) || when - previousAt >= LONG_GAP_MS;
  return `[${full ? `${date(when)} ` : ''}${time(when)}]`;
}

// Tags are remembered per conversation (session) so a gap is measured within that conversation.
export class TimeTags {
  #last = new Map();

  tag(key, at = Date.now()) {
    const text = timeTag(at, this.#last.get(key));
    this.#last.set(key, at);
    if (this.#last.size > 500) this.#last.delete(this.#last.keys().next().value);
    return text;
  }
}

// A model sometimes copies the tag format into its own reply; never send that.
export const stripTimeTag = (text) => typeof text === 'string'
  ? text.replace(/^\s*\[(?:\d{1,2}月\d{1,2}日\s*周.\s*)?\d{1,2}:\d{2}\]\s*/, '') : text;
