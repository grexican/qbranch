// The benchmark runner: one command, reproducible with your own models.
//   npm run bench:headjack -- --agent claude --models sonnet,haiku --sizes 5,25,100,500 --runs 2 --concurrency 8 --split test
// Options:
//   --arms none,native,native-again,headjack   --limit <n prompts>   --tiers named,lexical,...   --tag <name>
//   --timeout-ms 420000   --budget-usd 2   --auth-from-home   --seed hjbench-v1   --dry-run
//   --sizes beyond   v1's literal cutoff (the context limit) is not run, per PREREGISTRATION-v2.md; it is skipped
// Results: results/<tag>-<agent>-<model>.json (+ raw JSONL for resume in results/raw/), and results/<tag>-SUMMARY.md.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { BENCH, REPO, RESULTS, TESTBED } from './paths.mjs';
import { agent as getAgent } from './agents/index.mjs';
import { fetchFiller, MANIFEST } from './filler.mjs';
import { composeLibrary, materialize, composition, canaries as loadCanaries, SHARDS } from './library.mjs';
import { armTemplate, ARMS, thresholds, THRESHOLDS_FILE } from './arms.mjs';
import { makeSandbox } from '../../../packages/core/src/replay.mjs';
import { collectOutput, scoreRun } from './score.mjs';
import { startTap, requestText } from './tap.mjs';
import { parseListing, analyzeListing } from './listing.mjs';
import { summarize } from './summary.mjs';

const argv = process.argv.slice(2);
const opt = (f, d) => { const i = argv.indexOf(f); return i < 0 ? d : argv[i + 1]; };
const has = (f) => argv.includes(f);

export function loadPrompts({ split, tiers, limit, seed }) {
  const doc = JSON.parse(fs.readFileSync(path.join(TESTBED, 'prompts', 'prompts.json'), 'utf8'));
  let ps = doc.prompts.filter(p => !p.excluded && (split === 'all' || p.split === split));
  if (tiers) ps = ps.filter(p => tiers.includes(p.tier));
  if (limit) { // a stratified, seeded subset: every tier keeps its share
    const h = (id) => createHash('sha256').update(`${seed}:limit:${id}`).digest('hex');
    ps = [...ps].sort((a, b) => h(a.id).localeCompare(h(b.id))).slice(0, limit);
  }
  return ps.sort((a, b) => a.id.localeCompare(b.id));
}

const sha = (f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 16);
function environment(adapter, opts) {
  const git = (a) => (spawnSync('git', ['-C', REPO, ...a], { encoding: 'utf8' }).stdout || '').trim();
  return {
    ...adapter.meta(), date: new Date().toISOString(), qbranchCommit: git(['rev-parse', 'HEAD']), dirty: !!git(['status', '--porcelain', '--', 'bench', 'packages']),
    os: `${os.type()} ${os.release()} ${os.arch()}`, node: process.version, seed: opts.seed,
    thresholds: thresholds(), thresholdsFrozen: fs.existsSync(THRESHOLDS_FILE),
    promptsSha: sha(path.join(TESTBED, 'prompts', 'prompts.json')), canariesSha: sha(path.join(TESTBED, 'canaries.json')), fillerManifestSha: sha(MANIFEST),
  };
}

/** Record the listing a model receives for each library (one cheap native call through the tap). Claude only. */
async function recordListings({ adapter, model, libs, opts, log }) {
  const tap = await startTap();
  const out = {};
  try {
    for (const L of libs) {
      if (L.size <= 0) continue;
      const tpl = await armTemplate('native', { libDir: L.dir, key: L.key });
      const sb = makeSandbox(tpl.dir, { mode: 'copy' });
      try {
        tap.bodies.length = 0;
        await adapter.run({ prompt: 'Reply with OK.', dir: sb.dir, model, authFromHome: opts.authFromHome, env: { ANTHROPIC_BASE_URL: tap.url }, extraArgs: ['--tools', 'Skill'], timeoutMs: 180_000, budgetUsd: 0.5 });
        const body = tap.bodies.filter(b => (b.messages || []).length).pop();
        const a = analyzeListing(parseListing(body ? requestText(body) : ''), L.lib.map(s => s.name), L.lib.filter(s => s.kind === 'target').map(s => s.name));
        out[L.key] = a;
        log(`listing ${model} ${L.key}: ${a.described}/${a.size} described, first drop at ${a.firstDrop}, past-cutoff targets ${Object.values(a.targets).filter(t => t.pastCutoff).length}`);
      } finally { sb.cleanup(); }
    }
  } finally { await tap.close(); }
  return out;
}

