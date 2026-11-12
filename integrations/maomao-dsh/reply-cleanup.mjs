import { stripTimeTag } from './time-tags.mjs';

// Last step before a reply is sent: keep 猫猫's words, drop machine wrappers the model sometimes
// produces (leaked thinking, a reply written as a message array, a copied time tag).
const quoted = /(['"])((?:\\.|(?!\1)[^\\])*)\1/g;
const unescape = (value) => value.replace(/\\n/g, '\n').replace(/\\(["'\\])/g, '$1');

function unwrapArray(text) {
  const trimmed = text.trim();
  if (!/^\[[\s\S]*\]$/.test(trimmed) || !/^\[\s*[{'"]/.test(trimmed)) return text;
  // [{'type': 'text', 'text': '…'}, …] — keep each text field.
  if (/^\[\s*\{/.test(trimmed)) {
    const parts = [...trimmed.matchAll(/['"]text['"]\s*:\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/g)].map((m) => unescape(m[2]).trim()).filter(Boolean);
    return parts.length && /['"]type['"]\s*:/.test(trimmed) ? parts.join('<|bubble|>') : text;
  }
  // ['…', '…'] — a plain list of lines.
  const rest = trimmed.slice(1, -1).replace(quoted, '').replace(/[\s,]/g, '');
  if (rest) return text;
  const parts = [...trimmed.slice(1, -1).matchAll(quoted)].map((m) => unescape(m[2]).trim()).filter(Boolean);
  return parts.length ? parts.join('<|bubble|>') : text;
}

export function cleanReply(text) {
  if (typeof text !== 'string') return text;
  const withoutThinking = text.replace(/<(thought|think|thinking)>[\s\S]*?<\/\1>/gi, '').replace(/^\s*<(thought|think|thinking)>[\s\S]*$/i, '');
  return stripTimeTag(unwrapArray(withoutThinking).trim());
}
