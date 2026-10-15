#!/usr/bin/env node
// moneyball CLI: measure subagent runs, recommend the cheapest model that does each job, and serve the routing hooks.
import fs from 'node:fs';
import path from 'node:path';
import { runHook } from '@utility-belt/core/hooks';
import { loadConfig } from '../src/config.mjs';
import { scan } from '../src/scan.mjs';
import { plan, routes } from '../src/recommend.mjs';
import { preToolUse, sessionStart, writeRoutes } from '../src/route.mjs';
import { upsert, summarize } from '../src/stats.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const flag = (n) => rest.includes(n);
const opt = (n, d) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : d; };
const SELF = process.argv[1]; // this script (bundled or not); the native binary re-invokes itself instead

const HELP = `moneyball: pay for the model each job needs, not the one you defaulted to.

  moneyball scan [--days N] [--all-projects] [--quiet]   measure subagent runs from transcripts, rebuild routes
  moneyball report [--json] [--all]                      per-class recommendation: graduate | explore | try-effort | keep
  moneyball stats [--json]                               usage + what routing is worth (.moneyball-stats.json)
  moneyball hook pre|session [--platform P]              PreToolUse (subagent dispatch) / SessionStart hooks

Modes (moneyball.config.json "mode" or MONEYBALL_MODE): report | suggest (default) | enforce | explore`;

const money = (x) => `$${x.toFixed(2)}`;

async function doScan(cfg) {
  const r = await scan(cfg, { days: Number(opt('--days', cfg.days)), allProjects: flag('--all-projects') });
  const p = plan(cfg);
  const rt = routes(cfg);
  writeRoutes(cfg, rt);
  const last = {
    runs: p.reduce((a, c) => a + c.n, 0), classes: p.length, spend: p.reduce((a, c) => a + c.cost, 0),
    graduate: p.filter(c => c.action === 'graduate').length, explore: p.filter(c => c.action === 'explore').length,
    est_saving: p.reduce((a, c) => a + (c.saving || 0), 0),
  };
  upsert(cfg, (s) => { s.totals.scans++; s.last_scan = last; });
  return { ...r, ...last };
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
    case 'hook':
      return runHook((h) => (rest[0] === 'session' ? sessionStart(cfg, SELF) : preToolUse(cfg, h)), rest.slice(1));
    default: console.log(HELP);
  }
}

main().catch((e) => { console.error(`moneyball: ${e.message}`); process.exitCode = cmd === 'hook' ? 0 : 1; });
