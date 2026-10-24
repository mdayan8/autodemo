import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { writeExtras } from './share.js';

const INTRO = 2.2; // title card seconds
const OUTRO = 2.6; // call-to-action card seconds
const SIZES = { '4k': [3840, 2160], '1080p': [1920, 1080] };
const easeIO = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Piecewise-linear time map that squeezes idle stretches (page loads, agent thinking)
// so the video never sits on a frozen screen.
export function timeMap(events, duration, { edge = 0.5, keep = 0.3, min = 1.6 } = {}) {
  const busy = [];
  for (const e of events) {
    if (e.type === 'say') busy.push([e.t, e.end]);
    else if (e.type === 'activity') busy.push([e.t, e.end + 0.3]);
    else if (e.type !== 'scene' && e.type !== 'log') busy.push([Math.max(0, e.t - 0.2), (e.end ?? e.t) + 0.8]);
  }
  busy.sort((a, b) => a[0] - b[0]);
  const pts = [[0, 0]]; // [source time, output time]
  const add = (src, dstDelta) => pts.push([src, pts.at(-1)[1] + dstDelta]);
  const idle = (a, b) => {
    if (b - a <= min) return add(b, b - a);
    add(a + edge, edge); add(b - edge, keep); add(b, edge); // keep the edges, fast-forward the middle
  };
  let at = 0;
  for (const [a, b] of busy) {
    if (a > at) idle(at, a);
    if (b > Math.max(a, at)) add(b, b - Math.max(a, at));
    at = Math.max(at, b);
  }
  if (duration > at) idle(at, duration);
  const interp = (x, from, to) => {
    for (let i = 1; i < pts.length; i++) {
      if (x <= pts[i][from]) {
        const [a, b] = [pts[i - 1], pts[i]];
        const span = b[from] - a[from];
        return span ? a[to] + ((x - a[from]) / span) * (b[to] - a[to]) : b[to];
      }
    }
    return pts.at(-1)[to] + (x - pts.at(-1)[from]);
  };
  return { toDst: (s) => interp(s, 0, 1), toSrc: (d) => interp(d, 1, 0), length: pts.at(-1)[1] };
}

