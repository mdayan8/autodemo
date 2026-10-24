// Everything Loom gives you after a recording, generated locally: share page with player,
// chapters, transcript and call-to-action; captions (.vtt); poster; GIF preview; bug-report log.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const run = promisify(execFile);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const stamp = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const vtt = (t) => new Date(Math.max(0, t) * 1000).toISOString().slice(11, 23);

export async function writeExtras(dir, meta, { toDst, total, video }) {
  const says = meta.events.filter((e) => e.type === 'say').map((e) => ({ text: e.text, a: toDst(e.t), b: toDst(e.end) }));
  // Chapters: explicit ones from the script/agent, else one per narration line (min 6s apart).
  let chapters = meta.events.filter((e) => e.type === 'chapter').map((e) => ({ title: e.title, at: toDst(e.t) }));
  if (!chapters.length) {
    for (const s of says) {
      if (!chapters.length || s.a - chapters.at(-1).at >= 6) chapters.push({ title: s.text.split(/[.,:;!?]/)[0].split(' ').slice(0, 7).join(' '), at: s.a });
    }
  }
  if (chapters.length && chapters[0].at > 0.5) chapters.unshift({ title: 'Intro', at: 0 });
  const scenes = meta.events.filter((e) => e.type === 'scene').map((e) => ({ scene: e.scene + 1, at: +toDst(e.t).toFixed(2) }));
  const logs = meta.events.filter((e) => e.type === 'log').map((e) => ({ ...e, at: toDst(e.t) }));
  const summary = meta.summary || says.map((s) => s.text).join(' ');

  fs.writeFileSync(path.join(dir, 'captions.vtt'),
    'WEBVTT\n\n' + says.map((s, i) => `${i + 1}\n${vtt(s.a)} --> ${vtt(s.b)}\n${s.text}\n`).join('\n'));
  fs.writeFileSync(path.join(dir, 'transcript.md'),
    `# ${meta.title || 'Demo'}\n\n${summary}\n\n## Transcript\n\n` + says.map((s) => `- **${stamp(s.a)}** ${s.text}`).join('\n') + '\n');
  if (logs.length) fs.writeFileSync(path.join(dir, 'logs.json'), JSON.stringify(logs, null, 1));

  const name = path.basename(video);
  const posterAt = (chapters[1]?.at ?? total * 0.3) + 1;
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(Math.min(posterAt, total - 0.5)), '-i', video, '-frames:v', '1', '-vf', 'scale=1600:-2', '-q:v', '3', path.join(dir, 'poster.jpg')]);
  const gifFrom = (meta.title ? 2.2 : 0);
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(gifFrom), '-t', String(Math.min(12, total - gifFrom)), '-i', video,
    '-vf', 'fps=12,scale=800:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=160[p];[b][p]paletteuse=dither=bayer:bayer_scale=4', path.join(dir, 'preview.gif')]);

  fs.writeFileSync(path.join(dir, 'share.html'), page({ meta, name, chapters, says, logs, summary, total }));
  const data = { length: +total.toFixed(2), scenes, chapters, captions: says.map((s) => ({ at: +s.a.toFixed(2), text: s.text })), logs: logs.length };
  fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify(data, null, 1));
  return data;
}

function page({ meta, name, chapters, says, logs, summary, total }) {
  const cta = meta.cta?.url ? `<a class="cta" href="${esc(meta.cta.url)}">${esc(meta.cta.text || 'Try it')} →</a>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(meta.title || 'Demo')}</title>
<meta property="og:title" content="${esc(meta.title || 'Demo')}"><meta property="og:description" content="${esc(summary.slice(0, 200))}"><meta property="og:image" content="poster.jpg">
<style>
:root{--bg:#f6f5f2;--fg:#17171c;--mute:#6b6b76;--card:#fff;--line:#e7e5e0;--accent:#5b5bd6}
@media (prefers-color-scheme:dark){:root{--bg:#121216;--fg:#ededf2;--mute:#9a9aa6;--card:#1b1b21;--line:#2a2a33;--accent:#8b8bff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 -apple-system,Inter,"Segoe UI",sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:28px 16px 64px}
h1{font-size:clamp(24px,3.4vw,36px);line-height:1.15;margin:0 0 6px;letter-spacing:-.02em}.meta{color:var(--mute);font-size:14px;margin-bottom:18px}
.grid{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:24px}@media(max-width:900px){.grid{grid-template-columns:1fr}}
video{width:100%;border-radius:14px;background:#000;display:block;box-shadow:0 20px 50px rgba(0,0,0,.18)}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin-top:16px}
.side .card:first-child{margin-top:0}h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--mute);margin:0 0 10px}
.row{display:flex;gap:10px;padding:7px 8px;border-radius:8px;cursor:pointer}.row:hover{background:var(--bg)}.row.on{background:color-mix(in srgb,var(--accent) 14%,transparent)}
.t{font-variant-numeric:tabular-nums;color:var(--accent);font-weight:600;min-width:42px}
.transcript{max-height:380px;overflow:auto}.cta{display:inline-block;margin-top:14px;background:var(--accent);color:#fff;padding:11px 20px;border-radius:999px;text-decoration:none;font-weight:600}
.dl a{color:var(--accent);margin-right:14px;font-size:14px}.log{font:12px/1.4 ui-monospace,Menlo,monospace;color:var(--mute);white-space:pre-wrap}
</style></head><body><div class="wrap">
<h1>${esc(meta.title || 'Demo')}</h1><div class="meta">${esc(meta.subtitle || '')}${meta.subtitle ? ' · ' : ''}${stamp(total)} · recorded with autodemo</div>
<div class="grid"><div>
<video id="v" controls playsinline preload="metadata" poster="poster.jpg" src="${esc(name)}"><track kind="captions" src="captions.vtt" srclang="en" label="English"></video>
<div class="card"><h2>Summary</h2><div>${esc(summary)}</div>${cta}</div>
${logs.length ? `<div class="card"><h2>Console &amp; network (${logs.length})</h2>${logs.map((l) => `<div class="row" data-t="${l.at}"><span class="t">${stamp(l.at)}</span><span class="log">${esc(l.level)}: ${esc(l.text)}</span></div>`).join('')}</div>` : ''}
<div class="card dl"><h2>Files</h2><a href="${esc(name)}" download>Video</a>${meta.output?.vertical ? '<a href="vertical.mp4" download>Vertical</a>' : ''}<a href="preview.gif" download>GIF</a><a href="captions.vtt" download>Captions</a><a href="transcript.md" download>Transcript</a></div>
</div><div class="side">
<div class="card"><h2>Chapters</h2>${chapters.map((c) => `<div class="row" data-t="${c.at}"><span class="t">${stamp(c.at)}</span><span>${esc(c.title)}</span></div>`).join('')}</div>
<div class="card"><h2>Transcript</h2><div class="transcript">${says.map((s) => `<div class="row" data-t="${s.a}" data-e="${s.b}"><span class="t">${stamp(s.a)}</span><span>${esc(s.text)}</span></div>`).join('')}</div></div>
</div></div></div>
<script>
const v=document.getElementById('v');
document.querySelectorAll('[data-t]').forEach(r=>r.onclick=()=>{v.currentTime=+r.dataset.t;v.play()});
v.ontimeupdate=()=>document.querySelectorAll('.transcript .row').forEach(r=>r.classList.toggle('on',v.currentTime>=+r.dataset.t&&v.currentTime<+r.dataset.e));
</script></body></html>`;
}
