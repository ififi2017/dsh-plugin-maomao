import { mediaRuntime } from './model-media.mjs';

const entryId = 'maomao-dsh-models';
const identifier = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/.test(value);

function selection(value) {
  if (!identifier(value?.provider) || !identifier(value?.model)) return null;
  return { provider: value.provider, model: value.model };
}

export function apply(ctx, config = {}) {
  const chat = config.chat?.inherit === true ? { inherit: true } : selection(config.chat);
  const effectiveChat = () => chat?.inherit
    ? selection(ctx.get('agentDefaultModel')?.currentSelection?.()) : chat;
  ctx.provide('maomaoModels', Object.freeze({
    ...mediaRuntime(ctx, config.media),
    chat: () => chat,
    async useChat(controller, sessionId) {
      const selected = effectiveChat();
      if (!selected) return;
      const { agent } = await controller.resolveAgent(sessionId);
      if (!agent) throw new Error('Maomao could not select a conversation model for this session');
      agent.model.select(selected);
      return selected;
    },
  }));
}

export async function chatModels(ctx) {
  const catalog = await ctx.get('sessionController')?.modelCatalog?.();
  const editor = ctx.get('configEditor');
  return {
    available: Boolean(editor?.entries().some((row) => row.options.id === entryId)),
    saved: ctx.get('maomaoModels')?.chat?.() ?? null,
    default: selection(catalog?.default ?? ctx.get('agentDefaultModel')?.currentSelection?.()),
    choices: (catalog?.groups ?? []).flatMap((group) => group.models.flatMap((model) => {
      const route = selection({ provider: group.id, model: model.id });
      return route ? [{ ...route, name: String(model.name || model.id).slice(0, 130) }] : [];
    })),
  };
}

export async function manageChatModel(ctx, request, signal) {
  if (request?.action === 'list') return chatModels(ctx);
  if (!['test', 'save'].includes(request?.action)) return { status: 'invalid' };
  const followDefault = request.selection?.inherit === true;
  const selected = followDefault ? selection(ctx.get('agentDefaultModel')?.currentSelection?.()) : selection(request.selection);
  const llm = ctx.get('llm');
  if (!selected || !llm) return { status: 'invalid' };
  try {
    const prepared = await llm.prepareCall(request.action === 'test' ? { ...selected, maxTokens: 256 } : selected, signal);
    if (prepared.inputModalities && !prepared.inputModalities.includes('text')) return { status: 'invalid' };
    if (request.action === 'test') {
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(35_000)]);
      let text = '';
      let finished = false;
      for await (const chunk of prepared.stream({ ...prepared.config, signal: deadline,
        messages: [{ role: 'user', content: [{ type: 'text', text: '用一句简短的话打招呼。这是猫猫的模型连接测试。' }] }],
      })) {
        if (chunk.type === 'text-delta') text = (text + chunk.text).slice(0, 240);
        if (chunk.type === 'finish') finished = ['stop', 'max-tokens'].includes(chunk.reason.kind);
      }
      return finished && text.trim() ? { status: 'tested', text: text.trim() } : { status: 'test_failed' };
    }
    const editor = ctx.get('configEditor');
    const entry = editor?.entries().find((row) => row.options.id === entryId);
    if (!entry) return { status: 'unavailable' };
    signal.throwIfAborted();
    await editor.edit(entry, (current) => ({ ...current, chat: followDefault ? { inherit: true } : selected }));
    return { status: 'saved' };
  } catch {
    return { status: request.action === 'test' ? 'test_failed' : 'save_failed' };
  }
}
