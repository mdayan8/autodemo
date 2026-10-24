import fs from 'node:fs';
import path from 'node:path';
import { launch, settle, DPR } from './browser.js';
import { pageInit } from './inject.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

export const ACTIONS = ['goto', 'click', 'type', 'press', 'scroll', 'hover', 'wait_for', 'wait'];
export const VIEWPORTS = { '4k': { width: 1920, height: 1080 }, '1080p': { width: 1280, height: 720 } };
export const viewportFor = (script) => script.viewport || VIEWPORTS[script.output?.resolution] || VIEWPORTS['4k'];

// Keys next to each other on a QWERTY keyboard, for believable typos.
const NEAR = { a: 'sq', s: 'ad', d: 'sf', e: 'wr', i: 'uo', o: 'ip', n: 'bm', t: 'ry', r: 'et', l: 'k', u: 'yi', m: 'n', c: 'xv', h: 'gj' };

// Runs scenes against a page. `human: false` = fast mode (rehearsal / validation).
export class Performer {
  constructor(page, { human = true, t0 = performance.now(), viewport, typos = true } = {}) {
    this.page = page;
    this.human = human;
    this.typos = typos;
    this.t0 = t0;
    this.vp = viewport || page.viewportSize();
    this.events = [];
    this.mouse = { x: this.vp.width / 2, y: this.vp.height / 2 };
  }

  now() { return (performance.now() - this.t0) / 1000; }

  log(e) { this.events.push(e); }

  async moveTo(x, y, { ms } = {}) {
    const { page } = this;
    if (!this.human) { await page.mouse.move(x, y); this.mouse = { x, y }; return; }
    const from = this.mouse;
    const dist = Math.hypot(x - from.x, y - from.y);
    ms ??= Math.min(1000, Math.max(320, 260 + dist * 0.5));
    // Quadratic bezier with a slight sideways bow and a tiny overshoot, like a hand on a mouse.
    const bow = rand(-0.12, 0.12) * dist;
    const nx = -(y - from.y) / (dist || 1), ny = (x - from.x) / (dist || 1);
    const cx = (from.x + x) / 2 + nx * bow, cy = (from.y + y) / 2 + ny * bow;
    const over = dist > 200 ? rand(0.01, 0.03) : 0;
    const tx = x + (x - from.x) * over, ty = y + (y - from.y) * over;
    const start = performance.now();
    for (;;) {
      const p = Math.min(1, (performance.now() - start) / ms);
      const e = ease(p);
      const px = (1 - e) * (1 - e) * from.x + 2 * (1 - e) * e * cx + e * e * tx;
      const py = (1 - e) * (1 - e) * from.y + 2 * (1 - e) * e * cy + e * e * ty;
      await page.mouse.move(px, py);
      if (p >= 1) break;
      await sleep(14);
    }
    if (over) { await sleep(40); await page.mouse.move(x, y, { steps: 4 }); }
    this.mouse = { x, y };
  }

  // While the narrator talks, a real hand never holds the mouse perfectly still.
  async idle(ms) {
    const end = performance.now() + ms;
    if (!this.human || ms < 900) return sleep(ms);
    const home = { ...this.mouse };
    while (performance.now() + 700 < end) {
      await sleep(rand(250, 600));
      const x = home.x + rand(-6, 6), y = home.y + rand(-4, 4);
      await this.moveTo(x, y, { ms: rand(250, 420) });
    }
    const left = end - performance.now();
    if (left > 0) await sleep(left);
  }

