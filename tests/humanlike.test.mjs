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

test('style nudges name the habit the last few replies repeat, and stay quiet otherwise', async () => {
  const { styleNudge } = await import('../integrations/maomao-dsh/humanlike.mjs');
  const today = ['被猫猫塔的重量当场封印了呗喵！', '毛茸茸虽然轻，但幸福的负担可是很沉重的喵！',
    '(耳朵猛地一抖)那是，多少人排队还没这福气呢喵！', '所以偷着乐吧(甩尾巴)，这待遇可是全群独一份喵！'];
  const nudge = styleNudge(today);
  assert.match(nudge, /别带「喵」/); assert.match(nudge, /感叹号/); assert.match(nudge, /括号/);
  assert.equal(styleNudge(['中', '这也太离谱了', '俺刚睡醒…', '你说那家烩面馆俺去过']), '');
  assert.equal(styleNudge(['喵！', '喵！']), '', 'two lines are not a pattern yet');
});

test('the chat model gets images directly when it can see them', async () => {
  const { chatSeesImages } = await import('../integrations/maomao-dsh/model-call.mjs');
  const ctx = (modalities) => ({ get: (name) => name === 'llm' ? { resolveModelInfo: async () => ({ inputModalities: modalities }) } : undefined });
  assert.equal(await chatSeesImages(ctx(['text', 'image']), { provider: 'openai', model: 'm' }), true);
  assert.equal(await chatSeesImages(ctx(['text']), { provider: 'google', model: 'm' }), false, 'model info wins over the provider guess');
  assert.equal(await chatSeesImages({ get() {} }, { provider: 'google' }), true);
  assert.equal(await chatSeesImages({ get() {} }, { provider: 'deepseek', model: 'chat' }), false);
  assert.equal(await chatSeesImages({ get() {} }, null), false);
});

test('choice options are offered again only after enough replies and time have passed', async () => {
  const { ChoiceThrottle, choiceGuidance } = await import('../integrations/maomao-dsh/choices.mjs');
  let now = 0;
  const throttle = new ChoiceThrottle({ replies: 3, minutes: 10, clock: () => now });
  assert.equal(throttle.allow('chat'), true);
  throttle.noteReply('chat', true);
  for (let i = 0; i < 3; i++) { assert.equal(throttle.allow('chat'), false); throttle.noteReply('chat'); }
  assert.equal(throttle.allow('chat'), false, 'three replies but not ten minutes');
  now = 10 * 60_000;
  assert.equal(throttle.allow('chat'), true);
  assert.equal(throttle.allow('other-chat'), true, 'chats are throttled separately');
  assert.match(choiceGuidance, /极少使用/);
});

test('nudges separate emoji endings, kaomoji and stage directions', async () => {
  const { styleNudge } = await import('../integrations/maomao-dsh/humanlike.mjs');
  assert.match(styleNudge(['本喵登场！😼🔥', '网速就是猫步！😼🐾', '没收小鱼干哦！😼', '梦想总要有！😼✨']), /emoji/);
  const kaomoji = styleNudge(['哇好可爱(ฅ´ω`ฅ)', '太软了吧(ฅ///ฅ)', '晚安啦(｡♥‿♥｡)', '嗯嗯']);
  assert.match(kaomoji, /颜文字/); assert.doesNotMatch(kaomoji, /动作描写/);
  assert.match(styleNudge(['（叼着小鱼干从天而降）登场', '（甩了甩尾巴）好吧', '正常说话']), /动作描写/);
});

test('no sticker candidates means no candidate line, and a stale memory version is handed back', async () => {
  const { openStickerTools } = await import('../integrations/maomao-dsh/sticker-tools.mjs');
  const empty = openStickerTools({ current: () => true, signal: AbortSignal.timeout(1000), images: [], operate: async () => ({}) });
  assert.equal(empty.context({ guidance: false }), '');
  const one = openStickerTools({ current: () => true, signal: AbortSignal.timeout(1000), images: [{ data: 'x' }], operate: async () => ({}) });
  assert.match(one.context({ guidance: false }), /image-1/);
  const { LearningStore } = await import('../integrations/maomao-dsh/learning-store.mjs');
  const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const store = new LearningStore(mkdtempSync(join(tmpdir(), 'conflict-')), 'a'.repeat(64));
  const saved = store.save({ kind: 'profile', title: 't', body: 'b' }, { subject: 's', owner: true, manual: true });
  assert.deepEqual(store.change(saved.id, 99, 'forget', { subject: 's' }), { status: 'conflict', id: saved.id, version: 1 });
});
