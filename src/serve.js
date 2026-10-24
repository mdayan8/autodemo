// A local studio for everything the agent recorded: one page with every demo (poster, length,
// chapters), each opening its share page. A take that is still rolling or rendering shows live.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const TYPES = { '.html': 'text/html; charset=utf-8', '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.gif': 'image/gif',
  '.vtt': 'text/vtt', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8', '.png': 'image/png' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

function demos(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => {
    const dir = path.join(root, d.name), has = (f) => fs.existsSync(path.join(dir, f));
    const rec = read(path.join(dir, 'recording.json')) || read(path.join(dir, 'demo.json')) || {};
    const tl = read(path.join(dir, 'timeline.json'));
    const state = has('final.mp4') ? 'ready' : has('recording.json') ? 'rendering' : has('segment-1.mp4') ? 'recording' : 'empty';
    return { name: d.name, title: rec.title || d.name, state, length: tl?.length, chapters: tl?.chapters?.length || 0,
      page: has('share.html') ? 'share.html' : 'final.mp4', poster: has('poster.jpg'), mtime: fs.statSync(dir).mtimeMs };
  }).filter((d) => d.state !== 'empty').sort((a, b) => b.mtime - a.mtime);
}

function index(root) {
  const list = demos(root);
  const live = list.some((d) => d.state !== 'ready');
  const card = (d) => `<a class="card" href="${d.state === 'ready' ? `${encodeURIComponent(d.name)}/${d.page}` : '#'}">
    <div class="thumb">${d.poster ? `<img src="${encodeURIComponent(d.name)}/poster.jpg" alt="">` : ''}<span class="badge ${d.state}">${d.state === 'ready' ? (d.length ? `${Math.floor(d.length / 60)}:${String(Math.round(d.length % 60)).padStart(2, '0')}` : 'ready') : d.state + '…'}</span></div>
    <h2>${esc(d.title)}</h2><p>${d.chapters ? `${d.chapters} chapters · ` : ''}${new Date(d.mtime).toLocaleString()}</p></a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>autodemo studio</title>${live ? '<meta http-equiv="refresh" content="5">' : ''}
<style>:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--ink:#14161a;--dim:#6b7280}
@media(prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#181b21;--ink:#e8eaed;--dim:#9aa0a6}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,Inter,system-ui,sans-serif}
main{max-width:1100px;margin:0 auto;padding:32px 16px}h1{font-size:24px;margin:0 0 4px}.sub{color:var(--dim);margin:0 0 24px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:18px}
.card{background:var(--card);border-radius:14px;overflow:hidden;text-decoration:none;color:inherit;box-shadow:0 1px 3px rgba(0,0,0,.12)}
.thumb{aspect-ratio:16/9;background:#222;position:relative}.thumb img{width:100%;height:100%;object-fit:cover;display:block}
.badge{position:absolute;right:8px;bottom:8px;background:rgba(0,0,0,.75);color:#fff;font-size:12px;padding:2px 8px;border-radius:6px}
.badge.recording{background:#e0332b}.badge.rendering{background:#b45309}
.card h2{font-size:16px;margin:10px 12px 0}.card p{color:var(--dim);font-size:13px;margin:2px 12px 12px}</style></head>
<body><main><h1>autodemo studio</h1><p class="sub">Every demo your agents recorded in ${esc(root)}. Click one to watch it with chapters and transcript.</p>
<div class="grid">${list.map(card).join('') || '<p>No demos yet. Ask your agent to record one.</p>'}</div></main></body></html>`;
}

export function serve(root, { port = 4747 } = {}) {
  root = path.resolve(root);
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (url === '/' || url === '/index.html') { res.writeHead(200, { 'content-type': TYPES['.html'] }); return res.end(index(root)); }
    const file = path.join(root, path.normalize(url).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('not found'); }
    const size = fs.statSync(file).size, type = TYPES[path.extname(file)] || 'application/octet-stream';
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || ''); // video seeking
    if (range) {
      const a = range[1] ? +range[1] : 0, b = range[2] ? +range[2] : size - 1;
      res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${a}-${b}/${size}`, 'accept-ranges': 'bytes', 'content-length': b - a + 1 });
      return fs.createReadStream(file, { start: a, end: b }).pipe(res);
    }
    res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, url: `http://localhost:${port}/` }));
  });
}
