import { chatSeesImages, chatSelection, dshVision } from './integrations/maomao-dsh/model-call.mjs';
import { chatModels } from './model-config.mjs';
const catalog = {
  vision: ['gemini-3.8-flash', 'gemini-3.8-flash-lite', 'gpt-4.1-mini'],
  image: ['gemini-3.1-flash-image', 'gemini-3.1-flash-lite-image', 'gemini-3-pro-image',
    'gpt-image-2', 'gpt-image-2.6-sunburst', 'gpt-image-2.6-flare'],
  voice: ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts'],
  embedding: ['qwen/qwen3-embedding-8b', 'baai/bge-m3', 'google/gemini-embedding-001'],
};
const voices = ['Aoede', 'Kore', 'Leda', 'Puck', 'Zephyr', 'Sulafat'];
const credentials = {
  google: ['MAOMAO_GOOGLE_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY'],
  openai: ['MAOMAO_OPENAI_API_KEY', 'OPENAI_API_KEY'],
  openrouter: ['MAOMAO_OPENROUTER_API_KEY', 'OPENROUTER_API_KEY'],
};
const sampleImage = { mediaType: 'image/png',
  data: 'iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAAAsklEQVR4nO3QQQ2EAAAEMbzwQcHpwTgS8HAydhKaVEGP9/qlnPeTcsxHBAkSJChkPiJIkCBBIYIECRIkSJAgQYIi5iOCBAkSFCJIkCBBggQJEiQoYj4iSJAgQSGCBAkSJEiQIEGCIuYjggQJEhQiSJAgQYIECRIkKGI+IkiQIEEhggQJEiRIkCBBgiLmI4IECRIUIkiQIEGCBAkSJChiPiJIkCBBIYIECRIkSJAgQV8N+gODHQjRtXZe+wAAAABJRU5ErkJggg==' };
const modelEntry = 'maomao-dsh-models';
const modelId = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const googleTts = /^gemini-.*-tts(?:-|$)/i;
const roleProviders = { image: ['google', 'openai'], vision: ['google', 'openai'],
  voice: ['google'], embedding: ['google', 'openrouter'] };
const providerFor = (role, model) => role === 'embedding' && !model.startsWith('google/') ? 'openrouter'
  : /^(?:gpt-|chatgpt-image-)/i.test(model) ? 'openai' : 'google';
const officialHosts = { google: 'generativelanguage.googleapis.com', openai: 'api.openai.com', openrouter: 'openrouter.ai' };
const mime = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
const httpOutcome = (code) => [401, 403].includes(code) ? 'credential_rejected'
  : code === 429 ? 'rate_limit' : 'test_failed';

// Vision may also run on a model configured in DSH: "chat" follows the chat model, otherwise "route::model".
const dshVisionModel = (model) => model === 'chat' || /^[\w.-]{1,64}::[^\s\x00-\x1f]{1,160}$/.test(model);
const dshRoute = (ctx, model) => model === 'chat' ? chatSelection(ctx) : { provider: model.split('::')[0], model: model.split('::').slice(1).join('::') };

