// One-shot text completion on the user's chosen chat model, for background
// work (reflection, check-ins) that runs outside an agent session.
export async function completeText(ctx, { system, user, maxTokens = 600, signal }) {
  const chat = ctx.get?.('maomaoModels')?.chat?.();
  const selection = chat?.provider && chat?.model ? chat : ctx.get?.('agentDefaultModel')?.currentSelection?.();
  if (!selection) throw new Error('model_unavailable');
  const prepared = await ctx.get?.('llm')?.prepareCall({ ...selection, maxTokens }, signal);
  if (!prepared) throw new Error('model_unavailable');
  let text = ''; let done = false;
  for await (const chunk of prepared.stream({ ...prepared.config, signal,
    messages: [{ role: 'system', content: [{ type: 'text', text: system }] },
      { role: 'user', content: [{ type: 'text', text: user }] }],
  })) {
    if (chunk.type === 'text-delta') text += chunk.text;
    if (text.length > 14000) throw new Error('model_response_too_long');
    if (chunk.type === 'finish') done = chunk.reason.kind === 'stop';
  }
  if (!done) throw new Error('model_response_incomplete');
  return text;
}

export const parseJsonReply = (text) => JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
