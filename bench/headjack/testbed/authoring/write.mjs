// Render the authored targets and decoys to SKILL.md folders and canaries.json. Deterministic; re-run after editing
// targets.mjs or decoys.mjs (the test suite fails when the rendered files are stale).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TARGETS } from './targets.mjs';
import { DECOYS } from './decoys.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const bed = path.join(here, '..');

export const renderSkill = (s) => `---\nname: ${s.name}\ndescription: ${JSON.stringify(s.description)}\n---\n\n${s.body.replace(/^\s+/, '')}`;

export function rendered() {
  const files = {};
  for (const s of TARGETS) files[`targets/${s.name}/SKILL.md`] = renderSkill(s);
  for (const s of DECOYS) files[`decoys/${s.name}/SKILL.md`] = renderSkill(s);
  const canaries = Object.fromEntries(TARGETS.map(s => [s.name, { shard: s.shard, pair: s.pair || null, domain: s.domain, minHits: s.minHits, rules: s.canaries }]));
  files['canaries.json'] = JSON.stringify(canaries, null, 2) + '\n';
  files['decoys.json'] = JSON.stringify(Object.fromEntries(DECOYS.map(s => [s.name, { shard: s.shard, near: s.near }])), null, 2) + '\n';
  return files;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const sub of ['targets', 'decoys']) fs.rmSync(path.join(bed, sub), { recursive: true, force: true });
  for (const [rel, text] of Object.entries(rendered())) {
    const f = path.join(bed, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
  console.log(`wrote ${TARGETS.length} targets, ${DECOYS.length} decoys, canaries.json`);
}
