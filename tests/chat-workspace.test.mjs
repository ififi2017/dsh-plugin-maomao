import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { zstdCompressSync } from 'node:zlib';
import { CHAT_WORKSPACE_TITLE, chatWorkspace } from '../integrations/maomao-dsh/chat-workspace.mjs';

test('chat sessions get their own named DSH project and are attached to it, and a session from the old folder is replaced', async () => {
  const home = await mkdtemp(join(tmpdir(), 'maomao-chat-home-'));
  const session = async (id, cwd, agentPreset = 'maomao-qq-ordinary') => {
    await mkdir(join(home, 'sessions', 'any', id), { recursive: true });
    await writeFile(join(home, 'sessions', 'any', id, 'session.v4.jsonl.zstd'),
      zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'session', id, cwd, agentPreset })}\n`)));
  };
  try {
    const created = [];
    const attached = [];
    const archived = [];
    const workspace = chatWorkspace({ get: (name) => name === 'workspaceRegistry'
      ? { async create(dir, title) { created.push([dir, title]); return { async attachSession(id) { attached.push(id); } }; },
        async archiveSession(id) { archived.push(id); } } : undefined }, { home });
    const dir = await workspace.folder();
    assert.equal(dir, join(home, 'integrations', 'maomao-chats'));
    assert.ok((await stat(dir)).isDirectory());
    assert.deepEqual(created, [[dir, CHAT_WORKSPACE_TITLE]]);
    await session('session-old', join(home, 'profiles', 'desktop'));
    await session('session-new', dir);
    assert.equal(await workspace.holds('session-old'), false);
    assert.equal(await workspace.holds('session-new'), true);
    // The DSH project lists only attached sessions: those already in the folder are attached, the old one is not.
    assert.equal(await workspace.attachExisting(), 1);
    assert.deepEqual(attached, ['session-new']);
    await session('session-desk', join(home, 'profiles', 'desktop'), 'standard');
    assert.equal(await workspace.archiveOutside(), 1);
    assert.deepEqual(archived, ['session-old']);
    assert.equal(await chatWorkspace({}, { home }).folder(), undefined);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
