// Text embeddings for 猫猫's learned memories, on the model chosen in the panel (向量检索).
// Same providers and 1024 dimensions as the Python client in maomao-companion/embeddings.py.
export const EMBEDDING_DIMENSIONS = 1024;

const normalized = (vector) => {
  if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSIONS || !vector.every(Number.isFinite)) throw new Error('embedding_invalid_vector');
  const norm = Math.hypot(...vector);
  if (!(norm > 1e-12)) throw new Error('embedding_empty_vector');
  return vector.map((x) => x / norm);
};

const post = async (url, headers, body, signal) => {
  const response = await fetch(url, { method: 'POST', redirect: 'error', signal,
    headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  // Provider errors may echo submitted text; expose only the status.
  if (!response.ok) throw new Error(`embedding_http_${response.status}`);
  return response.json();
};

const ordered = (rows, count) => {
  if (!Array.isArray(rows) || rows.length !== count) throw new Error('embedding_count_mismatch');
  return [...rows].sort((a, b) => a.index - b.index).map((row) => normalized(row.embedding));
};

export async function embedTexts({ model, key }, texts, { query = false, signal } = {}) {
  if (typeof model !== 'string' || typeof key !== 'string' || !key) throw new Error('embedding_unavailable');
  if (!Array.isArray(texts) || !texts.length || texts.length > 16 || texts.some((t) => typeof t !== 'string' || !t.trim())) throw new Error('embedding_input_invalid');
  const inputs = texts.map((t) => t.slice(0, 1500));
  if (model.startsWith('google/')) {
    const name = `models/${model.slice('google/'.length)}`;
    const result = await post(`https://generativelanguage.googleapis.com/v1beta/${name}:batchEmbedContents`, { 'x-goog-api-key': key },
      { requests: inputs.map((text) => ({ model: name, content: { parts: [{ text }] },
        taskType: query ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT', outputDimensionality: EMBEDDING_DIMENSIONS })) }, signal);
    const rows = result?.embeddings;
    if (!Array.isArray(rows) || rows.length !== texts.length) throw new Error('embedding_count_mismatch');
    return rows.map((row) => normalized(row.values));
  }
  if (model.startsWith('openai/')) {
    const result = await post('https://api.openai.com/v1/embeddings', { authorization: `Bearer ${key}` },
      { model: model.slice('openai/'.length), input: inputs, dimensions: EMBEDDING_DIMENSIONS, encoding_format: 'float' }, signal);
    return ordered(result?.data, texts.length);
  }
  const instructed = query && model.startsWith('qwen/')
    ? inputs.map((t) => `Instruct: Retrieve relevant memories, diary entries and notes for this chat message.\nQuery: ${t}`) : inputs;
  const result = await post('https://openrouter.ai/api/v1/embeddings', { authorization: `Bearer ${key}` },
    { model, input: instructed, dimensions: EMBEDDING_DIMENSIONS, encoding_format: 'float',
      provider: { only: ['DeepInfra'], data_collection: 'deny', max_price: { prompt: 0.02 } } }, signal);
  if (String(result?.model ?? '').toLowerCase() !== model.toLowerCase()) throw new Error('embedding_model_mismatch');
  return ordered(result?.data, texts.length);
}

export const cosine = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);
