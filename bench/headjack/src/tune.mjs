// Tune headjack's `strong` threshold on the DEV split only, offline (no model calls), then freeze it.
//   node bench/headjack/src/tune.mjs [--sizes 25,100,500] [--freeze]
// For every dev prompt and library size, run the hook's retrieval (headjack's suggest(), on a scratch copy of the
// arm's template) and score the suggestions: recall = an acceptable skill suggested on a non-negative prompt;
// false-suggest = anything suggested on a negative prompt. Objective (declared before tuning): maximize
// recall - false-suggest (Youden's J), ties to the higher threshold. --freeze writes frozen-thresholds.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchFiller } from './filler.mjs';
import { composeLibrary, materialize } from './library.mjs';
import { armTemplate, headjackEnv, THRESHOLDS_FILE } from './arms.mjs';
import { loadPrompts } from './run.mjs';

const argv = process.argv.slice(2);
const opt = (f, d) => { const i = argv.indexOf(f); return i < 0 ? d : argv[i + 1]; };
const sizes = opt('--sizes', '5,25,100,500').split(',').map(Number);
const GRID = [0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55];
const seed = 'hjbench-v1';

process.env.HEADJACK_HOME = headjackEnv().HEADJACK_HOME;
process.env.HEADJACK_STATS = '0';
const { loadConfig } = await import('../../../packages/headjack/src/config.mjs');
const { suggest } = await import('../../../packages/headjack/src/suggest.mjs');

const prompts = loadPrompts({ split: 'dev' });
const filler = await fetchFiller({});
const tally = Object.fromEntries(GRID.map(g => [g, { tp: 0, pos: 0, fp: 0, neg: 0 }]));
for (const shard of [...new Set(prompts.map(p => p.shard))]) for (const size of sizes) {
  const lib = composeLibrary({ shard, size, seed, filler });
  const dir = materialize(lib, { shard, size, seed });
  const tpl = await armTemplate('headjack', { libDir: dir, key: `s${shard}-n${size}`, thresholds: {} });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hjb-tune-'));
  fs.cpSync(tpl.dir, scratch, { recursive: true });
  for (const p of prompts.filter(x => x.shard === shard)) for (const g of GRID) {
    const cfg = { ...loadConfig(scratch), strong: g, external: false, stats: false };
    const text = await suggest(cfg, p.text);
    const picks = [...text.matchAll(/^- [^/\s]+\/([a-z0-9-]+):/gm)].map(m => m[1]);
    const t = tally[g];
    if (p.answers.length) { t.pos++; if (picks.some(n => p.answers.includes(n))) t.tp++; } else { t.neg++; if (picks.length) t.fp++; }
  }
}
const rows = GRID.map(g => { const t = tally[g]; return { strong: g, recall: t.tp / t.pos, falseSuggest: t.fp / t.neg, J: t.tp / t.pos - t.fp / t.neg, ...t }; });
console.table(rows.map(r => ({ strong: r.strong, recall: r.recall.toFixed(3), falseSuggest: r.falseSuggest.toFixed(3), J: r.J.toFixed(3) })));
const best = [...rows].sort((a, b) => b.J - a.J || b.strong - a.strong)[0];
console.log('best', best.strong);
if (argv.includes('--freeze')) {
  fs.writeFileSync(THRESHOLDS_FILE, JSON.stringify({ strong: best.strong, suggestMax: 4, tunedOn: 'dev split, offline retrieval (src/tune.mjs)', objective: 'recall - false-suggest', sizes, grid: rows, frozenAt: new Date().toISOString() }, null, 2) + '\n');
  console.log('frozen ->', THRESHOLDS_FILE);
}
