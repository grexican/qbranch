#!/usr/bin/env node
// moneyball CLI: measure subagent runs, recommend the cheapest model that does each job, and serve the routing hooks.
import fs from 'node:fs';
import path from 'node:path';
import { runHook } from '@qbranch/core/hooks';
import { loadConfig } from '../src/config.mjs';
import { scan } from '../src/scan.mjs';
import { plan, routes } from '../src/recommend.mjs';
import { preToolUse, sessionStart, writeRoutes } from '../src/route.mjs';
import { upsert, summarize } from '../src/stats.mjs';
import { measureOverhead, staticContributors, attribute } from '../src/overhead.mjs';
import { deriveVariants, writeVariants, condense, tune } from '../src/experiments.mjs';
import { mineScenarios, validateScenario, runScenario, saveScenario, loadScenarios, scenariosDir } from '@qbranch/core/scenarios';

const [cmd, ...rest] = process.argv.slice(2);
const flag = (n) => rest.includes(n);
const opt = (n, d) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : d; };
const SELF = process.argv[1]; // this script (bundled or not); the native binary re-invokes itself instead

const HELP = `moneyball: pay for the model each job needs, not the one you defaulted to.

  moneyball scan [--days N] [--all-projects] [--quiet]   measure subagent runs from transcripts, rebuild routes
  moneyball report [--json] [--all]                      per-class recommendation: graduate | explore | try-effort | keep
  moneyball stats [--json]                               usage + what routing is worth (.moneyball-stats.json)
  moneyball overhead [--days N] [--json]                 the startup tax: fixed prompt per session/subagent, apart from the work
           [--probe --budget USD [--model haiku]]        ...and attribute it to components with one-turn probes (spends)
  moneyball experiments [--condense --budget USD]        derive startup-context variants into .moneyball/experiments/
  moneyball tune --budget USD [--limit N] [--repeats N] [--only a,b] [--concurrency N] [--per-run USD] [--timeout SEC] [--judge MODEL | --no-judge]
                                                        replay recurring tasks under each variant; recommend safe trims
           [--scenarios]                                 ...replay validated history scenarios instead (build tasks graded by tests)
  moneyball scenarios mine [--limit N] [--since DATE] [--no-pr]     past commits with tests -> build tasks (no spend)
  moneyball scenarios validate [--limit N] [--valid N] [--install] [--again]
                                                        keep those whose parent fails and commit passes the hidden tests
  moneyball scenarios list [--all] [--json]                         cached scenarios (.qbranch/scenarios/, or --cache DIR)
  moneyball scenarios run --budget USD [--per-run USD] [--limit N] [--model M] [--timeout SEC] [--id ID]
                                                        baseline: rebuild each scenario with the unchanged setup
  moneyball hook pre|session [--platform P]              PreToolUse (subagent dispatch) / SessionStart hooks

Modes (moneyball.config.json "mode" or MONEYBALL_MODE): report | suggest (default) | enforce | explore`;

const money = (x) => `$${x.toFixed(2)}`;
const num = (x) => (x == null ? '?' : Math.round(x).toLocaleString('en-US'));
const budgetOpt = () => { const b = Number(opt('--budget')); if (!(b > 0)) throw new Error('this spends money: pass --budget <usd>'); return b; };

// The replay harness lives in core. Imported by a computed specifier so builds without it still bundle and run.
async function loadReplay() {
  const spec = '@qbranch/core/replay';
  try { return await import(spec); }
  catch (e) {
    if (!/MODULE_NOT_FOUND|PACKAGE_PATH_NOT_EXPORTED|Cannot find/.test(`${e.code} ${e.message}`)) throw e;
    throw new Error('tune needs the replay harness (@qbranch/core/replay, see docs/replay-contract.md), which is not in this build yet. `moneyball overhead` and `moneyball experiments` work without it.');
  }
}

