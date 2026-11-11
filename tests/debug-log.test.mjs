import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DebugLog, redact } from '../integrations/maomao-dsh/debug-log.mjs';

test('the debug log filters by level, masks secrets, keeps one day, and keeps API errors across restarts', () => {
  const root = mkdtempSync(join(tmpdir(), 'maomao-log-'));
  let now = 1_000_000;
  try {
    const first = new DebugLog(root, { clock: () => now });
    assert.equal(first.level, 'debug');
    first.write('trace', 'tool', 'too detailed');
    first.write('debug', 'tool', 'maomao_memory save → saved', { args: { quote: '周末拍鸟' } });
    first.write('info', 'qq', '群回合', { text: 'token=abcdef123456 hello' });
    first.apiError('qq', 40034012, 'QQ 拒绝了 Markdown', 'Bearer sk-abcdefghijklmnopqrstuv');
    assert.deepEqual(first.read().map((row) => row.level), ['debug', 'info', 'error'], 'trace is below the recording level');
    assert.deepEqual(first.read({ level: 'info' }).map((row) => row.event), ['群回合', 'API 报错 40034012']);
    assert.match(first.read({ query: '群回合' })[0].detail, /token=«redacted»/);
    assert.doesNotMatch(first.apiErrors()[0].detail, /sk-abcdefghij/);
    const lastId = first.read().at(-1).id;
    first.write('info', 'qq', 'later');
    assert.deepEqual(first.read({ after: lastId }).map((row) => row.event), ['later']);
    now += 25 * 3_600_000;
    first.write('info', 'qq', 'next day');
    first.prune();
    assert.deepEqual(first.read().map((row) => row.event), ['next day'], 'the rolling log keeps only the last day');
    assert.equal(first.setLevel('trace'), true);
    first.close();
    const second = new DebugLog(root, { clock: () => now });
    assert.equal(second.read().length, 0, 'a restart starts a fresh rolling log');
    assert.equal(second.level, 'trace', 'the recording level is remembered');
    assert.equal(second.apiErrors()[0].code, '40034012', 'API errors persist');
    second.clearApiErrors();
    assert.equal(second.apiErrors().length, 0);
    second.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
  assert.match(redact({ api_key: 'AIzaSyD-1234567890abcdefghijk' }), /«redacted»/);
});
