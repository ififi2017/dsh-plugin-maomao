import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as pause } from 'node:timers/promises';
import { LearningRuntime } from '../integrations/maomao-dsh/learning.mjs';

// A fake embedding service: texts about birds point one way, everything else another.
const birdy = (text) => /鸟|birding/.test(text);
const vector = (text) => Array.from({ length: 1024 }, (_, i) => (i === 0 ? (birdy(text) ? 1 : 0) : i === 1 ? (birdy(text) ? 0 : 1) : 0));

test('learned memories get a vector index on the chosen model, and memory search also finds them by meaning', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'maomao-learning-vectors-'));
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    const body = JSON.parse(request.body);
    calls.push({ url: String(url), taskType: body.requests[0].taskType, count: body.requests.length });
    return Response.json({ embeddings: body.requests.map((r) => ({ values: vector(r.content.parts[0].text) })) });
  });
  const ctx = { get: (name) => name === 'maomaoModels'
    ? { embedding: async () => ({ key: 'synthetic-key', model: 'google/gemini-embedding-001' }) } : undefined };
  const runtime = new LearningRuntime(ctx, { root, delay: 1 });
  t.after(() => { runtime.close(); rmSync(root, { recursive: true, force: true }); });
  const lease = runtime.open({ namespace: 'private', scope: 'owner-a', subject: 'owner-a', owner: true, platform: 'telegram',
    label: '测试主人', text: '周末打算去湿地公园看鸟，带上新买的望远镜', sourceId: 'turn-1',
    signal: new AbortController().signal, current: () => true });
  const tools = new Map();
  lease.bind('session', { register(def) { tools.set(def.name, def); return () => {}; } });
  const run = (args) => tools.get('maomao_memory').execute(args, { agent: { id: 'session' } });

  const saved = await run({ action: 'save', kind: 'episode', title: '周末计划', body: '主人周末去湿地公园看鸟',
    quote: '周末打算去湿地公园看鸟', source: lease.source, certainty: 'confirmed' });
  assert.equal(saved.status, 'saved');
  await run({ action: 'save', kind: 'profile', title: '饮食', body: '主人不吃香菜', quote: '带上新买的望远镜', source: lease.source });

  // New memories are indexed shortly after they are saved.
  const end = Date.now() + 4000;
  while ((await runtime.vectorIndex('read')).indexed < 2 && Date.now() < end) await pause(50);
  assert.deepEqual(await runtime.vectorIndex('read'), { status: 'ready', model: 'google/gemini-embedding-001', indexed: 2, total: 2 });
  assert.equal(calls[0].taskType, 'RETRIEVAL_DOCUMENT');

  // "birding" shares no keyword with the saved text, but matches it by meaning.
  const found = JSON.parse((await run({ action: 'search', query: 'birding' })).data).items;
  assert.deepEqual(found.map((item) => item.title), ['周末计划']);
  assert.equal(calls.at(-1).taskType, 'RETRIEVAL_QUERY');
});

test('without an embedding model the index reports disabled and search stays keyword-only', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'maomao-learning-vectors-'));
  const runtime = new LearningRuntime({ get() {} }, { root, delay: 1 });
  t.after(() => { runtime.close(); rmSync(root, { recursive: true, force: true }); });
  assert.deepEqual(await runtime.vectorIndex('read'), { status: 'disabled' });
});

test('the panel learns whose memory each entry is: the owner, a name the platform sent, or only a fingerprint', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'maomao-learning-people-'));
  const runtime = new LearningRuntime({ get() {} }, { root, delay: 1 });
  t.after(() => { runtime.close(); rmSync(root, { recursive: true, force: true }); });
  const open = (subject, name, owner = false) => runtime.open({ namespace: 'qq', scope: 'group-a', subject, name, owner,
    platform: 'qq', label: 'QQ 群 · test', text: '大家好呀', sourceId: `turn-${subject}`, signal: new AbortController().signal, current: () => true });
  const bot = open('member-openid-1', '大肥鱼');
  open('member-openid-2', '');
  open('owner-openid', '', true);
  const people = runtime.panel({ action: 'read', sourceId: bot.scopeId }).people;
  const byName = Object.values(people);
  assert.deepEqual(byName.map((p) => p.name).sort(), ['', '', '大肥鱼']);
  assert.equal(byName.filter((p) => p.owner).length, 1);
  assert.ok(Object.keys(people).every((subject) => /^[a-f0-9]{16}$/.test(subject)), 'only fingerprints are stored, never the raw ID');
});
