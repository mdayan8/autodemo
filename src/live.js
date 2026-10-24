// Camera mode: a screen recorder for agents. The agent drives with ITS OWN tools
// (Claude in Chrome, computer use, Playwright MCP, a native app...). autodemo is just the
// camera + editor here: it records the screen (human cursor hidden), takes the agent's
// narration and click marks, finds the action by watching the screen, cuts the agent's
// thinking time, and renders the same polished output as the built-in browser mode.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findWindow, startRecording, shot, act } from './native.js';
import { activity } from './activity.js';
import { speak } from './narrate.js';
import { render } from './render.js';

const run = promisify(execFile);

// Bring the filmed app forward and raise the exact window (an app like Chrome has many).
async function raise({ app, win, tab }) {
  if (tab) return void await showTab(tab);
  if (!app) return;
  await run('osascript', ['-e', `tell ${app} to activate`]).catch(() => {});
  if (win?.title) {
    const t = win.title.replace(/["\\]/g, '');
    await run('osascript', ['-e', `tell application "System Events" to tell (first process whose bundle identifier is "${win.bundle}") to perform action "AXRaise" of (first window whose name is "${t}")`]).catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
  }
}
const PASS = ['trim', 'frame', 'title', 'subtitle', 'output', 'cta', 'summary', 'bubble', 'background', 'music', 'captions'];

// Find a browser tab by URL or title (e.g. "todomvc.com"), make it the active tab, restore and raise its
// window, and return the window's screen rectangle. No share picker and no Accessibility permission:
// browsers expose their windows and tabs to AppleScript.
const BROWSERS = ['Google Chrome', 'Brave Browser', 'Microsoft Edge', 'Chromium', 'Safari'];
export async function showTab(query) {
  const q = query.replace(/["\\]/g, '');
  for (const name of BROWSERS) {
    const safari = name === 'Safari';
    const script = `if application "${name}" is not running then return ""
tell application "${name}"
  repeat with w in windows
    set i to 0
    repeat with t in tabs of w
      set i to i + 1
      if (URL of t contains "${q}") or (${safari ? 'name' : 'title'} of t contains "${q}") then
        set tt to ${safari ? 'name' : 'title'} of t
        set ww to window id (id of w)
        ${safari ? 'set current tab of ww to tab i of ww' : 'set active tab index of ww to i'}
        ${safari ? 'set miniaturized of ww to false' : 'set minimized of ww to false'}
        set index of ww to 1
        activate
        delay 0.4
        return (bounds of ww as list) & {URL of tab i of ww} & {tt}
      end if
    end repeat
  end repeat
end tell
return ""`;
    const { stdout } = await run('osascript', ['-e', script]).catch(() => ({ stdout: '' }));
    const out = stdout.trim();
    if (!out) continue;
    const [l, t, r, b, url, ...title] = out.split(', ');
    return { app: name, title: title.join(', '), url, crop: { x: +l, y: +t, width: r - l, height: b - t } };
  }
  throw new Error(`No open browser tab matches "${query}". Open it first (in Chrome, Brave, Edge or Safari), or pass window instead.`);
}

export class CameraSession {
  static async start(opts) {
    if (opts.tab) { // film one browser tab: found, activated and raised by autodemo itself
      const t = await showTab(opts.tab);
      const s = new CameraSession({ app: t.app, title: t.title, url: t.url }, { ...opts, crop: t.crop });
      s.front = { tab: opts.tab };
      await s.resume();
      return s;
    }
    // A named window is raised and filmed alone (its rectangle of the screen); no window = whole screen.
    const win = opts.window ? await findWindow(opts.window).catch(() => null) : null;
    const app = win?.bundle ? `application id "${win.bundle}"` : opts.window ? `application "${opts.window}"` : null;
    const s0 = { app, win };
    await raise(s0);
    // Film only that window's area of the screen (nothing else on the desktop ends up in the video).
    if (win) opts = { ...opts, crop: { x: win.x, y: win.y, width: win.width, height: win.height } };
    const s = new CameraSession(win || { app: 'Screen', title: 'whole screen' }, opts);
    s.front = s0;
    await s.resume();
    return s;
  }

  constructor(win, opts) {
    this.win = win;
    this.opts = opts;
    this.out = path.resolve(opts.out);
    fs.mkdirSync(this.out, { recursive: true });
    this.segments = [];
    this.events = [];
    this.clock = 0; // session seconds in finished segments (paused time is not part of the video)
    this.cur = null;
  }

  now() { return this.cur ? this.cur.start + (Date.now() - this.cur.epoch) / 1000 : this.clock; }

  async resume() {
    if (this.cur) return;
    const file = path.join(this.out, `segment-${this.segments.length + 1}.mp4`);
    // Retina capture only for 4K output; point size is plenty for 1080p and ~4x smaller (long takes).
    const scale = this.opts.output?.resolution === '4k' ? undefined : 1;
    const rec = await startRecording(this.opts.crop, file, { fps: this.opts.fps || 60, cursor: this.opts.cursor, scale });
    rec.onDead = (why) => { // macOS ended the stream: close this segment and roll a new one
      this.log?.(`stream dropped (${why}); new segment`);
      this.pause().then(() => this.resume()).catch((e) => { this.failure = e; });
    };
    this.points = rec.started.points;
    this.cur = { file, rec, epoch: rec.started.started, start: this.clock };
  }

  async pause() {
    if (!this.cur) return;
    const { stopped } = await this.cur.rec.stop();
    const duration = (stopped - this.cur.epoch) / 1000;
    this.segments.push({ file: path.basename(this.cur.file), start: this.cur.start, duration });
    this.clock += duration;
    this.cur = null;
  }

  mark(e) { this.events.push({ ...e, t: this.now() }); }
  say(text) { this.mark({ type: 'say', text }); }
  chapter(title) { this.mark({ type: 'chapter', title }); }
  // x/y arrive in camera_screenshot pixels; that image is `k` times point size (fewer tokens).
  get k() { return this.opts.shotScale ?? 0.6; }
  pt(x, y) { return [x / this.k, y / this.k]; }
  click(x, y) {
    [x, y] = this.pt(x, y); this.mark({ type: 'click', point: { x, y }, box: { x: x - 30, y: y - 18, width: 60, height: 36 } }); }
  focus(x, y, width = 0, height = 0) {
    [x, y] = this.pt(x, y); width /= this.k; height /= this.k;
    this.mark({ type: 'focus', point: width ? null : { x, y }, box: width ? { x, y, width, height } : { x: x - 60, y: y - 30, width: 120, height: 60 } });
  }

  // For agents with no browser/computer tools of their own: real clicks and keys inside the filmed
  // area. x/y are camera_screenshot coordinates; clicks are also marked for the cursor and zoom.
  async act({ click, type, key, mods, scroll }) {
    const o = this.opts.crop || { x: 0, y: 0 };
    await raise(this.front);
    if (click) { this.click(click[0], click[1]); const [x, y] = this.pt(click[0], click[1]); await act('click', o.x + x, o.y + y); }
    if (type) await act('type', type);
    if (key) await act('key', key, mods);
    if (scroll) await act('scroll', scroll);
  }

  // Cut edges off the whole video (browser info bars, banners). Points, like camera_screenshot.
  setTrim(t) { // given in screenshot pixels
    const p = Object.fromEntries(Object.entries(t).filter(([, v]) => v != null).map(([k, v]) => [k, v / this.k]));
    this.opts.trim = { ...this.opts.trim, ...p };
  }

  // A browser info bar or banner across the top ("Claude started debugging this browser",
  // "Chrome is being controlled...") shows as a flat band unlike the page below it. Returns its
  // height in points, as a hint for the agent to confirm by looking (sites can have dark headers too).
  async topBar(png, height) {
    const rows = 120, cols = 32;
    const { stdout } = await run('ffmpeg', ['-loglevel', 'error', '-i', png, '-vf', `scale=${cols}:${rows},format=rgb24`, '-f', 'rawvideo', '-'],
      { encoding: 'buffer', maxBuffer: 1 << 20 });
    const px = (x, y) => { const k = (y * cols + x) * 3; return [stdout[k], stdout[k + 1], stdout[k + 2]]; };
    const diff = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
    const edge = (y) => px(0, y); // the band's colour at its left edge (no text there)
    const band = edge(1);
    for (let y = 2; y < rows * 0.15; y++) {
      if (diff(edge(y), band) > 45) return y >= rows * 0.025 ? Math.ceil(((y + 1) / rows) * height) : 0;
    }
    return 0;
  }

  // What the camera sees right now, scaled so image pixels = window points (click coordinates).
  async screenshot({ scale = this.k, withHint = false } = {}) {
    const file = path.join(os.tmpdir(), `autodemo-cam-${Date.now()}.png`);
    const info = await (this.cur ? this.cur.rec.shot(file) : shot(this.opts.crop, file));
    const jpg = file.replace(/\.png$/, '.jpg');
    // Sent at `scale` of point size (fewer tokens); coordinates stay in points either way.
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', file, '-vf', `scale=${Math.round(info.points.width * scale)}:-2`, '-q:v', '6', jpg]);
    const data = fs.readFileSync(jpg).toString('base64');
    const bar = withHint ? await this.topBar(file, info.points.height).catch(() => 0) : 0;
    fs.rmSync(file, { force: true }); fs.rmSync(jpg, { force: true });
    return { data, bar: Math.round(bar * scale), width: Math.round(info.points.width * scale), height: Math.round(info.points.height * scale) };
  }

  async stop({ progress = () => {} } = {}) {
    await this.pause();
    if (!this.segments.length) throw new Error('Nothing was recorded.');
    const vp = { width: this.points.width, height: this.points.height };
    progress('finding the action');
    for (const seg of this.segments) {
      const spans = await activity(path.join(this.out, seg.file), { offset: seg.start, aspect: vp.width / vp.height, points: vp });
      this.events.push(...spans.filter((a) => a.end <= seg.start + seg.duration + 0.1));
    }
    // Narration: lines play where the agent said them; a line never talks over the previous one.
    const says = this.events.filter((e) => e.type === 'say').sort((a, b) => a.t - b.t);
    let free = 0;
    for (const [i, e] of says.entries()) {
      progress(`voice ${i + 1}/${says.length}`);
      if (this.opts.voiceover !== false) Object.assign(e, await speak(e.text, { voice: this.opts.voice, speed: this.opts.speed }));
      else e.d = Math.max(1.6, e.text.split(' ').length * 0.32);
      e.t = Math.max(e.t, free);
      e.end = e.t + e.d;
      free = e.end + 0.15;
    }
    const meta = { windowTitle: this.win.title, url: this.win.url, viewport: vp, duration: Math.max(this.clock, free), sources: this.segments, events: this.events.sort((a, b) => a.t - b.t), output: {} };
    for (const k of PASS) if (this.opts[k] !== undefined) meta[k] = this.opts[k];
    fs.writeFileSync(path.join(this.out, 'recording.json'), JSON.stringify(meta, null, 1));
    return render(this.out, { progress });
  }
}
