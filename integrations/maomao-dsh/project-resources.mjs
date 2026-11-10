import { get } from 'node:https';
import { browserUrl, publicAddress, browserLookup, browserError } from './browser-network.mjs';
import { imageMediaType } from './qq-connector/media.mjs';

// No ambient GitHub/DSH credentials or browser cookies. Every redirect resolves
// again, and the HTTPS connection uses exactly the checked public IP.
export async function publicResource(url, { signal, maxBytes, accept, resolve = browserLookup, request = get } = {}, redirects = 0) {
  if (!browserUrl(url) || redirects > 4) throw browserError('BROWSER_BLOCKED');
  signal?.throwIfAborted();
  const target = new URL(url);
  const address = await publicAddress(target.hostname, resolve);
  signal?.throwIfAborted();
  const response = await new Promise((yes, no) => {
    const req = request(target, { signal, headers: { accept, 'user-agent': 'maomao-dsh-public-resources', 'accept-encoding': 'identity' },
      lookup: (_host, options, done) => done(null, options.all ? [address] : address.address, address.family),
    }, res => {
      res.on('error', no);
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.destroy(); yes({ redirect: res.headers.location }); return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.destroy(); no(browserError([401, 403, 404].includes(res.statusCode) ? 'RESOURCE_INACCESSIBLE' : 'RESOURCE_HTTP_ERROR')); return;
      }
      if (Number(res.headers['content-length']) > maxBytes || !['identity', undefined].includes(res.headers['content-encoding'])) {
        res.destroy(); no(browserError('RESOURCE_TOO_LARGE')); return;
      }
      const chunks = []; let bytes = 0;
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) { res.destroy(); no(browserError('RESOURCE_TOO_LARGE')); }
        else chunks.push(chunk);
      });
      res.on('end', () => yes({ url: target.href, buffer: Buffer.concat(chunks), mediaType: res.headers['content-type']?.split(';')[0] }));
    });
    req.on('error', no);
  });
  if (Object.hasOwn(response, 'redirect')) {
    if (!response.redirect) throw browserError('RESOURCE_HTTP_ERROR');
    return publicResource(new URL(response.redirect, target).href, { signal, maxBytes, accept, resolve, request }, redirects + 1);
  }
  return response;
}

export async function loadPublicImage(url, { signal, read = publicResource } = {}) {
  const value = await read(url, { signal, maxBytes: 5_000_000, accept: 'image/png,image/jpeg,image/webp' });
  const mediaType = imageMediaType(value.buffer);
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mediaType) || value.buffer.length > 5_000_000
    || (value.mediaType?.startsWith('image/') && value.mediaType !== mediaType)) throw browserError('RESOURCE_NOT_IMAGE');
  return { url: value.url, mediaType, bytes: value.buffer.length, data: value.buffer.toString('base64') };
}

export function projectRequest(args) {
  try {
    const u = new URL(args.repository);
    // The API URL is rebuilt from owner/repo/ref/path, so a pasted #L10 or ?plain=1 is simply ignored.
    if (u.origin !== 'https://github.com' || u.username || u.password) return null;
    // People paste tree/blob links and clone URLs; read them as root + ref + path.
    // A branch name with slashes is ambiguous in these links, so pass ref and path explicitly for those.
    const match = /^\/([a-z0-9_.-]+?)\/([a-z0-9_.-]+?)(?:\.git)?(?:\/(?:(?:tree|blob)\/([^/]+)(?:\/(.*?))?)?)?\/?$/i.exec(u.pathname);
    let linkPath = '';
    try { linkPath = match?.[4] ? decodeURIComponent(match[4]) : ''; } catch { return null; }
    const path = args.path || linkPath, ref = args.ref || (match?.[3] ? decodeURIComponent(match[3]) : ''), offset = args.offset ?? 0;
    if (!match || typeof path !== 'string' || path.length > 1000 || path.startsWith('/') || path.includes('\\')
      || /[\x00-\x1f]/.test(path) || path.split('/').some(p => ['.', '..'].includes(p))
      || typeof ref !== 'string' || ref.length > 200 || /[\x00-\x1f]/.test(ref)
      || !Number.isSafeInteger(offset) || offset < 0 || offset > 250000) return null;
    const repository = `https://github.com/${match[1]}/${match[2]}`;
    return { repository, path, ref, offset,
      api: `https://api.github.com/repos/${match[1]}/${match[2]}/contents/${path.split('/').map(encodeURIComponent).join('/')}${ref ? '?ref=' + encodeURIComponent(ref) : ''}` };
  } catch { return null; }
}

