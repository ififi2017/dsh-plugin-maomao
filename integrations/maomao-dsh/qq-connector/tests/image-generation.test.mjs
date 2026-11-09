import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { GeminiImageGeneration, OpenAiImageGeneration } from '../image-generation.mjs';
import { MaomaoQqConnector } from '../index.mjs';
import { apply as applyOrdinaryPolicy } from '../ordinary-policy.mjs';
import { ConnectorState } from '../state.mjs';
import { StickerIntelligence } from '../stickers.mjs';

test('OpenAI vision and image adapters send the expected media to the official endpoints', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=';
  const reference = { mediaType: 'image/png', data: png };
  const signal = AbortSignal.timeout(2000);
  const vision = new StickerIntelligence({ provider: 'openai', model: 'gpt-4.1-mini', key: 'synthetic', async fetchImpl(url, request) {
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    const body = JSON.parse(request.body);
    assert.equal(body.model, 'gpt-4.1-mini');
    assert.equal(body.messages[1].content.at(-1).image_url.url, `data:image/png;base64,${png}`);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{"description":"一个像素"}' } }] });
  } });
  assert.equal(await vision.inspect(reference, '有什么？', signal), '一个像素');

  const requests = [];
  const image = new OpenAiImageGeneration({ model: 'gpt-image-2', key: 'synthetic', async fetchImpl(url, request) {
    requests.push({ url, body: request.body });
    return Response.json({ data: [{ b64_json: png }] });
  } });
  assert.equal((await image.generate('一只猫', { aspectRatio: '1:1', signal })).fileName, 'maomao-image.png');
  assert.equal((await image.generate('改成水彩', { aspectRatio: '16:9', reference, signal })).fileName, 'maomao-image.png');
  assert.equal(requests[0].url, 'https://api.openai.com/v1/images/generations');
  assert.equal(JSON.parse(requests[0].body).model, 'gpt-image-2');
  assert.equal(requests[1].url, 'https://api.openai.com/v1/images/edits');
  assert.equal(requests[1].body.get('size'), '1536x864');
  assert.equal(requests[1].body.get('image[]').type, 'image/png');
});

test('a newly selected Gemini image model uses GenerateContent with the reference image', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=';
  const inlineData = { mimeType: 'image/png', data: png };
  const image = new GeminiImageGeneration({ model: 'gemini-3-pro-image', key: 'synthetic', async fetchImpl(url, request) {
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent');
    const body = JSON.parse(request.body);
    assert.deepEqual(body.contents[0].parts, [{ text: '改成水彩' }, { inlineData }]);
    assert.deepEqual(body.generationConfig, { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '3:2' } });
    return Response.json({ candidates: [{ content: { parts: [{ inlineData }] } }] });
  } });
  assert.equal((await image.generate('改成水彩', {
    aspectRatio: '3:2', reference: { mediaType: 'image/png', data: png }, signal: AbortSignal.timeout(2000),
  })).fileName, 'maomao-image.png');
});

