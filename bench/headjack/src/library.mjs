// Library composition: for shard s and size N, the skills an arm gets. Deterministic for a seed.
//   N <= 5   the shard's 5 target skills (truncated to N)
//   N > 5    the 5 targets + the shard's 3 decoys + filler, in a fixed seeded order of the public pool, then synthetic
//            skills when the public pool runs out. Filler for a smaller N is a prefix of the filler for a larger N.
// Materialized once per (seed, shard, N) under .cache/libs/, then copied (native) or indexed in place (headjack).
import fs from 'node:fs';
import path from 'node:path';
import { TESTBED, CACHE_DIR } from './paths.mjs';
import { shuffle, synthSkill } from './synth.mjs';
import { parseFrontmatter } from '../../../packages/core/src/frontmatter.mjs';

export const SHARDS = [1, 2, 3, 4, 5, 6, 7, 8];
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
export const canaries = () => readJson(path.join(TESTBED, 'canaries.json'));
export const decoys = () => readJson(path.join(TESTBED, 'decoys.json'));
const skillText = (kind, name) => fs.readFileSync(path.join(TESTBED, kind, name, 'SKILL.md'), 'utf8');

/** Entries: { name, description, kind: target|decoy|public|synthetic, text() }. */
export function composeLibrary({ shard, size, seed, filler = [] }) {
  const cans = canaries();
  const targets = Object.keys(cans).filter(n => cans[n].shard === shard).sort();
  const entry = (kind, name, text) => ({ name, kind, description: parseFrontmatter(text).meta.description, text: () => text });
  const out = targets.slice(0, size).map(n => entry('target', n, skillText('targets', n)));
  if (size <= targets.length) return out;
  const dec = Object.entries(decoys()).filter(([, d]) => d.shard === shard).map(([n]) => n).sort();
  for (const n of dec) if (out.length < size) out.push(entry('decoy', n, skillText('decoys', n)));
  const taken = new Set(out.map(s => s.name));
  const pool = shuffle(filler.map(f => f.name), `${seed}:filler`).map(n => filler.find(f => f.name === n));
  for (const f of pool) {
    if (out.length >= size) break;
    if (taken.has(f.name)) continue;
    taken.add(f.name);
    const text = fs.readFileSync(f.file, 'utf8');
    out.push({ name: f.name, kind: 'public', description: f.description, repo: f.repo, text: () => text });
  }
  for (let i = 0; out.length < size; i++) {
    const s = synthSkill(seed, i);
    if (taken.has(s.name)) continue;
    taken.add(s.name);
    const text = `---\nname: ${s.name}\ndescription: ${JSON.stringify(s.description)}\n---\n\n${s.body}`;
    out.push({ name: s.name, kind: 'synthetic', description: s.description, text: () => text });
  }
  return out;
}

/** Write the library to .cache/libs/<seed>/s<shard>-n<size>/library/<name>/SKILL.md (idempotent). Returns its dir. */
export function materialize(lib, { shard, size, seed, root = path.join(CACHE_DIR, 'libs') }) {
  const dir = path.join(root, String(seed), `s${shard}-n${size}`, 'library');
  const stamp = path.join(dir, '..', 'stamp.json');
  const want = JSON.stringify(lib.map(s => s.name));
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === want) return dir;
  fs.rmSync(dir, { recursive: true, force: true });
  for (const s of lib) {
    fs.mkdirSync(path.join(dir, s.name), { recursive: true });
    // SKILL.md frontmatter must name the folder: some public skills differ in case or spacing of the body only
    fs.writeFileSync(path.join(dir, s.name, 'SKILL.md'), s.text());
  }
  fs.writeFileSync(stamp, want);
  return dir;
}

/** Listing order (Claude Code lists user skills alphabetically, measured) and each target's position in it. */
export function listingPositions(lib) {
  const names = lib.map(s => s.name).sort();
  return Object.fromEntries(lib.filter(s => s.kind === 'target').map(s => [s.name, names.indexOf(s.name)]));
}

/** Composition summary for results files. */
export const composition = (lib) => lib.reduce((m, s) => ({ ...m, [s.kind]: (m[s.kind] || 0) + 1 }), {});