  // Find the element, bring it on screen smoothly, return its box (viewport CSS px).
  async target(selector, timeout) {
    const loc = this.page.locator(selector).first();
    await loc.waitFor({ state: 'visible', timeout });
    let box = await loc.boundingBox();
    if (!box || box.y < 0 || box.y + box.height > this.vp.height) {
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

  async typeText(text) {
    const { page } = this;
    if (!this.human) return page.keyboard.type(text);
    // Occasional typo + correction on ordinary words (never in emails, URLs or numbers).
    const plain = this.typos && !/[@/\\\d]/.test(text);
    let typoDone = false;
    for (const [i, ch] of [...text].entries()) {
      const near = NEAR[ch.toLowerCase()];
      if (plain && !typoDone && near && i > 2 && i < text.length - 2 && Math.random() < 0.06) {
        await page.keyboard.type(near[Math.floor(Math.random() * near.length)]);
        await sleep(rand(180, 320));
        await page.keyboard.press('Backspace');
        await sleep(rand(90, 160));
        typoDone = true;
      }
      await page.keyboard.type(ch);
      await sleep(ch === ' ' ? rand(70, 140) : /[.,!?]/.test(ch) ? rand(120, 220) : rand(35, 90));
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
        if (this.human) await sleep(rand(140, 280)); // a beat of hesitation before committing
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
        if (this.human) await sleep(rand(150, 300));
      }
      await this.typeText(text);
      if (enter) {
        if (this.human) await sleep(rand(200, 380));
        const before = await page.evaluate(() => [scrollY, location.origin + location.pathname]);
        await page.keyboard.press('Enter');
        await this.afterClick(before);
      }
      info.text = text;
    } else if (act === 'press') {
      await page.keyboard.press(v);
      info.key = v.replace('ControlOrMeta', process.platform === 'darwin' ? '⌘' : 'Ctrl').replace(/\+/g, ' ');
    } else if (act === 'scroll') {
      if (typeof v === 'number') {
        await page.evaluate(([dy, smooth]) => scrollBy({ top: dy, behavior: smooth ? 'smooth' : 'instant' }), [v, this.human]);
        await this.settleScroll();
      } else await this.target(v, timeout);
    } else if (act === 'wait_for') {
      await page.locator(v).first().waitFor({ state: 'visible', timeout });
    } else if (act === 'wait') {
      await this.idle(v);
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

// Fields carried from the script into the recording (and so into the editor).
const PASS = ['title', 'subtitle', 'output', 'cta', 'summary', 'bubble', 'background', 'music', 'captions'];

// Record a script: human-paced playback + page screencast frames + event log + console/network log.
// `voice[i]` = {file, d} narration for scene i (pre-generated, so timing is exact).
export async function record(script, { out, voice = [], headed = false, progress = () => {} }) {
  const framesDir = path.join(out, 'frames');
  fs.rmSync(framesDir, { recursive: true, force: true });
  fs.mkdirSync(framesDir, { recursive: true });
  const viewport = viewportFor(script);
  const b = await launch({ profile: script.profile, headless: !headed, viewport });
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
      format: 'jpeg', quality: 90, maxWidth: viewport.width * DPR, maxHeight: viewport.height * DPR, everyNthFrame: 1,
    });
    const perf = new Performer(page, { t0, viewport, typos: script.human?.typos !== false });

    // Bug-report mode (like Loom's): console errors and failed requests, timestamped.
    const logEvent = (level, text) => perf.log({ type: 'log', t: perf.now(), level, text: String(text).slice(0, 500) });
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logEvent(m.type(), m.text()); });
    page.on('pageerror', (e) => logEvent('exception', e.message));
    page.on('response', (r) => { if (r.status() >= 400) logEvent('http', `${r.status()} ${r.request().method()} ${r.url()}`); });
    page.on('requestfailed', (r) => logEvent('network', `${r.failure()?.errorText} ${r.url()}`));

    // Park the cursor mid-screen so it's visible from frame one.
    await page.mouse.move(viewport.width / 2, viewport.height / 2);
    await sleep(400);
    if (!frames.length) {
      await page.screenshot({ path: path.join(framesDir, 'start.jpg'), type: 'jpeg', quality: 90 });
      frames.push({ t: 0, file: 'start.jpg' });
    }

    for (const [i, scene] of script.scenes.entries()) {
      progress(`scene ${i + 1}/${script.scenes.length}`);
      const start = perf.now();
      if (scene.chapter) perf.log({ type: 'chapter', t: start, title: scene.chapter });
      const v = voice[i];
      if (v) {
        perf.log({ type: 'say', t: start, end: start + v.d, text: scene.say, file: v.file, scene: i });
        await sleep(250); // let the voice lead the action slightly
      } else if (scene.say) {
        // No voiceover: captions still show, timed for comfortable reading.
        const d = Math.max(1.6, scene.say.split(' ').length * 0.32);
        perf.log({ type: 'say', t: start, end: start + d, text: scene.say, scene: i });
        voice[i] = { d };
      }
      perf.log({ type: 'scene', t: start, scene: i });
      try {
        await perf.run(scene, i);
      } catch (err) {
        await page.screenshot({ path: path.join(out, 'error.png') }).catch(() => {});
        throw new Error(`Scene ${i + 1} failed: ${err.message.split('\n')[0]} (screenshot: ${path.join(out, 'error.png')})`);
      }
      const d = voice[i]?.d;
      const until = d ? start + d + 0.35 : perf.now() + (scene.pause ?? 600) / 1000;
      const left = until - perf.now() + (d && scene.pause ? scene.pause / 1000 : 0);
      if (left > 0) await perf.idle(left * 1000);
    }
    await sleep(900);
    const end = perf.now();
    await cdp.send('Page.stopScreencast').catch(() => {});
    await sleep(200);
    frames.forEach((f) => { f.t = Math.max(0, f.t / 1000); });
    frames.sort((a, b) => a.t - b.t);
    const meta = { viewport, duration: end, frames, events: perf.events, output: {} };
    for (const k of PASS) if (script[k] !== undefined) meta[k] = script[k];
    fs.writeFileSync(path.join(out, 'recording.json'), JSON.stringify(meta, null, 1));
    return meta;
  } finally {
    await b.close();
  }
}

// Fast dry run: every scene must succeed. Returns a report the agent can act on.
export async function validate(script, { headed = false } = {}) {
  const b = await launch({ profile: script.profile, headless: !headed, viewport: viewportFor(script) });
  const results = [];
  try {
    if (script.url) await b.page.goto(script.url, { waitUntil: 'load', timeout: 45000 });
    await settle(b.page);
    const perf = new Performer(b.page, { human: false });
    for (const [i, scene] of script.scenes.entries()) {
      try {
        await perf.run({ ...scene, timeout: scene.timeout ?? 8000 }, i);
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
