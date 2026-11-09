import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const worker = fileURLToPath(new URL('./memory_worker.py', import.meta.url));

export class OwnerMemory {
  #config;

  constructor(config) { this.#config = config; }

  async run(op, { owner, turnId, text = '', answer = '', details }, signal) {
    const { root, companionPath, embedding, modelSelection, quietHours, python = 'python3' } = this.#config;
    const models = ['begin', 'finish', 'index_status', 'index_rebuild'].includes(op) ? modelSelection?.() : null;
    const choice = models?.mediaChoice?.('embedding');
    const settings = choice ? await models.embedding().catch(() => null)
      : embedding ? { key: process.env.OPENROUTER_API_KEY } : null;
    signal.throwIfAborted();
    return new Promise((resolveResult, reject) => {
      const child = spawn(python, ['-u', worker], {
        stdio: ['pipe', 'pipe', 'ignore'],
        signal: AbortSignal.any([signal, AbortSignal.timeout(op === 'begin' ? 6500 : 13_000)]),
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1',
          MAOMAO_PRIVATE_ORDINARY: resolve(root),
          ...(companionPath ? { MAOMAO_COMPANION_PATH: resolve(companionPath) } : {}),
          ...(settings?.key ? { MAOMAO_PRIVATE_EMBEDDING_KEY: settings.key } : {}),
          ...(choice?.model ? { MAOMAO_PRIVATE_EMBEDDING_MODEL: choice.model } : {}),
          ...(quietHours ? { MAOMAO_PRIVATE_DND_START: String(quietHours.start), MAOMAO_PRIVATE_DND_END: String(quietHours.end) } : {}),
        },
      });
      let result = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        result += chunk;
        if (result.length > 24_000) child.kill();
      });
      child.on('error', () => reject(new Error('private_ordinary_worker_unavailable')));
      child.on('close', (code) => {
        if (code !== 0) return reject(new Error('private_ordinary_worker_failed'));
        try { resolveResult(JSON.parse(result)); }
        catch { reject(new Error('private_ordinary_response_invalid')); }
      });
      child.stdin.on('error', () => reject(new Error('private_ordinary_request_failed')));
      child.stdin.end(`${JSON.stringify({ op, owner, turnId, text: text.slice(0, 2000),
        answer: answer.slice(0, 2000), details })}\n`);
    });
  }
}
