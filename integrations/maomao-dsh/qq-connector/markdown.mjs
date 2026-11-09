// Keep code literal while removing presentation syntax for a plain QQ reply.
const CODE = /^ {0,3}(`{3,}|~{3,})[^\r\n]*\r?\n([\s\S]*?)^ {0,3}\1[ \t]*(?=\r?$)|(?<!`)(`+)(?!`)([^\r\n]+?)(?<!`)\3(?!`)/gm;

function plainProse(text) {
  return text
    .replace(/^ {0,3}(?:#{1,6}[ \t]+|>[ \t]?)/gm, '')
    .replace(/^([ \t]*)[-+*][ \t]+/gm, '$1• ')
    .replace(/!?\[([^\]\n]*)\]\((https?:\/\/[^\s()]+)\)/g, (_, label, url) => label ? `${label}（${url}）` : url)
    .replace(/(?<!\\)\*\*(?=\S)([^*\n]+)(?<=\S)\*\*|(?<![\\\w])__(?=\S)([^_\n]+)(?<=\S)__(?!\w)/g, '$1$2')
    .replace(/(?<![\\\w])\*(?=\S)([^*\n]+)(?<=\S)\*(?!\w)|(?<![\\\w])_(?=\S)([^_\n]+)(?<=\S)_(?!\w)/g, '$1$2')
    .replace(/(?<!\\)~~(?=\S)([^~\n]+)(?<=\S)~~/g, '$1');
}

export function plainQqMarkdown(text) {
  let result = '';
  let offset = 0;
  for (const match of text.matchAll(CODE)) {
    result += plainProse(text.slice(offset, match.index));
    result += match[2]?.replace(/\r?\n$/, '') ?? match[4];
    offset = match.index + match[0].length;
  }
  return (result + plainProse(text.slice(offset))).trim() || text;
}
