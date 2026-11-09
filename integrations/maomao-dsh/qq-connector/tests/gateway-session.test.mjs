import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { GatewaySessionFile, gatewaySessionPath } from '../gateway-session.mjs';
import { MaomaoQqConnector } from '../index.mjs';
import { qqStorageHome } from '../state.mjs';

test('QQ profile storage isolates Web while keeping the existing Desktop location', () => {
  const home = join(tmpdir(), 'maomao-profile-home');
  const desktop = join(home, 'profiles', 'desktop');
  const web = join(home, 'profiles', 'web');
  assert.equal(qqStorageHome(home, desktop), home);
  assert.equal(qqStorageHome(home, web), web);
  assert.notEqual(gatewaySessionPath(qqStorageHome(home, desktop), 'test-app'),
    gatewaySessionPath(qqStorageHome(home, web), 'test-app'));
});

test('QQ gateway RESUME state is private, bound to one Bot, and survives a new adapter instance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maomao-gateway-session-'));
  const path = gatewaySessionPath(root, 'test-app');
  const warnings = [];
  try {
    assert.doesNotMatch(path, /test-app/);
    const first = new GatewaySessionFile(path, 'test-app', { warn: (code) => warnings.push(code) });
    assert.equal(first.load(), null);
    first.save({ sessionId: 'gateway-session-one', lastSeq: 42 });
    assert.deepEqual(new GatewaySessionFile(path, 'test-app').load(),
      { sessionId: 'gateway-session-one', lastSeq: 42 });
    assert.equal(new GatewaySessionFile(path, 'other-app').load(), null);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(root, 'integrations', 'maomao-qq', 'gateway'))).mode & 0o777, 0o700);
    first.save({ sessionId: 'bad\nvalue', lastSeq: 43 });
    assert.deepEqual(first.load(), { sessionId: 'gateway-session-one', lastSeq: 42 });
    await writeFile(path, '{broken', { mode: 0o600 });
    assert.equal(first.load(), null);
    assert.deepEqual(warnings, ['gateway_session_load_failed']);
    first.save({ sessionId: 'gateway-session-two', lastSeq: null });
    assert.match(await readFile(path, 'utf8'), /gateway-session-two/);
    first.clear();
    assert.equal(first.load(), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('connector passes account-bound gateway persistence to the Tencent SDK', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maomao-gateway-wiring-'));
  const old = [process.env.MAOMAO_QQ_APP_ID, process.env.MAOMAO_QQ_APP_SECRET, process.env.MAOMAO_QQ_CONNECT];
  process.env.MAOMAO_QQ_APP_ID = 'test-app';
  process.env.MAOMAO_QQ_APP_SECRET = 'test-secret';
  process.env.MAOMAO_QQ_CONNECT = 'I_STOPPED_HERMES_QQ';
  let finishRun;
  let options;
  const bot = { use() {}, on() {}, start() { return new Promise((resolve) => { finishRun = resolve; }); },
    stop() { finishRun?.(); } };
  try {
    const connector = new MaomaoQqConnector({ sessionController: {}, emit() {}, logger: console },
      { statePath: join(root, 'state.json'), groupAllowlist: [], dmAllowlist: [],
        gatewaySession: { path: join(root, 'gateway.json') } },
      { botFactory(value) { options = value; return bot; } });
    await connector.start();
    assert.equal(typeof options.sessionPersistence.load, 'function');
    options.sessionPersistence.save({ sessionId: 'sdk-session', lastSeq: 7 });
    assert.deepEqual(options.sessionPersistence.load(), { sessionId: 'sdk-session', lastSeq: 7 });
    await connector.stop();
  } finally {
    [process.env.MAOMAO_QQ_APP_ID, process.env.MAOMAO_QQ_APP_SECRET, process.env.MAOMAO_QQ_CONNECT] = old;
    for (const name of ['MAOMAO_QQ_APP_ID', 'MAOMAO_QQ_APP_SECRET', 'MAOMAO_QQ_CONNECT']) {
      if (process.env[name] === 'undefined') delete process.env[name];
    }
    await rm(root, { recursive: true, force: true });
  }
});
