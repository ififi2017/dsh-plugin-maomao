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
