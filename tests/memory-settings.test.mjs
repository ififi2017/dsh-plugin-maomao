import assert from 'node:assert/strict';
import { test } from 'node:test';
import { manageMemorySettings } from '../memory-settings.mjs';

test('memory settings only allow a verified private target and require explicit approval for live delivery', async () => {
  const target = 'a'.repeat(64);
  const destination = { platform: 'telegram', accountId: '42', chatId: 'private-route', senderId: 'sender' };
  const privateEntry = { options: { id: 'maomao-dsh-private', config: {
    telegram: { enabled: true, accountId: '42' }, memory: { enabled: true, embedding: false },
  } } };
  const qqEntry = { options: { id: 'maomao-dsh-qq', config: { ordinary: { enabled: false }, stickers: { enabled: true } } } };
  const services = {
    configEditor: { entries: () => [privateEntry, qqEntry], async edit(entry, write) { entry.options.config = write(entry.options.config); } },
    maomaoPrivate: { shareTarget: (id) => id === target ? destination : null,
      shareTargets: () => [{ id: target, platform: 'telegram', owner: 1 }] },
  };
  const ctx = { get: (key) => services[key] };
  const update = (section, value) => manageMemorySettings(ctx, { action: 'save', section, value });
  const config = { mode: 'send', target, browse: true, lonely: false, quietStart: 22, quietEnd: 8 };
  assert.deepEqual(await update('sharing', config), { status: 'invalid' });
  assert.deepEqual(await update('sharing', { ...config, mode: 'shadow', target: 'b'.repeat(64) }), { status: 'destination_missing' });
  assert.deepEqual(await update('sharing', { ...config, mode: 'shadow' }), { status: 'saved' });
  assert.deepEqual(privateEntry.options.config.sharing.destination, destination);
  assert.equal(privateEntry.options.config.sharing.schedule.mode, 'shadow');
  assert.deepEqual(privateEntry.options.config.sharing.quietHours, { start: 22, end: 8 });
  assert.deepEqual(await update('privateMemory', { enabled: true, shared: false }), { status: 'saved' });
  assert.deepEqual(privateEntry.options.config.memory, { enabled: true, embedding: false, shared: false });
  assert.deepEqual(await update('qqMemory', { enabled: true, stickerEmbedding: true }), { status: 'saved' });
  assert.deepEqual(qqEntry.options.config.stickers, { enabled: true, embedding: true });
  assert.doesNotMatch(JSON.stringify(await manageMemorySettings(ctx, { action: 'list' })), /private-route/);
});
