import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply, manageChatModel } from '../model-config.mjs';

test('cat model changes are stored in the cat plugin and applied only to the given chat session', async () => {
  const hostDefault = { provider: 'host', model: 'default' };
  const chosen = { provider: 'cat-provider', model: 'chat-model' };
  const entry = { options: { id: 'maomao-dsh-models', config: {} } };
  const sessions = [];
  const services = {
    agentDefaultModel: { currentSelection: () => hostDefault },
    configEditor: { entries: () => [entry], async edit(row, change) { row.options.config = change(row.options.config); } },
    llm: {
      async prepareCall(config) {
        return { config, inputModalities: ['text'], async *stream(options) {
          assert.equal(options.maxTokens, 256);
          assert.match(options.messages[0].content[0].text, /模型连接测试/);
          yield { type: 'text-delta', text: '你好喵。' };
          yield { type: 'finish', reason: { kind: 'stop' } };
        } };
      },
    },
  };
  const ctx = { get: (key) => services[key], provide: (key, value) => { services[key] = value; } };
  const signal = new AbortController().signal;
  assert.deepEqual(await manageChatModel(ctx, { action: 'test', selection: chosen }, signal),
    { status: 'tested', text: '你好喵。' });
  assert.deepEqual(entry.options.config, {});
  assert.deepEqual(await manageChatModel(ctx, { action: 'save', selection: chosen }, signal), { status: 'saved' });
  apply(ctx, entry.options.config);
  const controller = { async resolveAgent(session) {
    return { agent: { model: { select: (model) => sessions.push({ session, model }) } } };
  } };
  await services.maomaoModels.useChat(controller, 'telegram-only');
  assert.deepEqual(sessions, [{ session: 'telegram-only', model: chosen }]);
  assert.deepEqual(hostDefault, { provider: 'host', model: 'default' });
  assert.deepEqual(await manageChatModel(ctx, { action: 'save', selection: { inherit: true } }, signal), { status: 'saved' });
  apply(ctx, entry.options.config);
  await services.maomaoModels.useChat(controller, 'telegram-only');
  assert.deepEqual(sessions.at(-1), { session: 'telegram-only', model: hostDefault });
});
