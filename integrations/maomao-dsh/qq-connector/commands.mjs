function safeId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : '不可用';
}

function number(value) {
  return Number.isFinite(value) && value >= 0 ? Math.round(value).toLocaleString('en-US') : null;
}

export function qqCommand(envelope) {
  if (typeof envelope?.text !== 'string' || envelope.addressedToOther) return null;
  const value = envelope.text.trim()
    .replace(envelope.addressed ? /^<@!?[A-Za-z0-9_-]{1,128}>\s*/ : /^$/, '').trim();
  if (envelope.addressed && /^\/(sid|status)$/i.test(value)) return value.toLowerCase();
  if (envelope.scope !== 'group') return null;
  if (/^\/reset$/i.test(value)) return { action: 'reset' };
  const match = /^\/(?:切换人设|persona)(?:[ \t]+([^\r\n]{1,80}))?$/i.exec(value);
  return match ? { action: 'persona', name: match[1]?.trim() } : null;
}

export function qqPersonaReply(command, { book, target, owner }) {
  if (!owner) return '请由已绑定的群主人使用人格指令。';
  if (!book) return '人格服务暂时不可用。';
  const { personas, targets } = book.manage({ action: 'read' }, [target]);
  const current = personas.find(({ id }) => id === targets[0].personaId);
  const label = (name) => name.replace(/[<@>|]/g, (char) => ({ '<': '＜', '@': '＠', '>': '＞', '|': '｜' }[char]));
  if (command.action === 'reset') {
    book.manage({ action: 'reset', targetId: target.id }, [target]);
    return `已重开本群对话，下一条消息会使用「${label(current.name)}」。长期记忆会保留。`;
  }
  if (!command.name) {
    const lines = personas.map(({ name, id }) => `${label(name)}（${id.slice(0, 8)}）`);
    const parts = [];
    for (let i = 0; i < lines.length; i += 13) parts.push(lines.slice(i, i + 13).join('\n'));
    parts[0] = `当前人格：${label(current.name)}\n发送 /切换人设 名称 或括号里的代码切换。发送 /reset 重开。\n${parts[0]}`;
    return parts.join('<|bubble|>');
  }
  const choice = command.name.toLowerCase();
  const matches = personas.filter(({ id, name }) => name.toLowerCase() === choice || id.slice(0, 8) === choice);
  if (matches.length !== 1) return '没有找到唯一匹配的人格。发送 /切换人设 查看名称和代码。';
  if (matches[0].id === current.id) return `当前已经使用「${label(current.name)}」。发送 /reset 可以重开对话。`;
  book.manage({ action: 'select', targetId: target.id, personaId: matches[0].id }, [target]);
  return `已切换为「${label(matches[0].name)}」，下一条消息会开启新对话。`;
}

export function sidReply(envelope, admission) {
  const lines = [`QQ 发送者 OpenID：${safeId(envelope.senderId)}`];
  if (envelope.scope === 'group') lines.push(`QQ群 OpenID：${safeId(envelope.chatId)}`);
  if (envelope.scope === 'c2c' && admission) {
    lines.push(`私聊授权：${admission.paired ? '已配对或加入白名单' : admission.acceptStrangers ? '允许陌生人聊天（尚未配对）' : '尚未配对'}`,
      `主人身份：${admission.owner ? '已配置' : '未配置'}`,
      '发送 /pair 查看配对方法。私聊授权不会自动绑定主人，也不共享其他渠道记忆。');
  }
  return lines.join('\n');
}

export function statusReply({ ready, selection, selectionSource, pressure } = {}) {
  const route = selection && typeof selection.provider === 'string' && typeof selection.model === 'string'
    ? `${selection.provider}/${selection.model}` : '暂不可用';
  const used = number(pressure?.projectedTokens ?? pressure?.pressureTokens);
  const limit = number(pressure?.contextWindow);
  const context = used && limit ? `约 ${used} / ${limit} tokens`
    : used ? `约 ${used} tokens（上限未知）` : '暂不可用';
  return [
    `QQ 连接：${ready ? '已连接' : '未连接'}`,
    `${selectionSource === 'session' ? '会话模型' : '默认模型'}：${route}`,
    `上下文参考：${context}`,
    'API 剩余额度：当前模型接口未提供统一查询',
  ].join('\n');
}
