import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setupTelegram } from '../setup-telegram.mjs';

const message = (updateId, userId, text, chatType = 'private') => ({
  update_id: updateId,
  message: { message_id: updateId, from: { id: userId, is_bot: false },
    chat: { id: userId, type: chatType }, date: Math.floor(Date.now() / 1000), text },
});
const manager = { id: 4001, is_bot: true, username: 'maomao_manager_bot', can_manage_bots: true };
const child = { id: 4002, is_bot: true, username: 'maomao_child_bot' };
const managed = (updateId, userId, bot = child) => ({
  update_id: updateId, managed_bot: { user: { id: userId, is_bot: false }, bot },
});

test('Telegram existing-bot QR binds the matching private Start without overwriting a setup', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maomao-telegram-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, 'setup');
  let code;
  let pollAttempts = 0;
  let qrCount = 0;
  const args = { token: '4002:testToken', owner: 'same-owner', ownerId: '9012', output,
    signal: AbortSignal.timeout(2000),
    onQr({ step, url }) {
      qrCount++;
      assert.equal(step, 'pair');
      const link = new URL(url);
      assert.equal(link.pathname, `/${child.username}`);
      code = link.searchParams.get('start');
      assert.match(code, /^[A-Za-z0-9_-]{32}$/);
    },
    async request(_token, method) {
      if (method === 'getWebhookInfo') return { url: '' };
      if (method === 'getMe') return child;
      assert.equal(method, 'getUpdates');
      if (++pollAttempts === 1) throw Object.assign(new Error('temporary network failure'), { code: 'telegram_network' });
      return [message(1, 9012, `/start ${code}`, 'group'), message(2, 9012, '/start stale'),
        message(3, 9013, `/start ${code}`), message(4, 9012, `/start ${code}`)];
    },
  };
  assert.equal((await setupTelegram(args)).username, child.username);
  assert.equal(qrCount, 1);
  assert.equal(pollAttempts, 2);
  const env = join(output, 'telegram.env');
  const patch = join(output, 'telegram.patch.yml');
  assert.equal((await stat(output)).mode & 0o777, 0o700);
  assert.equal((await stat(env)).mode & 0o777, 0o600);
  assert.equal((await stat(patch)).mode & 0o777, 0o600);
  assert.equal(await readFile(env, 'utf8'), 'MAOMAO_DSH_TELEGRAM_TOKEN=4002:testToken\n');
  const config = JSON.parse(await readFile(patch, 'utf8'))[0].config;
  assert.deepEqual(config.telegram, { enabled: true, accountId: '4002', enrollment: false });
  assert.deepEqual(config.bindings, [{ owner: 'same-owner', endpoints: [
    { platform: 'telegram', accountId: '4002', senderId: '9012', chatId: '9012' },
  ] }]);
  await assert.rejects(setupTelegram({ ...args, request() { assert.fail('existing directory must stop setup'); } }), { code: 'EEXIST' });
});

test('Telegram managed-bot setup ignores old and unrelated events and saves only the new token', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maomao-telegram-managed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let code;
  let created = false;
  let tokenCalls = 0;
  await setupTelegram({ token: '4001:managerToken', mode: 'managed', username: child.username, output: join(root, 'setup'),
    signal: AbortSignal.timeout(2000),
    onQr({ step, url }) {
      const link = new URL(url);
      if (step === 'pair') code = link.searchParams.get('start');
      else {
        assert.equal(link.pathname, `/newbot/${manager.username}/${child.username}`);
        created = true;
      }
    },
    async request(token, method, data) {
      if (method === 'getWebhookInfo') return { url: '' };
      if (method === 'getMe') return token.startsWith('4001:') ? manager : child;
      if (method === 'getManagedBotToken') {
        tokenCalls++;
        assert.equal(token, '4001:managerToken');
        assert.deepEqual(data, { user_id: child.id });
        return '4002:childToken';
      }
      assert.equal(method, 'getUpdates');
      assert.deepEqual(data.allowed_updates, ['message', 'managed_bot']);
      if (!data.offset) return [message(1, 9012, `/start ${code}`)];
      if (!created) {
        assert.equal(data.timeout, 0);
        return data.offset === 2 ? [managed(2, 9012)] : [];
      }
      assert.equal(data.offset, 3);
      return [managed(3, 9013), managed(4, 9012, { ...child, username: 'other_bot' }), managed(5, 9012)];
    },
  });
  assert.equal(tokenCalls, 1);
  assert.equal(await readFile(join(root, 'setup', 'telegram.env'), 'utf8'), 'MAOMAO_DSH_TELEGRAM_TOKEN=4002:childToken\n');
});