// Camera keyframes (source time, source points). Nearby actions share one zoom;
// scrolls, page loads and big screen changes zoom back out.
export function camera(events, vp) {
  const home = { z: 1, cx: vp.width / 2, cy: vp.height / 2 };
  const big = (e) => e.type === 'activity' && e.area > 0.45;
  const breakers = events.filter((e) => e.type === 'goto' || e.type === 'scroll' || big(e)).map((e) => e.t);
  // Stay zoomed while the scene's narration is still talking about this spot.
  const sayEnd = Object.fromEntries(events.filter((e) => e.type === 'say' && e.scene != null).map((e) => [e.scene, e.end]));
  const marks = events.filter((e) => e.box && e.zoom !== false && ['click', 'type', 'hover', 'focus'].includes(e.type));
  // Screen activity only steers the camera where the agent left no explicit marks.
  const near = (t) => marks.some((m) => Math.abs(m.t - t) < 2);
  const acts = [
    ...marks,
    ...events.filter((e) => e.type === 'activity' && e.area > 0.0015 && e.area < 0.2 && !near(e.t)),
  ].sort((a, b) => a.t - b.t).map((e) => ({ ...e, end: Math.max(e.end ?? e.t, (sayEnd[e.scene] ?? 0) - 0.6) }));

  const ZOOM = 1.8 * Math.sqrt(vp.width / 1280); // default auto-zoom; bigger viewports have smaller UI to push into
  const pad = vp.width * 0.11;
  const fit = (x0, y0, x1, y1) => Math.min(vp.width / (x1 - x0 + pad * 2), vp.height / (y1 - y0 + pad * 2));
  const clusters = [];
  for (const a of acts) {
    const c = clusters.at(-1);
    const broken = c && breakers.some((t) => t > c.lastT && t < a.t);
    // Merge into the current shot only if the combined area can still be zoomed in properly.
    const fits = c && fit(Math.min(c.x0, a.box.x), Math.min(c.y0, a.box.y),
      Math.max(c.x1, a.box.x + a.box.width), Math.max(c.y1, a.box.y + a.box.height)) >= 1.45;
    if (c && !broken && fits && a.t - c.end < 2.5) {
      c.end = Math.max(c.end, a.end);
      c.lastT = a.t;
      c.x0 = Math.min(c.x0, a.box.x); c.y0 = Math.min(c.y0, a.box.y);
      c.x1 = Math.max(c.x1, a.box.x + a.box.width); c.y1 = Math.max(c.y1, a.box.y + a.box.height);
      if (typeof a.zoom === 'number') c.force = a.zoom;
    } else {
      clusters.push({ start: a.t, end: a.end, lastT: a.t, x0: a.box.x, y0: a.box.y, x1: a.box.x + a.box.width, y1: a.box.y + a.box.height,
        force: typeof a.zoom === 'number' ? a.zoom : null });
    }
  }
  const K = [{ t: 0, ...home }];
  clusters.forEach((c, i) => {
    const s = { z: c.force ?? clamp(Math.min(ZOOM, fit(c.x0, c.y0, c.x1, c.y1)), 1, 3), cx: (c.x0 + c.x1) / 2, cy: (c.y0 + c.y1) / 2 };
    if (s.z < 1.15) return; // not worth a zoom
    const last = K.at(-1);
    const tin = Math.max(c.start - 0.15, last.t + 0.01);
    K.push({ t: tin, z: last.z, cx: last.cx, cy: last.cy });
    K.push({ t: tin + 0.9, ...s });
    const next = clusters[i + 1];
    const brk = breakers.find((t) => t > c.lastT);
    let hold = Math.min(c.end + 1.3, brk ?? Infinity);
    if (next && next.start - 0.15 < hold + 0.8 && !(brk < next.start)) {
      hold = Math.max(tin + 0.95, next.start - 0.2); // pan straight to the next spot
      K.push({ t: hold, ...s });
    } else {
      hold = Math.max(hold, tin + 0.95);
      K.push({ t: hold, ...s });
      K.push({ t: hold + 0.9, z: 1, cx: s.cx, cy: s.cy });
    }
  });
  return (t) => {
    let i = K.length - 1;
    while (i > 0 && K[i].t > t) i--;
    const a = K[i], b = K[i + 1];
    if (!b) return a;
    const p = easeIO(clamp((t - a.t) / (b.t - a.t), 0, 1));
    return { z: a.z + (b.z - a.z) * p, cx: a.cx + (b.cx - a.cx) * p, cy: a.cy + (b.cy - a.cy) * p };
  };
}

// Visible region (fractions of the source frame) for a camera state.
function crop(cam, vp) {
  const z = Math.max(1, cam.z);
  const w = vp.width / z, h = vp.height / z;
  const x = clamp(cam.cx - w / 2, 0, vp.width - w), y = clamp(cam.cy - h / 2, 0, vp.height - h);
  return [x / vp.width, y / vp.height, w / vp.width, h / vp.height];
}

// Camera mode: the real cursor is never recorded; the agent's cursor is drawn from its click marks.
function cursorTrack(events, vp) {
  const clicks = events.filter((e) => (e.type === 'click' || e.type === 'focus') && e.point).sort((a, b) => a.t - b.t);
  if (!clicks.length) return () => null;
  return (t) => {
    if (t < clicks[0].t - 0.8) return null;
    let i = clicks.findIndex((c) => c.t > t);
    if (i === -1) i = clicks.length;
    const prev = clicks[i - 1], next = clicks[i];
    let p = prev ? prev.point : next.point;
    if (next && t > next.t - 0.7) {
      const from = prev ? prev.point : { x: next.point.x - vp.width * 0.08, y: next.point.y + vp.height * 0.1 };
      const k = easeIO(clamp((t - (next.t - 0.7)) / 0.7, 0, 1));
      p = { x: from.x + (next.point.x - from.x) * k, y: from.y + (next.point.y - from.y) * k };
    }
    const ripple = prev && prev.type === 'click' && t - prev.t < 0.5 ? (t - prev.t) / 0.5 : null;
    return { x: p.x / vp.width, y: p.y / vp.height, ripple };
  };
}

