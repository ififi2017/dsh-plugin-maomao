const marker = '<|maomao_choices|>';

export const choiceGuidance = '如果当前回复确实适合让对方选择下一步，可以在正文后另起一行输出 '
  + marker + '["选项一","选项二"]。按本轮语境现写 2 至 3 个简短、有区别的选项，每项最多 24 个字。'
  + '不需要做决定时只输出正文。不要在正文重复列出按钮。收到「已选择的聊天分支」时，从该选项自然接着聊。';

export function parseChoiceReply(answer) {
  const index = answer.indexOf(marker);
  if (index < 0) return { text: answer, options: [] };
  const text = answer.slice(0, index).trim();
  let options;
  try { options = JSON.parse(answer.slice(index + marker.length).trim()); }
  catch { return { text, options: [] }; }
  if (!Array.isArray(options) || options.length < 2 || options.length > 3
    || options.some((label) => typeof label !== 'string' || !label.trim() || [...label.trim()].length > 24
      || /[\p{Cc}\p{Cf}<>{}\[\]]/u.test(label))) return { text, options: [] };
  options = options.map((label) => label.trim());
  return { text, options: new Set(options).size === options.length ? options : [] };
}

export const choiceData = (token, index) => `mc:${token}:${index}`;

export function parseChoiceData(data) {
  const match = typeof data === 'string' && /^mc:([a-f0-9]{32}):([0-2])$/.exec(data);
  return match ? { token: match[1], index: Number(match[2]) } : null;
}
