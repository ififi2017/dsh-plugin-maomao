import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { OrdinaryBridge } from '../ordinary.mjs';
import { normalizeInbound } from '../inbound.mjs';

function envelope({ botId = 'test-bot', scope = 'group', chatId = 'test-group-a',
  senderId = 'member-a', messageId, text, attachments = [] }) {
  return { channel: 'qq', botId, scope, chatId, senderId, messageId, text,
    attachments, receivedAt: Date.now() };
}

test('QQ ordinary memory separates groups, actors, private chats and bot accounts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maomao-ordinary-'));
  const bridge = new OrdinaryBridge({ root });
  try {
    const addressed = (messageId, text) => normalizeInbound({
      kind: 'group', rawEventType: 'GROUP_AT_MESSAGE_CREATE', groupOpenid: 'test-group-a',
      senderId: 'member-a', messageId, content: `<@!bot-open-id> ${text}`,
    }, Date.now(), 'test-bot');
    await bridge.observe(addressed('a1', '我喜欢拍翠鸟'));
    const same = await bridge.observe(addressed('a2', '我喜欢什么'));
    assert.match(JSON.stringify(same.context.user_preferences), /翠鸟/);
    const otherActor = await bridge.observe(envelope({ senderId: 'member-b', messageId: 'b1', text: '我喜欢什么' }));
    assert.deepEqual(otherActor.context.user_preferences, []);
    const otherGroup = await bridge.observe(envelope({ chatId: 'test-group-b', messageId: 'c1', text: '我喜欢什么' }));
    assert.deepEqual(otherGroup.context.user_preferences, []);
    const otherBot = await bridge.observe(envelope({ botId: 'other-bot', messageId: 'd1', text: '我喜欢什么' }));
    assert.deepEqual(otherBot.context.user_preferences, []);
    const dm = await bridge.observe(envelope({ scope: 'c2c', chatId: 'member-a', messageId: 'e1', text: '我喜欢什么' }));
    assert.deepEqual(dm.context.user_preferences, []);
    assert.deepEqual(await readdir(root), ['qq']);
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    await assert.rejects(bridge.observe(envelope({ scope: 'c2c', chatId: 'other', messageId: 'bad', text: '你好' })), /invalid_c2c_actor/);
    await assert.rejects(bridge.observe({ ...envelope({ messageId: 'bad2', text: '你好' }), channel: 'feishu' }), /ordinary_qq_only/);
  } finally {
    await bridge.stop();
    await rm(root, { recursive: true, force: true });
  }
});
