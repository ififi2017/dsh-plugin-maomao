#!/usr/bin/env node
// Usage: node scripts/humanlike-report.mjs <file> [--json]
// <file> is a QQ ordinary dialogue.sqlite3 (turns table) or a .jsonl of {"user","reply"} lines.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { scoreReplies } from '../integrations/maomao-dsh/humanlike.mjs';

const [file, flag] = process.argv.slice(2);
if (!file) {
  console.error('Usage: node scripts/humanlike-report.mjs <dialogue.sqlite3|replies.jsonl> [--json]');
  process.exit(2);
}

function load(path) {
  if (/\.sqlite3?$|\.db$/.test(path)) {
    const db = new DatabaseSync(path);
    try {
      return db.prepare("SELECT user_text, assistant_text FROM turns WHERE assistant_text!='' ORDER BY received")
        .all().map((row) => ({ user: row.user_text.replace(/^\[群成员 [0-9a-f]{12}\] /, ''), reply: row.assistant_text }));
    } finally { db.close(); }
  }
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
}

const { metrics, findings } = scoreReplies(load(file));
if (flag === '--json') {
  console.log(JSON.stringify({ metrics, findings }, null, 2));
} else {
  console.log(`回复数 ${metrics.replies}，平均 ${metrics.meanLength} 字，长度变异系数 ${metrics.lengthVariation}`);
  console.log(`问句结尾 ${metrics.questionEndingRate}，复述对方 ${metrics.echoRate}，颜文字 ${metrics.kaomojiRate}，最常见开头「${metrics.topOpener.text}」${metrics.topOpener.rate}`);
  console.log(findings.length ? findings.map((f) => `- [${f.code}] ${f.message}`).join('\n') : '没有发现明显的机器人式习惯。');
}
