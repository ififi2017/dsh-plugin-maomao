import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import { test } from 'node:test';
import { ChannelSetup } from '../channel-setup.mjs';

function fixture(providers = {}) {
  const entry = { options: { id: 'maomao-dsh-private', config: { telegram: { enabled: false },
    feishu: { enabled: false }, memory: { enabled: true }, bindings: [] } } };
  const entries = [entry, { options: { id: 'maomao-dsh-qq', config: {
    enabled: false, groupAllowlist: ['old-group'], dmAllowlist: [], shadow: { ownerIds: ['old-owner'] },
  } } }];
  const secrets = new Map();
  const editor = {
    entries: () => entries,
    async edit(row, change) { row.options.config = change(row.options.config); },
  };
  const services = { configEditor: editor,
    credentials: {
      async set(name, value) { secrets.set(name, value); },
      async unset(name) { secrets.delete(name); },
      async resolve(name) { return { value: secrets.get(name) }; },
    },
    maomaoPrivateSetup: { async verifyTelegram() {}, async verifyFeishu() {}, ...providers.private },
    maomaoQqSetup: { async verifyQQ() {}, ...providers.qq },
  };
  const setup = new ChannelSetup({ get: (key) => services[key] });
  return { setup, entry, qq: entries[1], secrets, editor };
}

async function readUntil(setup, platform, id, predicate) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const value = await setup.request({ platform, action: 'read', id });
    if (predicate(value)) return value;
    await pause(10);
  }
  assert.fail('onboarding did not reach the expected state');
}

const completed = (result) => ['connected', 'disconnected', 'verified', 'failed', 'cancelled'].includes(result.state);

test('Telegram import stores only a credential reference in profile and supports disabling and enabling', async () => {
  const verified = [];
  const { setup, entry, secrets, editor } = fixture({ private: { async verifyTelegram({ token }) { verified.push(token); } } });
  const credential = '12345:synthetic_credential';
  assert.equal((await setup.request({ platform: 'telegram', action: 'start', secret: credential })).reason, 'confirm_exclusive');
  const connected = await setup.request({ platform: 'telegram', action: 'start', exclusive: true, secret: credential });
  assert.equal((await readUntil(setup, 'telegram', connected.id, completed)).state, 'connected');
  const saved = entry.options.config.telegram;
  assert.equal(saved.enabled, true);
  assert.equal(saved.accountId, '12345');
  assert.equal(secrets.get(saved.credentialRef), credential);
  assert.doesNotMatch(JSON.stringify(entry.options.config), /synthetic_credential/);
  assert.doesNotMatch(JSON.stringify(setup.status()), /synthetic_credential|12345/);
  assert.equal(entry.options.config.memory.enabled, true);

  const edit = editor.edit;
  editor.edit = async () => { throw new Error('synthetic editor failure'); };
  const check = await setup.request({ platform: 'telegram', action: 'test' });
  assert.equal((await readUntil(setup, 'telegram', check.id, completed)).state, 'verified');
  assert.deepEqual(entry.options.config.telegram, saved);
  const update = await setup.request({ platform: 'telegram', action: 'start', exclusive: true,
    secret: '54321:replacement_credential' });
  assert.equal((await readUntil(setup, 'telegram', update.id, completed)).reason, 'configuration_rejected');
  assert.equal(secrets.size, 1);
  assert.deepEqual(entry.options.config.telegram, saved);
  editor.edit = edit;

  const stopped = await setup.request({ platform: 'telegram', action: 'disable' });
  assert.equal((await readUntil(setup, 'telegram', stopped.id, completed)).state, 'disconnected');
  assert.equal(entry.options.config.enabled, false);
  const resumed = await setup.request({ platform: 'telegram', action: 'enable', exclusive: true });
  assert.equal((await readUntil(setup, 'telegram', resumed.id, completed)).state, 'connected');
  assert.equal(entry.options.config.telegram.credentialRef, saved.credentialRef);
  assert.equal(verified.at(-1), credential);
});

test('QQ scan renders the platform QR in the host and grants no previous bot routes', async () => {
  let finishScan;
  const { setup, qq, secrets } = fixture({ qq: {
    provisionQQ({ onQr }) {
      onQr({ url: 'https://q.qq.com/qqbot/openclaw/connect.html?synthetic=1' });
      return new Promise((resolve) => { finishScan = resolve; });
    },
  } });
  const start = await setup.request({ platform: 'qq', action: 'start', mode: 'scan', exclusive: true });
  const scan = await readUntil(setup, 'qq', start.id, (value) => Boolean(value.qr));
  assert.match(scan.qr.image, /^data:image\/png;base64,/);
  assert.match(scan.qr.url, /^https:\/\/q\.qq\.com\//);
  finishScan({ appId: '1001', secret: 'synthetic-secret' });
  const end = await readUntil(setup, 'qq', start.id, completed);
  assert.equal(end.state, 'connected');
  assert.equal(end.qr, null);
  assert.equal(secrets.get(qq.options.config.credentialRef), 'synthetic-secret');
  assert.deepEqual(qq.options.config.groupAllowlist, []);
  assert.deepEqual(qq.options.config.shadow.ownerIds, []);
});
