import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createZstdDecompress } from 'node:zlib';

// The first line of a DSH session log is its header (id, cwd, agentPreset). Only that line is read.
export function readSessionHeader(file) {
  return new Promise((resolve) => {
    let text = '';
    const source = createReadStream(file);
    const stream = source.pipe(createZstdDecompress());
    const done = (value) => { source.destroy(); stream.destroy(); resolve(value); };
    stream.on('data', (chunk) => {
      text += chunk.toString('utf8');
      const line = text.indexOf('\n');
      if (line >= 0 || text.length > 8192) {
        try { done(JSON.parse(line >= 0 ? text.slice(0, line) : text)); } catch { done(null); }
      }
    });
    source.on('error', () => resolve(null));
    stream.on('error', () => resolve(null));
    stream.on('end', () => resolve(null));
  });
}

export async function* sessionHeaders(home) {
  const root = join(home, 'sessions');
  for (const dir of await readdir(root).catch(() => [])) {
    for (const name of await readdir(join(root, dir)).catch(() => [])) {
      if (!name.startsWith('session-')) continue;
      const header = await readSessionHeader(join(root, dir, name, 'session.v4.jsonl.zstd'));
      if (header?.id === name) yield header;
    }
  }
}

export async function findSessionHeader(home, sessionId) {
  const root = join(home, 'sessions');
  for (const dir of await readdir(root).catch(() => [])) {
    const file = join(root, dir, sessionId, 'session.v4.jsonl.zstd');
    if (await stat(file).then(() => true, () => false)) return readSessionHeader(file);
  }
  return null;
}
