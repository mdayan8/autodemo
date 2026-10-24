import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { launch, settle } from './browser.js';
import { Performer, ACTIONS, viewportFor } from './perform.js';
import { make, loadScript, validate, slug } from './demo.js';
import { CameraSession } from './live.js';
import { windows } from './native.js';

// stdout is the MCP channel; keep library chatter off it.
console.log = console.error;
const run = promisify(execFile);

const text = (t) => ({ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) });
const image = (data) => ({ type: 'image', data, mimeType: 'image/jpeg' });
const reply = (...content) => ({ content });
const fail = (e) => ({ isError: true, content: [text(e.message || String(e))] });
const safe = (fn) => async (args) => { try { return await fn(args || {}); } catch (e) { return fail(e); } };

let live = null; // rehearsal browser: { b, perf, profile }
let camera = null; // camera-mode session
const closeLive = async () => { if (live) { await live.b.close(); live = null; } };
const shotOf = async (page) => (await page.screenshot({ type: 'jpeg', quality: 55, scale: 'css' })).toString('base64');

const server = new McpServer({ name: 'autodemo', version: '0.2.0' }, {
  instructions:
    'autodemo is a screen recorder for agents: it films one browser tab, app window, simulator or the screen while YOU drive it with your own tools, ' +
    'then edits it into a polished video (zoom on the action, cursor, local voice, captions, macOS/gradient backgrounds, share page). ' +
    'Start with intake. Then: camera_start {tab: "part of URL"} or {window: "App"}; one camera_say per step (text + click + chapter) before each action; ' +
    'camera_trim to cut browser bars; camera_pause for sign-in (never type passwords); camera_stop, job, review; give the user the studio URL. ' +
    'No browser/computer tool of your own? camera_act clicks and types for you. Scripted, re-recordable demos for CI: open/step/check/record. ' +
    'Save tokens: locate elements with your tools\' text/DOM reads, screenshot only when you need coordinates.',
});

const SCENE_HELP =
  `A scene is one object with ONE action plus optional extras:\n` +
  `  {"goto": url} | {"click": sel} | {"hover": sel} | {"type": {"into": sel, "text": "...", "enter": true}} | {"press": "Enter"}\n` +
  `  {"scroll": 600 | sel} | {"wait_for": sel} | {"wait": ms}\n` +
  `Extras: "say": narration for the scene, "chapter": "name" (starts a chapter), "zoom": false | 2.2, "pause": ms after, "timeout": ms.\n` +
  `Selectors are Playwright selectors: role=button[name="Save"], text=Sign up, label=Email, css (#id, .class).`;

const SCRIPT_HELP =
  'Script: {"title", "subtitle"?, "url", "profile"? (saved sign-in), "voiceover"? (false = captions only), "voice"? (af_heart default; am_michael, bf_emma, bm_george, af_bella, am_adam), ' +
  '"speed"?, "blur"?: [selectors], "output"?: {"resolution": "4k"|"1080p", "vertical": true, "fps": 30|60}, "cta"?: {"text", "url"} (end card + share page button), ' +
  '"bubble"?: {"label": "AI"} or {"image": path} (presenter bubble), "summary"?, "music"?: path, "human"?: {"typos": false}, "scenes": [...]}.\n' + SCENE_HELP;

// ---------- intake: ask the user before doing anything ----------

