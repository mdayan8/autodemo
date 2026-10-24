// Smoke test: MCP server starts, rehearsal tools work, script validation catches mistakes.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadScript } from '../src/demo.js';
import { timeMap } from '../src/render.js';

assert.throws(() => loadScript({ url: 'x', scenes: [{ click: 'a', type: 'b' }] }), /one action per scene/);
const tm = timeMap([{ type: 'click', t: 1, end: 2 }, { type: 'click', t: 10, end: 11 }], 12);
assert.ok(tm.length < 9, 'idle gap should be squeezed');
assert.ok(Math.abs(tm.toSrc(tm.toDst(5)) - 5) < 1e-9, 'time map round-trips');

const bin = fileURLToPath(new URL('../bin/autodemo.js', import.meta.url));
const client = new Client({ name: 'check', version: '1' });
await client.connect(new StdioClientTransport({ command: 'node', args: [bin, 'mcp'] }));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  assert.ok(!r.isError, `${name}: ${r.content?.[0]?.text}`);
  return r.content;
};
const { tools } = await client.listTools();
console.log('tools:', tools.map((t) => t.name).join(', '));
await call('open', { url: 'https://demo.playwright.dev/todomvc/' });
const snap = (await call('snapshot'))[0].text;
assert.match(snap, /What needs to be done/);
await call('step', { scene: { type: { into: 'role=textbox[name="What needs to be done?"]', text: 'from mcp', enter: true } } });
assert.match((await call('snapshot'))[0].text, /from mcp/);
assert.equal((await call('screenshot'))[0].type, 'image');
await call('close');
await client.close();
console.log('ok');