function printOverhead(m, st, attr) {
  const line = (label, d) => `  ${label.padEnd(10)} ${String(d.n).padStart(5)}  median ${num(d.median).padStart(7)}  p90 ${num(d.p90).padStart(7)} tokens`;
  console.log(`startup tax, last ${m.days} days: the fixed prompt paid before any work (system prompt, instructions, skills, MCP, memory)`);
  console.log(line('subagents', m.subagents)); console.log(line('sessions', m.sessions));
  console.log(`  by model (same prompt, any model): ${Object.entries(m.byModel).map(([k, d]) => `${k} ${num(d.median)}`).join(' | ')}`);
  console.log(`  tax ${money(m.startupUsd)} of ${money(m.totalUsd)} total = ${(m.share * 100).toFixed(1)}% of spend; the work itself: ${money(m.totalUsd - m.startupUsd)}`);
  console.log('\nstatic contributors (on disk, ~4 chars/token, no spend)');
  for (const r of st) console.log(`  ${r.kind.padEnd(9)} ${(r.tokens == null ? 'probe' : num(r.tokens)).padStart(7)}  ${r.label}${r.count ? ` (${r.count} entries)` : ''}${r.calls != null ? `  ${r.calls} tool calls in window` : ''}`);
  if (!attr) return console.log('\nattribute it to components: moneyball overhead --probe --budget 0.25');
  console.log(`\nprobe attribution (${attr.model}, ${money(attr.spent)} spent): full startup prompt ${num(attr.full)} tokens`);
  for (const p of attr.parts) console.log(`  ${p.id.padEnd(13)} ${num(p.tokens).padStart(7)}  ${p.label}${p.note ? ` [${p.note}]` : ''}`);
}

async function doScan(cfg) {
  const r = await scan(cfg, { days: Number(opt('--days', cfg.days)), allProjects: flag('--all-projects') });
  const p = plan(cfg);
  const rt = routes(cfg);
  writeRoutes(cfg, rt);
  const last = {
    runs: p.reduce((a, c) => a + c.n, 0), classes: p.length, spend: p.reduce((a, c) => a + c.cost, 0), credit: p.reduce((a, c) => a + (c.credit || 0), 0),
    graduate: p.filter(c => c.action === 'graduate').length, explore: p.filter(c => c.action === 'explore').length,
    est_saving: p.reduce((a, c) => a + (c.saving || 0), 0),
  };
  upsert(cfg, (s) => { s.totals.scans++; s.last_scan = last; });
  return { ...r, ...last };
}

const cacheDir = (cfg) => (opt('--cache') ? path.resolve(opt('--cache')) : process.env.QBRANCH_SCENARIOS_DIR || scenariosDir(cfg.root));
const secs = (ms) => `${Math.round((ms || 0) / 1000)}s`;

/** History scenarios: past commits as build tasks graded by their own tests (@qbranch/core/scenarios). */
async function scenarios(cfg) {
  const [sub] = rest, dir = cacheDir(cfg);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, '.gitignore'))) fs.writeFileSync(path.join(dir, '.gitignore'), '*\n'); // tool state stays out of the repo
  const cached = (status) => loadScenarios(cfg.root, { dir, status });
  const ids = opt('--id') ? opt('--id').split(',') : null;
  switch (sub) {
    case 'mine': {
      const m = mineScenarios({ root: cfg.root, limit: Number(opt('--limit', 100)), since: opt('--since'), pr: !flag('--no-pr') });
      const known = new Map(cached().map(s => [s.id, s]));
      let added = 0;
      for (const s of m.scenarios) if (!known.has(s.id)) { saveScenario(s, dir); added++; }
      const why = {};
      for (const r of m.rejected) { const k = r.reason.replace(/\s*\(.*\)$/, ''); why[k] = (why[k] || 0) + 1; }
      fs.writeFileSync(path.join(dir, 'last-mine.json'), JSON.stringify({ at: new Date().toISOString(), scanned: m.scanned, candidates: m.scenarios.length, rejected: m.rejected }, null, 2) + '\n');
      console.log(`scanned ${m.scanned} commits: ${m.scenarios.length} candidates (${added} new), ${m.rejected.length} skipped`);
      for (const [k, n] of Object.entries(why).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);
      return console.log(`cache: ${dir}. Next: moneyball scenarios validate`);
    }
    case 'validate': {
      const want = opt('--valid') ? Number(opt('--valid')) : Infinity;
      // --again: re-validate the valid ones too (after a harness change)
      const todo = cached(['candidate', ...(flag('--install') ? ['needs-install'] : []), ...(flag('--again') ? ['valid'] : [])]).filter(s => !ids || ids.includes(s.id)).slice(0, Number(opt('--limit', 20)));
      let valid = flag('--again') ? 0 : cached('valid').length;
      for (const s of todo) {
        if (valid >= want) break;
        console.log(`${s.id} ${s.subject.slice(0, 70)}`);
        const v = await validateScenario(s, { install: flag('--install') || s.install, log: (m) => console.log(m) });
        saveScenario(v, dir);
        if (v.status === 'valid') valid++;
        console.log(`  -> ${v.status}${v.reason ? `: ${v.reason}` : ''} (${secs(v.validationMs)})`);
      }
      const all = cached();
      const n = (st) => all.filter(s => s.status === st).length;
      return console.log(`${n('valid')} valid, ${n('rejected')} rejected, ${n('needs-install')} need a fresh install (--install), ${n('candidate')} not yet validated`);
    }
    case 'list': {
      const all = cached(flag('--all') ? null : 'valid');
      if (flag('--json')) return console.log(JSON.stringify(all, null, 2));
      for (const s of all) console.log(`${s.status.padEnd(13)} ${s.id}  ${s.at.slice(0, 10)}  ${s.subject.slice(0, 70)}${s.reason ? `  -- ${s.reason}` : ''}`);
      return console.log(`${all.length} scenario(s) in ${dir}`);
    }
    case 'run': {
      const budgetUsd = budgetOpt();
      const tasks = cached('valid').filter(s => !ids || ids.includes(s.id)).slice(0, Number(opt('--limit', 5)));
      if (!tasks.length) throw new Error('no validated scenarios: run `moneyball scenarios mine` and `validate` first');
      const replay = await import('@qbranch/core/replay');
      const r = await replay.compareVariants({ tasks, variants: { baseline: async () => {} }, budgetUsd, perRunUsd: opt('--per-run') ? Number(opt('--per-run')) : undefined,
        model: opt('--model'), timeoutMs: Number(opt('--timeout', 1200)) * 1000, runner: runScenario,
        onRun: ({ task, run, grade, inconclusive }) => console.log(`${(inconclusive ? 'cut off' : grade.pass ? 'pass' : 'fail').padEnd(8)} ${task.id}  ${money(run.costUsd || 0)} ${secs(run.durationMs)}  `
          + `${Object.entries(run.suites || {}).map(([k, v]) => `${k} ${v.pass ? 'ok' : 'FAIL'}`).join(', ')}${inconclusive ? `  (${run.error || 'timeout'})` : ''}  ${task.subject.slice(0, 50)}`) });
      const b = r.perVariant.baseline;
      fs.writeFileSync(path.join(dir, 'last-run.json'), JSON.stringify({ at: new Date().toISOString(), model: opt('--model') || null, ...r }, null, 2) + '\n');
      return console.log(`baseline: ${b.runs} scored, pass ${b.runs ? Math.round(b.passRate * 100) + '%' : 'n/a'}, mean score ${b.meanScore?.toFixed(2) ?? 'n/a'}, ${money(r.spentUsd)} spent; ${r.inconclusive.length} cut off, ${r.skipped.length} skipped (budget)`);
    }
    default: console.log(HELP);
  }
}