export async function main() {
  const opts = {
    agent: opt('--agent', 'claude'), models: opt('--models', 'sonnet').split(','), split: opt('--split', 'test'),
    sizes: opt('--sizes', '5,25,100,500').split(','), runs: +opt('--runs', 2), concurrency: Math.min(8, +opt('--concurrency', 8)),
    arms: opt('--arms', ARMS.join(',')).split(','), limit: +opt('--limit', 0) || null, tiers: opt('--tiers', '') ? opt('--tiers').split(',') : null,
    tag: opt('--tag', new Date().toISOString().slice(0, 10)), timeoutMs: +opt('--timeout-ms', 420_000), budgetUsd: +opt('--budget-usd', 2),
    authFromHome: has('--auth-from-home'), seed: opt('--seed', 'hjbench-v1'), dryRun: has('--dry-run'),
  };
  const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
  if (opts.sizes.includes('beyond')) log('size "beyond" (v1 literal cutoff = the context limit) is not run, per PREREGISTRATION-v2.md; v1 H2 is reported from the named-request reach test at every size.');
  const sizes = opts.sizes.filter(s => s !== 'beyond').map(Number);
  if (opts.split === 'test' && !fs.existsSync(THRESHOLDS_FILE)) throw new Error(`the test split needs frozen thresholds (${path.relative(REPO, THRESHOLDS_FILE)}); tune on --split dev first`);
  const adapter = getAgent(opts.agent);
  const prompts = loadPrompts(opts);
  const cans = loadCanaries();
  const filler = await fetchFiller({ log });
  const shards = [...new Set(prompts.map(p => p.shard))].sort((a, b) => a - b);
  // libraries and arm templates (headjack indexes are built here, once)
  const libs = new Map();
  for (const shard of shards) for (const size of sizes) {
    const lib = composeLibrary({ shard, size, seed: opts.seed, filler });
    const key = `s${shard}-n${size}`;
    const dir = materialize(lib, { shard, size, seed: opts.seed });
    const t = {};
    for (const arm of opts.arms.filter(a => a !== 'none')) t[arm] = await armTemplate(arm, { libDir: dir, key });
    libs.set(key, { key, shard, size, lib, dir, names: new Set(lib.map(s => s.name)), templates: t, composition: composition(lib) });
    log(`library ${key}: ${JSON.stringify(composition(lib))}`);
  }
  const noneTpl = opts.arms.includes('none') ? await armTemplate('none', { libDir: null, key: 'none' }) : null;
  fs.mkdirSync(path.join(RESULTS, 'raw'), { recursive: true });

  for (const model of opts.models) {
    const base = `${opts.tag}-${opts.agent}-${model}`;
    const rawFile = path.join(RESULTS, 'raw', `${base}.jsonl`);
    const done = new Set(fs.existsSync(rawFile) ? fs.readFileSync(rawFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).key) : []);
    const listingsFile = path.join(RESULTS, 'raw', `${base}.listings.json`);
    let listings = fs.existsSync(listingsFile) ? JSON.parse(fs.readFileSync(listingsFile, 'utf8')) : {};
    const missing = [...libs.values()].filter(L => !listings[L.key]);
    if (missing.length && opts.agent === 'claude' && !opts.dryRun) {
      listings = { ...listings, ...await recordListings({ adapter, model, libs: missing, opts, log }) };
      fs.writeFileSync(listingsFile, JSON.stringify(listings, null, 1));
    }
    // the queue: repetition-major (a whole first pass before any second run), arms of one prompt side by side
    const units = [];
    for (let rep = 1; rep <= opts.runs; rep++) for (const p of prompts) {
      if (opts.arms.includes('none')) units.push({ key: `none|0|${p.id}|${rep}`, arm: 'none', size: 0, p, rep });
      for (const size of sizes) for (const arm of opts.arms.filter(a => a !== 'none')) units.push({ key: `${arm}|${size}|${p.id}|${rep}`, arm, size, p, rep });
    }
    const todo = units.filter(u => !done.has(u.key));
    log(`${model}: ${units.length} runs planned, ${todo.length} to do`);
    if (opts.dryRun) continue;
    let i = 0, n = 0;
    const t0 = Date.now();
    const worker = async () => {
      while (i < todo.length) {
        const u = todo[i++];
        const L = u.arm === 'none' ? null : libs.get(`s${u.p.shard}-n${u.size}`);
        const tpl = u.arm === 'none' ? noneTpl : L.templates[u.arm];
        const sb = makeSandbox(tpl.dir, { mode: 'copy' });
        let rec;
        try {
          const keepTranscript = path.join(RESULTS, 'raw', 'transcripts', base, `${u.key.replace(/[|]/g, '__').replace(/[^A-Za-z0-9_.-]/g, '-')}.jsonl`);
          const r = await adapter.run({ prompt: u.p.text, dir: sb.dir, model, settings: tpl.settings(), env: tpl.env(), timeoutMs: opts.timeoutMs, budgetUsd: opts.budgetUsd, authFromHome: opts.authFromHome, keepTranscript });
          const out = collectOutput(r, sb.dir);
          try { fs.mkdirSync(path.dirname(keepTranscript), { recursive: true }); fs.writeFileSync(keepTranscript.replace(/.jsonl$/, '.out.txt'), out.text); } catch { /* best effort */ }
          let suggested = [];
          try { suggested = Object.entries(JSON.parse(fs.readFileSync(path.join(sb.dir, '.headjack-stats.json'), 'utf8')).skills || {}).filter(([, v]) => v.suggested).map(([k]) => k.split('/').pop()); } catch { /* not headjack */ }
          const library = L ? L.names : new Set(); // the none arm has no skills: nothing it does can load one
          const s = scoreRun({ prompt: u.p, events: r.events, outputText: out.text, library, canaries: cans });
          const lst = L && listings[L.key];
          rec = { key: u.key, model, arm: u.arm, size: u.size, shard: u.p.shard, prompt: u.p.id, tier: u.p.tier, multi: u.p.multi, rep: u.rep,
            ok: r.ok, error: r.error, killed: r.killed, costUsd: r.costUsd, durationMs: r.durationMs, numTurns: r.numTurns, tokens: r.tokens,
            pastCutoff: lst && u.p.answers.length ? u.p.answers.every(a => lst.targets[a]?.pastCutoff) : null,
            ...s, suggested, files: out.files, at: new Date().toISOString() };
        } catch (e) {
          rec = { key: u.key, model, arm: u.arm, size: u.size, shard: u.p.shard, prompt: u.p.id, tier: u.p.tier, rep: u.rep, ok: false, error: `harness: ${e.message}`.slice(0, 300) };
        } finally { sb.cleanup(); }
        fs.appendFileSync(rawFile, JSON.stringify(rec) + '\n');
        n++;
        if (n % 10 === 0 || n === todo.length) {
          const rate = (Date.now() - t0) / n;
          log(`${model} ${n}/${todo.length} (eta ${((todo.length - n) * rate / 3600e3).toFixed(1)} h)`);
        }
      }
    };
    await Promise.all(Array.from({ length: opts.concurrency }, worker));
  }
  return finish(opts, adapter, libs, log);
}

