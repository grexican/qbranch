// Measures Claude Code's native skill-listing limits, per model, with the benchmark's own libraries.
//   npm run bench:headjack:cutoff -- --models sonnet,haiku [--sizes 5,10,...] [--reach-trials 3] [--names-at 2000,15000] --auth-from-home
//
// 1. Description cutoff (v2): for each size, one native session through src/tap.mjs records the exact listing the model
//    receives; we count which library skills kept a description and where the first name-only entry is.
// 2. Plain reach test: at the largest size, ask BY NAME for the alphabetically last target past the description cutoff,
//    natively and through headjack; a hit is the target's canaries in the output.
// 3. (opt-in, --names-at) v1's by-name cutoff: invoke the alphabetically last skill by name in very large libraries
//    (synthetic filler past the public pool). Costly near the context limit; not part of the default run.
import fs from 'node:fs';
import path from 'node:path';
import { RESULTS } from './paths.mjs';
import { agent as getAgent } from './agents/index.mjs';
import { fetchFiller } from './filler.mjs';
import { composeLibrary, materialize, canaries as loadCanaries } from './library.mjs';
import { armTemplate } from './arms.mjs';
import { makeSandbox } from '../../../packages/core/src/replay.mjs';
import { startTap, requestText } from './tap.mjs';
import { parseListing, analyzeListing } from './listing.mjs';
import { collectOutput, scoreRun } from './score.mjs';

const argv = process.argv.slice(2);
const opt = (f, d) => { const i = argv.indexOf(f); return i < 0 ? d : argv[i + 1]; };
const authFromHome = argv.includes('--auth-from-home');
const seed = opt('--seed', 'hjbench-v1');
const adapter = getAgent(opt('--agent', 'claude'));
const sizes = opt('--sizes', '5,8,10,15,20,25,35,50,75,100,150,200,300,500').split(',').map(Number);
const trials = +opt('--reach-trials', 3);
const namesAt = opt('--names-at', '') ? opt('--names-at').split(',').map(Number) : [];
const SHARD = +opt('--shard', 1);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const REACH_TASK = {
  'runbook-steps': 'write the procedure for restarting the nightly import job on the batch server (stop the timer, clear the lock file /var/run/import.lock, start it again, check the log)',
  'type-scale-ladder': 'set up the font sizes and line heights for a small marketing site as CSS variables',
  'palette-token-names': 'define the color variables for a dark blue and sand-colored theme in CSS',
  'commit-message-trailers': 'write the commit message for a change that adds retry with backoff to the email sender',
  'sql-house-style': 'write a query that lists each customer with their number of orders and total spent, from customers(id, name) and orders(id, customer_id, total)',
};

async function listingAt(model, lib, key, dir) {
  const tap = await startTap();
  const tpl = await armTemplate('native', { libDir: dir, key });
  const sb = makeSandbox(tpl.dir, { mode: 'copy' });
  try {
    const r = await adapter.run({ prompt: 'Reply with OK.', dir: sb.dir, model, authFromHome, env: { ANTHROPIC_BASE_URL: tap.url }, extraArgs: ['--tools', 'Skill'], timeoutMs: 300_000, budgetUsd: 1 });
    const body = tap.bodies.filter(b => (b.messages || []).length).pop();
    return { ok: r.ok, error: r.error, ...analyzeListing(parseListing(body ? requestText(body) : ''), lib.map(s => s.name), lib.filter(s => s.kind === 'target').map(s => s.name)) };
  } finally { sb.cleanup(); await tap.close(); }
}

