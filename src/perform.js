import fs from 'node:fs';
import path from 'node:path';
import { launch, settle, VIEWPORT, DPR } from './browser.js';
import { pageInit } from './inject.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

export const ACTIONS = ['goto', 'click', 'type', 'press', 'scroll', 'hover', 'wait_for', 'wait'];

// Runs scenes against a page. `human: false` = fast mode (rehearsal / validation).
export class Performer {
  constructor(page, { human = true, t0 = performance.now() } = {}) {
    this.page = page;
    this.human = human;
    this.t0 = t0;
    this.events = [];
    this.mouse = { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 };
  }

  now() { return (performance.now() - this.t0) / 1000; }

  log(e) { this.events.push(e); }

  async moveTo(x, y) {
    const { page } = this;
    if (!this.human) { await page.mouse.move(x, y); this.mouse = { x, y }; return; }
    const from = this.mouse;
    const dist = Math.hypot(x - from.x, y - from.y);
    const ms = Math.min(950, Math.max(320, 260 + dist * 0.55));
    // Quadratic bezier with a slight sideways bow, like a hand moving a mouse.
    const bow = rand(-0.12, 0.12) * dist;
    const nx = -(y - from.y) / (dist || 1), ny = (x - from.x) / (dist || 1);
    const cx = (from.x + x) / 2 + nx * bow, cy = (from.y + y) / 2 + ny * bow;
    const start = performance.now();
    for (;;) {
      const p = Math.min(1, (performance.now() - start) / ms);
      const e = ease(p);
      const px = (1 - e) * (1 - e) * from.x + 2 * (1 - e) * e * cx + e * e * x;
      const py = (1 - e) * (1 - e) * from.y + 2 * (1 - e) * e * cy + e * e * y;
      await page.mouse.move(px, py);
      if (p >= 1) break;
      await sleep(14);
    }
    this.mouse = { x, y };
  }

  // Find the element, bring it on screen smoothly, return its box (viewport CSS px).
  async target(selector, timeout) {
    const loc = this.page.locator(selector).first();
    await loc.waitFor({ state: 'visible', timeout });
    let box = await loc.boundingBox();
    const vh = VIEWPORT.height;
    if (!box || box.y < 0 || box.y + box.height > vh) {
      await loc.evaluate((el, smooth) => el.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'instant' }), this.human);
      await this.settleScroll();
      box = await loc.boundingBox();
    }
    if (!box) throw new Error(`"${selector}" has no visible box`);
    return box;
  }

  async settleScroll() {
    let last = -1;
    for (let i = 0; i < 60; i++) {
      const y = await this.page.evaluate(() => scrollY);
      if (y === last) return;
      last = y;
      await sleep(this.human ? 80 : 20);
    }
  }

  async run(scene, index) {
    const { page } = this;
    const timeout = scene.timeout ?? 15000;
    const t = this.now();
    const act = ACTIONS.find((k) => k in scene);
    if (!act) return;
    const v = scene[act];
    let box, point, info = {};

    if (act === 'goto') {
      await page.goto(v, { waitUntil: 'load', timeout: Math.max(timeout, 30000) });
      await settle(page);
    } else if (act === 'click' || act === 'hover') {
      box = await this.target(v, timeout);
      point = { x: box.x + box.width / 2 + rand(-0.15, 0.15) * Math.min(box.width, 40), y: box.y + box.height / 2 };
      await this.moveTo(point.x, point.y);
      if (act === 'click') {
        if (this.human) await sleep(rand(110, 200));
        const before = await page.evaluate(() => [scrollY, location.origin + location.pathname]);
        await page.mouse.down();
        if (this.human) await sleep(rand(50, 90));
        await page.mouse.up();
        await this.afterClick(before);
      }
    } else if (act === 'type') {
      const { into, text, clear = true, enter = false } = typeof v === 'string' ? { text: v } : v;
      if (into) {
        box = await this.target(into, timeout);
        point = { x: box.x + Math.min(box.width / 2, 60), y: box.y + box.height / 2 };
        await this.moveTo(point.x, point.y);
        await page.mouse.click(point.x, point.y);
        if (clear) {
          await page.keyboard.press('ControlOrMeta+a');
          await page.keyboard.press('Backspace');
        }
      }
      if (this.human) {
        for (const ch of text) {
          await page.keyboard.type(ch);
          await sleep(ch === ' ' ? rand(60, 130) : rand(35, 85));
        }
      } else await page.keyboard.type(text);
      if (enter) await page.keyboard.press('Enter');
      info.text = text;
    } else if (act === 'press') {
      await page.keyboard.press(v);
      info.key = v;
    } else if (act === 'scroll') {
      if (typeof v === 'number') {
        await page.evaluate(([dy, smooth]) => scrollBy({ top: dy, behavior: smooth ? 'smooth' : 'instant' }), [v, this.human]);
        await this.settleScroll();
      } else await this.target(v, timeout);
    } else if (act === 'wait_for') {
      await page.locator(v).first().waitFor({ state: 'visible', timeout });
    } else if (act === 'wait') {
      await sleep(v);
    }
    this.log({ type: act, t, end: this.now(), box, point, ...info, zoom: scene.zoom, scene: index });
  }

  // A click can scroll (anchor links) or load a new page. Log it so the camera zooms out for the move.
  async afterClick([y0, url0]) {
    await sleep(250);
    const t = this.now();
    const state = await this.page.evaluate(() => [scrollY, location.origin + location.pathname]).catch(() => null);
    if (!state || state[1] !== url0) {
      await settle(this.page);
      this.log({ type: 'goto', t, end: this.now() });
    } else if (Math.abs(state[0] - y0) > 40) {
      await this.settleScroll();
      this.log({ type: 'scroll', t, end: this.now() });
    }
  }
}