export function finish(opts, adapter, libs, log = console.log) {
  const files = [];
  for (const model of opts.models) {
    const base = `${opts.tag}-${opts.agent}-${model}`;
    const rawFile = path.join(RESULTS, 'raw', `${base}.jsonl`);
    if (!fs.existsSync(rawFile)) continue;
    const byKey = new Map(fs.readFileSync(rawFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).map(r => [r.key, r]));
    const listingsFile = path.join(RESULTS, 'raw', `${base}.listings.json`);
    const doc = {
      environment: { ...environment(adapter, opts), model }, options: { ...opts, models: [model] },
      libraries: Object.fromEntries([...libs.values()].map(L => [L.key, L.composition])),
      listings: fs.existsSync(listingsFile) ? JSON.parse(fs.readFileSync(listingsFile, 'utf8')) : {},
      runs: [...byKey.values()],
    };
    const f = path.join(RESULTS, `${base}.json`);
    fs.writeFileSync(f, JSON.stringify(doc, null, 1) + '\n');
    files.push(f);
  }
  const md = summarize(files.map(f => JSON.parse(fs.readFileSync(f, 'utf8'))), { tag: opts.tag });
  const sf = path.join(RESULTS, `${opts.tag}-SUMMARY.md`);
  fs.writeFileSync(sf, md);
  log(`wrote ${files.map(f => path.relative(BENCH, f)).join(', ')} and ${path.relative(BENCH, sf)}`);
  return { files, summary: sf };
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('src', 'run.mjs'))) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