const PAGE = fs.readFileSync(new URL('./compositor.html', import.meta.url), 'utf8');

function ffmpeg(args, stdio = ['pipe', 'ignore', 'inherit']) {
  const p = spawn('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio });
  const done = new Promise((res, rej) => p.on('close', (c) => (c ? rej(new Error(`ffmpeg exited ${c}`)) : res())));
  return { p, done };
}

// Streams JPEG frames of one video segment from ffmpeg, from `start` seconds on, at `fps`.
class VideoReader {
  constructor(file, start, fps, cut) {
    this.start = start; this.fps = fps; this.idx = -1; this.cur = null; this.queue = []; this.waiters = []; this.ended = false;
    // cut = [x, y, w, h] as fractions of the source: trims browser bars/banners off every frame.
    const crop = cut ? `crop=iw*${cut[2]}:ih*${cut[3]}:iw*${cut[0]}:ih*${cut[1]},` : '';
    this.ff = spawn('ffmpeg', ['-loglevel', 'error', '-hwaccel', 'videotoolbox', '-ss', String(start), '-i', file,
      '-vf', `${crop}fps=${fps}`, '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '2', '-'], { stdio: ['ignore', 'pipe', 'inherit'] });
    let buf = Buffer.alloc(0);
    this.ff.stdout.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const s = buf.indexOf(Buffer.from([0xff, 0xd8]));
        const e = s < 0 ? -1 : buf.indexOf(Buffer.from([0xff, 0xd9]), s + 2);
        if (e < 0) break;
        this.queue.push(buf.subarray(s, e + 2));
        buf = buf.subarray(e + 2);
        this.waiters.shift()?.();
      }
      if (this.queue.length > 8) this.ff.stdout.pause();
    });
    this.ff.on('close', () => { this.ended = true; this.waiters.splice(0).forEach((w) => w()); });
  }
  async next() {
    while (!this.queue.length && !this.ended) await new Promise((r) => this.waiters.push(r));
    if (!this.queue.length) return false;
    this.cur = this.queue.shift(); this.idx++;
    if (this.queue.length < 4) this.ff.stdout.resume();
    return true;
  }
  async at(t) {
    const want = Math.max(0, Math.floor((t - this.start) * this.fps + 1e-6));
    while (this.idx < want || !this.cur) if (!(await this.next())) break;
    return this.cur;
  }
  close() { this.ff.kill('SIGKILL'); }
}

// Plan every output frame up front (cheap), then draw them in parallel chunks.
export function plan(meta, { W, H, fps }) {
  const { events, viewport: vp } = meta;
  const live = !!meta.sources;
  const tm = timeMap(events, meta.duration, live ? { edge: 0.35, keep: 0.2, min: 1.0 } : {});
  const cam = camera(events, vp);
  const cursor = live ? cursorTrack(events, vp) : () => null;
  const intro = meta.title ? INTRO : 0;
  const outro = meta.cta ? OUTRO : 0;
  const body = tm.length;
  const total = intro + body + outro;
  const says = events.filter((e) => e.type === 'say').map((e) => ({ ...e, a: tm.toDst(e.t) + intro, b: tm.toDst(e.end) + intro }));
  const keys = events.filter((e) => e.type === 'press').map((e) => ({ key: e.key, a: tm.toDst(e.t) + intro }));
  const vertical = H > W;
  const frames = [];
  let fi = 0;
  for (let i = 0, n = Math.ceil(total * fps); i < n; i++) {
    const T = i / fps;
    const s = tm.toSrc(clamp(T - intro, 0, body));
    const c = cam(s);
    const o = { crop: crop(vertical ? { ...c, z: c.z * 1.35 } : c, vp), aspect: vp.width / vp.height };
    if (live) {
      const seg = Math.max(0, meta.sources.findLastIndex((x) => x.start <= s + 1e-6));
      o.video = { seg, t: s - meta.sources[seg].start };
      o.cursor = cursor(s);
    } else {
      while (fi + 1 < meta.frames.length && meta.frames[fi + 1].t <= s) fi++;
      o.file = meta.frames[fi].file;
    }
    if (intro && T < intro) o.title = { text: meta.title, sub: meta.subtitle, alpha: T < intro - 0.5 ? 1 : (intro - T) / 0.5 };
    if (outro && T > intro + body) o.outro = { ...meta.cta, alpha: clamp((T - intro - body) / 0.5, 0, 1) };
    const say = says.find((x) => T >= x.a && T < x.b + 0.15);
    if (say && meta.captions !== false) o.caption = { text: say.text, p: clamp((T - say.a) / (say.b - say.a), 0, 1) };
    o.key = keys.find((x) => T >= x.a && T < x.a + 1.3)?.key;
    if (meta.bubble) o.bubble = { ...meta.bubble, speaking: !!say, phase: T };
    frames.push(o);
  }
  return { frames, total, intro, says, tm };
}

