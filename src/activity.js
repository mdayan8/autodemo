// Find where the screen changes in a camera-mode recording, so the editor can zoom to
// the action and cut the frozen stretches (agent thinking time) without any event log.
import { spawn } from 'node:child_process';

const W = 192; // analysis width; height follows the aspect ratio

export function activity(file, { offset = 0, fps = 10, aspect = 16 / 9, points } = {}) {
  const H = Math.round(W / aspect / 2) * 2;
  const N = W * H;
  const minPixels = Math.max(6, N * 0.0008); // ignore blinking carets and noise
  const ff = spawn('ffmpeg', ['-loglevel', 'error', '-i', file, '-vf', `fps=${fps},scale=${W}:${H},format=gray`, '-f', 'rawvideo', '-'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const spans = [];
  let prev = null, buf = Buffer.alloc(0), i = 0, span = null;
  const toPts = (x, y) => ({ x: (x / W) * points.width, y: (y / H) * points.height });

  const frame = (f) => {
    const t = offset + i / fps;
    if (prev) {
      let n = 0, x0 = W, y0 = H, x1 = -1, y1 = -1;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const k = y * W + x;
          if (Math.abs(f[k] - prev[k]) > 18) {
            n++;
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
          }
        }
      }
      if (n >= minPixels) {
        const a = toPts(x0, y0), b = toPts(x1 + 1, y1 + 1);
        const area = ((x1 - x0 + 1) * (y1 - y0 + 1)) / N;
        if (span && t - span.end < 0.35) {
          span.end = t;
          span.x0 = Math.min(span.x0, a.x); span.y0 = Math.min(span.y0, a.y);
          span.x1 = Math.max(span.x1, b.x); span.y1 = Math.max(span.y1, b.y);
          span.area = Math.max(span.area, area);
        } else {
          span = { t: t - 1 / fps, end: t, x0: a.x, y0: a.y, x1: b.x, y1: b.y, area };
          spans.push(span);
        }
      }
    }
    prev = f;
    i++;
  };

  ff.stdout.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= N) { frame(buf.subarray(0, N)); buf = buf.subarray(N); }
  });
  return new Promise((resolve, reject) => {
    ff.on('close', (c) => (c ? reject(new Error(`activity analysis failed (${c})`)) : resolve(
      spans.map((s) => ({ type: 'activity', t: s.t, end: s.end, area: s.area,
        box: { x: s.x0, y: s.y0, width: s.x1 - s.x0, height: s.y1 - s.y0 } })),
    )));
  });
}