function validated(role, value) {
  if (!Object.hasOwn(catalog, role) || typeof value?.model !== 'string' || typeof value.enabled !== 'boolean') return null;
  if (role === 'vision' && value.provider === 'dsh') return dshVisionModel(value.model) ? { enabled: value.enabled, model: value.model, provider: 'dsh' } : null;
  let model = value.model.trim();
  if (role !== 'embedding') model = model.replace(/^models\//, '');
  if (role === 'image' && model === 'gemini-nano-banana-2.1') model = 'gemini-3.1-flash-image';
  const inferred = providerFor(role, model);
  const provider = value.provider ?? inferred;
  if (!roleProviders[role].includes(provider)
    || (role === 'embedding' ? !catalog.embedding.includes(model) || provider !== inferred : !modelId.test(model))
    || (role === 'vision' && !(provider === 'google' ? /^gemini-/ : /^gpt-/).test(model))
    || (role === 'voice' && (!googleTts.test(model) || !voices.includes(value.voice)))) return null;
  return { enabled: value.enabled, model, ...(provider !== inferred ? { provider } : {}),
    ...(role === 'voice' ? { voice: value.voice } : {}) };
}

async function mediaCredential(ctx, provider) {
  const vault = ctx.get('credentials');
  const read = async (ref) => (await vault?.resolve?.(ref))?.value?.trim() || process.env[ref]?.trim();
  const [dedicated, ...standard] = credentials[provider];
  const override = await read(dedicated);
  if (override) return { key: override, source: 'maomao' };
  const route = ctx.get('configEditor')?.entries().find(({ options }) => options.id === 'llm-pi-ai')
    ?.options.config?.providers?.[provider];
  const endpoints = [route?.baseURL, route?.baseUrl, ...(Array.isArray(route?.models)
    ? route.models.map((model) => model?.baseURL ?? model?.baseUrl) : [])].filter(Boolean);
  for (const endpoint of endpoints) {
    try { if (new URL(endpoint).origin !== `https://${officialHosts[provider]}`) return null; }
    catch { return null; }
  }
  const configuredRef = route?.apiKeyEnv;
  for (const ref of new Set([configuredRef, ...standard])) {
    if (typeof ref !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(ref)) continue;
    const key = await read(ref);
    if (key) return { key, source: 'harness' };
  }
  const record = await vault?.readRecord?.(`llm-pi-ai/${provider}`);
  if (record?.kind === 'api-key' && record.key?.trim()) return { key: record.key.trim(), source: 'harness' };
  return null;
}
const resolveKey = async (ctx, provider) => (await mediaCredential(ctx, provider))?.key;

const groupChoices = (role) => roleProviders[role].map((provider) => ({
  provider, models: catalog[role].filter((id) => providerFor(role, id) === provider),
}));

function discoveredModel(role, provider, row) {
  const id = provider === 'google' ? row?.name?.replace?.(/^models\//, '') : row?.id;
  if (typeof id !== 'string') return null;
  if (role === 'embedding') {
    const key = provider === 'google' ? `google/${id}` : id;
    if (provider === 'google' && Array.isArray(row.supportedGenerationMethods)
      && !row.supportedGenerationMethods.includes('embedContent') && !row.supportedGenerationMethods.includes('batchEmbedContents')) return null;
    return catalog.embedding.includes(key) ? key : null;
  }
  if (!modelId.test(id)) return null;
  if (provider === 'google' && Array.isArray(row.supportedGenerationMethods)
    && !row.supportedGenerationMethods.includes('generateContent')) return null;
  if (provider === 'openai' && typeof row.shutdown_date === 'string'
    && Date.parse(row.shutdown_date) <= Date.now()) return null;
  if (role === 'image') return (provider === 'google'
    ? /^(?:gemini-.*-image(?:-|$)|nano-banana(?:-|$))/i
    : /^(?:gpt-image-|chatgpt-image-)/i).test(id) ? id : null;
  if (role === 'voice') return googleTts.test(id) ? id : null;
  if (provider === 'google') return /^gemini-\d/i.test(id)
    && !/(?:^|-)(?:image|tts|audio|live|embedding|robotics|computer-use)(?:-|$)/i.test(id) ? id : null;
  return /^gpt-(?:4o|4\.1|5|6)(?:[.-]|$)/i.test(id)
    && !/(?:audio|realtime|transcribe|search|codex|instruct|tts|pro(?:-|$))/i.test(id) ? id : null;
}

async function discoverModels(ctx, role, provider, signal) {
  const key = await resolveKey(ctx, provider);
  if (!key) return { provider, status: 'credential_missing' };
  const google = provider === 'google';
  const path = provider === 'openrouter' ? '/api/v1/embeddings/models' : google ? '/v1beta/models' : '/v1/models';
  const url = new URL(path, `https://${officialHosts[provider]}`);
  if (google) url.searchParams.set('pageSize', '100');
  const headers = google ? { 'x-goog-api-key': key } : { authorization: `Bearer ${key}` };
  const models = new Set();
  const seenTokens = new Set();
  for (let page = 0; page < 20; page += 1) {
    const response = await fetch(url, { headers, redirect: 'error', signal });
    if (!response.ok) return { provider, status: httpOutcome(response.status) };
    const payload = await response.json();
    const rows = google ? payload?.models : payload?.data;
    if (!Array.isArray(rows)) return { provider, status: 'test_failed' };
    for (const row of rows) {
      const id = discoveredModel(role, provider, row);
      if (id) models.add(id);
    }
    const token = google && payload.nextPageToken;
    if (!token) return { provider, status: 'ok', models: [...models].sort() };
    if (typeof token !== 'string' || seenTokens.has(token)) break;
    seenTokens.add(token);
    url.searchParams.set('pageToken', token);
  }
  return { provider, status: 'partial', models: [...models].sort() };
}

export function mediaRuntime(ctx, raw) {
  const saved = Object.fromEntries(Object.keys(catalog).map((role) => [role, validated(role, raw?.[role])]));
  return {
    mediaChoice: (role) => saved[role] ?? null,
    async mediaAdapter(role) {
      if (!saved[role]?.enabled) return null;
      return createAdapter(ctx, role, saved[role]);
    },
    async embedding() {
      if (!saved.embedding?.enabled) return null;
      const key = await resolveKey(ctx, providerFor('embedding', saved.embedding.model));
      return key ? { key, model: saved.embedding.model } : null;
    },
  };
}

async function createAdapter(ctx, role, choice) {
  if (role === 'vision' && choice.provider === 'dsh') return dshVision(ctx, () => dshRoute(ctx, choice.model));
  const factory = ctx.get('maomaoQqSetup')?.mediaAdapters?.[role];
  const provider = choice.provider ?? providerFor(role, choice.model);
  const key = await resolveKey(ctx, provider);
  return factory && key ? factory({ provider, model: choice.model, voice: choice.voice, key }) : null;
}

async function testEmbedding(ctx, choice, signal) {
  const provider = providerFor('embedding', choice.model);
  const key = await resolveKey(ctx, provider);
  if (!key) return { status: 'credential_missing' };
  if (provider === 'google') {
    const model = 'models/gemini-embedding-001';
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/${model}:batchEmbedContents`, {
      method: 'POST', redirect: 'error', signal,
      headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ requests: [{ model, content: { parts: [{ text: '猫猫的固定连接测试。' }] },
        taskType: 'RETRIEVAL_DOCUMENT', outputDimensionality: 1024 }] }),
    });
    if (!response.ok) return { status: httpOutcome(response.status) };
    const vector = (await response.json())?.embeddings?.[0]?.values;
    return vector?.length === 1024 && vector.every(Number.isFinite)
      ? { status: 'tested', dimensions: vector.length } : { status: 'test_failed' };
  }
  const response = await fetch('https://openrouter.ai/api/v1/embeddings', {
    method: 'POST', redirect: 'error', signal,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: choice.model, input: ['猫猫的固定连接测试。'], dimensions: 1024,
      encoding_format: 'float', provider: { only: ['DeepInfra'], data_collection: 'deny', max_price: { prompt: 0.02 } } }),
  });
  if (!response.ok) return { status: httpOutcome(response.status) };
  const result = await response.json();
  const vector = result?.data?.[0]?.embedding;
  return result?.model?.toLowerCase() === choice.model && vector?.length === 1024 && vector.every(Number.isFinite)
    ? { status: 'tested', dimensions: vector.length } : { status: 'test_failed' };
}

async function testMedia(ctx, role, choice, signal) {
  if (role === 'embedding') return testEmbedding(ctx, choice, signal);
  const adapter = await createAdapter(ctx, role, choice);
  if (!adapter) return { status: choice.provider === 'dsh' || await resolveKey(ctx, choice.provider ?? providerFor(role, choice.model)) ? 'unavailable' : 'credential_missing' };
  if (role === 'vision') {
    const text = await adapter.inspect(sampleImage, '这张测试图有哪些颜色？', signal);
    return text ? { status: 'tested', text } : { status: 'test_failed' };
  }
  if (role === 'voice') {
    const wav = await adapter.synthesize('你好，我是猫猫。祝你今天愉快喵。', signal);
    return { status: 'tested', mime: 'audio/wav', data: wav.toString('base64') };
  }
  const result = await adapter.generate('一只橘色猫咪坐在窗前看月亮，简洁的卡通插画，无文字。', { aspectRatio: '1:1', signal });
  const type = mime[result?.fileName?.split('.').at(-1)];
  return result && type ? { status: 'tested', mime: type, data: result.buffer.toString('base64') } : { status: 'test_failed' };
}

export async function manageMediaModel(ctx, request, signal = new AbortController().signal) {
  const action = request?.action;
  const editor = ctx.get('configEditor');
  const vault = ctx.get('credentials');
  if (action === 'list') {
    const entries = Object.entries(catalog).map(([role, choices]) => ({
      role, choices, groups: groupChoices(role), saved: ctx.get('maomaoModels')?.mediaChoice?.(role) ?? null,
    }));
    // Vision: offer "follow the chat model" first, then every DSH-configured model that accepts images.
    const vision = entries.find(({ role }) => role === 'vision');
    if (vision) Object.assign(vision, await dshVisionChoices(ctx, signal).catch(() => ({})));
    const credentialSources = Object.fromEntries(await Promise.all(Object.keys(credentials)
      .map(async (provider) => [provider, (await mediaCredential(ctx, provider))?.source ?? null])));
    return { entries, voices, credentialSources,
      credentials: Object.fromEntries(Object.entries(credentialSources).map(([id, source]) => [id, Boolean(source)])),
      writable: Boolean(vault) };
  }
  if (action === 'discover') {
    const { role } = request;
    if (!Object.hasOwn(roleProviders, role)) return { status: 'invalid' };
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(14_000)]);
    const groups = await Promise.all(roleProviders[role].map((provider) => discoverModels(ctx, role, provider, deadline)
      .catch(() => ({ provider, status: 'test_failed' }))));
    return { status: 'ok', groups };
  }
  if (action === 'credential') {
    const { provider, secret } = request;
    if (!vault || !Object.hasOwn(credentials, provider) || typeof secret !== 'string'
      || !/^[\x21-\x7e]{8,512}$/.test(secret)) return { status: 'invalid' };
    try {
      await vault.set(credentials[provider][0], secret);
      return { status: 'credential_saved' };
    } catch { return { status: 'save_failed' }; }
  }
  const { role } = request ?? {};
  const choice = validated(role, request?.selection);
  if (!choice || !['save', 'test'].includes(action)) return { status: 'invalid' };
  try {
    if (action === 'test') return await testMedia(ctx, role, choice, AbortSignal.any([signal, AbortSignal.timeout(90_000)]));
    if (choice.enabled && choice.provider !== 'dsh' && !await resolveKey(ctx, choice.provider ?? providerFor(role, choice.model))) return { status: 'credential_missing' };
    const entry = editor?.entries().find((row) => row.options.id === modelEntry);
    if (!entry) return { status: 'unavailable' };
    signal.throwIfAborted();
    await editor.edit(entry, (config) => ({ ...config, media: { ...config.media, [role]: choice } }));
    return { status: 'saved' };
  } catch (error) {
    const code = Number(/(?:^|_)http_(\d{3})$/.exec(error?.code ?? error?.message ?? '')?.[1]);
    return { status: action === 'test' ? httpOutcome(code) : 'save_failed' };
  }
}

async function dshVisionChoices(ctx, signal) {
  const llm = ctx.get('llm');
  const chat = chatSelection(ctx);
  const { choices = [] } = await chatModels(ctx);
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
  const seen = await Promise.all(choices.slice(0, 120).map(async (choice) => {
    const info = await llm?.resolveModelInfo?.(choice.provider, choice.model, deadline).catch(() => null);
    return info?.inputModalities?.includes('image') ? choice : null;
  }));
  const routes = seen.filter(Boolean);
  const chatName = choices.find((choice) => choice.provider === chat?.provider && choice.model === chat?.model)?.name ?? chat?.model ?? '';
  const labels = { chat: `跟随对话模型${chatName ? `（${chatName}）` : ''}`,
    ...Object.fromEntries(routes.map((choice) => [`${choice.provider}::${choice.model}`, `${choice.name} · ${choice.provider}`])) };
  return { chatVision: { name: chatName, sees: await chatSeesImages(ctx, chat, deadline) },
    labels, dshModels: ['chat', ...routes.map((choice) => `${choice.provider}::${choice.model}`)] };
}
