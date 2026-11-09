import { imageMediaType } from './media.mjs';

const IMAGE_TYPES = new Map([['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/webp', 'webp']]);
const MAX_IMAGE = 5_000_000;
const BASE64_LIMIT = Math.ceil(MAX_IMAGE / 3) * 4;
function imageResult(data) {
  if (typeof data !== 'string' || !data || data.length > BASE64_LIMIT || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
  const buffer = Buffer.from(data, 'base64');
  const extension = IMAGE_TYPES.get(imageMediaType(buffer));
  return extension && buffer.length <= MAX_IMAGE ? { buffer, fileName: `maomao-image.${extension}` } : null;
}

export class GeminiImageGeneration {
  #key;
  #fetch;
  #model;

  constructor({ key, model = 'gemini-3.1-flash-image', fetchImpl = fetch }) {
    if (!key) throw new Error('qq_image_generation_key_unavailable');
    this.#key = key;
    this.#fetch = fetchImpl;
    this.#model = model;
  }

  async generate(prompt, { reference, aspectRatio, signal }) {
    const input = [{ type: 'text', text: prompt }];
    if (reference && IMAGE_TYPES.has(reference.mediaType) && reference.data.length <= BASE64_LIMIT) {
      input.push({ type: 'image', mime_type: reference.mediaType, data: reference.data });
    }
    const interactions = this.#model === 'gemini-3.1-flash-image';
    const response = await this.#fetch(interactions
      ? 'https://generativelanguage.googleapis.com/v1beta/interactions'
      : `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.#model)}:generateContent`, {
      method: 'POST', redirect: 'error',
      headers: { 'x-goog-api-key': this.#key, 'content-type': 'application/json' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(80_000)]),
      body: JSON.stringify(interactions ? { model: this.#model, input,
        response_format: { type: 'image', aspect_ratio: aspectRatio, image_size: '1K' } } : {
        contents: [{ role: 'user', parts: input.map((part) => part.type === 'image'
          ? { inlineData: { mimeType: part.mime_type, data: part.data } } : { text: part.text }) }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio } },
      }),
    });
    if (!response.ok) {
      const code = `qq_image_generation_http_${response.status}`;
      throw Object.assign(new Error(code), { code });
    }
    const result = await response.json();
    if (!interactions) return imageResult(result?.candidates?.[0]?.content?.parts
      ?.findLast((part) => IMAGE_TYPES.has(part.inlineData?.mimeType))?.inlineData.data);
    const items = [...(result.steps ?? []).filter((step) => step.type === 'model_output')
      .flatMap((step) => step.content ?? []), ...(result.outputs ?? [])];
    const data = items.findLast((item) => ['image', 'output_image'].includes(item.type)
      && typeof item.data === 'string')?.data;
    return imageResult(data);
  }
}

const IMAGE_SIZES = { '1:1': '1024x1024', '2:3': '1024x1536', '3:2': '1536x1024', '9:16': '864x1536', '16:9': '1536x864' };

export class OpenAiImageGeneration {
  #key;
  #model;
  #fetch;

  constructor({ key, model, fetchImpl = fetch }) {
    if (!key || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(model ?? '')) {
      throw new Error('qq_image_generation_key_or_model_unavailable');
    }
    this.#key = key;
    this.#model = model;
    this.#fetch = fetchImpl;
  }

  async generate(prompt, { reference, aspectRatio, signal }) {
    const ratio = this.#model.startsWith('gpt-image-1') ? ({ '16:9': '3:2', '9:16': '2:3' }[aspectRatio] ?? aspectRatio) : aspectRatio;
    const params = { model: this.#model, prompt, size: IMAGE_SIZES[ratio] ?? IMAGE_SIZES['1:1'],
      quality: 'medium', output_format: 'jpeg' };
    const headers = { authorization: `Bearer ${this.#key}` };
    let endpoint = 'generations';
    let body;
    if (reference) {
      const extension = IMAGE_TYPES.get(reference.mediaType);
      if (!extension || typeof reference.data !== 'string' || reference.data.length > BASE64_LIMIT) return null;
      endpoint = 'edits';
      body = new FormData();
      for (const [name, value] of Object.entries(params)) body.set(name, value);
      body.set('image[]', new Blob([Buffer.from(reference.data, 'base64')], { type: reference.mediaType }), `reference.${extension}`);
    } else {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(params);
    }
    const response = await this.#fetch(`https://api.openai.com/v1/images/${endpoint}`, {
      method: 'POST', redirect: 'error', headers, body,
      signal: AbortSignal.any([signal, AbortSignal.timeout(80_000)]),
    });
    if (!response.ok) {
      const code = `qq_image_generation_http_${response.status}`;
      throw Object.assign(new Error(code), { code });
    }
    return imageResult((await response.json())?.data?.[0]?.b64_json);
  }
}
