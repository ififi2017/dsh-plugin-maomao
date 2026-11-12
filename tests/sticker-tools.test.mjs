import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeStickerDescription } from '../integrations/maomao-dsh/model-call.mjs';
import { openStickerTools } from '../integrations/maomao-dsh/sticker-tools.mjs';
import { STICKER_CATEGORIES } from '../integrations/maomao-dsh/qq-connector/stickers.mjs';

test('a chat-model sticker description is trimmed to fit instead of rejected, and unclear privacy stays private', () => {
  const long = normalizeStickerDescription({ description: '猫'.repeat(300), text: '字'.repeat(150), category: '卖萌',
    is_meme: true, confidence: '0.9', personal_or_sensitive: false, steal_reason: '适合'.repeat(40) }, STICKER_CATEGORIES);
  assert.equal(long.description.length, 200);
  assert.equal(long.text.length, 100);
  assert.equal(long.category, '其他');
  assert.equal(long.confidence, 0.9);
  assert.equal(long.steal_reason.length, 48);
  assert.equal(long.personal_or_sensitive, false);
  assert.equal(normalizeStickerDescription({ description: '自拍', is_meme: false }, STICKER_CATEGORIES).personal_or_sensitive, true);
  assert.equal(normalizeStickerDescription({ is_meme: true }, STICKER_CATEGORIES), null);
});

test('sticker candidates show where they came from and are inspected and collected against their own message', async () => {
  const calls = [];
  const tools = openStickerTools({ current: () => true, signal: AbortSignal.timeout(5000),
    images: [{ data: 'own' }, { data: 'ambient', origin: '刚才群里有人发的', source: { receiptKey: 'earlier' } }],
    operate: async (action, args) => { calls.push([action, args.data, args.source?.receiptKey ?? null]);
      return action === 'inspect' ? { status: 'ok', jpeg: 'x' } : { status: 'saved', id: 'saved-1' }; },
    describe: async () => ({ description: '猫猫比心', text: '', category: '开心', is_meme: true, confidence: 0.9, personal_or_sensitive: false, steal_reason: '' }) });
  assert.match(tools.context(), /"id":"image-1"\}/);
  assert.match(tools.context(), /"id":"image-2","from":"刚才群里有人发的"/);
  const defs = new Map();
  tools.bind('s', { register(def) { defs.set(def.name, def); return () => {}; } });
  const run = (args) => defs.get('maomao_stickers').execute(args, { agent: { id: 's' } });
  assert.equal((await run({ action: 'collect', id: 'image-2', reason: '比心的时候用' })).status, 'saved');
  assert.deepEqual(calls, [['inspect', 'ambient', 'earlier'], ['collect', 'ambient', 'earlier']]);
});

test('what the cat quietly kept since its last turn is mentioned once in the turn context', () => {
  const tools = openStickerTools({ current: () => true, signal: AbortSignal.timeout(1000), note: '[你刚才顺手收藏了这里的表情：…]', operate: async () => ({}) });
  assert.match(tools.context({ guidance: false }), /顺手收藏/);
});

test('chat-model vision sends the picture as a DSH attachment, asks for the least reasoning, and keeps a complete answer that hit the output limit', async () => {
  const { dshVision } = await import('../integrations/maomao-dsh/model-call.mjs');
  const seen = [];
  const reply = '{"description":"猫猫探头","text":"","category":"开心","is_meme":true,"confidence":0.8,"personal_or_sensitive":false,"steal_reason":"路过时发"}';
  const saved = [];
  const ctx = { get: (name) => name === 'attachments' ? { saveImage: async (image) => { saved.push(image); return { attachmentId: 'a1' }; } } : name === 'llm' ? {
    async prepareCall(config, signal, configure) {
      seen.push(configure?.({ maxTokens: config.maxTokens }, { reasoning: { efforts: [{ id: 'minimal' }, { id: 'high' }] } }));
      return { config, async *stream({ messages }) {
        assert.deepEqual(messages[1].content, [{ type: 'image', attachment: { attachmentId: 'a1' } }]); yield { type: 'text-delta', text: reply }; yield { type: 'finish', reason: { kind: 'max-tokens' } }; } };
    } } : null };
  const result = await dshVision(ctx, () => ({ provider: 'google', model: 'flash' })).describe(Buffer.from('jpeg').toString('base64'), AbortSignal.timeout(1000));
  assert.equal(saved[0].data.toString(), 'jpeg');
  assert.equal(saved[0].mediaType, 'image/jpeg');
  assert.equal(seen[0].reasoningEffort, 'minimal');
  assert.equal(result.description, '猫猫探头');
  assert.equal(result.steal_reason, '路过时发');
});
