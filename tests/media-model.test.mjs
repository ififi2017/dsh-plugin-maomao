import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';
import { manageMediaModel, mediaRuntime } from '../model-media.mjs';

test('media settings keep secrets and model choices scoped, and use a valid image for the model test', async () => {
  const secrets = new Map();
  const row = { options: { id: 'maomao-dsh-models', config: { chat: { inherit: true } } } };
  const services = {
    credentials: {
      async set(ref, value) { secrets.set(ref, value); },
      async resolve(ref) { return { value: secrets.get(ref) }; },
    },
    configEditor: { entries: () => [row], async edit(entry, write) { entry.options.config = write(entry.options.config); } },
    maomaoQqSetup: { mediaAdapters: {
      vision(options) {
        assert.equal(options.model, 'gemini-3.8-flash-lite');
        assert.equal(options.key, 'synthetic-api-key');
        return { async inspect(image) {
          const png = Buffer.from(image.data, 'base64');
          assert.equal(png.toString('ascii', 1, 4), 'PNG');
          const width = png.readUInt32BE(16);
          const height = png.readUInt32BE(20);
          assert.equal(inflateSync(png.subarray(41, 41 + png.readUInt32BE(33))).length, height * (1 + width * 3));
          return '红色和蓝色';
        } };
      },
    } },
  };
  const ctx = { get: (key) => services[key] };
  assert.equal((await manageMediaModel(ctx, { action: 'credential', provider: 'google', secret: 'synthetic-api-key' })).status, 'credential_saved');
  const selection = { enabled: true, model: 'gemini-3.8-flash-lite' };
  assert.deepEqual(await manageMediaModel(ctx, { action: 'test', role: 'vision', selection }),
    { status: 'tested', text: '红色和蓝色' });
  assert.equal((await manageMediaModel(ctx, { action: 'save', role: 'vision', selection })).status, 'saved');
  services.maomaoModels = mediaRuntime(ctx, row.options.config.media);
  assert.deepEqual(services.maomaoModels.mediaChoice('vision'), selection);
  assert.deepEqual(row.options.config.chat, { inherit: true });
  assert.doesNotMatch(JSON.stringify(await manageMediaModel(ctx, { action: 'list' })), /synthetic-api-key/);
  assert.equal((await manageMediaModel(ctx, { action: 'test', role: 'voice',
    selection: { enabled: true, model: 'gemini-3.8-flash-lite', voice: 'Aoede' } })).status, 'invalid');
});

test('embedding test sends only a fixed sample and reports provider credential rejection', async (t) => {
  const ctx = { get: (key) => key === 'credentials' ? { async resolve() { return { value: 'synthetic-key' }; } } : undefined };
  const selection = { enabled: true, model: 'baai/bge-m3' };
  const request = { action: 'test', role: 'embedding', selection };
  const fetch = t.mock.method(globalThis, 'fetch', async (url, args) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/embeddings');
    const body = JSON.parse(args.body);
    assert.equal(body.model, selection.model);
    assert.deepEqual(body.provider.only, ['DeepInfra']);
    assert.equal(body.provider.data_collection, 'deny');
    assert.deepEqual(body.input, ['猫猫的固定连接测试。']);
    return Response.json({ model: selection.model, data: [{ embedding: Array(1024).fill(0.25) }] });
  });
  assert.deepEqual(await manageMediaModel(ctx, request), { status: 'tested', dimensions: 1024 });
  fetch.mock.mockImplementation(async () => new Response('', { status: 401 }));
  assert.deepEqual(await manageMediaModel(ctx, request), { status: 'credential_rejected' });
});

test('media uses Harness API credentials for their own provider and refuses proxy credentials', async () => {
  const route = { options: { id: 'llm-pi-ai', config: { providers: {
    openai: { apiKeyEnv: 'DSH_TEST_OPENAI' }, google: {},
  } } } };
  const services = {
    configEditor: { entries: () => [route] },
    credentials: {
      async resolve(ref) { return ref === 'DSH_TEST_OPENAI' ? { value: 'synthetic-openai-key' } : undefined; },
      async readRecord(id) { return id === 'llm-pi-ai/google' ? { kind: 'api-key', key: 'synthetic-google-key' } : undefined; },
    },
    maomaoQqSetup: { mediaAdapters: { vision: (options) => options, image: (options) => options } },
  };
  const ctx = { get: (key) => services[key] };
  const media = mediaRuntime(ctx, {
    vision: { enabled: true, model: 'gpt-4.1-mini' },
    image: { enabled: true, model: 'gemini-nano-banana-2.1' },
  });
  assert.equal((await media.mediaAdapter('vision')).key, 'synthetic-openai-key');
  assert.equal((await media.mediaAdapter('image')).key, 'synthetic-google-key');
  assert.equal(media.mediaChoice('image').model, 'gemini-3.1-flash-image');
  const catalog = await manageMediaModel(ctx, { action: 'list' });
  assert.equal(catalog.credentialSources.openai, 'harness');
  assert.doesNotMatch(JSON.stringify(catalog), /synthetic-(openai|google)-key/);
  route.options.config.providers.openai.baseURL = 'https://proxy.invalid/v1';
  assert.equal(await media.mediaAdapter('vision'), null);
});

