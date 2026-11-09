import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QqGroupTools } from '../group-tools.mjs';

function lease(query, overrides = {}) {
  let tool;
  let closed = false;
  const turn = query.open({ bot: { api: { async getToken() { return 'token'; } } },
    groupId: 'current-group', speakerId: 'current-speaker', current: () => true, ...overrides });
  const close = turn.bind('chat-session', { register(spec) { tool = spec; return () => { closed = true; }; } });
  return { close, get closed() { return closed; },
    run: (args, id = 'chat-session') => tool.execute(args, { agent: { id } }) };
}

test('group tools scope requests to the current group and only resolve this turn’s member references', async () => {
  const routes = [];
  const query = new QqGroupTools({ async request(_token, method, route) {
    routes.push([method, route]);
    if (route.endsWith('/info')) return { group_openid: 'current-group', group_name: '测试群' };
    if (route.endsWith('/members')) return { members: [{ member_openid: 'person-7', username: '群友', union_openid: 'private' }] };
    return { member_openid: 'person-7', username: '群友', member_role: 'member', union_openid: 'private' };
  } });
  const turn = lease(query);
  assert.equal((await turn.run({ operation: 'info' }, 'other-session')).status, 'unavailable');
  assert.equal((await turn.run({ operation: 'member', member: 'someone-else' })).status, 'invalid_target');
  assert.equal(JSON.parse((await turn.run({ operation: 'info' })).data).name, '测试群');
  const page = await turn.run({ operation: 'members' });
  assert.doesNotMatch(page.data, /person-7|private/);
  const detail = await turn.run({ operation: 'member', member: JSON.parse(page.data).members[0].member_ref });
  assert.equal(JSON.parse(detail.data).nickname, '群友');
  assert.doesNotMatch(detail.data, /person-7|private/);
  assert.equal((await turn.run({ operation: 'info' })).status, 'limit');
  turn.close();
  assert.ok(turn.closed);
  assert.equal((await turn.run({ operation: 'info' })).status, 'unavailable');
  assert.deepEqual(routes, [
    ['GET', '/v2/groups/current-group/info'],
    ['GET', '/v2/groups/current-group/members'],
    ['GET', '/v2/groups/current-group/members/person-7'],
  ]);
});

test('QQ permission denial only disables the denied operation in that group', async () => {
  const routes = [];
  const query = new QqGroupTools({ async request(_token, _method, route) {
    routes.push(route);
    if (route.endsWith('/members')) throw Object.assign(new Error('not allowed'), { bizCode: 11253 });
    return { group_name: '仍可查询群资料' };
  } });
  const turn = lease(query);
  assert.deepEqual(await turn.run({ operation: 'members' }), { status: 'denied', data: '' });
  assert.deepEqual(await turn.run({ operation: 'members' }), { status: 'denied', data: '' });
  assert.equal((await turn.run({ operation: 'info' })).status, 'ok');
  const anotherGroup = lease(query, { groupId: 'other-group' });
  await anotherGroup.run({ operation: 'members' });
  assert.deepEqual(routes, ['/v2/groups/current-group/members', '/v2/groups/current-group/info', '/v2/groups/other-group/members']);
});
