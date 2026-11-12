import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from './debug-log.mjs';
import { findSessionHeader, sessionHeaders } from './session-header.mjs';

// 猫猫's chat sessions (QQ, Lark, Telegram) run in their own folder, registered as one DSH project,
// so they sit together in the sidebar instead of under "未分组". The title is set only when the
// project is first created; a rename in DSH is kept.
export const CHAT_WORKSPACE_TITLE = '猫猫的聊天';

export const dshHome = () => process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh');

export function chatWorkspace(ctx, { configured, home = dshHome() } = {}) {
  let ready = null;
  let project = null;
  const checked = new Set();
  const folder = () => (ready ??= (async () => {
    if (configured) return configured;
    // Without DSH's project list there is no group to show; keep DSH's default folder.
    const registry = ctx.get?.('workspaceRegistry');
    if (typeof registry?.create !== 'function') return undefined;
    const dir = join(home, 'integrations', 'maomao-chats');
    await mkdir(dir, { recursive: true });
    project = await registry.create(dir, CHAT_WORKSPACE_TITLE).catch((error) => {
      log('warn', 'plugin', '无法登记猫猫的聊天分组', error?.message ?? String(error));
      return null;
    });
    return dir;
  })().catch((error) => {
    ready = null;
    log('warn', 'plugin', '无法准备猫猫的聊天文件夹', error?.message ?? String(error));
    return configured;
  }));
  // Whether an existing session already runs in the chat folder; one from before the move is
  // replaced on its next message so the conversation shows up in the group.
  const holds = async (sessionId) => {
    const dir = await folder();
    if (!dir || checked.has(sessionId)) return true;
    const header = await findSessionHeader(home, sessionId);
    if (!header) return true;
    if (header.cwd === dir) { checked.add(sessionId); return true; }
    return false;
  };
  // A DSH project lists only the sessions explicitly attached to it; running in its folder is not enough.
  const attach = async (sessionId) => {
    if (!sessionId || !await folder() || typeof project?.attachSession !== 'function') return;
    await project.attachSession(sessionId).catch((error) =>
      log('warn', 'plugin', '会话无法放进猫猫的聊天分组', error?.message ?? String(error)));
  };
  // Sessions already created in the folder before attaching existed.
  const attachExisting = async () => {
    const dir = await folder();
    if (!dir) return 0;
    let count = 0;
    for await (const header of sessionHeaders(home)) {
      if (header.cwd === dir) { await attach(header.id); count += 1; }
    }
    return count;
  };
  // 猫猫's chat sessions left in another folder by earlier versions. Archiving hides them and can be
  // undone in DSH; a chat still bound to one starts a fresh session in the group on its next message.
  const archiveOutside = async (presets = ['maomao-qq-ordinary', 'maomao-private-ordinary']) => {
    const dir = await folder();
    const registry = ctx.get?.('workspaceRegistry');
    if (!dir || typeof registry?.archiveSession !== 'function') return 0;
    let count = 0;
    for await (const header of sessionHeaders(home)) {
      if (!presets.includes(header.agentPreset) || header.cwd === dir) continue;
      try { await registry.archiveSession(header.id, { stopActivity: true }); count += 1; }
      catch (error) { log('warn', 'plugin', '旧聊天会话无法归档', { session: header.id, error: error?.message ?? String(error) }); }
    }
    return count;
  };
  return { folder, holds, attach, attachExisting, archiveOutside };
}
