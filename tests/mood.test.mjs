import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MoodBook } from '../integrations/maomao-dsh/mood.mjs';
import { cleanReply } from '../integrations/maomao-dsh/reply-cleanup.mjs';

const at = (time) => Date.parse(`2026-11-12T${time}:00+08:00`);

test('mood follows what people say, fades with time and never shows numbers', () => {
  const previousTz = process.env.TZ;
  process.env.TZ = 'Asia/Taipei';
  try {
    const mood = new MoodBook();
    assert.equal(mood.memo('chat', { at: at('15:00') }), '');
    mood.note('chat', '笨猫', at('15:00'));
    mood.note('chat', '略略略 笨猫', at('15:01'));
    assert.equal(mood.mode('chat', { at: at('15:02') }), 'pout');
    assert.equal(mood.mode('chat', { at: at('18:00') }), '', 'a pout fades within a few hours');
    mood.note('chat', '摸摸 别生气', at('18:01'));
    assert.equal(mood.mode('chat', { at: at('18:02') }), 'coaxed');
    mood.note('chat', '今天头疼，好难受', at('19:00'));
    assert.equal(mood.mode('chat', { at: at('19:30') }), 'tender');
    mood.note('chat', '睡了一觉好多了', at('21:00'));
    assert.notEqual(mood.mode('chat', { at: at('21:30') }), 'tender');
    mood.note('chat', '帮我看下这个报错', at('21:40'));
    assert.equal(mood.mode('chat', { at: at('21:41') }), 'focused');
    assert.equal(mood.mode('quiet', { at: at('02:00') }), 'sleepy');
    const memo = new MoodBook();
    memo.note('chat', '笨猫', at('15:00'));
    memo.note('chat', '傻猫', at('15:00'));
    assert.match(memo.memo('chat', { at: at('15:01') }), /^\[你此刻的心情，只用来拿捏语气，不用说出来\] [^\d]+$/);
    const long = new MoodBook();
    long.note('dm', '在吗', at('10:00') - 3 * 86400_000);
    long.note('dm', '在吗', at('10:00'));
    assert.equal(long.mode('dm', { at: at('10:01') }), 'missing');
    assert.notEqual(long.mode('dm', { at: at('10:01'), group: true }), 'missing');
  } finally {
    if (previousTz === undefined) delete process.env.TZ; else process.env.TZ = previousTz;
  }
});

test('replies are cleaned of machine wrappers before sending, keeping the words', () => {
  assert.equal(cleanReply("[{'type': 'text', 'text': '哼，才不是'}, {'type': 'text', 'text': '好吧'}]"), '哼，才不是<|bubble|>好吧');
  assert.equal(cleanReply('["你好呀", "在干嘛"]'), '你好呀<|bubble|>在干嘛');
  assert.equal(cleanReply('<thought>想想怎么说</thought>喵'), '喵');
  assert.equal(cleanReply('[22:51] 早'), '早');
  assert.equal(cleanReply('[QQ 表情：旺柴] 才不要'), '[QQ 表情：旺柴] 才不要');
  assert.equal(cleanReply('列表 [1, 2] 照常'), '列表 [1, 2] 照常');
});

test('joining a group chat unprompted waits to read and type, a few seconds in all', async () => {
  const { joinInPause } = await import('../integrations/maomao-dsh/pacing.mjs');
  const middle = { random: () => 0.5 };
  const short = joinInPause('增智慧？', '增没增不知道', middle);
  const long = joinInPause('哼！俺这叫能屈能伸，大度的猫猫才不跟握着电源线的人硬刚呢！', '嘴硬，尾巴毛都炸成鸡毛掸子了还大度嘞！', middle);
  assert.ok(short >= 2000 && short < long && long <= 8000, `${short} / ${long}`);
});

test('a running joke used three times in half a day earns a nudge to move on, and fades after', () => {
  const book = new MoodBook();
  const t = Date.parse('2026-11-13T16:00:00+08:00');
  book.noteLine('group', '学猫猫说话可是要交小鱼干的', t);
  book.noteLine('group', '张嘴闭嘴小鱼干！', t + 60_000);
  assert.equal(book.repeatNudge('group', t + 120_000), '');
  book.noteLine('group', '分你半条小鱼干，再来碗烩面', t + 120_000);
  assert.match(book.repeatNudge('group', t + 180_000), /「小鱼干」/);
  assert.doesNotMatch(book.repeatNudge('group', t + 180_000), /烩面/);
  assert.equal(book.repeatNudge('group', t + 13 * 3600_000), '');
  assert.equal(book.repeatNudge('other', t), '');
});

test('in a group, 猫猫 is polite with someone new and relaxed with a regular', () => {
  const book = new MoodBook();
  const t = Date.parse('2026-11-13T10:00:00+08:00');
  book.acquaint('group', 'newcomer', t);
  assert.match(book.familiarity('group', 'newcomer'), /不太熟/);
  for (let i = 0; i < 4; i++) book.acquaint('group', 'sometimes', t + i * 60_000);
  assert.match(book.familiarity('group', 'sometimes'), /打过几次交道/);
  for (let i = 0; i < 16; i++) book.acquaint('group', 'regular', t + i * 2 * 3600_000);
  assert.match(book.familiarity('group', 'regular'), /熟人/);
  assert.match(book.familiarity('group', 'never-seen'), /不太熟/);
});