const QUESTIONS = {
  goal: { type: 'string', title: 'What kind of video?', enum: ['Full product walkthrough', 'One feature', 'Launch teaser (short)', 'PR proof (feature works)', 'Bug report'] },
  audience: { type: 'string', title: 'Who will watch it?', description: 'e.g. new users, investors, my team, a code reviewer' },
  length: { type: 'string', title: 'Length', enum: ['15 seconds', '30 seconds', '1 minute', '2 minutes', 'As long as it needs'] },
  voiceover: { type: 'boolean', title: 'AI voiceover?', description: 'Off = silent video with captions', default: true },
  voice: { type: 'string', title: 'Voice', enum: ['af_heart (warm, US female)', 'am_michael (calm, US male)', 'bf_emma (UK female)', 'bm_george (UK male)'] },
  formats: { type: 'string', title: 'Formats', enum: ['Landscape 4K', 'Landscape 4K + vertical (Shorts/Reels)'] },
  driver: { type: 'string', title: 'How should I drive it?', enum: ['autodemo browser (best quality)', 'Film my window while you use your own tools (any app)'] },
  signin: { type: 'boolean', title: 'Does it need a sign-in?', default: false },
  cta: { type: 'string', title: 'Link for the end card (optional)' },
  notes: { type: 'string', title: 'Anything to show, avoid or hide?' },
};

server.registerTool('intake', {
  description: 'START HERE. Ask the user what video they want (goal, audience, length, voiceover or not, voice, formats, driver, sign-in, call-to-action). ' +
    'Shows a form when the client supports it; otherwise returns the questions for you to ask with your own ask-user tool.',
  inputSchema: { what: z.string().optional().describe('what the video is about, if already known (product, URL, feature)') },
}, safe(async ({ what }) => {
  const caps = server.server.getClientCapabilities();
  if (caps?.elicitation) {
    const r = await server.server.elicitInput({
      mode: 'form',
      message: `Let's plan your demo video${what ? ` of ${what}` : ''}.`,
      requestedSchema: { type: 'object', properties: QUESTIONS, required: ['goal', 'voiceover'] },
    });
    if (r.action === 'accept') {
      return reply(text({ answers: r.content, next: 'Turn these answers into the plan: pick browser or camera mode, keep to the length, set voiceover/voice/output/cta in the script.' }));
    }
    return reply(text(`The user chose to ${r.action} the form. Ask them briefly in chat what they want instead, or use sensible defaults (1 minute walkthrough, voiceover on, 4K).`));
  }
  const list = Object.entries(QUESTIONS).map(([k, q]) => `- ${q.title}${q.enum ? ` (${q.enum.join(' / ')})` : ''}`).join('\n');
  return reply(text(`This client has no form support, so ask the user these yourself (use your ask-user / question tool if you have one, several at once; offer the first option as the recommended default):\n${list}\n\nThen continue with the plan.`));
}));

// ---------- browser mode: rehearse ----------

server.registerTool('open', {
  description: 'Open a URL in a rehearsal browser (nothing is recorded) and return a screenshot. Use a profile to reuse a saved sign-in.',
  inputSchema: { url: z.string(), profile: z.string().optional().describe('saved sign-in profile name'), resolution: z.enum(['4k', '1080p']).optional() },
}, safe(async ({ url, profile, resolution }) => {
  await closeLive();
  const b = await launch({ profile, viewport: viewportFor({ output: { resolution } }) });
  await b.page.goto(url, { waitUntil: 'load', timeout: 45000 });
  await settle(b.page);
  live = { b, perf: new Performer(b.page, { human: false }), profile };
  return reply(text(`Opened ${b.page.url()} — "${await b.page.title()}". Use snapshot for selectors, explore to map the product, step to try actions.`), image(await shotOf(b.page)));
}));

server.registerTool('snapshot', {
  description: 'Accessibility tree of the rehearsal page (roles + names). Use it to pick selectors like role=button[name="Save"].',
  inputSchema: {},
}, safe(async () => {
  if (!live) throw new Error('Nothing open. Call open first.');
  const tree = await live.b.page.locator('body').ariaSnapshot();
  return reply(text(`URL: ${live.b.page.url()}\n\n${tree.length > 15000 ? tree.slice(0, 15000) + '\n…(truncated)' : tree}`));
}));

server.registerTool('screenshot', {
  description: 'Screenshot of the rehearsal page.',
  inputSchema: {},
}, safe(async () => {
  if (!live) throw new Error('Nothing open. Call open first.');
  return reply(image(await shotOf(live.b.page)));
}));

