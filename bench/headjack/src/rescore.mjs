// Re-score recorded runs from their saved transcripts and outputs (after a scoring fix), without re-running models.
//   node bench/headjack/src/rescore.mjs --tag <tag> --models sonnet,haiku
import fs from 'node:fs';
import path from 'node:path';
import { RESULTS, TESTBED } from './paths.mjs';
import { claudeEvents } from '../../../packages/core/src/transcripts.mjs';
import { scoreRun } from './score.mjs';
import { canaries as loadCanaries } from './library.mjs';

const argv = process.argv.slice(2);
const opt = (f, d) => { const i = argv.indexOf(f); return i < 0 ? d : argv[i + 1]; };
const tag = opt('--tag'), agent = opt('--agent', 'claude');
const cans = loadCanaries();
const prompts = new Map(JSON.parse(fs.readFileSync(path.join(TESTBED, 'prompts', 'prompts.json'), 'utf8')).prompts.map(p => [p.id, p]));
for (const model of opt('--models', 'sonnet').split(',')) {
  const base = `${tag}-${agent}-${model}`;
  const raw = path.join(RESULTS, 'raw', `${base}.jsonl`);
  const libs = new Map();
  const libNames = (shard, size) => {
    const k = `s${shard}-n${size}`;
    if (!libs.has(k)) { const f = path.join(RESULTS, '..', '.cache', 'libs', 'hjbench-v1', k, 'stamp.json'); libs.set(k, new Set(fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : [])); }
    return libs.get(k);
  };
  let n = 0, changed = 0;
  const out = fs.readFileSync(raw, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).map(r => {
    const t = path.join(RESULTS, 'raw', 'transcripts', base, `${r.key.replace(/[|]/g, '__').replace(/[^A-Za-z0-9_.-]/g, '-')}.jsonl`);
    const o = t.replace(/\.jsonl$/, '.out.txt');
    if (!r.ok || !fs.existsSync(o)) return r;
    const events = fs.existsSync(t) ? [...claudeEvents(t)] : [];
    const s = scoreRun({ prompt: prompts.get(r.prompt), events, outputText: fs.readFileSync(o, 'utf8'), library: r.arm === 'none' ? new Set() : libNames(r.shard, r.size), canaries: cans });
    n++;
    if (JSON.stringify(s.loaded.sort()) !== JSON.stringify([...(r.loaded || [])].sort()) || s.useHit !== r.useHit) changed++;
    return { ...r, ...s };
  });
  fs.writeFileSync(raw, out.map(r => JSON.stringify(r)).join('\n') + '\n');
  console.log(`${base}: rescored ${n}, changed ${changed}`);
}
