import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { weixinInbound, PrivateBindings } from '../identity.mjs';
import { parseIlinkJson, provisionWeixin } from '../weixin-api.mjs';
import { WeixinTransport } from '../weixin-transport.mjs';

const json = (value, headers = {}) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json', ...headers } });
const secret = JSON.stringify({ token: 'bot-token', baseUrl: 'https://ilinkai.weixin.qq.com', userId: 'owner@im.wechat' });
const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

test('WeChat messages become private-chat events: text, voice transcript, quote and image; groups and bot echoes are dropped', () => {
  const now = Date.now();
  const event = weixinInbound('bot@im.bot', { message_type: 1, message_id: '7412345678901234567', from_user_id: 'owner@im.wechat',
    create_time_ms: now, context_token: 'ctx', item_list: [
      { type: 1, text_item: { text: '看看这个' }, ref_msg: { title: '上一条说的' } },
      { type: 3, voice_item: { text: '今天好累' } },
      { type: 2, image_item: { aeskey: '00112233445566778899aabbccddeeff', media: { encrypt_query_param: 'q' } } },
    ] }, now);
  assert.equal(event.platform, 'weixin');
  assert.equal(event.chatId, 'owner@im.wechat');
  assert.equal(event.messageId, '7412345678901234567');
  assert.equal(event.text, '[引用] 上一条说的\n看看这个\n[语音] 今天好累');
  assert.equal(event.media.weixin.encrypt_query_param, 'q');
  assert.equal(weixinInbound('bot@im.bot', { message_type: 2, message_id: '1', from_user_id: 'owner@im.wechat', create_time_ms: now,
    item_list: [{ type: 1, text_item: { text: 'echo' } }] }, now), null, 'the bot\'s own messages');
  assert.equal(weixinInbound('bot@im.bot', { message_type: 1, message_id: '2', group_id: 'g', from_user_id: 'owner@im.wechat',
    create_time_ms: now, item_list: [{ type: 1, text_item: { text: 'hi' } }] }, now), null, 'groups are not offered');
  assert.equal(parseIlinkJson('{"message_id":7412345678901234567}').message_id, '7412345678901234567', 'uint64 ids keep their digits');
  assert.doesNotThrow(() => new PrivateBindings([{ owner: 'me', endpoints: [{ platform: 'weixin', accountId: 'bot@im.bot',
    senderId: 'owner@im.wechat', chatId: 'owner@im.wechat' }] }]));
});

test('scan to connect: QR code, scanned, confirmed; the scanning WeChat becomes the account 猫猫 chats with', async () => {
  const shown = [];
  const statuses = [{ status: 'wait' }, { status: 'scaned' },
    { status: 'confirmed', bot_token: 'bot-token', ilink_bot_id: 'bot@im.bot', ilink_user_id: 'owner@im.wechat', baseurl: 'https://ilinkai.weixin.qq.com' }];
  const fetchImpl = async (url) => {
    if (String(url).includes('get_bot_qrcode')) return json({ qrcode: 'qr-1', qrcode_img_content: 'https://liteapp.weixin.qq.com/q/abc' });
    return json(statuses.shift());
  };
  const result = await provisionWeixin({ signal: AbortSignal.timeout(3000), onQr: (qr) => shown.push(qr.step), fetchImpl, pollMs: 1 });
  assert.deepEqual(shown, ['scan', 'confirm']);
  assert.equal(result.accountId, 'bot@im.bot');
  assert.deepEqual(JSON.parse(result.secret), { token: 'bot-token', baseUrl: 'https://ilinkai.weixin.qq.com', userId: 'owner@im.wechat' });
  await assert.rejects(provisionWeixin({ signal: AbortSignal.timeout(3000), onQr() {}, pollMs: 1,
    fetchImpl: async (url) => String(url).includes('get_bot_qrcode')
      ? json({ qrcode: 'q', qrcode_img_content: 'https://evil.example.com/q' }) : json({ status: 'wait' }) }), /invalid_qr/);
});

