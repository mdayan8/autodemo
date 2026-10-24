#!/usr/bin/env node
import { parseArgs } from 'node:util';
import path from 'node:path';

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: { out: { type: 'string' }, headed: { type: 'boolean' }, profile: { type: 'string' } },
});
const [cmd, arg] = positionals;

const HELP = `autodemo - agents record their own product demos

  autodemo mcp                     start the MCP server (stdio) for Claude Code, Codex, Cursor...
  autodemo run demo.json           record + narrate + render  [--out dir] [--headed]
  autodemo check demo.json         fast dry run, reports the first broken scene
  autodemo render <dir>            re-render an existing recording (no re-recording)
  autodemo login <url> --profile p open a browser so you can sign in; the session is saved to profile p
  autodemo doctor                  check ffmpeg, Chromium and the voice model`;

switch (cmd) {
  case 'mcp':
    await import('../src/mcp.js');
    break;
  case 'run': {
    const { make } = await import('../src/demo.js');
    const r = await make(path.resolve(arg), { out: flags.out, headed: flags.headed });
    console.log(r.files.join('\n'));
    break;
  }
  case 'check': {
    const { loadScript, validate } = await import('../src/demo.js');
    const r = await validate(loadScript(path.resolve(arg)), { headed: flags.headed });
    console.log(JSON.stringify(r, null, 2));
    process.exitCode = r.ok ? 0 : 1;
    break;
  }
  case 'render': {
    const { render } = await import('../src/demo.js');
    const r = await render(path.resolve(arg), { progress: (m) => console.error(`[autodemo] ${m}`) });
    console.log(r.files.join('\n'));
    break;
  }
  case 'login': {
    const { launch } = await import('../src/browser.js');
    const b = await launch({ profile: flags.profile || 'default', headless: false });
    await b.page.goto(arg);
    console.log(`Sign in, then close the browser window. Session saves to profile "${flags.profile || 'default'}".`);
    await new Promise((r) => b.ctx.on('close', r));
    break;
  }
  case 'doctor': {
    const { execFileSync } = await import('node:child_process');
    const ok = async (name, fn) => { try { await fn(); console.log(`ok   ${name}`); } catch (e) { console.log(`FAIL ${name}: ${e.message.split('\n')[0]}`); process.exitCode = 1; } };
    await ok('ffmpeg', () => execFileSync('ffmpeg', ['-version']));
    const { chromium } = await import('playwright');
    await ok('chromium', async () => { if (!(await import('node:fs')).existsSync(chromium.executablePath())) throw new Error('run: npx playwright install chromium'); });
    const { speak } = await import('../src/narrate.js');
    try { const v = await speak('Autodemo is ready.'); console.log(`ok   voice (${v.d.toFixed(1)}s sample: ${v.file})`); }
    catch (e) { console.log(`FAIL voice: ${e.message}`); process.exitCode = 1; }
    break;
  }
  default:
    console.log(HELP);
}