async function named(model, arm, lib, key, dir, target) {
  const tpl = await armTemplate(arm, { libDir: dir, key });
  const sb = makeSandbox(tpl.dir, { mode: 'copy' });
  try {
    const task = REACH_TASK[target] || 'apply it to a small example of your choice';
    const prompt = `Use the ${target} skill: ${task}.`;
    const r = await adapter.run({ prompt, dir: sb.dir, model, settings: tpl.settings(), env: tpl.env(), authFromHome, timeoutMs: 420_000, budgetUsd: 2 });
    const s = scoreRun({ prompt: { answers: [target] }, events: r.events, outputText: collectOutput(r, sb.dir).text, library: new Set(lib.map(x => x.name)), canaries: loadCanaries() });
    return { arm, ok: r.ok, error: r.error, used: s.useHit, loaded: s.loadHit, costUsd: r.costUsd };
  } finally { sb.cleanup(); }
}

const filler = await fetchFiller({ log });
fs.mkdirSync(RESULTS, { recursive: true });
for (const model of opt('--models', 'sonnet').split(',')) {
  const out = { agent: adapter.meta(), model, seed, shard: SHARD, date: new Date().toISOString(), method: 'listing recorded at the API boundary by a local pass-through proxy (src/tap.mjs); Claude Code lists user skills alphabetically', descriptions: [], reach: null, namesAt: [] };
  let last = null;
  for (const size of sizes) {
    const lib = composeLibrary({ shard: SHARD, size, seed, filler });
    const key = `s${SHARD}-n${size}`;
    const dir = materialize(lib, { shard: SHARD, size, seed });
    const a = await listingAt(model, lib, key, dir);
    out.descriptions.push({ size, ok: a.ok, listed: a.size, described: a.described, firstDrop: a.firstDrop, lastDescribed: a.lastDescribed, pastCutoffTargets: Object.entries(a.targets).filter(([, t]) => t.pastCutoff).map(([n]) => n) });
    log(`${model} n=${size}: listed ${a.size}, described ${a.described}, first drop at ${a.firstDrop}, last skill described ${a.lastDescribed}`);
    last = { lib, key, dir, a };
  }
  // the description cutoff: the smallest size at which the alphabetically last skill has lost its description
  const firstLost = out.descriptions.find(d => d.lastDescribed === false);
  out.descriptionCutoff = { smallestSizeWhereLastSkillLosesDescription: firstLost?.size ?? null, descriptionsKeptBeforeFirstDrop: Math.min(...out.descriptions.map(d => d.firstDrop ?? d.listed)) };
  // reach test at the largest size: the alphabetically last target that is past the cutoff
  const past = Object.entries(last.a.targets).filter(([, t]) => t.pastCutoff).sort((x, y) => y[1].position - x[1].position);
  if (past.length) {
    const target = past[0][0];
    const runs = [];
    for (let t = 0; t < trials; t++) for (const arm of ['native', 'headjack']) runs.push(await named(model, arm, last.lib, last.key, last.dir, target));
    const rate = (arm) => { const xs = runs.filter(r => r.arm === arm && r.ok); return `${xs.filter(r => r.used).length}/${xs.length}`; };
    out.reach = { size: last.lib.length, target, position: past[0][1].position, runs, native: rate('native'), headjack: rate('headjack') };
    log(`${model} reach by name at n=${last.lib.length} for ${target} (position ${past[0][1].position}, no description): native ${rate('native')}, headjack ${rate('headjack')}`);
  }
  for (const size of namesAt) {
    const lib = composeLibrary({ shard: SHARD, size, seed, filler });
    const key = `s${SHARD}-n${size}`;
    const dir = materialize(lib, { shard: SHARD, size, seed });
    const target = Object.keys(loadCanaries()).filter(n => loadCanaries()[n].shard === SHARD).sort().pop();
    const r = await named(model, 'native', lib, key, dir, target);
    out.namesAt.push({ size, target, ...r });
    log(`${model} v1 by-name at n=${size}: ${r.used ? 'reached' : 'not reached'} ${r.error || ''}`);
  }
  fs.writeFileSync(path.join(RESULTS, `cutoff-${adapter.meta().agent}-${model}.json`), JSON.stringify(out, null, 1) + '\n');
}