async function renderChunk(browser, meta, dir, frames, from, to, { W, H, fps }, file) {
  const page = await browser.newPage();
  const readers = new Map();
  let current = null;
  await page.route('http://autodemo.render/**', (route) => {
    const u = new URL(route.request().url());
    if (u.pathname.startsWith('/f/')) return route.fulfill({ path: path.join(dir, 'frames', path.basename(u.pathname)), contentType: 'image/jpeg' });
    if (u.pathname.startsWith('/v/')) return route.fulfill({ body: current, contentType: 'image/jpeg' });
    if (u.pathname.startsWith('/a/')) return route.fulfill({ path: decodeURIComponent(u.pathname.slice(3)) });
    return route.fulfill({ body: PAGE, contentType: 'text/html; charset=utf-8' });
  });
  await page.goto('http://autodemo.render/');
  // An image background is a file path: hand it to the page as a data URL.
  let bg = meta.background || null;
  if (typeof bg === 'string' && /\.(png|jpe?g|webp)$/i.test(bg)) {
    bg = `data:image/${path.extname(bg).slice(1).replace('jpg', 'jpeg')};base64,${fs.readFileSync(path.resolve(dir, bg)).toString('base64')}`;
  }
  await page.evaluate(([w, h, b, l]) => window.setup(w, h, b, l), [W, H, bg, { frame: meta.frame, label: meta.windowTitle || meta.title || '', url: meta.url || '' }]);
  const enc = ffmpeg(['-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p', '-r', String(fps), file]);
  try {
    for (let i = from; i < to; i++) {
      const o = frames[i];
      if (o.video) {
        const { seg, t } = o.video;
        let r = readers.get(seg);
        if (!r || r.start > t + 1e-6) { r?.close(); r = new VideoReader(path.resolve(dir, meta.sources[seg].file), t, fps, meta.cut); readers.set(seg, r); }
        current = await r.at(t);
        o.src = `/v/${i}.jpg`;
      } else o.src = `/f/${o.file}`;
      const jpg = Buffer.from(await page.evaluate((o) => window.frame(o), o), 'base64');
      if (!enc.p.stdin.write(jpg)) await new Promise((r) => enc.p.stdin.once('drain', r));
    }
  } finally {
    readers.forEach((r) => r.close());
    enc.p.stdin.end();
    await enc.done;
    await page.close();
  }
}

