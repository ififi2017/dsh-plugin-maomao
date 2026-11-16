import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { normalizeInbound, recentImageFor, recentImagesFrom } from '../inbound.mjs';
import { MaomaoQqConnector } from '../index.mjs';
import { OrdinaryBridge } from '../ordinary.mjs';
import { StickerIntelligence } from '../stickers.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=';
const attachments = [{ content_type: 'image/png', url: 'https://img.qpic.cn/sticker' }];
const picture = { type: 'image', mediaType: 'image/png', data: png };
const description = { description: '捂嘴憋笑的小猫', text: '忍住', category: '开心',
  is_meme: true, confidence: .97, personal_or_sensitive: false, steal_reason: '这个憋笑脸拿来看热闹正合适' };

function message(messageId, options = {}) {
  return { messageId, kind: 'group', groupOpenid: 'group-a', senderId: 'member-a',
    rawEventType: 'GROUP_MESSAGE_CREATE', content: '', attachments: [], ...options };
}

test('prior image follows a same-chat quote or a recent unambiguous reference', () => {
  const first = normalizeInbound(message('image', { attachments, msgIdx: '100' }), 10_000, 'bot-a');
  const other = normalizeInbound(message('other', { attachments, groupOpenid: 'group-b', msgIdx: '100' }), 15_000, 'bot-a');
  const ask = normalizeInbound(message('ask', { content: '这张怎么样' }), 20_000, 'bot-a');
  assert.equal(recentImageFor(ask, [first, other]), first);
  assert.equal(recentImageFor(ask, [other]), null);
  assert.equal(recentImageFor({ ...ask, botId: 'bot-b' }, [first]), null);
  assert.equal(recentImageFor({ ...ask, text: '早上好' }, [first]), null);
  assert.equal(recentImageFor({ ...ask, replyIndex: '100', text: '这是啥' }, [other, first]), first);
  assert.equal(recentImageFor({ ...ask, receivedAt: 130_001 }, [first]), null);
  const onlyOtherMembers = [{ ...first, senderId: 'b' }, { ...first, senderId: 'c', receiptKey: 'another' }];
  assert.equal(recentImageFor(ask, onlyOtherMembers), null);
  const native = normalizeInbound(message('face', { raw: { content: '<faceType=3,faceId="9",ext="BAD">' } }), 0);
  assert.equal(native.text, '[QQ 表情：大哭]');
  assert.deepEqual(native.attachments, []);
});

