export function telegramBotId(token) {
  return /^(\d+):[A-Za-z0-9_-]+$/.exec(token ?? '')?.[1] ?? '';
}

export const telegramError = (code) => Object.assign(new Error(code), { code });

export async function telegramCall(token, method, data, signal, { fetchImpl = fetch, ms = 12_000 } = {}) {
  const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
    signal: AbortSignal.any([signal, AbortSignal.timeout(ms)]),
  }).catch(() => { throw telegramError('telegram_network'); });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.ok !== true) {
    const code = Number.isInteger(body?.error_code) ? body.error_code : response.status;
    throw telegramError(`telegram_http_${code}`);
  }
  return body.result;
}

export async function identifyTelegramBot(call, botId, signal, { polling = true } = {}) {
  if (polling) {
    const hook = await call('getWebhookInfo', {}, signal);
    if (!hook || typeof hook.url !== 'string' || hook.url) throw telegramError('telegram_webhook_or_status_unknown');
  }
  const bot = await call('getMe', {}, signal);
  if (String(bot?.id) !== botId || bot?.is_bot !== true) throw telegramError('telegram_wrong_bot');
  return bot;
}