test('model discovery filters each provider by capability and keeps embedding choices compatible', async (t) => {
  const ctx = { get: (key) => key === 'credentials' ? {
    async resolve(ref) {
      if (ref === 'MAOMAO_GOOGLE_API_KEY') return { value: 'synthetic-google-key' };
      if (ref === 'MAOMAO_OPENAI_API_KEY') return { value: 'synthetic-openai-key' };
      if (ref === 'MAOMAO_OPENROUTER_API_KEY') return { value: 'synthetic-openrouter-key' };
    },
  } : undefined };
  const google = (id, method = 'generateContent') => ({ name: `models/${id}`, supportedGenerationMethods: [method] });
  const fetch = t.mock.method(globalThis, 'fetch', async (url, { headers }) => {
    if (url.hostname === 'generativelanguage.googleapis.com') {
      assert.equal(headers['x-goog-api-key'], 'synthetic-google-key');
      if (url.searchParams.get('pageToken') === 'second') return Response.json({ models: [
        google('gemini-3.1-flash-image'), google('gemini-3.1-flash-tts-preview'),
        google('gemini-embedding-001', 'embedContent'), google('gemini-embedding-2', 'embedContent'),
      ] });
      return Response.json({ models: [google('gemini-3.8-flash'), google('gemini-3-pro-image')],
        nextPageToken: 'second' });
    }
    if (url.hostname === 'openrouter.ai') {
      assert.equal(url.pathname, '/api/v1/embeddings/models');
      assert.equal(headers.authorization, 'Bearer synthetic-openrouter-key');
      return Response.json({ data: [{ id: 'baai/bge-m3' }, { id: 'openai/text-embedding-3-small' }] });
    }
    assert.equal(url.href, 'https://api.openai.com/v1/models');
    assert.equal(headers.authorization, 'Bearer synthetic-openai-key');
    return Response.json({ data: [{ id: 'gpt-image-2' }, { id: 'gpt-image-1', shutdown_date: '2000-01-01' },
      { id: 'gpt-4.1-mini' }, { id: 'gpt-4o-audio-preview' }] });
  });
  for (const [role, expected] of Object.entries({
    image: { google: ['gemini-3-pro-image', 'gemini-3.1-flash-image'], openai: ['gpt-image-2'] },
    vision: { google: ['gemini-3.8-flash'], openai: ['gpt-4.1-mini'] },
    voice: { google: ['gemini-3.1-flash-tts-preview'] },
    embedding: { google: ['google/gemini-embedding-001'], openrouter: ['baai/bge-m3'] },
  })) {
    assert.deepEqual(await manageMediaModel(ctx, { action: 'discover', role }), { status: 'ok',
      groups: Object.entries(expected).map(([provider, models]) => ({ provider, models, status: 'ok' })) });
  }
  fetch.mock.mockImplementation(async (url) => new Response('', { status: url.hostname === 'api.openai.com' ? 401 : 429 }));
  assert.deepEqual((await manageMediaModel(ctx, { action: 'discover', role: 'image' })).groups, [
    { provider: 'google', status: 'rate_limit' }, { provider: 'openai', status: 'credential_rejected' },
  ]);
});

test('manual model IDs use the selected provider and reject URLs', async () => {
  const row = { options: { id: 'maomao-dsh-models', config: {} } };
  const services = {
    credentials: { async resolve() { return { value: 'synthetic-key' }; } },
    configEditor: { entries: () => [row], async edit(entry, write) { entry.options.config = write(entry.options.config); } },
    maomaoQqSetup: { mediaAdapters: { image: ({ provider, model }) => ({ provider, model }) } },
  };
  const ctx = { get: (key) => services[key] };
  const selection = { enabled: true, provider: 'openai', model: 'custom-image-preview' };
  assert.deepEqual(await manageMediaModel(ctx, { action: 'save', role: 'image', selection }), { status: 'saved' });
  assert.deepEqual(await mediaRuntime(ctx, row.options.config.media).mediaAdapter('image'),
    { provider: 'openai', model: 'custom-image-preview' });
  assert.deepEqual(await manageMediaModel(ctx, { action: 'save', role: 'image',
    selection: { ...selection, model: 'https://unknown.invalid' } }), { status: 'invalid' });
});
