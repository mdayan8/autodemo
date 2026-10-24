import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './browser.js';

const run = promisify(execFile);
const CACHE = path.join(HOME, 'tts');
let kokoro; // loaded once per process (~90MB model, downloaded on first use)

export async function duration(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  return parseFloat(stdout);
}

// Text -> wav file. Kokoro-82M locally; falls back to macOS `say` if Kokoro can't load.
export async function speak(text, { voice = 'af_heart', speed = 1 } = {}) {
  fs.mkdirSync(CACHE, { recursive: true });
  const key = crypto.createHash('sha1').update(`${voice}|${speed}|${text}`).digest('hex').slice(0, 16);
  const file = path.join(CACHE, `${key}.wav`);
  if (!fs.existsSync(file)) {
    try {
      if (!kokoro) {
        const { KokoroTTS } = await import('kokoro-js');
        kokoro = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'cpu' });
      }
      const audio = await kokoro.generate(text, { voice, speed });
      await audio.save(file);
    } catch (err) {
      console.error(`[autodemo] Kokoro failed (${err.message}); using macOS say`);
      const aiff = file.replace(/\.wav$/, '.aiff');
      await run('say', ['-r', String(Math.round(185 * speed)), '-o', aiff, text]);
      await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', aiff, '-ar', '24000', file]);
      fs.rmSync(aiff, { force: true });
    }
  }
  return { file, d: await duration(file) };
}
