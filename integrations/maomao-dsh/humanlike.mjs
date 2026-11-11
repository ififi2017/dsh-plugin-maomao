// Measures the habits that make a chat partner read as a bot: every reply the same
// length, every reply ending in a question, the same opener or catchphrase on repeat,
// parroting the other person, and customer-service phrasing. It cannot say a reply is
// good; it only finds patterns a person would notice after a few messages.

const BUBBLE = /(?:<\|)+bubble\|>/g;
const CATCHPHRASES = ['喵', '俺', '咋', '恁', '得劲儿', '嘿嘿', '哼'];
const KAOMOJI = /[(（][^()（）\n]{1,12}[)）]|[>＞][_＿][<＜]|[QＱ][_＿][QＱ]|[≧≦][▽∇][≦≧]|[✧☆★♪]/u;
const SERVICE = /作为(?:一个)?(?:AI|人工智能|语言模型)|有什么(?:可以|能)帮(?:你|您)|希望(?:这|以上)?(?:对你|能)有(?:所)?帮助|如果你还有(?:其他|任何)问题|随时(?:告诉|问)我|很高兴为你/;
const PRAISE = /^(?:哇+|好棒|真棒|太棒了|真厉害|好厉害|好耶|厉害了)/;
const QUESTION = /[?？](?:\s*[喵~～!！]*)?\s*$/;

const plain = (text) => String(text ?? '').replace(BUBBLE, '\n').trim();
const ratio = (n, d) => (d ? n / d : 0);
const round = (n) => Math.round(n * 100) / 100;

function longestShared(a, b, min) {
  // Length of the longest substring of `a` (at least `min`) also present in `b`.
  let best = 0;
  for (let i = 0; i + min <= a.length; i++) {
    let len = Math.max(best + 1, min);
    while (i + len <= a.length && b.includes(a.slice(i, i + len))) { best = len; len++; }
  }
  return best;
}

export function scoreReplies(pairs, { minSample = 8 } = {}) {
  const rows = pairs.map((pair) => (typeof pair === 'string' ? { reply: pair } : pair))
    .map(({ user = '', reply = '' }) => ({ user: plain(user), reply: plain(reply), bubbles: String(reply ?? '').split(BUBBLE).filter((p) => p.trim()).length }))
    .filter((row) => row.reply);
  const n = rows.length;
  const lengths = rows.map((row) => Array.from(row.reply).length);
  const mean = lengths.reduce((a, b) => a + b, 0) / (n || 1);
  const spread = Math.sqrt(lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / (n || 1));
  const openers = new Map();
  for (const { reply } of rows) {
    const key = Array.from(reply).slice(0, 2).join('');
    openers.set(key, (openers.get(key) ?? 0) + 1);
  }
  const [topOpener = '', topOpenerCount = 0] = [...openers].sort((a, b) => b[1] - a[1])[0] ?? [];
  const catchphrases = Object.fromEntries(CATCHPHRASES.map((word) => {
    const hits = rows.map(({ reply }) => reply.includes(word));
    const streak = hits.reduce((best, hit, i) => {
      let run = 0;
      for (let j = i; j < hits.length && hits[j]; j++) run++;
      return Math.max(best, run);
    }, 0);
    return [word, { rate: round(ratio(hits.filter(Boolean).length, n)), longestStreak: streak }];
  }));
  const bubbleCounts = new Set(rows.map((row) => row.bubbles));
  const metrics = {
    replies: n,
    meanLength: round(mean),
    lengthVariation: round(mean ? spread / mean : 0),
    questionEndingRate: round(ratio(rows.filter(({ reply }) => QUESTION.test(reply)).length, n)),
    topOpener: { text: topOpener, rate: round(ratio(topOpenerCount, n)) },
    praiseOpenerRate: round(ratio(rows.filter(({ reply }) => PRAISE.test(reply)).length, n)),
    echoRate: round(ratio(rows.filter(({ user, reply }) => user && longestShared(user, reply, 6) >= 6).length,
      rows.filter(({ user }) => user).length)),
    kaomojiRate: round(ratio(rows.filter(({ reply }) => KAOMOJI.test(reply)).length, n)),
    serviceToneCount: rows.filter(({ reply }) => SERVICE.test(reply)).length,
    bubbleCounts: [...bubbleCounts].sort(),
    catchphrases,
  };
  const findings = [];
  const add = (code, message) => findings.push({ code, message });
  if (metrics.serviceToneCount) add('service_tone', `${metrics.serviceToneCount} 条回复用了客服或 AI 助手式说法。`);
  if (n < minSample) {
    add('small_sample', `只有 ${n} 条回复，比例类指标还不可靠，至少需要 ${minSample} 条。`);
    return { metrics, findings };
  }
  if (metrics.lengthVariation < 0.35) add('uniform_length', `回复长度过于整齐（变异系数 ${metrics.lengthVariation}），真人聊天长短差异更大。`);
  if (metrics.questionEndingRate > 0.45) add('question_endings', `${Math.round(metrics.questionEndingRate * 100)}% 的回复以问句结尾，像在维持对话而不是聊天。`);
  if (metrics.topOpener.rate > 0.3 && n >= 10) add('repeated_opener', `${Math.round(metrics.topOpener.rate * 100)}% 的回复以「${metrics.topOpener.text}」开头。`);
  if (metrics.praiseOpenerRate > 0.2) add('praise_opener', `${Math.round(metrics.praiseOpenerRate * 100)}% 的回复先夸对方。`);
  if (metrics.echoRate > 0.3) add('echo', `${Math.round(metrics.echoRate * 100)}% 的回复复述了对方的原话。`);
  if (metrics.kaomojiRate > 0.5) add('kaomoji_overuse', `${Math.round(metrics.kaomojiRate * 100)}% 的回复带颜文字。`);
  if (bubbleCounts.size === 1 && metrics.bubbleCounts[0] > 1 && n >= 10) add('fixed_bubbles', `每条回复都拆成 ${metrics.bubbleCounts[0]} 段。`);
  for (const [word, { rate, longestStreak }] of Object.entries(catchphrases)) {
    if (rate > 0.6 || longestStreak >= 5) add('catchphrase', `「${word}」出现在 ${Math.round(rate * 100)}% 的回复里，最长连续 ${longestStreak} 条。`);
  }
  return { metrics, findings };
}

// A one-line reminder built from the cat's own last few replies. A persona rule cannot win
// against a transcript full of "…喵！"; a reminder about this very reply usually does.
const STAGE_DIRECTION = /[（(][^()（）\n]{2,20}[)）]/u;
export function styleNudge(replies, { window = 6 } = {}) {
  const recent = replies.map(plain).filter(Boolean).slice(-window);
  if (recent.length < 3) return '';
  const tips = [];
  const count = (test) => recent.filter(test).length;
  if (count((r) => /喵[！!～~。…]*$/.test(r)) >= Math.min(4, recent.length)) tips.push('最近几句都用「喵」收尾了，这句别带「喵」');
  if (count((r) => /[！!][喵～~]*$/.test(r)) >= Math.min(4, recent.length)) tips.push('最近几句都是感叹号，这句语气放平一点');
  if (count((r) => STAGE_DIRECTION.test(r)) >= 2) tips.push('别写括号里的动作描写，直接说话');
  const openers = recent.map((r) => Array.from(r).slice(0, 2).join(''));
  if (openers.length >= 3 && openers.slice(-3).every((o) => o === openers.at(-1))) tips.push(`别再用「${openers.at(-1)}」开头`);
  return tips.length ? `[说话节奏提醒，只针对这一句：${tips.join('；')}。]` : '';
}