// Record a script: human-paced playback + page screencast frames + event log.
// `voice[i]` = {file, d} narration for scene i (pre-generated, so timing is exact).
export async function record(script, { out, voice = [], headed = false, progress = () => {} }) {
  const framesDir = path.join(out, 'frames');
  fs.rmSync(framesDir, { recursive: true, force: true });
  fs.mkdirSync(framesDir, { recursive: true });
  const b = await launch({ profile: script.profile, headless: !headed });
  try {
    await b.ctx.addInitScript(pageInit, script.blur || []);
    const { page } = b;
    if (script.url) await page.goto(script.url, { waitUntil: 'load', timeout: 45000 });
    await settle(page);

    const frames = [];
    const cdp = await b.ctx.newCDPSession(page);
    let t0Epoch = 0;
    cdp.on('Page.screencastFrame', async (f) => {
      cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
      const file = `${String(frames.length).padStart(6, '0')}.jpg`;
      frames.push({ t: f.metadata.timestamp * 1000 - t0Epoch, file });
      fs.writeFile(path.join(framesDir, file), Buffer.from(f.data, 'base64'), () => {});
    });
    const t0 = performance.now();
    t0Epoch = Date.now();
    await cdp.send('Page.startScreencast', {
      format: 'jpeg', quality: 88, maxWidth: VIEWPORT.width * DPR, maxHeight: VIEWPORT.height * DPR, everyNthFrame: 1,
    });
    // Park the cursor mid-screen so it's visible from frame one.
    await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2);
    await sleep(400);
    if (!frames.length) {
      await page.screenshot({ path: path.join(framesDir, 'start.jpg'), type: 'jpeg', quality: 88 });
      frames.push({ t: 0, file: 'start.jpg' });
    }

    const perf = new Performer(page, { t0 });
    for (const [i, scene] of script.scenes.entries()) {
      progress(`scene ${i + 1}/${script.scenes.length}`);
      const start = perf.now();
      const v = voice[i];
      if (v) {
        perf.log({ type: 'say', t: start, end: start + v.d, text: scene.say, file: v.file, scene: i });
        await sleep(250); // let the voice lead the action slightly
      }
      perf.log({ type: 'scene', t: start, scene: i });
      try {
        await perf.run(scene, i);
      } catch (err) {
        await page.screenshot({ path: path.join(out, 'error.png') }).catch(() => {});
        throw new Error(`Scene ${i + 1} failed: ${err.message.split('\n')[0]} (screenshot: ${path.join(out, 'error.png')})`);
      }
      const until = v ? start + v.d + 0.35 : perf.now() + (scene.pause ?? 600) / 1000;
      const left = until - perf.now() + (v && scene.pause ? scene.pause / 1000 : 0);
      if (left > 0) await sleep(left * 1000);
    }
    await sleep(900);
    const end = perf.now();
    await cdp.send('Page.stopScreencast').catch(() => {});
    await sleep(200);
    frames.forEach((f) => { f.t = Math.max(0, f.t / 1000); });
    frames.sort((a, b) => a.t - b.t);
    const meta = {
      title: script.title || '', subtitle: script.subtitle || '', viewport: VIEWPORT,
      duration: end, frames, events: perf.events, output: script.output || {},
    };
    fs.writeFileSync(path.join(out, 'recording.json'), JSON.stringify(meta, null, 1));
    return meta;
  } finally {
    await b.close();
  }
}

// Fast dry run: every scene must succeed. Returns a report the agent can act on.
export async function validate(script, { headed = false } = {}) {
  const b = await launch({ profile: script.profile, headless: !headed });
  const results = [];
  try {
    if (script.url) await b.page.goto(script.url, { waitUntil: 'load', timeout: 45000 });
    await settle(b.page);
    const perf = new Performer(b.page, { human: false });
    for (const [i, scene] of script.scenes.entries()) {
      try {
        await perf.run({ ...scene, timeout: scene.timeout ?? 8000 });
        results.push({ scene: i + 1, ok: true });
      } catch (err) {
        results.push({ scene: i + 1, ok: false, error: err.message.split('\n')[0] });
        break;
      }
    }
    return { ok: results.every((r) => r.ok) && results.length === script.scenes.length, results, url: b.page.url() };
  } finally {
    await b.close();
  }
}
