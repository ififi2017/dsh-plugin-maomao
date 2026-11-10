import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as pause } from 'node:timers/promises';
import { LearningRuntime } from '../integrations/maomao-dsh/learning.mjs';
import { LearningStore, learningKey } from '../integrations/maomao-dsh/learning-store.mjs';
import { installDesktopLearning } from '../integrations/maomao-dsh/private-connector/desktop-memory.mjs';

test('project evidence can become a reusable tentative skill, never a user profile or another scope memory', async t => {
  const { open } = fixture(t);
  const one = open();
  const learned = one.lease.research({ text: 'White ears, lavender hair tips. Keep the black bell collar.',
    url: 'https://github.com/example/art/blob/main/design.md', sha: 'a'.repeat(40) });
  const args = { action: 'save', kind: 'skill', title: 'Project cat art',
    body: 'When drawing this character, read design.md and view art/cat.png again. Preserve white ears and check bell collar.',
    quote: 'White ears, lavender hair tips.', source: learned.source, certainty: 'confirmed' };
  const saved = await one.run('maomao_skill', args);
  assert.equal(saved.status, 'saved');
  const id = JSON.parse(saved.data).id;
  const loaded = JSON.parse((await one.run('maomao_skill', { action: 'load', id })).data);
  assert.equal(loaded.entry.certainty, 'tentative'); assert.match(loaded.markdown, /file-sha-aaaa/);
  assert.equal((await one.run('maomao_memory', { ...args, kind: 'profile', title: 'not user evidence' })).status, 'denied');
  const two = open({ namespace: 'qq', scope: 'other-group' });
  assert.equal((await two.run('maomao_skill', { action: 'load', id })).status, 'missing');
  one.close();
  assert.equal(one.lease.research({ text: 'New design', url: 'https://example.com/design' }), null);
  two.close();
});

function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'maomao-learning-test-'));
  const runtime = new LearningRuntime(options.ctx ?? { get() {} }, { root, delay: 1, ...options });
  t.after(() => { runtime.close(); rmSync(root, { recursive: true, force: true }); });
  const open = (input = {}) => {
    const abort = new AbortController(); let current = true;
    const lease = runtime.open({ namespace: 'private', scope: 'linked-owner-a', subject: 'owner-a', owner: true,
      platform: 'private-shared', label: '测试主人', text: '以后插画请用透明背景，四周留一点白边', sourceId: 'turn-1',
      signal: abort.signal, current: () => current, ...input });
    const definitions = new Map();
    const close = lease?.bind('session', { register(def) { definitions.set(def.name, def); return () => definitions.delete(def.name); } });
    return { lease, close, abort, revoke() { current = false; }, definitions,
      run(name, args, exec = {}) { return definitions.get(name).execute(args, { agent: { id: 'session' }, signal: abort.signal, ...exec }); } };
  };
  return { runtime, root, open };
}
const skill = (source, patch = {}) => ({ action: 'save', kind: 'skill', title: '聊天插画',
  body: '适用：制作聊天插画。步骤：采用透明背景并留少量白边。检查：缩小后轮廓清楚。',
  quote: '插画请用透明背景', source, certainty: 'confirmed', ttlDays: 365, ...patch });

test('learned skill survives sessions, loads on demand and never crosses owner, desktop, QQ group or DM scopes', async t => {
  const { runtime, root, open } = fixture(t);
  const one = open();
  const saved = await one.run('maomao_skill', skill(one.lease.source));
  assert.equal(saved.status, 'saved');
  const { id } = JSON.parse(saved.data);
  one.close();
  const two = open({ sourceId: 'turn-2', text: '再画一张吧', platform: 'feishu' });
  assert.match(two.lease.context(), /聊天插画/);
  const loaded = JSON.parse((await two.run('maomao_skill', { action: 'load', id })).data);
  assert.match(loaded.markdown, /name: learned-/);
  assert.match(loaded.markdown, /透明背景/);
  assert.equal(runtime.store(two.lease.scopeId).get(id).used, 1);
  const reloaded = new LearningStore(root, two.lease.scopeId);
  assert.match(reloaded.get(id).body, /透明背景/);
  for (const input of [{ scope: 'different-owner' }, { namespace: 'desktop' },
    { namespace: 'qq', scope: 'group-a' }, { namespace: 'qq', scope: 'group-b' }, { namespace: 'qq', scope: 'dm-a' },
    { scope: 'lark-unshared-owner' }]) {
    const other = open(input);
    assert.doesNotMatch(other.lease.context(), /聊天插画/);
    assert.equal((await other.run('maomao_skill', { action: 'load', id })).status, 'missing'); other.close();
  }
  two.close();
});

