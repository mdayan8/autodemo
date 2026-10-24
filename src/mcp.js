import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { launch, settle } from './browser.js';
import { Performer, ACTIONS } from './perform.js';
import { make, loadScript, validate } from './demo.js';

// stdout is the MCP channel; keep library chatter off it.
console.log = console.error;
const run = promisify(execFile);

const text = (t) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: e.message || String(e) }] });
const safe = (fn) => async (args) => { try { return await fn(args); } catch (e) { return fail(e); } };

let live = null; // rehearsal browser: { b, perf, profile }
const closeLive = async () => { if (live) { await live.b.close(); live = null; } };

const server = new McpServer({ name: 'autodemo', version: '0.1.0' }, {
  instructions:
    'autodemo records narrated product demo videos. Workflow: 1) open + snapshot + step to rehearse the flow live (nothing is recorded); ' +
    '2) write a demo script (same scene format as step); 3) check it; 4) record (returns a job id; poll job); 5) review the frames and fix/re-record if needed. ' +
    'If a site needs sign-in, call login and ask the user to sign in in the window that opens; never type passwords yourself.',
});

const SCENE_HELP =
  `A scene is one object with ONE action plus optional extras:\n` +
  `  {"goto": url} | {"click": sel} | {"hover": sel} | {"type": {"into": sel, "text": "...", "enter": true}} | {"press": "Enter"}\n` +
  `  {"scroll": 600 | sel} | {"wait_for": sel} | {"wait": ms}\n` +
  `Extras: "say": narration spoken during the scene, "zoom": false | 2.2, "pause": ms after, "timeout": ms.\n` +
  `Selectors are Playwright selectors: role=button[name="Save"], text=Sign up, css (#id, .class), label=Email.`;

const scene = z.record(z.string(), z.any()).describe(SCENE_HELP);

server.registerTool('open', {
  description: 'Open a URL in a rehearsal browser (not recorded). Use a profile to reuse a saved sign-in.',
  inputSchema: { url: z.string(), profile: z.string().optional().describe('saved sign-in profile name'), headed: z.boolean().optional() },
}, safe(async ({ url, profile, headed }) => {
  await closeLive();
  const b = await launch({ profile, headless: !headed });
  await b.page.goto(url, { waitUntil: 'load', timeout: 45000 });
  await settle(b.page);
  live = { b, perf: new Performer(b.page, { human: false }), profile };
  return text(`Opened ${b.page.url()} — "${await b.page.title()}". Call snapshot to see the page.`);
}));

server.registerTool('snapshot', {
  description: 'Accessibility tree of the rehearsal page (roles + names). Use it to pick selectors like role=button[name="Save"].',
  inputSchema: {},
}, safe(async () => {
  if (!live) throw new Error('Nothing open. Call open first.');
  const tree = await live.b.page.locator('body').ariaSnapshot();
  return text(`URL: ${live.b.page.url()}\n\n${tree.length > 15000 ? tree.slice(0, 15000) + '\n…(truncated)' : tree}`);
}));

server.registerTool('screenshot', {
  description: 'Screenshot of the rehearsal page (viewport only).',
  inputSchema: {},
}, safe(async () => {
  if (!live) throw new Error('Nothing open. Call open first.');
  const buf = await live.b.page.screenshot({ type: 'jpeg', quality: 70, scale: 'css' });
  return { content: [{ type: 'image', data: buf.toString('base64'), mimeType: 'image/jpeg' }] };
}));

server.registerTool('step', {
  description: 'Run one scene on the rehearsal page right away (fast, not recorded) to test that it works. ' + SCENE_HELP,
  inputSchema: { scene },
}, safe(async ({ scene }) => {
  if (!live) throw new Error('Nothing open. Call open first.');
  if (!ACTIONS.some((k) => k in scene)) throw new Error('Scene has no action. ' + SCENE_HELP);
  await live.perf.run({ timeout: 8000, ...scene });
  await live.b.page.waitForTimeout(300);
  return text(`ok — now at ${live.b.page.url()}`);
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
  return text(`A browser window is open at ${url}. Ask the user to sign in there and tell you when they're done; then call login_done.`);
}));

