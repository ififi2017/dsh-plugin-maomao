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
