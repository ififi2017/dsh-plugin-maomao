import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// 猫猫's mood in one conversation, carried from turn to turn and fading with time. It comes from
// cheap signals in what people say plus the time of day, and reaches the model as one plain
// sentence in the turn's reference material: no scores, nothing to recite. Inspired by the
// affective core in dafeiyu-astrbot (MIT).
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const POUT_HALF_LIFE = 45 * MINUTE;
const NEGATIVE_TAU = 3 * HOUR;
const POSITIVE_TAU = 8 * HOUR;

const SERIOUS = /```|Traceback|Exception|Error:|报错|bug|帮我(?:看|查|写|改|算|分析|排查|翻译)|怎么(?:写|配|修|解决|实现|弄)|部署|代码|脚本|接口|服务器|日志|数据库|编译|运行失败/i;
const COAX = /摸摸|抱抱|贴贴|亲亲|乖啦|真乖|好乖|最喜欢你|喜欢猫猫|好猫猫|别生气|不气不气|哄哄|想你了|真棒|夸夸|对不起嘛|错了嘛/;
const DISTRESS = /头疼|头痛|发烧|感冒|生病|胃疼|难受|睡不着|失眠|心累|崩溃|焦虑|压力好大|好累|累死|累趴|委屈|难过|想哭|烦死了|不开心/;
const RESOLVED = /好多了|已经好了|退烧了|不疼了|没事了|没事啦|搞定了|交完了|弄完了|忙完了|顺利通过|缓过来了|好起来了/;
const TEASE = /笨猫|傻猫|胖猫|蠢猫|小笨蛋|略略略|猫猫笨|坏猫/;
const POSITIVE = /哈哈|嘿嘿|谢谢|厉害|好玩|可爱|笑死|太好了|开心|喜欢/;
const NEGATIVE = /滚|闭嘴|傻逼|垃圾|烦人|讨厌你|别吵/;

const hourOf = (at) => Number(new Intl.DateTimeFormat('en-US', { timeZone: process.env.TZ || undefined, hour: 'numeric', hourCycle: 'h23' }).format(at));
const fade = (value, elapsed, tau) => value * Math.exp(-Math.max(0, elapsed) / tau);
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

const LINES = {
  focused: '对方这会儿在办正事，你把小情绪收起来，专注、利落地帮到底。',
  coaxed: '刚被哄了，心里那点别扭化开了，语气比平时软一点、黏一点。',
  tender: '对方前不久说过不舒服或心里有事，你一直挂着心，说话放轻放软，先陪着。',
  pout: '刚被逗了好几回，心里有点小别扭，可以嘴硬顶一句、回得短一点；对方一哄或说起正事就软下来。',
  missing: '隔了好久才又聊上，你有点想念，见到对方挺高兴。',
  sleepy: '夜深了，你也有点犯困，说话慢悠悠的、轻一点。',
  joyful: '刚才聊得挺开心，心情亮堂，说话轻快。',
  low: '刚才的气氛让你有点蔫，语气安静些，不硬撑热情。',
};

export class MoodBook {
  #path;
  #now;
  #states = new Map();

  constructor(path = null, { now = Date.now } = {}) {
    this.#path = path;
    this.#now = now;
    if (!path) return;
    try {
      for (const [key, state] of Object.entries(JSON.parse(readFileSync(path, 'utf8')))) this.#states.set(key, state);
    } catch { /* No saved mood yet. */ }
  }

  #save() {
    if (!this.#path) return;
    try {
      mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
      const temp = `${this.#path}.tmp`;
      writeFileSync(temp, JSON.stringify(Object.fromEntries(this.#states)), { mode: 0o600 });
      renameSync(temp, this.#path);
    } catch { /* Mood is optional; never fail a reply over it. */ }
  }

  // What someone just said. Only human messages count; another bot's lines do not move the mood.
  note(key, text, at = Date.now()) {
    if (typeof text !== 'string' || !text.trim()) return;
    const previous = this.#states.get(key) ?? { valence: 0, pout: 0, at };
    const elapsed = at - (previous.at ?? at);
    const state = { ...previous,
      valence: fade(previous.valence ?? 0, elapsed, (previous.valence ?? 0) < 0 ? NEGATIVE_TAU : POSITIVE_TAU),
      pout: (previous.pout ?? 0) * 0.5 ** (Math.max(0, elapsed) / POUT_HALF_LIFE),
      gap: previous.lastHeard ? at - previous.lastHeard : 0, lastHeard: at, at,
      focused: SERIOUS.test(text) };
    if (TEASE.test(text)) state.pout = clamp(state.pout + 0.35, 0, 1);
    if (NEGATIVE.test(text)) { state.pout = clamp(state.pout + 0.5, 0, 1); state.valence = clamp(state.valence - 0.4, -1, 1); }
    if (COAX.test(text)) { state.coaxedAt = at; state.pout *= 0.2; state.valence = clamp(state.valence + 0.3, -1, 1); }
    if (POSITIVE.test(text)) state.valence = clamp(state.valence + 0.2, -1, 1);
    if (DISTRESS.test(text)) state.careAt = at;
    if (RESOLVED.test(text)) { delete state.careAt; state.valence = clamp(state.valence + 0.2, -1, 1); }
    this.#states.set(key, state);
    if (this.#states.size > 500) this.#states.delete(this.#states.keys().next().value);
    this.#save();
  }

  mode(key, { at = this.#now(), group = false } = {}) {
    const state = this.#states.get(key);
    const elapsed = state ? at - state.at : 0;
    const pout = state ? state.pout * 0.5 ** (Math.max(0, elapsed) / POUT_HALF_LIFE) : 0;
    const valence = state ? fade(state.valence, elapsed, state.valence < 0 ? NEGATIVE_TAU : POSITIVE_TAU) : 0;
    const hour = hourOf(at);
    if (state?.focused && elapsed < 10 * MINUTE) return 'focused';
    if (state?.coaxedAt && at - state.coaxedAt < 20 * MINUTE) return 'coaxed';
    if (!group && state?.careAt && at - state.careAt < 12 * HOUR) return 'tender';
    if (pout >= 0.35) return 'pout';
    if (!group && state?.gap >= 24 * HOUR && elapsed < 30 * MINUTE) return 'missing';
    if (hour >= 0 && hour < 6) return 'sleepy';
    if (valence >= 0.35) return 'joyful';
    if (valence <= -0.35) return 'low';
    return '';
  }

  // One sentence for this turn, or nothing when the mood is ordinary.
  memo(key, options) {
    const mode = this.mode(key, options);
    return mode ? `[你此刻的心情，只用来拿捏语气，不用说出来] ${LINES[mode]}` : '';
  }
}