server.registerTool('login_done', {
  description: 'Close the sign-in window and save the session to its profile.',
  inputSchema: {},
}, safe(async () => {
  const profile = live?.profile;
  await closeLive();
  return text(profile ? `Saved. Use "profile": "${profile}" in open and in the demo script.` : 'No sign-in window was open.');
}));

server.registerTool('check', {
  description: 'Fast dry run of a whole demo script. Reports the first scene that fails. Run before record.',
  inputSchema: { script: z.any().optional().describe('demo script object'), path: z.string().optional().describe('or path to demo.json') },
}, safe(async ({ script, path: p }) => {
  await closeLive();
  return text(await validate(loadScript(script ?? path.resolve(p))));
}));

const jobs = new Map();

server.registerTool('record', {
  description:
    'Record the demo: generates narration, plays the script back at human speed while recording, then renders a polished video ' +
    '(auto-zoom on clicks, smooth cursor, captions, title card, dead time cut). Takes 1-3 minutes, so it returns a job id: call job to wait for it.\n' +
    'Script: {"title", "subtitle"?, "url", "profile"?, "voice"? (Kokoro voice, default af_heart; e.g. am_michael, bf_emma), ' +
    '"speed"?, "blur"?: [selectors to hide], "output"?: {"vertical": true}, "scenes": [...]}.\n' + SCENE_HELP,
  inputSchema: {
    script: z.any().optional().describe('demo script object'),
    path: z.string().optional().describe('or path to demo.json'),
    out: z.string().optional().describe('output folder (default ./demos/<title>)'),
  },
}, safe(async ({ script, path: p, out }) => {
  const s = loadScript(script ?? path.resolve(p));
  await closeLive();
  const id = `job${jobs.size + 1}`;
  const job = { status: 'running', log: 'starting' };
  jobs.set(id, job);
  make(s, { out, progress: (m) => { job.log = m; } })
    .then((r) => Object.assign(job, { status: 'done', result: r }))
    .catch((e) => Object.assign(job, { status: 'failed', error: e.message }));
  return text(`Recording started: ${id}. Call job with id "${id}" to wait for it.`);
}));

server.registerTool('job', {
  description: 'Wait for a record job (up to ~50s per call). Returns progress, or the video paths and timeline when done.',
  inputSchema: { id: z.string() },
}, safe(async ({ id }) => {
  const job = jobs.get(id);
  if (!job) throw new Error(`No job ${id}`);
  for (let i = 0; i < 100 && job.status === 'running'; i++) await new Promise((r) => setTimeout(r, 500));
  if (job.status === 'running') return text(`still running: ${job.log}. Call job again.`);
  if (job.status === 'failed') throw new Error(`Recording failed: ${job.error}\nFix the script (use open/step to test) and record again.`);
  return text({ ...job.result, next: 'Call review with the video path to check the result.' });
}));

server.registerTool('review', {
  description: 'Look at a finished video: one frame per scene plus the timeline and captions. Check for wrong pages, error messages, ' +
    'cut-off text or anything private, then fix the script and re-record if needed.',
  inputSchema: { video: z.string().describe('path to final.mp4') },
}, safe(async ({ video }) => {
  const dir = path.dirname(path.resolve(video));
  const tl = JSON.parse(fs.readFileSync(path.join(dir, 'timeline.json'), 'utf8'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autodemo-'));
  const content = [{ type: 'text', text: JSON.stringify(tl, null, 1) }];
  const scenes = tl.scenes.slice(0, 12);
  for (const [i, s] of scenes.entries()) {
    const next = scenes[i + 1]?.at ?? tl.length;
    const at = Math.min(tl.length - 0.1, s.at + Math.min(1.5, (next - s.at) * 0.7));
    const f = path.join(tmp, `${i}.jpg`);
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(at), '-i', video, '-frames:v', '1', '-vf', 'scale=960:-1', '-q:v', '5', f]);
    content.push({ type: 'text', text: `scene ${s.scene} @ ${at.toFixed(1)}s` });
    content.push({ type: 'image', data: fs.readFileSync(f).toString('base64'), mimeType: 'image/jpeg' });
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  return { content };
}));

server.registerTool('close', { description: 'Close the rehearsal browser.', inputSchema: {} }, safe(async () => {
  await closeLive();
  return text('closed');
}));

process.on('SIGTERM', async () => { await closeLive(); process.exit(0); });
await server.connect(new StdioServerTransport());