server.registerTool('step', {
  description: 'Run one scene on the rehearsal page right away (fast, not recorded) and get a screenshot of the result: look at it and decide the next move. ' + SCENE_HELP,
  inputSchema: { scene: z.record(z.string(), z.any()).describe(SCENE_HELP), screenshot: z.boolean().optional().describe('default true') },
}, safe(async ({ scene, screenshot = true }) => {
  if (!live) throw new Error('Nothing open. Call open first.');
  if (!ACTIONS.some((k) => k in scene)) throw new Error('Scene has no action. ' + SCENE_HELP);
  await live.perf.run({ timeout: 8000, ...scene });
  await live.b.page.waitForTimeout(400);
  const msg = text(`ok — now at ${live.b.page.url()}`);
  return screenshot ? reply(msg, image(await shotOf(live.b.page))) : reply(msg);
}));

server.registerTool('explore', {
  description: 'Map the product for a walkthrough: visits same-site pages linked from the current page and lists each page\'s title, headings and main buttons/links. ' +
    'Use it to find every feature worth showing before writing the script.',
  inputSchema: { max_pages: z.number().int().min(1).max(40).optional().describe('default 12') },
}, safe(async ({ max_pages = 12 }) => {
  if (!live) throw new Error('Nothing open. Call open first.');
  const start = new URL(live.b.page.url());
  const seen = new Set(), queue = [start.href.split('#')[0]], pages = [];
  const tab = await live.b.ctx.newPage();
  try {
    while (queue.length && pages.length < max_pages) {
      const url = queue.shift();
      if (seen.has(url)) continue;
      seen.add(url);
      try {
        await tab.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await settle(tab);
      } catch { continue; }
      const info = await tab.evaluate(() => {
        const vis = (el) => el.offsetParent !== null;
        const names = (sel, n) => [...document.querySelectorAll(sel)].filter(vis).map((e) => (e.innerText || e.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ')).filter((s) => s && s.length < 60).slice(0, n);
        return {
          title: document.title,
          headings: names('h1,h2,h3', 12),
          buttons: names('button,[role=button],input[type=submit]', 15),
          forms: document.querySelectorAll('form,input,textarea,select').length,
          links: [...document.querySelectorAll('a[href]')].map((a) => a.href),
        };
      });
      pages.push({ url, title: info.title, headings: info.headings, buttons: info.buttons, inputs: info.forms });
      for (const l of info.links) {
        try {
          const u = new URL(l);
          if (u.origin === start.origin && !/\.(pdf|png|jpe?g|zip|mp4)$/i.test(u.pathname)) queue.push(u.href.split('#')[0]);
        } catch {}
      }
    }
  } finally {
    await tab.close();
  }
  return reply(text({ pages, unvisited: [...new Set(queue)].filter((u) => !seen.has(u)).slice(0, 30) }));
}));

server.registerTool('login', {
  description: 'Open a visible browser window so the USER can sign in. Tell the user to sign in and reply when done, then call login_done. ' +
    'The session is saved under the profile name; use the same "profile" in open and in the demo script.',
  inputSchema: { url: z.string(), profile: z.string() },
}, safe(async ({ url, profile }) => {
  await closeLive();
  const b = await launch({ profile, headless: false });
  await b.page.goto(url, { waitUntil: 'load', timeout: 45000 });
  live = { b, perf: new Performer(b.page, { human: false }), profile, login: true };
  return reply(text(`A browser window is open at ${url}. Ask the user to sign in there and tell you when they're done; then call login_done.`));
}));

server.registerTool('login_done', {
  description: 'Close the sign-in window and save the session to its profile.',
  inputSchema: {},
}, safe(async () => {
  const profile = live?.profile;
  await closeLive();
  return reply(text(profile ? `Saved. Use "profile": "${profile}" in open and in the demo script.` : 'No sign-in window was open.'));
}));

// ---------- browser mode: record ----------

server.registerTool('check', {
  description: 'Fast dry run of a whole demo script. Reports the first scene that fails. Run before record.',
  inputSchema: { script: z.any().optional().describe('demo script object'), path: z.string().optional().describe('or path to demo.json') },
}, safe(async ({ script, path: p }) => {
  await closeLive();
  return reply(text(await validate(loadScript(script ?? path.resolve(p)))));
}));

const jobs = new Map();
const startJob = (work) => {
  const id = `job${jobs.size + 1}`;
  const job = { status: 'running', log: 'starting' };
  jobs.set(id, job);
  work((m) => { job.log = m; })
    .then((r) => Object.assign(job, { status: 'done', result: r }))
    .catch((e) => Object.assign(job, { status: 'failed', error: e.message }));
  return id;
};

server.registerTool('record', {
  description: 'Record the demo in browser mode: generates narration, plays the script back at human speed (smooth mouse, natural typing) while recording, then renders ' +
    '4K video with auto-zoom, cursor, captions, title/end cards, plus share.html (player, chapters, transcript), captions.vtt, poster, GIF and a console/network log. ' +
    'Takes a few minutes, so it returns a job id: call job to wait.\n' + SCRIPT_HELP,
  inputSchema: {
    script: z.any().optional().describe('demo script object'),
    path: z.string().optional().describe('or path to demo.json'),
    out: z.string().optional().describe('output folder (default ./demos/<title>)'),
  },
}, safe(async ({ script, path: p, out }) => {
  const s = loadScript(script ?? path.resolve(p));
  await closeLive();
  const id = startJob((progress) => make(s, { out, progress }));
  return reply(text(`Recording started: ${id}. Call job with id "${id}" to wait for it.`));
}));

server.registerTool('job', {
  description: 'Wait for a record/camera job (up to ~50s per call). Returns progress, or the video paths and timeline when done.',
  inputSchema: { id: z.string() },
}, safe(async ({ id }) => {
  const job = jobs.get(id);
  if (!job) throw new Error(`No job ${id}`);
  for (let i = 0; i < 100 && job.status === 'running'; i++) await new Promise((r) => setTimeout(r, 500));
  if (job.status === 'running') return reply(text(`still running: ${job.log}. Call job again.`));
  if (job.status === 'failed') throw new Error(`Failed: ${job.error}\nFix the problem (rehearse with open/step, or check the window) and try again.`);
  return reply(text({ ...job.result, share: path.join(job.result.out || path.dirname(job.result.files[0]), 'share.html'),
    next: 'Call review with the final.mp4 path and check every frame before telling the user it is done.' }));
}));

server.registerTool('review', {
  description: 'Look at a finished video: one frame per scene/chapter plus the timeline, captions and logged errors. Check for wrong pages, error messages, ' +
    'cut-off text, a bad zoom or anything private, then fix and re-record (or re-render) if needed.',
  inputSchema: { video: z.string().describe('path to final.mp4') },
}, safe(async ({ video }) => {
  const dir = path.dirname(path.resolve(video));
  const tl = JSON.parse(fs.readFileSync(path.join(dir, 'timeline.json'), 'utf8'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autodemo-'));
  const content = [text(tl)];
  const marks = (tl.scenes.length ? tl.scenes : tl.captions.map((c, i) => ({ scene: i + 1, at: c.at }))).slice(0, 14);
  for (const [i, s] of marks.entries()) {
    const next = marks[i + 1]?.at ?? tl.length;
    const at = Math.min(tl.length - 0.1, s.at + Math.min(1.5, (next - s.at) * 0.7));
    const f = path.join(tmp, `${i}.jpg`);
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(at), '-i', video, '-frames:v', '1', '-vf', 'scale=960:-2', '-q:v', '5', f]);
    content.push(text(`scene ${s.scene} @ ${at.toFixed(1)}s`), image(fs.readFileSync(f).toString('base64')));
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  return { content };
}));

server.registerTool('close', { description: 'Close the rehearsal browser.', inputSchema: {} }, safe(async () => {
  await closeLive();
  return reply(text('closed'));
}));

// ---------- camera mode: a screen recorder for agents ----------
// Token budget: screenshots are small JPEGs (0.6x points), every other reply is one short line,
// and camera_say carries the click/chapter for that step so one step = one call.

const rolling = () => { if (!camera) throw new Error('Camera is not rolling. Call camera_start first.'); return camera; };
const xy = z.array(z.number()).length(2);

server.registerTool('windows', {
  description: 'List open windows (id, app, title) you can film with camera_start window. macOS only.',
  inputSchema: {},
}, safe(async () => reply(text((await windows()).map((w) => `${w.id} ${w.app} | ${w.title}${w.onScreen ? '' : ' (hidden)'}`).join('\n')))));

server.registerTool('camera_start', {
  description: 'Start recording, like sharing one tab or window in Zoom, with no picker: tab (a browser tab by URL/title; autodemo finds, activates and raises it) ' +
    'or window (any app, simulator or emulator window); neither = whole screen. Then drive it with YOUR OWN tools (Claude in Chrome, computer use, ...) ' +
    'or camera_act, calling camera_say before each step. Returns a small screenshot; its pixels are the coordinates every camera tool uses. ' +
    'Long takes (10-20 min) are fine; use output.fps 30 for them.',
  inputSchema: {
    tab: z.string().optional().describe('part of a browser tab URL or title, e.g. "todomvc.com" (Chrome, Brave, Edge, Safari)'),
    window: z.string().optional().describe('or an app window: app name, window id or title (e.g. "Simulator", "Figma")'),
    title: z.string().optional(), subtitle: z.string().optional(),
    voiceover: z.boolean().optional(), voice: z.string().optional(),
    background: z.any().optional().describe('macos | macos-light | midnight | sunset | ocean | forest | peach | aurora | grid | mono | light, or ["#hex","#hex"], or an image path'),
    frame: z.enum(['mac', 'browser', 'none']).optional().describe('window frame drawn around the recording (default: mac on macos backgrounds, else none)'),
    trim: z.object({ top: z.number().optional(), right: z.number().optional(), bottom: z.number().optional(), left: z.number().optional() }).optional()
      .describe('cut edges off the video, in screenshot pixels (browser info bars, banners)'),
    cursor: z.boolean().optional().describe('also record the real mouse pointer'),
    output: z.object({ resolution: z.enum(['4k', '1080p']).optional(), vertical: z.boolean().optional(), fps: z.number().optional() }).optional(),
    cta: z.object({ text: z.string().optional(), url: z.string().optional() }).optional(),
    bubble: z.object({ label: z.string().optional(), image: z.string().optional() }).optional(),
    out: z.string().optional(),
  },
}, safe(async ({ trim, ...opts }) => {
  if (camera) throw new Error('Camera is already rolling. Call camera_stop first.');
  camera = await CameraSession.start({ ...opts, fps: opts.output?.fps, out: opts.out || path.join('demos', slug(opts.title || 'camera')) });
  if (trim) camera.setTrim(trim);
  const s = await camera.screenshot({ withHint: !trim });
  const hint = s.bar ? ` A bar ${s.bar}px tall is across the top (browser info bar or banner?). If it is not part of the app, call camera_trim {top: ${s.bar}}.` : '';
  return reply(text(`Rolling: ${camera.win.app} | ${camera.win.title} (${s.width}x${s.height}).${hint}`), image(s.data));
}));

server.registerTool('camera_say', {
  description: 'One step of the demo in one call: the narration line (spoken here; say it right BEFORE the action), plus optionally where you are about to click and a new chapter. Then do the action.',
  inputSchema: { text: z.string().optional(), click: xy.optional().describe('[x, y] in screenshot pixels: draws cursor + ripple, zooms there'), chapter: z.string().optional() },
}, safe(async ({ text: t, click, chapter }) => {
  const c = rolling();
  if (chapter) c.chapter(chapter);
  if (t) c.say(t);
  if (click) c.click(...click);
  return reply(text('ok'));
}));

server.registerTool('camera_click', {
  description: 'Mark a click (screenshot pixels) without narration: cursor, ripple and zoom. Usually pass click to camera_say instead.',
  inputSchema: { x: z.number(), y: z.number() },
}, safe(async ({ x, y }) => { rolling().click(x, y); return reply(text('ok')); }));

server.registerTool('camera_focus', {
  description: 'Point the camera at a region (zoom in), in screenshot pixels. Give width/height for an area, or just x/y for a spot.',
  inputSchema: { x: z.number(), y: z.number(), width: z.number().optional(), height: z.number().optional() },
}, safe(async ({ x, y, width, height }) => { rolling().focus(x, y, width, height); return reply(text('ok')); }));

server.registerTool('camera_trim', {
  description: 'Cut edges off the whole video (screenshot pixels): browser info bars ("Claude started debugging this browser"), cookie banners, an agent\'s glow at the edges. Applies to the full take.',
  inputSchema: { top: z.number().optional(), right: z.number().optional(), bottom: z.number().optional(), left: z.number().optional() },
}, safe(async (t) => { rolling().setTrim(t); return reply(text('ok')); }));

server.registerTool('camera_act', {
  description: 'Click, type, press a key or scroll in the filmed app yourself (real mouse/keyboard) when you have no browser or computer-use tool. ' +
    'Loop: camera_screenshot, decide, camera_act. x/y are screenshot pixels; clicks are marked automatically. Needs Accessibility permission once ' +
    '(if it fails, ask the user to allow it in System Settings > Privacy & Security > Accessibility). Takes over the real mouse: only when the user is not using the Mac.',
  inputSchema: {
    click: xy.optional(), type: z.string().optional(), key: z.string().optional().describe('return, tab, escape, up, down, a, l, ...'),
    mods: z.string().optional().describe('cmd,shift,alt,ctrl'), scroll: z.number().optional().describe('pixels, positive = down'),
  },
}, safe(async (a) => { await rolling().act(a); return reply(text('ok')); }));

server.registerTool('camera_screenshot', {
  description: 'What the camera sees now (small JPEG; its pixels are the coordinates). Only look when you need to: prefer your own tools\' text/DOM reads.',
  inputSchema: {},
}, safe(async () => reply(image((await rolling().screenshot()).data))));

server.registerTool('camera_pause', {
  description: 'Stop filming (the user signs in, or anything private). Nothing is recorded until camera_resume.',
  inputSchema: {},
}, safe(async () => { await rolling().pause(); return reply(text('paused')); }));

server.registerTool('camera_resume', {
  description: 'Resume filming after camera_pause.',
  inputSchema: {},
}, safe(async () => { await rolling().resume(); return reply(text('rolling')); }));

let studio = null;
server.registerTool('studio', {
  description: 'Start the local studio (if not running) and return its URL: a page listing every recorded demo, each opening its share page; takes still recording or rendering show live. Give the URL to the user.',
  inputSchema: { dir: z.string().optional().describe('demos folder (default ./demos)'), port: z.number().optional() },
}, safe(async ({ dir, port }) => {
  studio ??= await (await import('./serve.js')).serve(dir || 'demos', { port: port || 4747 });
  return reply(text(studio.url));
}));

server.registerTool('camera_stop', {
  description: 'Stop and render: narration, auto-zoom on the action, cursor, captions, background, cut thinking time, share page. Returns a job id: call job to wait.',
  inputSchema: {},
}, safe(async () => {
  const s = rolling();
  camera = null;
  const id = startJob(async (progress) => ({ out: s.out, ...(await s.stop({ progress })) }));
  return reply(text(`Rendering: ${id}. Call job with id "${id}".`));
}));

process.on('SIGTERM', async () => { await closeLive(); await camera?.pause().catch(() => {}); process.exit(0); });
await server.connect(new StdioServerTransport());
