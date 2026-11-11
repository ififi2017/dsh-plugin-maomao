// Keep code literal when a channel cannot deliver a formatted reply.
const CODE = /^ {0,3}(`{3,}|~{3,})[^\r\n]*\r?\n([\s\S]*?)^ {0,3}\1[ \t]*(?=\r?$)|(?<!`)(`+)(?!`)([^\r\n]+?)(?<!`)\3(?!`)/gm;

const TABLE_RULE = /^ {0,3}\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*$/m;
const RULE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/m;
const FENCE = /^ {0,3}(?:\x60{3,}|~{3,})/m;

export const hasMarkdownFence = (text) => FENCE.test(text);
export const hasMarkdownBlock = (text) => FENCE.test(text) || RULE.test(text) || TABLE_RULE.test(text)
  || /^ {0,3}(?:#{1,6}[ \t]+|>|[-+*][ \t]+|\d{1,9}[.)][ \t]+)/m.test(text);

function plainProse(text) {
  return text
    .replace(new RegExp(TABLE_RULE.source + '\\r?\\n?', 'gm'), '')
    .replace(new RegExp(RULE.source, 'gm'), '────────')
    .replace(/^( {0,3})[-+*][ \t]+\[([ xX])\][ \t]+/gm, (_, indent, checked) => indent + (checked === ' ' ? '☐ ' : '☑ '))
    .replace(/^ {0,3}(?:#{1,6}[ \t]+|>[ \t]?)/gm, '')
    .replace(/^([ \t]*)[-+*][ \t]+/gm, '$1• ')
    .replace(/!?\[([^\]\n]*)\]\((https?:\/\/[^\s()]+)\)/g, (_, label, url) => label ? `${label}（${url}）` : url)
    .replace(/(?<![\\*])\*\*\*(?=\S)([^\n]+?)(?<=\S)\*\*\*(?!\*)/g, '$1')
    .replace(/(?<!\\)\*\*(?=\S)([^\n]+?)(?<=\S)\*\*(?!\*)|(?<![\\\w])__(?=\S)([^_\n]+)(?<=\S)__(?!\w)/g, '$1$2')
    .replace(/(?<![\\\w])\*(?=\S)([^*\n]+)(?<=\S)\*(?!\w)|(?<![\\\w])_(?=\S)([^_\n]+)(?<=\S)_(?!\w)/g, '$1$2')
    .replace(/(?<!\\)~~(?=\S)([^~\n]+)(?<=\S)~~/g, '$1');
}

export function plainChatMarkdown(text) {
  let result = '';
  let offset = 0;
  for (const match of text.matchAll(CODE)) {
    result += plainProse(text.slice(offset, match.index));
    result += match[2]?.replace(/\r?\n$/, '') ?? match[4];
    offset = match.index + match[0].length;
  }
  return (result + plainProse(text.slice(offset))).trim() || text;
}

export const hasChatMarkdown = (text, plain = plainChatMarkdown(text)) => hasMarkdownBlock(text) || plain !== text.trim();
