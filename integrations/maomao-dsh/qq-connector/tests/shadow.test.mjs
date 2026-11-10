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
    assert.equal((await shadow.observe(inbound('two', '继续说说'))).reason, 'semantic_yes');
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

test('activity is passed to the model instead of imposing multi-minute or hourly silence', async () => {
  let now = 1_000_000;
  const seen = [];
  const shadow = new PassiveShadow(null, { clock: () => now, debounceMs: 1,
    judge: async (payload) => { seen.push(payload); return { reply: true }; } });
  try {
    for (let i = 0; i < 7; i++) {
      const envelope = inbound(`topic-${i}`, '新来的群友也想聊这个梗', { senderId: `member-${i}` });
      assert.equal((await shadow.observe(envelope)).reason, 'semantic_yes');
      shadow.noteReply(envelope, '接一句');
      now += 5_000;
    }
    assert.equal(seen.length, 7);
    assert.equal(seen.at(-1).mode, 'unsolicited');
    assert.equal(seen.at(-1).recent_interjections, 6);
    assert.equal(seen.at(-1).seconds_since_cat_reply, 5);
    assert.equal((await shadow.observe(inbound('burst', '另一条', { senderId: 'someone' }))).decision, 'would_reply');
    shadow.noteReply(inbound('burst'), '刚回过');
    now += 3_990;
    assert.equal((await shadow.observe(inbound('immediate', '又一条'))).reason, 'semantic_yes');
    assert.equal(seen.at(-1).current.text, '又一条');
  } finally { await shadow.stop(); }
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

test('a participant can be judged after sixty seconds until the actual QQ reply window expires', async () => {
  let now = 1_000_000;
  const judged = [];
  const shadow = new PassiveShadow(null, { clock: () => now, debounceMs: 1,
    judge: async (payload) => { judged.push(payload); return { reply: true }; } });
  const anchor = inbound('human-anchor', '大家聊聊', { rawEventType: 'GROUP_AT_MESSAGE_CREATE' });
  const peer = { maxRounds: 3 };
  try {
    await shadow.observe(anchor);
    now += 75_000;
    const turn = await shadow.notePeer('app-a', 'group-a', peer,
      { messageId: 'late-participant', senderId: 'someone', content: '刚才那个梗我还有个看法' },
      { enabled: () => true });
    assert.ok(turn);
    assert.deepEqual(judged[0].rounds, { used: 0, remaining: 3, limit: 3 });
    assert.equal(turn.current(), true);
    turn.release();
    now = anchor.receivedAt + 300_001;
    assert.equal(await shadow.notePeer('app-a', 'group-a', peer,
      { messageId: 'expired', senderId: 'someone', content: '过期以后' }, { enabled: () => true }), null);
    assert.equal(judged.length, 1);
    assert.equal(turn.current(), false);
  } finally { await shadow.stop(); }
});
