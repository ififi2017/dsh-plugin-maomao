const MAX_WAV_BYTES = 2_000_000;

export function spokenTranscript(answer) {
  return answer.replaceAll('<|bubble|>', ' ')
    .replace(/\[[^\]\n]{1,50}\]|[（(][^）)\n]{1,50}[）)]/gu, '')
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '')
    .replace(/\s+/g, ' ').trim();
}

export class GeminiSpeech {
  #key;
  #fetch;
  #model;
  #voice;

  constructor({ key, model = 'gemini-3.8-flash-tts', voice = 'Aoede', fetchImpl = fetch }) {
    if (!key) throw new Error('qq_voice_key_unavailable');
    this.#key = key;
    this.#fetch = fetchImpl;
    this.#model = model;
    this.#voice = voice;
  }

  async synthesize(text, signal) {
    if (!text || text.length > 400 || /https?:\/\/|[`<>]|MEDIA:/i.test(text)) {
      throw new Error('qq_voice_invalid_transcript');
    }
    const style = /辛苦|别怕|没事|晚安|抱抱|难过|心疼/u.test(text)
      ? 'gentle and reassuring, with natural phrasing and an unhurried pace'
      : /杂鱼|ざこ|ざぁこ|笨蛋|哼哼|不会吧/u.test(text)
        ? 'playful and lightly teasing, like a casual voice message to a friend'
        : 'warm and playful, with natural conversational rhythm and brief pauses at punctuation';
    const response = await this.#fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST', redirect: 'error',
      headers: { 'x-goog-api-key': this.#key, 'content-type': 'application/json' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
      body: JSON.stringify({
        model: this.#model,
        input: [{ type: 'user_input', content: [{ type: 'text', text,
          annotations: [{ type: 'speech_metadata', style }] }] }],
        response_format: { type: 'audio' },
        generation_config: { speech_config: [{ voice: this.#voice }] },
      }),
    });
    if (!response.ok) {
      const code = `qq_voice_provider_http_${response.status}`;
      throw Object.assign(new Error(code), { code });
    }
    const result = await response.json();
    const items = [...(result?.steps ?? []).filter((step) => step.type === 'model_output')
      .flatMap((step) => step.content ?? []), ...(result?.outputs ?? [])];
    const data = items.findLast((item) => ['audio', 'output_audio'].includes(item.type))?.data;
    if (typeof data !== 'string' || data.length > Math.ceil(MAX_WAV_BYTES / 3) * 4
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error('qq_voice_invalid_audio');
    const wav = Buffer.from(data, 'base64');
    if (wav.length <= 44 || wav.length > MAX_WAV_BYTES || wav.toString('ascii', 0, 4) !== 'RIFF'
      || wav.toString('ascii', 8, 12) !== 'WAVE' || wav.readUInt32LE(4) + 8 > wav.length) {
      throw new Error('qq_voice_invalid_wav');
    }
    return wav;
  }
}
