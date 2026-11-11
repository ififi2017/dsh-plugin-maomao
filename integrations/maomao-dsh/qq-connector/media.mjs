const QQ_MEDIA_HOSTS = ['qq.com', 'qpic.cn', 'gtimg.cn', 'qlogo.cn', 'qqbot.cn'];
const QQ_MEDIA_EXACT_HOSTS = new Set(['multimedia.nt.qq.com.cn']);
const MAX_IMAGE_BYTES = 5_000_000;
const mediaError = (code, message = 'QQ image download failed') => Object.assign(new Error(message), { code });

export function qqMediaUrl(value) {
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    if (!QQ_MEDIA_EXACT_HOSTS.has(host)
      && !QQ_MEDIA_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return null;
    return url.href;
  } catch { return null; }
}

export function imageMediaType(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return 'image/jpeg';
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

const RETRYABLE = new Set(['network', 'timeout', 'http']);
const failureCode = (error) => error?.code && typeof error.code === 'string' && !error.code.startsWith('ERR_') && !error.code.startsWith('UND_')
  ? error.code : error?.name === 'TimeoutError' ? 'timeout' : 'network';

// QQ media links are sometimes slow or briefly unavailable; one retry turns most of
// those into a picture the cat can actually see.
export async function loadQqImage(attachment, { getToken, fetchImpl = fetch, signal, retryDelayMs = 800 } = {}) {
  if (attachment?.kind !== 'image') return null;
  const url = qqMediaUrl(attachment.sourceUrl ?? '');
  if (!url) return null;
  const token = typeof getToken === 'function' ? await getToken() : '';
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchQqImage(url, attachment, { token, fetchImpl, signal });
    } catch (error) {
      const code = failureCode(error);
      if (attempt > 0 || signal?.aborted || !RETRYABLE.has(code)) throw Object.assign(error, { code });
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}

async function fetchQqImage(url, attachment, { token, fetchImpl, signal }) {
  const timeout = AbortSignal.timeout(15_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const headers = token ? { Authorization: `QQBot ${token}` } : {};
  let response = await fetchImpl(url, { method: 'GET', redirect: 'manual', signal: combined, headers });
  // Follow one redirect, and only to another QQ media host.
  if (response.status >= 300 && response.status < 400) {
    const next = qqMediaUrl(new URL(response.headers.get('location') ?? '', url).href);
    await response.body?.cancel().catch(() => undefined);
    if (!next) throw mediaError('unsafe_source');
    response = await fetchImpl(next, { method: 'GET', redirect: 'error', signal: combined, headers });
  }
  if (!response.ok) throw mediaError(response.status >= 500 ? 'http' : response.status === 404 || response.status === 410 ? 'missing'
    : response.status === 401 || response.status === 403 ? 'permission'
      : response.status === 429 ? 'rate_limit' : 'client_error');
  if (!response.body) throw mediaError('empty');
  const declared = Number(response.headers.get('content-length'));
  if (declared > MAX_IMAGE_BYTES) {
    await response.body.cancel().catch(() => undefined);
    throw mediaError('size', 'QQ image exceeds size limit');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_IMAGE_BYTES) throw mediaError('size', 'QQ image exceeds size limit');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const data = Buffer.concat(chunks, total);
  const mediaType = imageMediaType(data);
  if (!mediaType) throw mediaError(total ? 'format' : 'empty', 'QQ image format is unsupported');
  return { type: 'image', mediaType, data: data.toString('base64'), name: attachment.name || 'qq-image' };
}
