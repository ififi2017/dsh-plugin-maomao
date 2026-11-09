import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { registerTestApp } from '../setup-feishu.mjs';

test('official QR setup provisions only a new app and writes private credentials once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maomao-feishu-setup-'));
  const path = join(root, 'test.env');
  const input = { brand: 'lark', images: true, path, signal: AbortSignal.timeout(5000) };
  try {
    let scanned = false;
    const result = await registerTestApp({ ...input,
      onQr(info) {
        const url = new URL(info.url);
        assert.equal(url.hostname, 'open.larksuite.com');
        assert.equal(url.pathname, '/page/launcher');
        assert.equal(url.searchParams.get('user_code'), 'synthetic-code');
        assert.equal(url.searchParams.get('createOnly'), 'true');
        assert.equal(url.searchParams.get('addons'), 'synthetic-addons');
        scanned = true;
      },
      async register(options) {
        assert.equal(options.domain, 'accounts.feishu.cn');
        assert.equal(options.createOnly, true);
        assert.equal(options.appId, undefined);
        assert.deepEqual(options.addons, { preset: false,
          scopes: { tenant: ['im:message.p2p_msg:readonly', 'im:message:send_as_bot', 'im:resource', 'im:message:readonly'] },
          events: { items: { tenant: ['im.message.receive_v1'] } } });
        options.onQRCodeReady({ url: 'https://open.feishu.cn/page/launcher?user_code=synthetic-code&createOnly=true&addons=synthetic-addons', expireIn: 300 });
        options.onStatusChange({ status: 'domain_switched' });
        return { client_id: 'cli_test', client_secret: 'synthetic-secret' };
      },
    });
    assert.ok(scanned);
    assert.deepEqual(result, { brand: 'lark', appId: 'cli_test', path });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.match(await readFile(path, 'utf8'), /^MAOMAO_DSH_FEISHU_APP_SECRET=synthetic-secret$/m);
    await assert.rejects(registerTestApp({ ...input, register: () => assert.fail('existing file must stop before network') }),
      { code: 'EEXIST' });
    const failedPath = join(root, 'failed.env');
    await assert.rejects(registerTestApp({ ...input, path: failedPath,
      async register(options) { options.onQRCodeReady({ url: 'https://accounts.larksuite.com.example.invalid' }); } }),
    /invalid_feishu_authorization_url/);
    await assert.rejects(stat(failedPath), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
