import { randomBytes } from 'node:crypto';
import { mkdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import qrcode from 'qrcode-terminal';
import { telegramInbound } from './identity.mjs';
import { identifyTelegramBot, telegramBotId, telegramCall, telegramError } from './telegram-api.mjs';

const usernamePattern = /^[a-z][a-z0-9_]{4,31}$/i;
const validUserId = (id) => Number.isSafeInteger(id) && id > 0;

function pollingUpdates(call, signal, allowedUpdates) {
  let offset;
  return async (timeout) => {
    signal.throwIfAborted();
    const result = await call('getUpdates', { offset, timeout, limit: 100, allowed_updates: allowedUpdates }, signal, 35_000);
    if (!Array.isArray(result)) throw telegramError('telegram_invalid_updates');
    const updates = result.filter((update) => Number.isSafeInteger(update?.update_id) && update.update_id >= (offset ?? 0));
    for (const { update_id } of updates) offset = Math.max(offset ?? 0, update_id + 1);
    return updates;
  };
}

async function nextMatching(read, match, signal) {
  let retry = 500;
  for (;;) {
    let updates;
    try {
      updates = await read(25);
      retry = 500;
    } catch (error) {
      signal.throwIfAborted();
      if (!/^telegram_(?:network|http_5\d\d)$/.test(error?.code ?? '')) throw error;
      await pause(retry, undefined, { signal });
      retry = Math.min(retry * 2, 5_000);
      continue;
    }
    for (const update of updates) {
      const value = match(update);
      if (value) return value;
    }
  }
}

async function pairOwner({ bot, read, onQr, ownerId, signal }) {
  const challenge = randomBytes(24).toString('base64url');
  const since = Date.now();
  onQr({ step: 'pair', url: `https://t.me/${bot.username}?start=${challenge}` });
  return nextMatching(read, (update) => {
    const event = telegramInbound(String(bot.id), update);
    return event?.text === `/start ${challenge}` && event.sentAt >= since - 5_000
      && (!ownerId || event.senderId === ownerId) ? event.senderId : null;
  }, signal);
}

export async function provisionTelegram({ token, mode, username = `maomao_${randomBytes(5).toString('hex')}_bot`,
  ownerId, signal, onQr, request = telegramCall }) {
  if (!['existing', 'managed'].includes(mode) || (mode === 'managed' && (!usernamePattern.test(username) || !/bot$/i.test(username)))) {
    throw telegramError('telegram_setup_options_invalid');
  }
  const botId = telegramBotId(token);
  if (!botId) throw telegramError('telegram_setup_token_required');
  const call = request.bind(null, token);
  const bot = await identifyTelegramBot(call, botId, signal);
  if (!usernamePattern.test(bot.username ?? '')) throw telegramError('telegram_setup_username_invalid');
  if (mode === 'managed' && bot.can_manage_bots !== true) throw telegramError('telegram_management_disabled');
  const read = pollingUpdates(call, signal, mode === 'managed' ? ['message', 'managed_bot'] : ['message']);
  const senderId = await pairOwner({ bot, read, onQr, ownerId, signal });
  if (mode === 'existing') return { bot, token, senderId };

  // Managed updates carry no timestamp. Advance past pending updates before opening the creation link.
  for (let pending = 0; (await read(0)).length; pending++) {
    if (pending >= 9) throw telegramError('telegram_manager_queue_busy');
  }
  const link = new URL(`https://t.me/newbot/${bot.username}/${username}`);
  link.searchParams.set('name', '猫猫 Harness 测试');
  onQr({ step: 'create', url: link.href });
  const managed = await nextMatching(read, ({ managed_bot: event }) => {
    if (event?.user?.is_bot !== false || String(event.user.id) !== senderId
      || event.bot?.is_bot !== true || !validUserId(event.bot.id)
      || event.bot.username?.toLowerCase() !== username.toLowerCase()) return null;
    return event.bot;
  }, signal);
  const newToken = await call('getManagedBotToken', { user_id: managed.id }, signal);
  const newBotId = String(managed.id);
  if (telegramBotId(newToken) !== newBotId || newBotId === botId) throw telegramError('telegram_wrong_managed_bot');
  const newBot = await identifyTelegramBot(request.bind(null, newToken), newBotId, signal);
  if (newBot.username?.toLowerCase() !== username.toLowerCase()) throw telegramError('telegram_wrong_managed_bot');
  return { bot: newBot, token: newToken, senderId };
}

export async function setupTelegram({ token, mode = 'existing', username, owner = 'telegram-local-owner', ownerId,
  output, signal, onQr, request = telegramCall }) {
  if (!['existing', 'managed'].includes(mode) || !/^[\w-]{1,128}$/.test(owner)
    || (ownerId && !/^[1-9]\d{0,15}$/.test(ownerId))) throw telegramError('telegram_setup_options_invalid');
  username ??= `maomao_${randomBytes(5).toString('hex')}_bot`;
  if (mode === 'managed' && (!usernamePattern.test(username) || !/bot$/i.test(username))) {
    throw telegramError('telegram_setup_username_invalid');
  }
  if (!telegramBotId(token)) throw telegramError('telegram_setup_token_required');
  signal.throwIfAborted();
  await mkdir(dirname(output), { mode: 0o700, recursive: true });
  await mkdir(output, { mode: 0o700 });
  let saved = false;
  try {
    const { bot, token: botToken, senderId } = await provisionTelegram({ token, mode, username, ownerId, signal, onQr, request });
    signal.throwIfAborted();
    const accountId = String(bot.id);
    const endpoint = { platform: 'telegram', accountId, senderId, chatId: senderId };
    const patch = [{ id: 'maomao-dsh-private', config: {
      enabled: true, telegram: { enabled: true, accountId, enrollment: false },
      bindings: [{ owner, endpoints: [endpoint] }], memory: { enabled: false }, sharing: { enabled: false },
    } }];
    await writeFile(join(output, 'telegram.env'), `MAOMAO_DSH_TELEGRAM_TOKEN=${botToken}\n`, { flag: 'wx', mode: 0o600 });
    await writeFile(join(output, 'telegram.patch.yml'), JSON.stringify(patch, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    saved = true;
    return { username: bot.username, output };
  } finally {
    if (!saved) {
      await Promise.allSettled(['telegram.env', 'telegram.patch.yml'].map((name) => unlink(join(output, name))));
      await rmdir(output).catch(() => undefined);
    }
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    managed: { type: 'boolean' }, username: { type: 'string' }, owner: { type: 'string' },
    'owner-id': { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('npm run setup:telegram -- [--managed [--username new_bot]] [--owner ALIAS] [--owner-id ID] [--output NEW_DIRECTORY]');
    return;
  }
  if (values.username && !values.managed) throw telegramError('telegram_setup_options_invalid');
  const output = resolve(values.output ?? join(homedir(), '.config', 'maomao', 'dsh-telegram-test'));
  const token = values.managed ? process.env.MAOMAO_DSH_TELEGRAM_MANAGER_TOKEN : process.env.MAOMAO_DSH_TELEGRAM_TOKEN;
  const cancel = new AbortController();
  const stop = () => cancel.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const result = await setupTelegram({ token, mode: values.managed ? 'managed' : 'existing', username: values.username,
      owner: values.owner, ownerId: values['owner-id'], output, signal: AbortSignal.any([cancel.signal, AbortSignal.timeout(720_000)]),
      onQr({ step, url }) {
        console.log(step === 'create' ? '扫码创建新 Bot，并保留预填的用户名。' : '用自己的 Telegram 账号扫码并点击 Start。');
        qrcode.generate(url, { small: true }, (qr) => console.log(qr));
        console.log(url);
      },
    });
    console.log(`@${result.username} 已配对。凭据和 Harness 配置保存在 ${result.output}`);
    if (values.managed) console.log(`打开 https://t.me/${result.username} 并点击 Start 后即可发消息。`);
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    if (error?.code === 'EEXIST') console.error('输出目录已存在，请指定新目录。');
    else if (error?.code === 'telegram_setup_token_required') console.error('请从本机凭据文件载入 Bot Token。管理模式使用 MAOMAO_DSH_TELEGRAM_MANAGER_TOKEN。');
    else if (error?.code === 'telegram_management_disabled') console.error('请先在 @BotFather Mini App 为管理 Bot 开启 Bot Management Mode。');
    else if (['telegram_http_409', 'telegram_webhook_or_status_unknown'].includes(error?.code)) console.error('Bot 有其他收件连接。请使用独立测试 Bot，或先停用现有接收服务。');
    else if (['AbortError', 'TimeoutError'].includes(error?.name)) console.error('Telegram 配对已取消或超时。');
    else console.error('Telegram 配对未完成，请检查网络、Bot 凭据和扫码账号。');
    process.exitCode = 1;
  });
}
