import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';

// The model supplies speech text only. This fixed local conversion never executes model arguments.
export async function opusVoice(wav, signal) {
  if (!Buffer.isBuffer(wav) || wav.length > 2_000_000 || wav.length < 44
    || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('invalid_wav');
  let binary = 'ffmpeg';
  if (process.platform === 'darwin' && await access('/opt/homebrew/bin/ffmpeg', constants.X_OK).then(() => true, () => false)) {
    binary = '/opt/homebrew/bin/ffmpeg';
  }
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['-hide_banner', '-loglevel', 'error', '-f', 'wav', '-i', 'pipe:0',
      '-vn', '-c:a', 'libopus', '-ac', '1', '-ar', '48000', '-b:a', '32k', '-f', 'ogg', 'pipe:1'],
    { stdio: ['pipe', 'pipe', 'ignore'], signal: deadline });
    const chunks = [];
    let size = 0;
    child.on('error', () => reject(new Error('voice_conversion_unavailable')));
    child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > 2_000_000) child.kill(); else chunks.push(chunk);
    });
    child.on('close', (code) => {
      const buffer = Buffer.concat(chunks);
      if (code !== 0 || deadline.aborted || size > 2_000_000 || buffer.toString('ascii', 0, 4) !== 'OggS') {
        reject(new Error('voice_conversion_failed'));
      } else resolve({ buffer, fileName: 'maomao-voice.ogg', mediaType: 'audio/ogg' });
    });
    child.stdin.end(wav);
  });
}
