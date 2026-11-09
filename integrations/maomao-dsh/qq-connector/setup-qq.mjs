import { mkdir, open, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { qrConnect, startQrConnect } from '@tencent-connect/qqbot-connector';
import { QQBot } from '@tencent-connect/qqbot-nodejs';

export function qqCredentials({ appId, appSecret } = {}) {
  if (typeof appId !== 'string' || !/^\d{1,32}$/.test(appId)
    || typeof appSecret !== 'string' || !/^[A-Za-z0-9_=-]{8,512}$/.test(appSecret)) {
    throw Object.assign(new Error('Invalid QQ credentials'), { code: 'qq_credentials_invalid' });
  }
  return { appId, secret: appSecret };
}

export async function verifyQQ({ appId, secret, signal }) {
  qqCredentials({ appId, appSecret: secret });
  signal.throwIfAborted();
  const bot = new QQBot({ appId, appSecret: secret, accountId: appId, transport: 'websocket' });
  if (!await bot.api.getToken()) throw new Error('QQ token verification failed');
  signal.throwIfAborted();
}

export function provisionQQ({ signal, onQr, connect = startQrConnect }) {
  signal.throwIfAborted();
  return new Promise((resolveResult, reject) => {
    let dispose;
    const done = (error, value) => {
      signal.removeEventListener('abort', cancel);
      if (error) reject(error);
      else resolveResult(value);
    };
    const cancel = () => {
      dispose?.();
      done(signal.reason);
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      dispose = connect({
        onSuccess(result) {
          try {
            if (!Array.isArray(result) || result.length !== 1) throw new Error('qq_credentials_count_invalid');
            done(null, qqCredentials(result[0]));
          } catch (error) { done(error); }
        },
        onFailure(error) { done(error); },
        onQrDisplayed(url) {
          try { onQr({ url }); }
          catch (error) { dispose?.(); done(error); }
        },
        onQrExpired() { onQr(null); },
      }, { signal, displayQrCodeToConsole: false });
    } catch (error) { done(error); }
  });
}

export async function setupQQ({ output, signal, connect = qrConnect }) {
  signal.throwIfAborted();
  await mkdir(dirname(output), { mode: 0o700, recursive: true });
  const file = await open(output, 'wx', 0o600);
  let saved = false;
  try {
    const credentials = await connect({ signal }).catch((error) => {
      signal.throwIfAborted();
      throw error;
    });
    signal.throwIfAborted();
    if (!Array.isArray(credentials) || credentials.length !== 1) throw new Error('qq_credentials_count_invalid');
    const { appId, secret: appSecret } = qqCredentials(credentials[0]);
    await file.writeFile(`MAOMAO_QQ_APP_ID=${appId}\nMAOMAO_QQ_APP_SECRET=${appSecret}\n`);
    await file.sync();
    saved = true;
    return { appId, output };
  } finally {
    await file.close();
    if (!saved) await unlink(output);
  }
}

async function main() {
  const { values } = parseArgs({ options: { output: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) {
    console.log('npm run setup:qq -- [--output /absolute/path.env]');
    return;
  }
  const output = resolve(values.output ?? join(homedir(), '.config', 'maomao', 'dsh-qq-test.env'));
  const cancel = new AbortController();
  const stop = () => cancel.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const result = await setupQQ({ output, signal: AbortSignal.any([cancel.signal, AbortSignal.timeout(720_000)]) });
    console.log(`已保存 QQ Bot ${result.appId} 的凭据到 ${result.output}`);
    console.log('启动隔离测试连接器后，可用 /sid 获取 QQ 主人和测试群的 OpenID。');
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    if (error?.code === 'EEXIST') console.error('凭据文件已存在，请用 --output 指定新文件。');
    else if (['AbortError', 'TimeoutError'].includes(error?.name)) console.error('QQ 扫码已取消或超时。');
    else console.error('QQ 扫码未完成，请检查网络和 QQ 机器人管理权限。');
    process.exitCode = 1;
  });
}