test('the transport receives messages, resumes from its saved cursor, and replies with the sender\'s context token', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maomao-weixin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sent = [];
  const key = randomBytes(16);
  let polls = 0;
  let uploadKey = '';
  const abort = new AbortController();
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const body = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : null;
    if (path.endsWith('/getupdates')) {
      polls += 1;
      if (polls === 1) {
        assert.equal(body.get_updates_buf, '');
        assert.equal(init.headers.Authorization, 'Bearer bot-token');
        return json({ ret: 0, get_updates_buf: 'cursor-1', msgs: [{ message_type: 1, message_id: '11', from_user_id: 'owner@im.wechat',
          create_time_ms: Date.now(), context_token: 'ctx-11', item_list: [
            { type: 1, text_item: { text: '在吗' } },
            { type: 2, image_item: { aeskey: key.toString('hex'), media: { encrypt_query_param: 'img' } } }] }] });
      }
      abort.abort();
      return json({ ret: 0, get_updates_buf: 'cursor-1', msgs: [] });
    }
    if (path.endsWith('/sendmessage')) { sent.push(body.msg); return json({ ret: 0, message_id: 900 + sent.length }); }
    if (path.endsWith('/getuploadurl')) { uploadKey = body.aeskey; return json({ upload_param: 'up' }); }
    if (path.endsWith('/upload')) {
      // The upload carries the image encrypted with the key announced in getuploadurl.
      const announced = Buffer.from(uploadKey, 'hex');
      const decipher = createDecipheriv('aes-128-ecb', announced, null);
      assert.deepEqual(Buffer.concat([decipher.update(Buffer.from(init.body)), decipher.final()]), png);
      return new Response('', { status: 200, headers: { 'x-encrypted-param': 'down-1' } });
    }
    if (path.endsWith('/download')) {
      const cipher = createCipheriv('aes-128-ecb', key, null);
      return new Response(Buffer.concat([cipher.update(png), cipher.final()]));
    }
    throw new Error(`unexpected ${path}`);
  };
  const statePath = join(root, 'weixin.json');
  const transport = new WeixinTransport({ accountId: 'bot@im.bot', secret, statePath, fetchImpl });
  assert.equal(transport.voiceNotes, false, 'no voice notes on WeChat');
  const events = [];
  await transport.run(async (event) => { events.push(event); }, abort.signal);
  assert.equal(events.length, 1);
  assert.equal(events[0].text, '在吗');
  const image = await transport.image(events[0], AbortSignal.timeout(2000));
  assert.equal(image.mediaType, 'image/png');
  assert.equal(await transport.reply(events[0], '**在呢**', null, AbortSignal.timeout(2000)), '901');
  assert.equal(sent[0].context_token, 'ctx-11');
  assert.equal(sent[0].to_user_id, 'owner@im.wechat');
  assert.equal(sent[0].item_list[0].text_item.text, '在呢', 'WeChat gets plain text');
  await transport.replyMedia(events[0], { kind: 'image', buffer: png, mediaType: 'image/png', fileName: 'a.png' }, null, AbortSignal.timeout(2000));
  assert.equal(sent[1].item_list[0].type, 2);
  assert.equal(sent[1].item_list[0].image_item.media.encrypt_query_param, 'down-1');
  assert.equal(await transport.replyMedia(events[0], { kind: 'voice', buffer: png }, null, AbortSignal.timeout(2000)), null);
  // A restart resumes from the saved cursor and can still write to the owner (sharing, lonely cat).
  const restarted = new WeixinTransport({ accountId: 'bot@im.bot', secret, statePath, fetchImpl });
  assert.equal(await restarted.send('owner@im.wechat', '想你了', null, AbortSignal.timeout(2000)), '903');
  assert.equal(sent[2].context_token, 'ctx-11');
  await assert.rejects(restarted.send('stranger@im.wechat', 'hi', null, AbortSignal.timeout(2000)), /weixin_no_context/);
});

test('an expired WeChat login stops the transport with a clear reason instead of retrying forever', async () => {
  const transport = new WeixinTransport({ accountId: 'bot@im.bot', secret,
    fetchImpl: async () => json({ ret: -14, errmsg: 'session timeout' }) });
  await assert.rejects(transport.run(async () => {}, AbortSignal.timeout(3000)), /weixin_session_expired/);
});
