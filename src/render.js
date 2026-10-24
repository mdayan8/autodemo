import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const FPS = 30;
const INTRO = 2.2; // title card seconds (only when the script has a title)
const ZOOM = 1.8; // default auto-zoom on clicks
const easeIO = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Piecewise-linear time map that squeezes idle stretches (page loads, waits
// with nothing said) so the video never sits on a frozen screen.
export function timeMap(events, duration) {
  const busy = [];
  for (const e of events) {
    if (e.type === 'say') busy.push([e.t, e.end]);
    else if (e.type !== 'scene') busy.push([Math.max(0, e.t - 0.2), (e.end ?? e.t) + 0.8]);
  }
  busy.sort((a, b) => a[0] - b[0]);
  const pts = [[0, 0]]; // [source time, output time]
  const add = (src, dstDelta) => pts.push([src, pts.at(-1)[1] + dstDelta]);
  const idle = (a, b) => {
    if (b - a <= 1.6) return add(b, b - a);
    add(a + 0.5, 0.5); add(b - 0.5, 0.3); add(b, 0.5); // keep the edges, fast-forward the middle
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

// Camera keyframes (source time, viewport CSS px). Nearby actions share one
// zoom; scrolls and page loads zoom back out.
export function camera(events, vp) {
  const home = { z: 1, cx: vp.width / 2, cy: vp.height / 2 };
  const breakers = events.filter((e) => e.type === 'goto' || e.type === 'scroll').map((e) => e.t);
  // Stay zoomed while the scene's narration is still talking about this spot.
  const sayEnd = Object.fromEntries(events.filter((e) => e.type === 'say').map((e) => [e.scene, e.end]));
  const acts = events
    .filter((e) => e.box && e.zoom !== false && ['click', 'type', 'hover'].includes(e.type))
    .map((e) => ({ ...e, end: Math.max(e.end, (sayEnd[e.scene] ?? 0) - 0.6) }));
  const pad = 140;
  const fit = (x0, y0, x1, y1) => Math.min(vp.width / (x1 - x0 + pad * 2), vp.height / (y1 - y0 + pad * 2));
  const clusters = [];
  for (const a of acts) {
    const c = clusters.at(-1);
    const broken = c && breakers.some((t) => t > c.lastT && t < a.t);
    // Merge into the current shot only if the combined area can still be zoomed in properly.
    const fits = c && fit(Math.min(c.x0, a.box.x), Math.min(c.y0, a.box.y),
      Math.max(c.x1, a.box.x + a.box.width), Math.max(c.y1, a.box.y + a.box.height)) >= 1.45;
    if (c && !broken && fits && a.t - c.end < 2.5) {
      c.end = a.end;
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

const PAGE = `<!doctype html><html><body style="margin:0;background:#000">
<canvas id="c"></canvas><script>
const cv = document.getElementById('c'), g = cv.getContext('2d');
const cache = new Map();
async function img(f) {
  if (cache.has(f)) return cache.get(f);
  const im = new Image(); im.src = '/f/' + f; await im.decode();
  cache.set(f, im); if (cache.size > 6) cache.delete(cache.keys().next().value);
  return im;
}
function rr(x, y, w, h, r) { g.beginPath(); g.roundRect(x, y, w, h, r); }
function wrap(text, max) {
  const words = text.split(' '), lines = []; let cur = '';
  for (const w of words) { const t = cur ? cur + ' ' + w : w; if (g.measureText(t).width > max && cur) { lines.push(cur); cur = w; } else cur = t; }
  if (cur) lines.push(cur); return lines;
}
window.setup = (W, H) => { cv.width = W; cv.height = H; };
window.frame = async (o) => {
  const W = cv.width, H = cv.height, vertical = H > W;
  const bg = g.createLinearGradient(0, 0, W, H); bg.addColorStop(0, '#1b2140'); bg.addColorStop(1, '#3a2257');
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  // Vertical: the landscape window sits big in the middle, captions go below it.
  const pad = Math.round(W * (vertical ? 0.03 : 0.035));
  const rw = W - pad * 2, rh = rw * 9 / 16, rx = pad, ry = (H - rh) / 2 - (vertical ? H * 0.04 : 0), rad = 18;
  if (o.file) {
    const im = await img(o.file);
    const [fx, fy, fw, fh] = o.crop;
    g.save(); g.globalAlpha = o.alpha ?? 1;
    g.shadowColor = 'rgba(0,0,0,.45)'; g.shadowBlur = 40; g.shadowOffsetY = 14;
    rr(rx, ry, rw, rh, rad); g.fillStyle = '#fff'; g.fill(); g.shadowColor = 'transparent';
    rr(rx, ry, rw, rh, rad); g.clip();
    g.imageSmoothingQuality = 'high';
    g.drawImage(im, fx * im.naturalWidth, fy * im.naturalHeight, fw * im.naturalWidth, fh * im.naturalHeight, rx, ry, rw, rh);
    g.restore();
  }
  if (o.title) {
    g.save(); g.globalAlpha = o.title.alpha;
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = '700 ' + Math.round(W * (vertical ? 0.075 : 0.042)) + 'px -apple-system, "SF Pro Display", Inter, sans-serif';
    const lines = wrap(o.title.text, W * 0.8), lh = W * (vertical ? 0.09 : 0.05);
    lines.forEach((l, i) => g.fillText(l, W / 2, H / 2 - (lines.length - 1) * lh / 2 + i * lh - (o.title.sub ? lh * 0.4 : 0)));
    if (o.title.sub) {
      g.globalAlpha = o.title.alpha * 0.7; g.font = '500 ' + Math.round(W * (vertical ? 0.04 : 0.02)) + 'px -apple-system, Inter, sans-serif';
      g.fillText(o.title.sub, W / 2, H / 2 + (lines.length) * lh / 2 + lh * 0.2);
    }
    g.restore();
  }
  if (o.key) {
    g.save(); g.font = '600 ' + Math.round(W * 0.016) + 'px -apple-system, Inter, sans-serif';
    const tw = g.measureText(o.key).width + 44, x = rx + rw - tw - 28, y = ry + 28;
    g.fillStyle = 'rgba(15,15,20,.82)'; rr(x, y, tw, 52, 12); g.fill();
    g.fillStyle = '#fff'; g.textBaseline = 'middle'; g.fillText(o.key, x + 22, y + 27); g.restore();
  }
  if (o.caption) {
    g.save(); const fs = Math.round(W * (vertical ? 0.045 : 0.019));
    g.font = '600 ' + fs + 'px -apple-system, "SF Pro Text", Inter, sans-serif';
    const lines = wrap(o.caption, rw * 0.78), lh = fs * 1.35, bw = Math.max(...lines.map(l => g.measureText(l).width)) + fs * 1.6;
    const bh = lines.length * lh + fs * 0.9, bx = (W - bw) / 2, by = vertical ? ry + rh + fs * 1.5 : ry + rh - bh - fs * 1.6;
    g.fillStyle = 'rgba(12,12,18,.78)'; rr(bx, by, bw, bh, fs * 0.6); g.fill();
    g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
    lines.forEach((l, i) => g.fillText(l, W / 2, by + fs * 0.45 + lh * (i + 0.5)));
    g.restore();
  }
  return cv.toDataURL('image/jpeg', 0.92).slice(23);
};
</script></body></html>`;

function ffmpeg(args) {
  const p = spawn('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((res, rej) => p.on('close', (c) => (c ? rej(new Error(`ffmpeg exited ${c}`)) : res())));
  return { p, done };
}

// recording.json + frames/ -> final.mp4 (and vertical.mp4 if output.vertical)
export async function render(dir, { progress = () => {} } = {}) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'recording.json'), 'utf8'));
  const { events, frames, viewport: vp } = meta;
  const tm = timeMap(events, meta.duration);
  const cam = camera(events, vp);
  const intro = meta.title ? INTRO : 0;
  const total = intro + tm.length;
  const says = events.filter((e) => e.type === 'say').map((e) => ({ ...e, a: tm.toDst(e.t) + intro, b: tm.toDst(e.end) + intro }));
  const keys = events.filter((e) => e.type === 'press').map((e) => ({ key: e.key, a: tm.toDst(e.t) + intro }));

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.route('http://autodemo.render/**', (route) => {
    const u = new URL(route.request().url());
    if (u.pathname.startsWith('/f/')) return route.fulfill({ path: path.join(dir, 'frames', path.basename(u.pathname)), contentType: 'image/jpeg' });
    return route.fulfill({ body: PAGE, contentType: 'text/html' });
  });
  await page.goto('http://autodemo.render/');

  const outputs = [['final.mp4', 1920, 1080]];
  if (meta.output.vertical) outputs.push(['vertical.mp4', 1080, 1920]);
  const results = [];
  try {
    for (const [name, W, H] of outputs) {
      await page.evaluate(([w, h]) => window.setup(w, h), [W, H]);
      const silent = path.join(dir, `.${name}`);
      const enc = ffmpeg(['-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', silent]);
      let fi = 0;
      const n = Math.ceil(total * FPS);
      for (let i = 0; i < n; i++) {
        const T = i / FPS;
        const s = tm.toSrc(Math.max(0, T - intro));
        while (fi + 1 < frames.length && frames[fi + 1].t <= s) fi++;
        const c = cam(s);
        // Vertical shows a smaller window, so push the zoom a little further.
        const o = { file: frames[fi].file, crop: crop(H > W ? { ...c, z: c.z * 1.35 } : c, vp) };
        if (intro && T < intro) o.title = { text: meta.title, sub: meta.subtitle, alpha: T < intro - 0.5 ? 1 : (intro - T) / 0.5 };
        o.caption = says.find((x) => T >= x.a && T < x.b + 0.15)?.text;
        o.key = keys.find((x) => T >= x.a && T < x.a + 1.3)?.key;
        const jpg = Buffer.from(await page.evaluate((o) => window.frame(o), o), 'base64');
        if (!enc.p.stdin.write(jpg)) await new Promise((r) => enc.p.stdin.once('drain', r));
        if (i % 60 === 0) progress(`rendering ${name} ${Math.round((i / n) * 100)}%`);
      }
      enc.p.stdin.end();
      await enc.done;

      // Mix narration in at its (remapped) start times.
      const file = path.join(dir, name);
      if (says.length) {
        const ins = says.flatMap((x) => ['-i', x.file]);
        const delays = says.map((x, k) => `[${k + 1}:a]adelay=delays=${Math.round(x.a * 1000)}:all=1[a${k}]`).join(';');
        const mix = says.map((_, k) => `[a${k}]`).join('') + `amix=inputs=${says.length}:normalize=0[a]`;
        await ffmpeg(['-i', silent, ...ins, '-filter_complex', `${delays};${mix}`, '-map', '0:v', '-map', '[a]',
          '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', file]).done;
        fs.rmSync(silent);
      } else fs.renameSync(silent, file);
      results.push(file);
    }
  } finally {
    await browser.close();
  }
  // Timeline for review: when each scene appears in the final video.
  const scenes = events.filter((e) => e.type === 'scene').map((e) => ({ scene: e.scene + 1, at: +(tm.toDst(e.t) + intro).toFixed(2) }));
  const timeline = { length: +total.toFixed(2), scenes, captions: says.map((x) => ({ at: +x.a.toFixed(2), text: x.text })) };
  fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify(timeline, null, 1));
  return { files: results, timeline };
}