async function renderVideo(meta, dir, name, size, fps, progress) {
  const [W, H] = size;
  const { frames, total, says } = plan(meta, { W, H, fps });
  const workers = Math.max(1, Math.min(meta.workers ?? 4, Math.floor(os.cpus().length / 2), Math.ceil(frames.length / 90)));
  const per = Math.ceil(frames.length / workers);
  const browser = await chromium.launch();
  const parts = [];
  const tick = setInterval(() => progress(`rendering ${name} (${W}x${H}, ${workers} workers)`), 15000);
  try {
    await Promise.all(Array.from({ length: workers }, (_, k) => {
      const part = path.join(dir, `.${name}.part${k}.mp4`);
      parts.push(part);
      return renderChunk(browser, meta, dir, frames, k * per, Math.min(frames.length, (k + 1) * per), { W, H, fps }, part);
    }));
  } finally {
    clearInterval(tick);
    await browser.close();
  }
  const list = path.join(dir, `.${name}.txt`);
  fs.writeFileSync(list, parts.map((p) => `file '${p}'`).join('\n'));
  const silent = path.join(dir, `.${name}`);
  await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-f', 'mp4', silent]).done;
  parts.forEach((p) => fs.rmSync(p, { force: true }));
  fs.rmSync(list);

  // Mix narration in at its (remapped) start times, plus optional music ducked under the voice.
  const file = path.join(dir, name);
  const audio = says.filter((x) => x.file);
  const music = meta.music && fs.existsSync(meta.music) ? meta.music : null;
  if (audio.length || music) {
    const ins = audio.flatMap((x) => ['-i', x.file]);
    const f = audio.map((x, k) => `[${k + 1}:a]adelay=delays=${Math.round(x.a * 1000)}:all=1[a${k}]`);
    let mix = audio.map((_, k) => `[a${k}]`).join('');
    if (music) {
      ins.push('-stream_loop', '-1', '-i', music);
      f.push(`[${audio.length + 1}:a]volume=0.12,atrim=0:${total.toFixed(2)},afade=t=out:st=${Math.max(0, total - 2).toFixed(2)}:d=2[m]`);
      mix += '[m]';
    }
    f.push(`${mix}amix=inputs=${audio.length + (music ? 1 : 0)}:normalize=0[a]`);
    await ffmpeg(['-i', silent, ...ins, '-filter_complex', f.join(';'), '-map', '0:v', '-map', '[a]',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', total.toFixed(2), '-movflags', '+faststart', file]).done;
  } else {
    await ffmpeg(['-i', silent, '-c', 'copy', '-movflags', '+faststart', file]).done;
  }
  fs.rmSync(silent);
  return file;
}

// trim {top, right, bottom, left} (points) cuts edges off the recording: browser info bars, banners,
// an agent's on-page glow. Everything downstream just sees a smaller viewport.
function trim(meta) {
  const t = meta.trim;
  if (!t || !meta.viewport) return meta;
  const { width: W, height: H } = meta.viewport;
  const l = t.left || 0, tp = t.top || 0, w = W - l - (t.right || 0), h = H - tp - (t.bottom || 0);
  if (w < 100 || h < 100) throw new Error('trim leaves too little of the picture');
  const mv = (o) => o && { ...o, x: o.x - l, y: o.y - tp };
  const events = meta.events.map((e) => ({
    ...e, point: mv(e.point), box: mv(e.box),
  }));
  return { ...meta, events, viewport: { width: w, height: h }, cut: [l / W, tp / H, w / W, h / H] };
}

// recording.json -> final.mp4 (+ vertical.mp4), share page, captions, chapters, poster, gif.
export async function render(dir, { progress = () => {} } = {}) {
  const meta = trim(JSON.parse(fs.readFileSync(path.join(dir, 'recording.json'), 'utf8')));
  const out = meta.output || {};
  const fps = out.fps || 30;
  const files = [];
  files.push(await renderVideo(meta, dir, 'final.mp4', SIZES[out.resolution] || SIZES['4k'], fps, progress));
  if (out.vertical) files.push(await renderVideo(meta, dir, 'vertical.mp4', [1080, 1920], fps, progress));
  progress('share page, captions, gif');
  const { tm, intro, total } = plan(meta, { W: 16, H: 9, fps: 1 });
  const timeline = await writeExtras(dir, meta, { toDst: (s) => tm.toDst(s) + intro, total, video: files[0] });
  return { files, timeline };
}
