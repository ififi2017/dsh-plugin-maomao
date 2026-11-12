import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MaomaoQqConnector } from '../index.mjs';
import { GeminiSpeech } from '../speech.mjs';

test('QQ voice reuses only a delivered same-speaker voice, and falls back before delivery starts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maomao-voice-'));
  const config = { MAOMAO_QQ_APP_ID: 'test-app', MAOMAO_QQ_APP_SECRET: 'test-secret',
    MAOMAO_QQ_CONNECT: 'I_STOPPED_HERMES_QQ' };
  const old = Object.fromEntries(Object.keys(config).map((key) => [key, process.env[key]]));
  Object.assign(process.env, config);
  const wav = Buffer.alloc(48);
  wav.write('RIFF');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVE', 8);
  const synthesis = [];
  const speech = new GeminiSpeech({ key: 'test-key', model: 'gemini-3.8-flash-lite-tts', voice: 'Kore', async fetchImpl(url, request) {
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
    const payload = JSON.parse(request.body);
    assert.equal(payload.model, 'gemini-3.8-flash-lite-tts');
    assert.deepEqual(payload.generation_config.speech_config, [{ voice: 'Kore' }]);
    const { text, annotations } = payload.input[0].content[0];
    assert.equal(annotations[0].type, 'speech_metadata');
    synthesis.push(text);
    return text === '上传前故障'
      ? Response.json({}, { status: 503 })
      : Response.json({ steps: [{ type: 'model_output',
        content: [{ type: 'audio', data: wav.toString('base64') }] }] });
  } });
  const sent = [];
  const voiceTurns = [];
  let finishRun;
  const bot = { use() {}, on() {}, start() { return new Promise((resolve) => { finishRun = resolve; }); },
    stop() { finishRun?.(); }, async uploadMedia(req) {
      assert.deepEqual(req.buffer, wav);
      assert.equal(req.fileType, 3);
      assert.equal(req.srvSendMsg, false);
      return { file_info: 'voice-token' };
    }, async send(req) {
      sent.push(req);
      if (req.target.msgId === 'uncertain') throw new Error('network');
      return { id: `sent-${sent.length}` };
    } };
  const models = { mediaChoice: (role) => role === 'voice' ? { enabled: true } : null, mediaAdapter: async () => speech };
  const connector = new MaomaoQqConnector({ sessionController: {}, emit() {}, logger: { warn() {}, error() {} },
    get: (key) => key === 'maomaoModels' ? models : undefined },
    { statePath: join(root, 'state.json'), ordinary: { root: join(root, 'ordinary') },
      groupAllowlist: ['test-group', 'other-group'] },
    { botFactory: () => bot, harness: { async ask(envelope, { voice, chatTools }) {
      voiceTurns.push(voice);
      const definitions = new Map();
      const close = chatTools.bind('voice-session', { register(definition) {
        definitions.set(definition.name, definition); return () => definitions.delete(definition.name);
      } });
      try {
        // This fake LLM deliberately chooses based on the whole turn, not a connector classifier.
        if (['other', 'other-group', 'deny'].includes(envelope.messageId)) return '好的，用文字回答。';
        const text = envelope.messageId === 'japanese' ? 'おやすみ。' : envelope.messageId === 'fallback' ? '上传前故障' : '晚安喵。';
        const outcome = await definitions.get('maomao_speak').execute({ text }, {
          agent: { id: 'voice-session' }, signal: AbortSignal.timeout(2000), concludeTurn() {},
        });
        // After a sent (or uncertain) voice this fake model chooses to say nothing more.
        return outcome.status === 'unavailable' ? '这次语音没发出去，先给你文字版。' : '';
      } finally { close(); }
    } } });
  const deliver = async (messageId, content, senderId = 'member-a', groupOpenid = 'test-group', count = 1) => {
    const expected = sent.length + count;
    await connector.accept({ messageId, kind: 'group', rawEventType: 'GROUP_AT_MESSAGE_CREATE',
      senderId, groupOpenid, content: `<@123456> ${content}`, attachments: [] });
    const until = Date.now() + 3000;
    while (sent.length < expected && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(sent.length, expected);
  };
  try {
    await connector.start();
    await deliver('first', '请用语音说一句晚安');
    await deliver('other', '用日语再来一下', 'member-b');
    await deliver('other-group', '用日语再来一下', 'member-a', 'other-group');
    await deliver('japanese', '用日语再来一下');
    assert.equal(voiceTurns[3].previous, '晚安喵。');
    assert.equal(voiceTurns[1], null);
    assert.equal(voiceTurns[2], null);
    await deliver('deny', '不要用语音，再说一遍');
    await deliver('fallback', '请用语音回复', 'member-a', 'test-group', 1);
    await deliver('uncertain', '请用语音回复');
    assert.deepEqual(sent.map((req) => req.msgType), [7, 0, 0, 7, 0, 0, 7]);
    assert.match(sent[5].content, /文字版/);
    assert.deepEqual(synthesis, ['晚安喵。', 'おやすみ。', '上传前故障', '晚安喵。']);
  } finally {
    await connector.stop();
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
