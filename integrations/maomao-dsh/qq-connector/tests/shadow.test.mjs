import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { normalizeInbound } from '../inbound.mjs';
import { PassiveShadow } from '../shadow.mjs';

function inbound(messageId, content, overrides = {}) {
  return normalizeInbound({ kind: 'group', rawEventType: 'GROUP_MESSAGE_CREATE',
    groupOpenid: 'group-a', senderId: 'member-a', messageId, content,
    attachments: [], ...overrides }, 1_000_000, 'app-a');
}

test('shadow keeps group context separate, judges followups, and writes no chat bodies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maomao-qq-shadow-'));
  const path = join(directory, 'decisions.jsonl');
  let now = 1_000_000;
  const seen = [];
  const shadow = new PassiveShadow(path, { clock: () => now, debounceMs: 1,
    ownerIds: ['member-a'], judge: async (payload) => { seen.push(payload); return { reply: true }; } });
  try {
    const first = inbound('one', '最近上班好累啊');
    assert.equal((await shadow.observe(first)).decision, 'would_reply');
    assert.equal(seen[0].mode, 'unsolicited');
    assert.equal((await shadow.observe(inbound('two', '继续说说'))).reason, 'cooldown');
    assert.equal((await shadow.observe(inbound('three', '给@别人看', {
      mentions: [{ is_you: false, member_openid: 'member-b' }],
    }))).reason, 'addressed_other');
    shadow.noteReply(first, '辛苦啦');
    now += 5_000;
    const followup = inbound('four', '有多累？');
    assert.equal((await shadow.observe(followup)).decision, 'would_reply');
    assert.equal(seen.at(-1).mode, 'followup');
    assert.equal(seen.at(-1).same_recipient, true);
    assert.deepEqual(shadow.contextFor(followup).map((row) => row.role),
      ['user', 'user', 'user', 'assistant']);
    assert.deepEqual(shadow.contextFor(inbound('other', '你好', { groupOpenid: 'group-b' })), []);
    const addressed = inbound('five', '@猫猫 你好', { rawEventType: 'GROUP_AT_MESSAGE_CREATE' });
    assert.equal((await shadow.observe(addressed)).reason, 'direct_reply_path');
    const output = await readFile(path, 'utf8');
    assert.doesNotMatch(output, /上班|辛苦|继续说说|member-a|group-a/);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await shadow.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('newer message supersedes a pending judgment and candidate mode never sends', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maomao-qq-shadow-'));
  let now = 1_000_000;
  const shadow = new PassiveShadow(join(directory, 'decisions.jsonl'), {
    clock: () => now, debounceMs: 20,
  });
  try {
    const first = shadow.observe(inbound('one', '好想'));
    now += 100;
    const second = shadow.observe(inbound('two', '狠狠'));
    assert.equal(await first, null);
    assert.equal((await second).decision, 'candidate');
    assert.equal(shadow.status().semanticJudge, false);
    const pending = shadow.observe(inbound('three', '还有呢'));
    await shadow.stop();
    assert.equal(await pending, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