test('native image tool is bound to one admitted QQ turn and delivers only once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maomao-image-tool-'));
  const env = { MAOMAO_QQ_APP_ID: 'test-bot', MAOMAO_QQ_APP_SECRET: 'test-secret',
    MAOMAO_QQ_CONNECT: 'I_STOPPED_HERMES_QQ' };
  const old = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=';
  const calls = [];
  const sent = [];
  let promptCount = 0;
  const { promise: handled, resolve: resolveHandled, reject: rejectHandled } = Promise.withResolvers();
  let definition;
  let activation;
  let finishRun;
  let terminated = false;
  const tools = { register(value, options) {
    assert.equal(value.name, 'maomao_generate_image');
    definition = value;
    activation = options.when;
    return () => { definition = undefined; };
  } };
  const agent = { id: 'test-session', ctx: { get(name) {
    if (name === 'systemPrompt') return { getSectionOrder: () => 0, section: () => () => {} };
    assert.equal(name, 'tools');
    return tools;
  } } };
  const exec = { agent, signal: AbortSignal.timeout(3000), concludeTurn() { terminated = true; } };
  const bot = { use() {}, on() {}, start() { return new Promise((resolve) => { finishRun = resolve; }); },
    stop() { finishRun?.(); }, async uploadMedia(req) {
      assert.deepEqual(req.buffer, Buffer.from(png, 'base64'));
      assert.equal(req.fileType, 1);
      return { file_info: 'image-token' };
    }, async send(req) { sent.push(req); return { id: 'out' }; } };
  const generator = new GeminiImageGeneration({ key: 'synthetic-key', async fetchImpl(_url, req) {
    calls.push(JSON.parse(req.body));
    return Response.json({ steps: [{ type: 'model_output',
      content: [{ type: 'image', data: png }] }] });
  } });
  const controller = {
    async create() { return { sessionId: agent.id }; },
    async projections() { return { values: { agentPreset: 'maomao-qq-ordinary' } }; },
    async resolveAgent(sessionId) { assert.equal(sessionId, agent.id); return { agent }; },
    async state() { return { cursor: 0 }; },
    async prompt(req) {
      try {
        promptCount += 1;
        assert.match(req.content[0].text, /聊天工具/);
        const args = { prompt: '橘猫坐在月亮旁', aspect_ratio: '1:1', use_reference: true };
        assert.equal(activation({ agent }), true);
        assert.equal(activation({ agent: { id: 'unrelated' } }), false);
        assert.deepEqual(await definition.execute(args, { ...exec, agent: { id: 'unrelated' } }), { status: 'denied', data: '' });
        assert.deepEqual(await definition.execute(args, exec), { status: 'sent', data: '' });
        assert.deepEqual(await definition.execute(args, exec), { status: 'limit', data: '' });
        assert.ok(terminated);
      } catch (error) { rejectHandled(error); throw error; }
    },
    async wait() {
      resolveHandled(); return { reason: 'idle', output: { records: [
      { event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'duplicate' }] } } } },
    ] } }; },
  };
  const connector = new MaomaoQqConnector({ sessionController: controller, emit() {}, logger: console },
    { statePath: join(root, 'state.json'), groupAllowlist: ['group-a'], imageGeneration: { enabled: true } },
    { imageGeneration: generator, botFactory: () => bot });
  applyOrdinaryPolicy({ tools: {
    restrict(filter) { assert.deepEqual(filter, { allow: [] }); },
  } });
  assert.equal(definition, undefined);
  connector.loadImages = async () => [{ type: 'image', mediaType: 'image/png', data: png }];
  try {
    await connector.start();
    await connector.accept({ kind: 'group', rawEventType: 'GROUP_AT_MESSAGE_CREATE', groupOpenid: 'group-a',
      senderId: 'sender-a', messageId: 'message-a', content: '换成水彩风吧',
      attachments: [{ content_type: 'image/png', url: 'https://img.qpic.cn/test' }] });
    await handled;
    assert.equal(promptCount, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, 'gemini-3.1-flash-image');
    assert.deepEqual(calls[0].input[1], { type: 'image', mime_type: 'image/png', data: png });
    assert.deepEqual(sent.map((item) => [item.target.msgId, item.msgType, item.extra.msg_seq]), [['message-a', 7, 1]]);
  } finally {
    await connector.stop();
    assert.equal(definition, undefined);
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('image generation attempts have a durable per-conversation budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maomao-image-budget-'));
  try {
    const file = join(root, 'state.json');
    const now = Date.now();
    let state = await new ConnectorState(file, { clock: () => now }).load();
    const receipt = (id, chat = 'a') => ({
      receiptKey: `bot:group:${chat}:${id}`, botId: 'bot', scope: 'group',
      chatId: chat, messageId: String(id), receivedAt: now,
    });
    assert.equal(await state.reserveImage(receipt(1)), false);
    for (let id = 1; id <= 5; id += 1) {
      await state.recordReceipt(receipt(id));
      assert.equal(await state.reserveImage(receipt(id)), true);
      assert.equal(await state.reserveImage(receipt(id)), false);
    }
    state = await new ConnectorState(file, { clock: () => now }).load();
    await state.recordReceipt(receipt(6));
    await state.recordReceipt(receipt(6, 'b'));
    assert.equal(await state.reserveImage(receipt(6)), false);
    assert.equal(await state.reserveImage(receipt(6, 'b')), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