export async function readPublicProject(args, { signal, read = publicResource } = {}) {
  const input = projectRequest(args);
  if (!input) throw browserError('BROWSER_BLOCKED');
  const value = await read(input.api, { signal, maxBytes: 2_000_000, accept: 'application/vnd.github+json' });
  const data = JSON.parse(value.buffer.toString('utf8'));
  const file = row => ({ name: row.name, path: row.path, type: row.type, bytes: row.size, sha: row.sha,
    url: browserUrl(row.html_url) || undefined,
    image_url: /\.(png|jpe?g|webp)$/i.test(row.name) && browserUrl(row.download_url) || undefined });
  if (Array.isArray(data)) return { ...input, api: undefined, kind: 'directory',
    entries: data.slice(input.offset, input.offset + 80).map(file),
    next_offset: data.length > input.offset + 80 ? input.offset + 80 : null };
  const info = { ...input, api: undefined, ...file(data) };
  if (data.type !== 'file') return { ...info, kind: 'unsupported', note: 'Symlinks and submodules are not followed.' };
  if (info.image_url) return { ...info, kind: 'image', note: 'Use maomao_reference_image to view and obtain a generation reference_id.' };
  if (!(/\.(md|mdx|txt|json|ya?ml|toml|html?|csv|prompt)$/i.test(data.name) || /^(?:README|LICENSE|NOTICE|AUTHORS|CHANGELOG|CONTRIBUTING)$/i.test(data.name))
    || data.size > 250000 || data.encoding !== 'base64')
    return { ...info, kind: 'unsupported', note: 'Read small text documentation and prompts; no code execution or archive downloads.' };
  const content = Buffer.from(data.content, 'base64').toString('utf8');
  const end = input.offset + 12000;
  return { ...info, kind: 'text', content: content.slice(input.offset, end),
    next_offset: content.length > end ? end : null,
    ...pageResources(content, data.download_url) };
}

// Preserve useful resources before stripping page markup. Resolve relative
// Markdown/HTML URLs against the fetched document, never the local filesystem.
export function pageResources(content, base) {
  const links = [], images = [];
  const clean = value => value.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'");
  const add = (list, url, label = '') => {
    try {
      const resolved = new URL(clean(url), base).href;
      if (browserUrl(resolved) && !list.some(row => row.url === resolved) && list.length < 30)
        list.push({ url: resolved, label: clean(label).slice(0, 180) });
    } catch { /* Invalid external links are omitted. */ }
  };
  const body = content.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  for (const m of body.matchAll(/(!?)\[([^\]\n]*)\]\(<?([^\s)>]+)>?(?:\s+"[^"]*")?\)/g)) add(m[1] ? images : links, m[3], m[2]);
  for (const m of body.matchAll(/<(img|a)\b[^>]*>/gi)) {
    const tag = m[0], isImage = m[1].toLowerCase() === 'img';
    const attr = name => new RegExp('\\b' + name + '\\s*=\\s*["\']([^"\']+)["\']', 'i').exec(tag)?.[1];
    if (attr(isImage ? 'src' : 'href')) add(isImage ? images : links, attr(isImage ? 'src' : 'href'), attr('alt'));
  }
  return { links, images };
}
