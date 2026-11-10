import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scoreReplies } from '../integrations/maomao-dsh/humanlike.mjs';
import { typingPause } from '../integrations/maomao-dsh/pacing.mjs';

const codes = (result) => result.findings.map((f) => f.code).sort();

test('scripted replies are flagged for the habits people notice', () => {
  const pairs = Array.from({ length: 12 }, (_, i) => ({
    user: `今天我去公园散步了第${i}次`,
    reply: `哇，今天我去公园散步了第${i}次呀，真不错喵！那你明天还去吗？`,
  }));
  pairs.push({ user: '谢谢', reply: '不客气！希望对你有帮助，如果你还有其他问题随时告诉我喵？' });
  const result = scoreReplies(pairs);
  for (const code of ['catchphrase', 'echo', 'question_endings', 'repeated_opener', 'service_tone', 'uniform_length']) {
    assert.ok(codes(result).includes(code), code);
  }
});

test('varied conversational replies pass, and tiny samples only report what is certain', () => {
  const replies = ['中', '哈哈哈哈哈哈 这也太离谱了', '俺刚睡醒…', '你说的那家烩面馆俺也去过，汤是真得劲儿，就是排队排到怀疑人生',
    '嗯嗯', '不去，外头太晒了', '咋又是你喵', '行吧行吧，听你的。', '(=ↀωↀ=)', '这题俺不会，真不会，别看俺',
    '刚才群里那个梗笑死俺了', '晚安'];
  assert.deepEqual(scoreReplies(replies).findings, []);
  assert.deepEqual(codes(scoreReplies(['你好', '在呢'])), ['small_sample']);
});

test('typing pauses grow with length, stay bounded and jitter', () => {
  const fixed = { random: () => 0.5 };
  assert.ok(typingPause('嗯', fixed) < typingPause('这是一条稍微长一点的消息，打字要花点时间', fixed));
  assert.equal(typingPause('长'.repeat(500), fixed), 2200);
  assert.notEqual(typingPause('一样的话', { random: () => 0 }), typingPause('一样的话', { random: () => 1 }));
});
