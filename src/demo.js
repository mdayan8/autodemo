import fs from 'node:fs';
import path from 'node:path';
import { ACTIONS, record, validate } from './perform.js';
import { speak } from './narrate.js';
import { render } from './render.js';

// Accepts a script object or a path to demo.json. Throws readable errors an agent can fix.
export function loadScript(input) {
  const script = typeof input === 'string' ? JSON.parse(fs.readFileSync(input, 'utf8')) : input;
  const errs = [];
  if (!Array.isArray(script?.scenes) || !script.scenes.length) errs.push('"scenes" must be a non-empty array');
  (script?.scenes || []).forEach((s, i) => {
    const acts = ACTIONS.filter((k) => k in s);
    if (acts.length > 1) errs.push(`scene ${i + 1}: one action per scene (found ${acts.join(', ')})`);
    if (!acts.length && !s.say) errs.push(`scene ${i + 1}: needs an action (${ACTIONS.join(', ')}) or "say"`);
  });
  if (!script?.url && script?.scenes?.[0] && !('goto' in script.scenes[0])) errs.push('set "url" or start with a goto scene');
  if (errs.length) throw new Error('Invalid demo script:\n- ' + errs.join('\n- '));
  return script;
}

const slug = (s) => (s || 'demo').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'demo';

// The whole pipeline: narrate -> perform/record -> render.
export async function make(input, { out, headed = false, progress = (m) => console.error(`[autodemo] ${m}`) } = {}) {
  const script = loadScript(input);
  out = path.resolve(out || path.join('demos', slug(script.title)));
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'demo.json'), JSON.stringify(script, null, 2));

  const voice = [];
  for (const [i, s] of script.scenes.entries()) {
    if (!s.say || script.voiceover === false) continue; // no voiceover: captions only
    progress(`voice ${i + 1}/${script.scenes.length}`);
    voice[i] = await speak(s.say, { voice: script.voice, speed: script.speed });
  }
  progress('recording');
  await record(script, { out, voice, headed, progress });
  progress('rendering');
  const { files, timeline } = await render(out, { progress });
  return { out, files, timeline };
}

export { validate, render };
export { slug };
