import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKER = fileURLToPath(new URL('./ordinary_worker.py', import.meta.url));

export class OrdinaryBridge {
  #root;
  #companionPath;
  #python;
  #stickerPack;
  #embedding;
  #modelSelection;
  #child = null;
  #buffer = '';
  #pending = new Map();
  #closed = false;

  constructor({ root, companionPath, python = 'python3', stickerPack, embedding = false, modelSelection } = {}) {
    const home = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh');
    this.#root = resolve(root ?? join(home, 'integrations', 'maomao-qq', 'ordinary'));
    const source = companionPath ?? process.env.MAOMAO_COMPANION_PATH;
    this.#companionPath = source ? resolve(source) : null;
    this.#python = python;
    this.#stickerPack = stickerPack ? resolve(stickerPack) : null;
    this.#embedding = embedding;
    this.#modelSelection = modelSelection;
  }

  #fail(error) {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#buffer = '';
    this.#child = null;
  }

  #start() {
    if (this.#closed) throw new Error('ordinary_bridge_closed');
    if (this.#child) return this.#child;
    const child = spawn(this.#python, ['-u', WORKER], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: process.env.HOME ?? '',
        LANG: process.env.LANG ?? 'C.UTF-8',
        PYTHONDONTWRITEBYTECODE: '1',
        MAOMAO_ORDINARY_ROOT: this.#root,
        ...(this.#companionPath ? { MAOMAO_COMPANION_PATH: this.#companionPath } : {}),
        ...(this.#stickerPack ? { MAOMAO_STICKER_PACK: this.#stickerPack } : {}),
        ...(this.#embedding && process.env.OPENROUTER_API_KEY
          ? { MAOMAO_STICKER_EMBEDDING_KEY: process.env.OPENROUTER_API_KEY } : {}),
      },
    });
    this.#child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      this.#buffer += chunk;
      while (this.#buffer.includes('\n')) {
        const index = this.#buffer.indexOf('\n');
        const line = this.#buffer.slice(0, index);
        this.#buffer = this.#buffer.slice(index + 1);
        if (line.length > 100_000) {
          child.kill();
          this.#fail(new Error('ordinary_response_too_large'));
          return;
        }
        let response;
        try { response = JSON.parse(line); } catch { continue; }
        const pending = this.#pending.get(response.id);
        if (!pending) continue;
        this.#pending.delete(response.id);
        clearTimeout(pending.timer);
        if (response.ok === true) pending.resolve(response.result);
        else pending.reject(new Error(typeof response.error === 'string' ? response.error : 'ordinary_error'));
      }
      if (this.#buffer.length > 100_000) {
        child.kill();
        this.#fail(new Error('ordinary_response_too_large'));
      }
    });
    child.on('error', () => this.#fail(new Error('ordinary_worker_unavailable')));
    child.on('exit', () => {
      if (this.#child === child) this.#fail(new Error('ordinary_worker_exited'));
    });
    return child;
  }

  observe(envelope) {
    return this.media('observe', envelope);
  }

  async media(op, envelope, args = {}) {
    if (this.#closed) throw new Error('ordinary_bridge_closed');
    if (!envelope || envelope.channel !== 'qq' || !['group', 'c2c'].includes(envelope.scope)) {
      throw new Error('ordinary_qq_only');
    }
    const models = this.#embedding && ['remember_image', 'sticker_candidates'].includes(op) ? this.#modelSelection?.() : null;
    if (models?.mediaChoice?.('embedding')) {
      args = { ...args, embeddingOverride: await models.embedding().catch(() => null) };
    }
    if (this.#closed || this.#pending.size >= 32) throw new Error('ordinary_queue_full');
    const id = randomUUID();
    const child = this.#start();
    const safe = {
      channel: 'qq', botId: envelope.botId, scope: envelope.scope,
      chatId: envelope.chatId, senderId: envelope.senderId,
      messageId: envelope.messageId, receivedAt: envelope.receivedAt,
      text: envelope.text.slice(0, 2000),
      attachments: envelope.attachments.map(({ kind }) => ({ kind })),
    };
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        this.#fail(new Error('ordinary_timeout'));
      }, 12_000);
      this.#pending.set(id, { resolve: resolvePromise, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, op, envelope: safe, args })}\n`, (error) => {
        if (error && this.#pending.has(id)) {
          clearTimeout(timer);
          this.#pending.delete(id);
          reject(new Error('ordinary_write_failed'));
        }
      });
    });
  }

  async stop() {
    this.#closed = true;
    this.#child?.kill();
    this.#fail(new Error('ordinary_bridge_closed'));
  }
}
