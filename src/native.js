// Node side of the native camera (native/capture.swift, built on first use).
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { HOME } from './browser.js';

const run = promisify(execFile);
const SRC = fileURLToPath(new URL('../native/capture.swift', import.meta.url));
const BIN = path.join(HOME, 'bin', 'autodemo-capture');

export async function helper() {
  if (process.platform !== 'darwin') throw new Error('Camera mode needs macOS (ScreenCaptureKit).');
  const stale = !fs.existsSync(BIN) || fs.statSync(BIN).mtimeMs < fs.statSync(SRC).mtimeMs;
  if (stale) {
    fs.mkdirSync(path.dirname(BIN), { recursive: true });
    try {
      await run('swiftc', ['-O', '-parse-as-library', SRC, '-o', BIN], { timeout: 300000 });
    } catch (e) {
      throw new Error(`Could not build the native recorder (needs Xcode Command Line Tools: xcode-select --install). ${e.stderr || e.message}`);
    }
  }
  return BIN;
}

async function call(args) {
  const { stdout } = await run(await helper(), args, { timeout: 30000 }).catch((e) => ({ stdout: e.stdout || '' }));
  const out = JSON.parse(stdout.trim().split('\n').pop() || '{}');
  if (out.error) throw new Error(out.error);
  return out;
}

export const windows = async () => (await call(['windows'])).windows;

// Find a window by id, or by app name / title substring.
export async function findWindow(query) {
  const list = await windows();
  if (/^\d+$/.test(String(query))) return list.find((w) => w.id === Number(query));
  const q = String(query).toLowerCase();
  return list.find((w) => w.app.toLowerCase() === q) || list.find((w) => `${w.app} ${w.title}`.toLowerCase().includes(q));
}

// No window id = the whole screen. Screen capture is what screen recorders use; it keeps working
// even when macOS refuses single-window capture.
// A crop {x, y, width, height} records just that area of the screen.
const target = (t) => (!t ? [] : typeof t === 'object' ? ['--crop', [t.x, t.y, t.width, t.height].map(Math.round).join(',')] : ['--window', String(t)]);

// Real input at screen points: act('click', x, y) | act('type', text) | act('key', 'return', 'cmd') | act('scroll', dy)
export const act = (...args) => call(['act', ...args.filter((a) => a !== undefined).map(String)]);

// Is anything (another window, a notification) on top of the filmed area?
export const covered = (crop, app) => call(['front', '--crop', [crop.x, crop.y, crop.width, crop.height].map(Math.round).join(','), '--app', app]);

export const shot = (windowId, out) => call(['shot', ...target(windowId), '--out', out]);

// One continuous recording. stop() resolves once the file is finalized. onDead fires if macOS
// ends the stream mid-take (the caller rotates to a new segment).
export async function startRecording(target_, out, { fps = 60, cursor = false, scale } = {}) {
  const args = ['record', ...target(target_), '--out', out, '--fps', String(fps), ...(cursor ? ['--cursor'] : []), ...(scale ? ['--scale', String(scale)] : [])];
  const p = spawn(await helper(), args, { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = readline.createInterface({ input: p.stdout });
  const waiting = [];
  let exited = null, lastError = '';
  const rec = { onDead: null };
  lines.on('line', (l) => {
    let o; try { o = JSON.parse(l); } catch { return; }
    if (o.dead) return rec.onDead?.(o.dead);
    if (o.log) return;
    if (o.error) lastError = o.error;
    waiting.shift()?.(o);
  });
  p.once('exit', (c) => { exited = c; waiting.splice(0).forEach((w) => w({ error: `recorder stopped early (${lastError || `exit ${c}`})` })); });
  // Never wait forever: a recorder that died, or that macOS stops feeding, fails instead of hanging.
  const next = (ms = 30000) => new Promise((resolve, reject) => {
    if (exited !== null) return reject(new Error(`recorder stopped early (${lastError || `exit ${exited}`})`));
    const t = setTimeout(() => { p.kill(); reject(new Error('recorder did not respond; macOS screen capture may be stuck (log out and back in)')); }, ms);
    waiting.push((o) => { clearTimeout(t); o.error ? reject(new Error(o.error)) : resolve(o); });
  });
  rec.started = await next(); // { started: epochMs, width, height, points: {width, height} }
  // The latest recorded frame (never start a second capture while recording: it kills the recording).
  rec.shot = (file) => { const r = next(); p.stdin.write(`shot ${file}\n`); return r; };
  rec.stop = () => { const r = next(); p.stdin.end('stop\n'); return r; }; // { stopped: epochMs, file }
  return rec;
}