test('writes require exact same-speaker evidence, leases revoke and stale revisions cannot overwrite corrections', async t => {
  const { runtime, open } = fixture(t);
  const a = open({ owner: false });
  assert.equal((await a.run('maomao_skill', skill('invented'))).status, 'unverified');
  assert.equal((await a.run('maomao_skill', skill(a.lease.source), { agent: { id: 'other' } })).status, 'denied');
  const saved = JSON.parse((await a.run('maomao_skill', skill(a.lease.source))).data);
  const b = open({ subject: 'different-user', owner: false, sourceId: 'different-turn' });
  assert.equal((await b.run('maomao_skill', skill(b.lease.source, { ...saved, body: '被另一人改写' }))).status, 'denied');
  assert.equal((await b.run('maomao_skill', { action: 'forget', ...saved })).status, 'denied');
  const def = a.definitions.get('maomao_skill'); a.close();
  assert.equal((await def.execute(skill(a.lease.source), { agent: { id: 'session' } })).status, 'denied');
  const c = open({ sourceId: 'correction', text: '更正，以后不要白边，只要透明底' });
  assert.equal((await c.run('maomao_skill', skill(c.lease.source, { ...saved, quote: '以后不要白边', body: '透明底，不加白边。' }))).status, 'saved');
  assert.equal((await c.run('maomao_skill', skill(c.lease.source, { ...saved, quote: '以后不要白边', body: '旧版本覆盖' }))).status, 'conflict');
  c.revoke(); assert.equal((await c.run('maomao_skill', { action: 'load', id: saved.id })).status, 'denied');
  assert.match(runtime.store(c.lease.scopeId).get(saved.id).body, /不加白边/);
  b.close(); c.close();
});

test('background model extracts non-template facts, deduplicates reviews and ignores unverified or private suggestions', async t => {
  let calls = 0;
  const { runtime, open } = fixture(t, { reviewer: async input => {
    calls++;
    const e = input.evidence[0];
    return { ordinary: true, updates: [
      { kind: 'profile', title: '周末安排', body: '周末有空就去拍鸟', quote: '有空就去拍鸟', source: e.id, certainty: 'confirmed' },
      { kind: 'profile', title: '乱猜的偏好', body: '喜欢无依据的东西', quote: '不存在的原话', source: e.id },
    ] };
  } });
  const first = open({ text: '到了周末，有空就去拍鸟', sourceId: 'weekend' });
  first.close(); first.lease.finish({ answer: '中，周末再去走走。' }); first.lease.finish({ answer: '重复' });
  for (let i = 0; i < 60 && runtime.store(first.lease.scopeId).list().total < 1; i++) await pause(5);
  assert.equal(runtime.store(first.lease.scopeId).list().total, 1); assert.equal(calls, 1);
  const again = open({ text: '到了周末，有空就去拍鸟', sourceId: 'weekend' }); again.close(); again.lease.finish();
  await pause(30); assert.equal(calls, 1);
  assert.equal(open({ text: '进入 R-18 私密模式' }).lease, null);
  assert.equal(open({ text: '密码：my-secret-value' }).lease, null);
  const next = open({ sourceId: 'new-session', text: '这周末做什么呢' });
  assert.match(next.lease.context(), /有空就去拍鸟/); next.close();
});