async function main() {
  const cfg = loadConfig();
  switch (cmd) {
    case 'scan': {
      const r = await doScan(cfg);
      if (!flag('--quiet')) console.log(`scanned ${r.scanned} subagent transcripts (+${r.added} new): ${r.runs} runs, ${r.classes} classes, ${money(r.spend)}; ${r.graduate} graduated, ${r.explore} exploring, est. saving ${money(r.est_saving)}`);
      return;
    }
    case 'report': {
      const p = plan(cfg);
      if (flag('--json')) return console.log(JSON.stringify(p, null, 2));
      if (!p.length) return console.log('no runs measured yet: run `moneyball scan`');
      const gross = p.reduce((a, c) => a + c.cost, 0), credit = p.reduce((a, c) => a + (c.credit || 0), 0);
      console.log(`subagent spend ${money(gross)}, delegation credit ${money(credit)} (parent context kept out), net ${money(gross - credit)}; savings are judged net, per completed task\n`);
      const shown = flag('--all') ? p : p.filter(c => c.action !== 'keep' || c.cost > 1).slice(0, 30);
      for (const c of shown) {
        const tiers = Object.entries(c.tiers).map(([t, v]) => `${t} ${v.ok}/${v.n}`).join(', ');
        console.log(`${c.action.padEnd(10)} ${money(c.cost).padStart(9)}  ${c.label.slice(0, 70)}\n${''.padEnd(21)}[${c.prior}] ${tiers} -- ${c.why}${c.saving ? ` (est. ${money(c.saving)})` : ''}`);
      }
      return;
    }
    case 'stats': {
      let s; try { s = JSON.parse(fs.readFileSync(path.join(cfg.root, cfg.stats || '.moneyball-stats.json'), 'utf8')); } catch { return console.log('no stats yet'); }
      return console.log(flag('--json') ? JSON.stringify(s, null, 2) : summarize(s));
    }
    case 'overhead': {
      const days = Number(opt('--days', cfg.days));
      const m = measureOverhead({ root: flag('--all-projects') ? null : cfg.root, days });
      const st = staticContributors(cfg.root, m.mcpCalls);
      const attr = flag('--probe') ? await attribute(cfg.root, { budget: budgetOpt(), model: opt('--model', 'haiku') }) : null;
      upsert(cfg, (s) => {
        s.overhead = { at: new Date().toISOString(), days, sessions: m.sessions, subagents: m.subagents, startup_usd: m.startupUsd, total_usd: m.totalUsd, share: m.share,
          attribution: attr ? Object.fromEntries([['full', attr.full], ...attr.parts.map(p => [p.id, p.tokens])]) : s.overhead?.attribution ?? null };
      });
      if (flag('--json')) return console.log(JSON.stringify({ ...m, static: st, attribution: attr }, null, 2));
      return printOverhead(m, st, attr);
    }
    case 'experiments': {
      let condensed = null;
      if (flag('--condense')) {
        const c = await condense(cfg.root, { budget: budgetOpt(), model: opt('--model', 'sonnet') });
        condensed = c?.text; if (c) console.log(`condensed CLAUDE.md written by ${opt('--model', 'sonnet')} (${money(c.cost)})`);
      }
      const usage = measureOverhead({ root: cfg.root, days: Number(opt('--days', cfg.days)) }).mcpCalls;
      const vs = deriveVariants(cfg.root, { condensed, usage });
      const dir = writeVariants(cfg, vs);
      for (const v of vs) console.log(`${v.id.padEnd(32)} ${(v.estTokensSaved == null ? 'probe' : `~${num(v.estTokensSaved)}`).padStart(8)}  ${v.description}`);
      return console.log(`${vs.length} variants in ${dir} (manifest.json + patch.diff each; live files untouched). Test them: moneyball tune --budget <usd>`);
    }
    case 'scenarios': return scenarios(cfg);
    case 'tune': {
      const budget = budgetOpt();
      const given = flag('--scenarios') ? { tasks: loadScenarios(cfg.root, { dir: cacheDir(cfg), status: 'valid' }), runner: runScenario } : {};
      const r = await tune(cfg, { budget, replay: await loadReplay(), ...given, days: Number(opt('--days', cfg.days)), limit: Number(opt('--limit', 20)), repeats: Number(opt('--repeats', 1)),
        only: opt('--only') ? opt('--only').split(',') : null, concurrency: Number(opt('--concurrency', 1)), perRunUsd: opt('--per-run') ? Number(opt('--per-run')) : undefined,
        timeoutMs: opt('--timeout') ? Number(opt('--timeout')) * 1000 : undefined, judgeModel: flag('--no-judge') ? null : opt('--judge', 'sonnet') });
      upsert(cfg, (s) => { s.last_experiment = { at: r.at, tasks: r.tasks, variants: r.variants.length, recommended: r.variants.filter(v => v.recommend).map(v => v.id), spent: r.spent }; });
      if (flag('--json')) return console.log(JSON.stringify(r, null, 2));
      console.log(`replayed ${r.tasks} tasks x ${r.repeats} under baseline + ${r.variants.length} variants, ${money(r.spent)} spent; baseline pass ${r.baseline.runs ? Math.round(r.baseline.passRate * 100) + '%' : 'n/a (no scored runs)'}`
        + (r.inconclusive ? `; ${r.inconclusive} replays cut off by budget or time (not scored)` : ''));
      if (r.noise) console.log(`A/A control (the unchanged setup, run again): pass ${Math.round((r.aa.passRate || 0) * 100)}%, score ${(r.aa.meanScore ?? 0).toFixed(2)}; noise ${Math.round(r.noise.passDelta * 100)} pts pass, ${r.noise.scoreDelta.toFixed(2)} score, ${r.noise.regressions} chance regression(s)${r.tooNoisy ? ' -- TOO NOISY to judge a 10% change: add --repeats' : ''}`);
      for (const v of r.variants) {
        if (v.skipped) { console.log(`skip       ${v.id}: ${v.skipped}`); continue; }
        console.log(`${(v.recommend ? 'recommend' : 'reject').padEnd(10)} ${v.id.padEnd(30)} pass ${Math.round(v.passRate * 100)}% score ${v.meanScore.toFixed(2)} ${money(v.costUsd)} saves ${num(v.startupTokensSaved)} tok -- ${v.why}`);
        if (v.recommend) console.log(`${''.padEnd(11)}review, then apply by hand: ${v.patch}`);
      }
      return;
    }
    case 'hook':
      return runHook((h) => (rest[0] === 'session' ? sessionStart(cfg, SELF) : preToolUse(cfg, h)), rest.slice(1));
    default: console.log(HELP);
  }
}

main().catch((e) => { console.error(`moneyball: ${e.message}`); process.exitCode = cmd === 'hook' ? 0 : 1; });