test('isolated worker and connector collect twice, send one notice, then append selected 512 GIF after text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maomao-stickers-'));
  const env = { ...Object.fromEntries(['MAOMAO_QQ_APP_ID', 'MAOMAO_QQ_APP_SECRET', 'MAOMAO_QQ_CONNECT']
    .map((key) => [key, process.env[key]])) };
  Object.assign(process.env, { MAOMAO_QQ_APP_ID: 'test-bot', MAOMAO_QQ_APP_SECRET: 'test-secret',
    MAOMAO_QQ_CONNECT: 'I_STOPPED_HERMES_QQ' });
  const ordinary = new OrdinaryBridge({ root: join(root, 'memory'), stickerPack: root });
  const sends = [];
  const calls = [];
  const asks = [];
  let finishRun;
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  const bot = { use() {}, on() {}, start() { return new Promise((resolve) => { finishRun = resolve; }); },
    stop() { finishRun?.(); }, async uploadMedia(request) {
      assert.deepEqual(request.buffer, gif);
      assert.equal(request.fileName, 'A2.gif');
      assert.equal(request.srvSendMsg, false);
      return { file_info: 'media-token' };
    }, async send(request) { sends.push(request); return { id: `sent-${sends.length}` }; } };
  const stickers = new StickerIntelligence({ model: 'gemini-test', key: 'synthetic-key',
    async fetchImpl(_url, request) {
      const parts = JSON.parse(request.body).contents[0].parts;
      const image = Boolean(parts[0].inlineData);
      calls.push(image ? 'vision' : 'selection');
      const output = image ? description : { choice: 'pack:A2' };
      return Response.json({ candidates: [{ finishReason: 'STOP',
        content: { parts: [{ text: JSON.stringify(output) }] } }] });
    } });
  const connector = new MaomaoQqConnector({ sessionController: {}, emit() {}, logger: console },
    { groupAllowlist: ['group-a', 'group-b'], statePath: join(root, 'state.json'),
      stickers: { enabled: true, collect: true } },
    { botFactory: () => bot, ordinary, stickers, harness: { async ask(envelope, options) {
      asks.push({ envelope, options });
      return '中<|bubble|>这表情还挺可爱';
    } } });
  connector.loadImages = async (receiptKey) => receiptKey.endsWith(':first') || receiptKey.endsWith(':second')
    ? [picture] : [];
  const until = async (predicate) => {
    const end = Date.now() + 4000;
    while (!(await predicate()) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 15));
    assert.ok(await predicate());
  };
  try {
    await mkdir(join(root, '512', 'gif'), { recursive: true });
    await writeFile(join(root, '512', 'gif', 'A2.gif'), gif);
    await connector.start();
    const envelope = (groupOpenid) => normalizeInbound(message('lookup', { groupOpenid, attachments }), Date.now(), 'test-bot');
    await connector.accept(message('first', { attachments }));
    await until(async () => (await ordinary.media('prepare_image', envelope('group-a'), { data: png })).known);
    assert.equal(sends.length, 0);
    await connector.accept(message('second', { attachments }));
    await until(() => sends.length === 1);
    assert.match(sends[0].content, /偷走啦.*憋笑脸/);
    assert.equal(sends[0].target.msgId, 'second');
    const candidates = (group) => ordinary.media('sticker_candidates', envelope(group), { query: '捂嘴憋笑' });
    assert.ok((await candidates('group-a')).some((item) => !item.id.startsWith('pack:')));
    assert.ok((await candidates('group-b')).every((item) => item.id.startsWith('pack:')));
    await connector.accept(message('ask', { rawEventType: 'GROUP_AT_MESSAGE_CREATE', content: '这张怎么样' }));
    await until(() => sends.length === 4);
    assert.equal(asks[0].options.images[0].data, png);
    assert.equal(asks[0].options.referencedImage.sameSender, true);
    assert.deepEqual(calls, ['vision', 'selection']);
    assert.deepEqual(sends.slice(1).map((entry) => [entry.msgType, entry.extra.msg_seq]), [[0, 1], [0, 2], [7, 3]]);
    assert.equal(sends[3].target.msgId, 'ask');
  } finally {
    await connector.stop();
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('in sticker-tool mode a clear sticker is kept on first sight and announced with a short line when no turn mentions it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maomao-steal-'));
  const env = { ...Object.fromEntries(['MAOMAO_QQ_APP_ID', 'MAOMAO_QQ_APP_SECRET', 'MAOMAO_QQ_CONNECT']
    .map((key) => [key, process.env[key]])) };
  Object.assign(process.env, { MAOMAO_QQ_APP_ID: 'test-bot', MAOMAO_QQ_APP_SECRET: 'test-secret',
    MAOMAO_QQ_CONNECT: 'I_STOPPED_HERMES_QQ' });
  const ordinary = new OrdinaryBridge({ root: join(root, 'memory'), stickerPack: root });
  const sends = [];
  let finishRun;
  const bot = { use() {}, on() {}, start() { return new Promise((resolve) => { finishRun = resolve; }); },
    stop() { finishRun?.(); }, async send(request) { sends.push(request); return { id: `sent-${sends.length}` }; } };
  const stickers = { async describe() { return description; } };
  const learning = { settings: { stickers: true, collectStickers: true } };
  const connector = new MaomaoQqConnector({ sessionController: {}, emit() {}, logger: console,
    get: (name) => name === 'maomaoLearning' ? learning : undefined },
  { groupAllowlist: ['group-a'], statePath: join(root, 'state.json'), stickers: { enabled: true } },
  { botFactory: () => bot, ordinary, stickers, stealNoticeDelayMs: 60, harness: { async ask() { return ''; } } });
  connector.loadImages = async (receiptKey) => receiptKey.endsWith(':first') ? [picture] : [];
  try {
    await connector.start();
    await connector.accept(message('first', { attachments }));
    const end = Date.now() + 4000;
    while (!sends.length && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(sends.length, 1);
    assert.match(sends[0].content, /偷走啦.*憋笑脸/);
    assert.equal(sends[0].target.msgId, 'first');
  } finally {
    await connector.stop();
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('a message of only a QQ store sticker is not empty: it reads as a QQ face, named when the sticker says so', () => {
  const store = (ext) => normalizeInbound(message('store', { content: '',
    raw: { content: `<faceType=3,faceId="ec7c4b1b0d3cd7b5",ext="${ext}">` } }), 0, 'bot-a');
  assert.equal(store('opaque').text, '[QQ 表情]');
  assert.equal(store(Buffer.from(JSON.stringify({ text: '[狗头保命]' })).toString('base64')).text, '[QQ 表情：狗头保命]');
  const known = normalizeInbound(message('face', { content: '', raw: { content: '[<face,id=178/>]' } }), 0, 'bot-a');
  assert.equal(known.text, '[QQ 表情：斜眼笑]');
});

test('a picture rides along with a follow-up question once, and plain remarks do not drag old pictures or stickers in', () => {
  const at = (id, seconds, options = {}) => normalizeInbound(message(id, options), 1_000_000 + seconds * 1000, 'bot-a');
  const screenshot = at('shot', 0, { attachments });
  const sticker = at('sticker', 50, { attachments, content: '【表情: 未知表情】' });
  const receipts = [screenshot, sticker];
  // "Picture, then 分析下" picks up the screenshot.
  assert.deepEqual(recentImagesFrom(at('ask', 20, { content: '出来分析下' }), receipts).map((r) => r.messageId), ['shot']);
  // An unrelated remark soon after an unanswered picture still gets it; a minute later it does not.
  assert.deepEqual(recentImagesFrom(at('remark', 30, { content: '你 tm' }), [screenshot]).map((r) => r.messageId), ['shot']);
  assert.deepEqual(recentImagesFrom(at('later', 70, { content: '你 tm' }), [screenshot]), []);
  // A sticker is not "the picture you mean" unless the line points at it.
  assert.deepEqual(recentImagesFrom(at('next', 55, { content: '怎么又扎心' }), [sticker]), []);
  assert.deepEqual(recentImagesFrom(at('about', 55, { content: '这张啥意思' }), [sticker]).map((r) => r.messageId), ['sticker']);
  // Once a turn has looked at a picture it is not attached again.
  assert.deepEqual(recentImagesFrom(at('again', 25, { content: '分析下' }), receipts, 3, 120_000, { shown: new Set([screenshot.receiptKey]) }), []);
});

test('a screenshot of a page, balance or dashboard is never kept as a sticker, whatever the vision model says', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maomao-screenshot-'));
  const ordinary = new OrdinaryBridge({ root: join(root, 'memory'), stickerPack: root });
  try {
    const envelope = normalizeInbound(message('shot', { attachments }), Date.now(), 'bot-a');
    const remember = (result) => ordinary.media('remember_image', envelope, { data: png, collect: true, first_sight: true, result });
    const kept = await remember({ description: 'Google AdSense 网页后台的收入卡片截图，余额 0 美元', text: '估算收入 US$0.10',
      category: '无语', is_meme: true, confidence: 0.95, personal_or_sensitive: false, steal_reason: '收入太少时自嘲' });
    assert.equal(kept.notice, undefined, 'the AdSense screenshot is not kept');
    const sticker = await remember(description);
    assert.match(sticker.notice ?? '', /偷走啦/, 'a real sticker still is');
  } finally {
    await ordinary.stop?.();
    await rm(root, { recursive: true, force: true });
  }
});

test('when 猫猫 replies in the chat after a background save, the fallback line is not sent as well', { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'maomao-steal-once-'));
  const env = { ...Object.fromEntries(['MAOMAO_QQ_APP_ID', 'MAOMAO_QQ_APP_SECRET', 'MAOMAO_QQ_CONNECT']
    .map((key) => [key, process.env[key]])) };
  Object.assign(process.env, { MAOMAO_QQ_APP_ID: 'test-bot', MAOMAO_QQ_APP_SECRET: 'test-secret',
    MAOMAO_QQ_CONNECT: 'I_STOPPED_HERMES_QQ' });
  const ordinary = new OrdinaryBridge({ root: join(root, 'memory'), stickerPack: root });
  const sends = [];
  let finishRun;
  const bot = { use() {}, on() {}, start() { return new Promise((resolve) => { finishRun = resolve; }); },
    stop() { finishRun?.(); }, async send(request) { sends.push(request); return { id: `sent-${sends.length}` }; } };
  const learning = { settings: { stickers: true, collectStickers: true } };
  // The reply takes a moment, so the background save lands first, as it did in the real chat.
  const harness = { async ask() { await new Promise((resolve) => setTimeout(resolve, 2000)); return '图俺顺手收下了。'; } };
  const connector = new MaomaoQqConnector({ sessionController: {}, emit() {}, logger: console,
    get: (name) => name === 'maomaoLearning' ? learning : undefined },
  { groupAllowlist: ['group-a'], statePath: join(root, 'state.json'), stickers: { enabled: true }, typingPace: false },
  { botFactory: () => bot, ordinary, stickers: { async describe() { return description; } }, stealNoticeDelayMs: 2500, harness });
  connector.loadImages = async (receiptKey) => receiptKey.endsWith(':first') ? [picture] : [];
  try {
    await connector.start();
    await connector.accept(message('first', { attachments, rawEventType: 'GROUP_AT_MESSAGE_CREATE' }));
    await new Promise((resolve) => setTimeout(resolve, 5000));
    assert.deepEqual(sends.map((s) => s.content), ['图俺顺手收下了。']);
  } finally {
    await connector.stop();
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('saved stickers are mentioned at most once per chat every 30 minutes; the rest are kept quietly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maomao-steal-quiet-'));
  const env = { ...Object.fromEntries(['MAOMAO_QQ_APP_ID', 'MAOMAO_QQ_APP_SECRET', 'MAOMAO_QQ_CONNECT']
    .map((key) => [key, process.env[key]])) };
  Object.assign(process.env, { MAOMAO_QQ_APP_ID: 'test-bot', MAOMAO_QQ_APP_SECRET: 'test-secret',
    MAOMAO_QQ_CONNECT: 'I_STOPPED_HERMES_QQ' });
  const ordinary = new OrdinaryBridge({ root: join(root, 'memory'), stickerPack: root });
  const sends = [];
  let finishRun;
  const bot = { use() {}, on() {}, start() { return new Promise((resolve) => { finishRun = resolve; }); },
    stop() { finishRun?.(); }, async send(request) { sends.push(request); return { id: `sent-${sends.length}` }; } };
  const learning = { settings: { stickers: true, collectStickers: true } };
  const other = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex').toString('base64');
  const connector = new MaomaoQqConnector({ sessionController: {}, emit() {}, logger: console,
    get: (name) => name === 'maomaoLearning' ? learning : undefined },
  { groupAllowlist: ['group-a'], statePath: join(root, 'state.json'), stickers: { enabled: true } },
  { botFactory: () => bot, ordinary, stickers: { async describe() { return description; } }, stealNoticeDelayMs: 60,
    harness: { async ask() { return ''; } } });
  connector.loadImages = async (receiptKey) => receiptKey.endsWith(':first') ? [picture]
    : receiptKey.endsWith(':second') ? [{ ...picture, data: other }] : [];
  try {
    await connector.start();
    await connector.accept(message('first', { attachments }));
    const end = Date.now() + 3000;
    while (!sends.length && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 15));
    await connector.accept(message('second', { attachments }));
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(sends.filter((s) => /偷走啦/.test(s.content)).length, 1);
  } finally {
    await connector.stop();
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