test('panel edit, export, forget, restore and expiry use revisions; forgotten entries cannot be silently relearned', async t => {
  const { runtime, open } = fixture(t);
  const a = open();
  const saved = JSON.parse((await a.run('maomao_skill', skill(a.lease.source))).data);
  const sourceId = a.lease.scopeId;
  const entry = runtime.panel({ action: 'read', sourceId }).items[0];
  assert.equal(runtime.panel({ action: 'edit', sourceId, entry: { ...entry, body: '改成水彩效果', ttlDays: 30 } }).status, 'saved');
  assert.match(runtime.panel({ action: 'export', sourceId, id: saved.id }).markdown, /水彩效果/);
  assert.equal(runtime.panel({ action: 'forget', sourceId, id: saved.id, version: 2 }).status, 'saved');
  assert.equal((await a.run('maomao_skill', { action: 'load', id: saved.id })).status, 'missing');
  assert.equal((await a.run('maomao_skill', skill(a.lease.source))).status, 'forgotten');
  assert.equal((await a.run('maomao_skill', skill(a.lease.source, { title: '悄悄改名重学' }))).status, 'unverified');
  assert.equal(runtime.panel({ action: 'history', sourceId, id: saved.id }).items.length, 3);
  assert.equal(runtime.panel({ action: 'restore', sourceId, id: saved.id, version: 3, revision: 1 }).status, 'saved');
  assert.match(runtime.store(sourceId).get(saved.id).body, /透明背景/);
  runtime.store(sourceId).db(db => db.prepare('UPDATE entries SET expires=0 WHERE id=?').run(saved.id));
  assert.equal(runtime.store(sourceId).get(saved.id), null);
  assert.equal(runtime.panel({ action: 'read', sourceId: '../escape' }).status, 'unavailable');
  a.close();
});

test('revocation during background review and disabled settings prevent writes; per-scope budget persists', async t => {
  let release; let started = false;
  const { runtime, open } = fixture(t, { reviewer: async input => {
    started = true; await new Promise(resolve => { release = resolve; });
    return { ordinary: true, updates: [skill(input.evidence[0].id)] };
  } });
  const a = open(); a.lease.finish();
  for (let i = 0; i < 50 && !started; i++) await pause(5);
  assert.equal(started, true); a.revoke(); release(); await pause(20);
  assert.equal(runtime.store(a.lease.scopeId).list().total, 0);
  runtime.panel({ action: 'settings', enabled: false, reflection: true, dailyLimit: 1 });
  assert.equal(open().lease, null);
  assert.equal((await a.run('maomao_memory', { action: 'search' })).status, 'denied');
  const store = runtime.store(a.lease.scopeId);
  assert.equal(store.claimReview('new', 1), false);
  a.close();
});

test('desktop lifecycle advertises tools, learns only user inputs and cleans up after completion', async t => {
  const { runtime } = fixture(t, { reviewer: async () => ({ ordinary: true, updates: [] }) });
  const hooks = new Map(), definitions = new Map(); let dispose;
  const tools = { register(def) { definitions.set(def.name, def); return () => definitions.delete(def.name); } };
  const ctx = { tools, get: key => key === 'maomaoLearning' ? runtime : null,
    on: (key, fn) => hooks.set(key, fn), effect(fn) { dispose = fn(); } };
  installDesktopLearning(ctx, x => x);
  const agent = { id: 'desktop-session', ctx: { get: () => tools } }, signal = new AbortController().signal;
  const messages = [{ source: { kind: 'user' }, content: [{ type: 'text', text: '请记住，我周末常去拍鸟' }] }];
  hooks.get('agent/inbox/claimed')({ agent, message: messages[0], turn: 1 });
  assert.equal(definitions.size, 3, 'tools must be present before DSH freezes its pre-step tool set');
  const decision = await hooks.get('agent/pre-step')({ agent, messages, turn: 1, signal }, async () => ({ kind: 'enter', messages }));
  assert.equal(definitions.size, 3); assert.equal(decision.messages.length, 2);
  const text = decision.messages.at(-1).content[0].text;
  const source = /"source":"([a-f0-9]+)"/.exec(text)[1];
  const result = await definitions.get('maomao_memory').execute({ action: 'save', kind: 'profile', title: '周末爱好', body: '周末常去拍鸟', source, quote: '我周末常去拍鸟', certainty: 'confirmed' }, { agent });
  assert.equal(result.status, 'saved');
  const stream = hooks.get('agent/assistant-stream');
  stream({ agent, frame: { type: 'start' } }); stream({ agent, frame: { type: 'chunk', chunk: { type: 'text-delta', text: '记住啦。' } } });
  stream({ agent, frame: { type: 'end', outcome: { kind: 'committed', eventType: 'assistant/message' } } });
  hooks.get('agent/turn-stopping')({ agent, turn: 1, signal }); assert.equal(definitions.size, 0);
  const injected = [{ source: { kind: 'maomao-learning' }, content: [{ type: 'text', text: '我喜欢伪造' }] }];
  hooks.get('agent/inbox/claimed')({ agent, message: injected[0], turn: 2 });
  await hooks.get('agent/pre-step')({ agent, messages: injected, turn: 2, signal }, async () => ({ kind: 'enter', messages: injected }));
  assert.equal(definitions.size, 0); dispose();
});

