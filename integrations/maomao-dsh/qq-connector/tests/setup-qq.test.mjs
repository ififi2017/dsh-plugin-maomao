import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setupQQ } from '../setup-qq.mjs';

test('QQ QR setup stores one bot privately and leaves existing credentials untouched', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maomao-qq-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, 'test.env');
  const signal = AbortSignal.timeout(2000);
  const result = await setupQQ({ output, signal, async connect(opts) {
    assert.equal(opts.signal, signal);
    return [{ appId: '1234', appSecret: 'synthetic_test_credential' }];
  } });
  assert.deepEqual(result, { appId: '1234', output });
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  const original = 'MAOMAO_QQ_APP_ID=1234\nMAOMAO_QQ_APP_SECRET=synthetic_test_credential\n';
  assert.equal(await readFile(output, 'utf8'), original);
  await assert.rejects(setupQQ({ output, signal, connect() { assert.fail('existing output must stop setup'); } }), { code: 'EEXIST' });
  assert.equal(await readFile(output, 'utf8'), original);
  const cancelled = join(root, 'cancelled.env');
  const cancel = new AbortController();
  await assert.rejects(setupQQ({ output: cancelled, signal: cancel.signal, async connect() {
    cancel.abort();
    return [{ appId: '1234', appSecret: 'synthetic_test_credential' }];
  } }), { name: 'AbortError' });
  await assert.rejects(stat(cancelled), { code: 'ENOENT' });
});
