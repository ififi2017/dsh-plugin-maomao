import { mkdir, open, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { registerApp } from '@larksuiteoapi/node-sdk';
import qrcode from 'qrcode-terminal';

const VERIFY_HOSTS = { feishu: 'open.feishu.cn', lark: 'open.larksuite.com' };

export async function provisionFeishu({ brand, images, signal, onQr, register = registerApp }) {
  if (!['feishu', 'lark'].includes(brand)) throw new Error('invalid_brand');
  signal.throwIfAborted();
  let detectedBrand = 'feishu';
  const result = await register({
    // The SDK starts on Feishu and switches polling when it detects a Lark tenant.
    domain: 'accounts.feishu.cn',
    createOnly: true,
    appPreset: { name: '猫猫 Harness 测试', desc: '猫猫的普通私聊和群聊机器人' },
    addons: {
      preset: false,
      // group_at_msg lets Lark deliver group messages that @-mention the bot; nothing else from groups.
      scopes: { tenant: ['im:message.p2p_msg:readonly', 'im:message.group_at_msg:readonly', 'im:message:send_as_bot',
        ...(images ? ['im:resource', 'im:message:readonly'] : [])] },
      events: { items: { tenant: ['im.message.receive_v1'] } },
    },
    signal,
    onStatusChange({ status }) {
      if (status === 'domain_switched') detectedBrand = 'lark';
    },
    onQRCodeReady({ url, expireIn }) {
      const destination = new URL(url);
      if (destination.protocol !== 'https:' || destination.username || destination.password || destination.port
        || !Object.values(VERIFY_HOSTS).includes(destination.hostname)
        || !['/page/launcher', '/page/cli'].includes(destination.pathname) || !destination.searchParams.get('user_code')) {
        throw new Error('invalid_feishu_authorization_url');
      }
      destination.hostname = VERIFY_HOSTS[brand];
      onQr({ url: destination.href, expireIn });
    },
  });
  signal.throwIfAborted();
  const actualBrand = result?.user_info?.tenant_brand ?? detectedBrand;
  if (!/^cli_[A-Za-z0-9_-]{1,120}$/.test(result?.client_id ?? '')
    || !/^[A-Za-z0-9_=-]{8,512}$/.test(result?.client_secret ?? '')
    || !['feishu', 'lark'].includes(actualBrand)) throw new Error('invalid_feishu_credentials');
  return { brand: actualBrand, appId: result.client_id, secret: result.client_secret };
}

export async function registerTestApp({ path, ...options }) {
  options.signal.throwIfAborted();
  await mkdir(dirname(path), { mode: 0o700, recursive: true });
  const file = await open(path, 'wx', 0o600);
  let saved = false;
  try {
    const { brand, appId, secret } = await provisionFeishu(options);
    await file.writeFile([
      `MAOMAO_DSH_FEISHU_APP_ID=${appId}`,
      `MAOMAO_DSH_FEISHU_APP_SECRET=${secret}`,
      `MAOMAO_DSH_FEISHU_BRAND=${brand}`,
      '',
    ].join('\n'));
    await file.sync();
    saved = true;
    return { brand, appId, path };
  } finally {
    await file.close();
    if (!saved) await unlink(path);
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    brand: { type: 'string', default: 'feishu' },
    output: { type: 'string' },
    images: { type: 'boolean' },
    help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('npm run setup:feishu -- [--brand feishu|lark] [--images] [--output /absolute/path.env]');
    return;
  }
  if (!['feishu', 'lark'].includes(values.brand)) throw new Error('invalid_brand');
  const path = resolve(values.output ?? join(homedir(), '.config', 'maomao', `dsh-${values.brand}-test.env`));
  const cancel = new AbortController();
  const stop = () => cancel.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const result = await registerTestApp({ brand: values.brand, images: values.images, path,
      signal: AbortSignal.any([cancel.signal, AbortSignal.timeout(12 * 60_000)]),
      onQr({ url, expireIn }) {
        const waiting = Number.isFinite(expireIn) ? Math.min(expireIn, 720) : 720;
        console.log(`请用飞书或 Lark 扫码，确认创建测试应用。此命令最多等待 ${waiting} 秒。`);
        qrcode.generate(url, { small: true }, (image) => console.log(image));
        console.log('也可打开下面的完整授权链接：');
        console.log(url);
      },
    });
    console.log(`已保存 ${result.brand} 应用 ${result.appId} 的凭据到 ${result.path}`);
    console.log('接下来启动测试连接，再从机器人私聊验证 /sid。');
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    if (error?.code === 'EEXIST') console.error('凭据文件已存在，请用 --output 指定新文件。');
    else if (['abort', 'expired_token', 'access_denied'].includes(error?.code)) console.error(`扫码未完成（${error.code}）。`);
    else console.error('扫码配置未完成。请检查参数、网络和飞书应用创建权限。');
    process.exitCode = 1;
  });
}