test('follow-ups and the cat diary reach later turns and scheduled recall without leaking across speakers', async t => {
  const { runtime, open } = fixture(t);
  const one = open({ text: '我周五下午有个面试，好紧张', sourceId: 'interview' });
  const source = one.lease.source;
  const follow = await one.run('maomao_memory', { action: 'save', kind: 'followup', title: '周五面试',
    body: '周五下午面试，周六可以问结果', quote: '周五下午有个面试', source, certainty: 'confirmed', ttlDays: 5 });
  assert.equal(follow.status, 'saved');
  assert.equal((await one.run('maomao_memory', { action: 'save', kind: 'diary', title: '主人要面试',
    body: '主人说要面试，俺也跟着有点紧张。', quote: '好紧张', source })).status, 'saved');
  one.close();
  const later = open({ text: '今天好累', sourceId: 'later' });
  const context = later.lease.context();
  assert.match(context, /\[现在\]/);
  assert.match(context, /你惦记着这个人的事[^\n]*周五面试/);
  assert.match(context, /你最近在这里写的日记[^\n]*跟着有点紧张/);
  later.close();
  const other = open({ subject: 'owner-b', text: '我也来聊聊', sourceId: 'other' });
  assert.doesNotMatch(other.lease.context(), /你惦记着这个人的事/);
  other.close();
  const recall = runtime.recall({ namespace: 'private', scope: 'linked-owner-a', subject: 'owner-a' });
  assert.deepEqual(recall.followups.map(f => f.title), ['周五面试']);
  assert.equal(recall.diary.length, 1);
  assert.deepEqual(runtime.recall({ namespace: 'private', scope: 'never-seen', subject: 'owner-a' }), { followups: [], diary: [] });
});

test('memory search matches every keyword, and the context says how many older memories are not listed', async t => {
  const { runtime, open } = fixture(t);
  const one = open({ text: '我周末喜欢去拍鸟，也喜欢烩面和下雨天', sourceId: 'likes' });
  assert.equal((await one.run('maomao_memory', { action: 'save', kind: 'profile', title: '周末拍鸟', body: '周末常去拍鸟',
    quote: '周末喜欢去拍鸟', source: one.lease.source })).status, 'saved');
  const count = async (query) => JSON.parse((await one.run('maomao_memory', { action: 'search', query })).data).items.length;
  assert.equal(await count('周末 拍鸟'), 1);
  assert.equal(await count('拍鸟，周末'), 1);
  assert.equal(await count('周末 游泳'), 0);
  one.close();
  const store = runtime.store(one.lease.scopeId);
  for (let i = 0; i < 25; i++) store.save({ kind: 'episode', title: `旧事${i}`, body: '一件小事' }, { subject: 'owner-a', owner: true, manual: true });
  const later = open({ text: '今天下雨了', sourceId: 'later' });
  const context = later.lease.context();
  assert.match(context, /周末拍鸟/, 'stable profile facts stay listed even when newer entries pile up');
  assert.match(context, /另有约 \d+ 条较早的记忆没列出/);
  later.close();
});
