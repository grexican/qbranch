#!/usr/bin/env node
// groundhog CLI: find the work your agents keep re-doing by hand, keep the lessons, and guard them with hooks.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, selfCommand } from '@qbranch/core';
import { runHook } from '@qbranch/core/hooks';
import { loadConfig } from '../src/config.mjs';
import { mine } from '../src/mine.mjs';
import { accept, fromRecovery, fromSwitch, fromRtk, loadLessons, preToolUse, recurrences, sessionStart, updateLesson } from '../src/lessons.mjs';
import { verifyLesson, acceptable } from '../src/verify.mjs';
import { loadScenarios, scenariosDir } from '@qbranch/core/scenarios';
import { draftRunbook } from '../src/draft.mjs';
import { upsert, summarize } from '../src/stats.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const flag = (n) => rest.includes(n);
const opt = (n, d) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : d; };

const HELP = `groundhog: stop re-living the same session.

  groundhog scan [--days N] [--all-projects]   mine transcripts: repeated commands, sequences, error -> fix pairs
  groundhog report [--json]                    numbered candidates: lessons (L), tool switches (W), rtk retries (K),
                                               sequences (S), friction (F), repeats (R)
  groundhog accept L<n>|W<n>|K<n>              add a mined lesson to the ledger (groundhog.lessons.json; commit it)
  groundhog accept L<n> --verify --budget USD  replay the tasks where it failed, without and with the lesson, plus a
                                               held-out sample; add it only if it helps (or never hurts) and breaks nothing
  groundhog verify [L<n>] --budget USD         re-check accepted lessons; a lesson that breaks another task is flagged
      verify options: [--model M] [--tasks N] [--held-out N] [--repeats N] [--days N] [--timeout SEC]
                      [--scenarios [--cache DIR]]  held-out set = validated history scenarios (moneyball scenarios)
  groundhog add --when <regex> --instead <text> [--remind]   add a lesson by hand
  groundhog lessons                            list the ledger
  groundhog draft S<n>|R<n> [--name x]         write a runbook skill draft to .groundhog/drafts/
  groundhog stats [--json]                     usage + whether accepted lessons stopped recurring
  groundhog hook session|pre [--platform P]    SessionStart (inject lessons) / PreToolUse (guard shell commands)`;

function index(cfg) {
  const ix = readJson(path.join(cfg.dataDir, 'index.json'), null);
  if (!ix) throw new Error('no scan yet: run `groundhog scan`');
  return ix;
}
const pick = (list, ref, letter) => list[Number(String(ref || '').replace(new RegExp(`^${letter}`, 'i'), '')) - 1] || null;

/** Options for a replay verification; refuses to spend without an explicit --budget. */
async function verifyOpts(cfg) {
  const budgetUsd = Number(opt('--budget'));
  if (!(budgetUsd > 0)) throw new Error('verification replays real tasks with a model and spends money: pass --budget <usd>');
  const [exe, pre] = await selfCommand('groundhog', fileURLToPath(import.meta.url));
  return { budgetUsd, model: opt('--model'), days: Number(opt('--days', cfg.days)), tasks: Number(opt('--tasks', 2)), heldOut: Number(opt('--held-out', 2)),
    repeats: Number(opt('--repeats', 1)), timeoutMs: Number(opt('--timeout', 300)) * 1000, log: (m) => console.log(m),
    hookCommand: [exe, ...pre].map(a => `"${a.split(path.sep).join('/')}"`).join(' '),
    scenarios: flag('--scenarios') ? loadScenarios(cfg.root, { dir: opt('--cache') ? path.resolve(opt('--cache')) : process.env.QBRANCH_SCENARIOS_DIR || scenariosDir(cfg.root), status: 'valid' }) : null };
}
const showVerified = (v) => !v ? '' : v.before
  ? `${v.verdict}: pass ${v.before.passRate} -> ${v.after.passRate}, score ${v.before.meanScore} -> ${v.after.meanScore} on ${v.tasks} task(s)${v.regressions.length ? `, regressions: ${v.regressions.join(', ')}` : ''}, $${v.costUsd}`
    + (v.repeats === 1 && v.verdict !== 'neutral' ? ' (one sample per task and variant: confirm with --repeats 3)' : '')
  : `${v.verdict}${v.note ? ` (${v.note})` : ''}`;

async function main() {
  if (cmd !== 'hook' && (rest.includes('--help') || rest.includes('-h'))) return console.log(HELP);
  const cfg = loadConfig();
  switch (cmd) {
    case 'scan': {
      const ix = mine(cfg, { days: Number(opt('--days', cfg.days)), allProjects: flag('--all-projects') });
      const rec = recurrences(cfg, ix.allCalls);
      upsert(cfg, (s) => {
        s.totals.scans++; s.recurrences = rec;
        s.last_scan = { sessions: ix.sessions, calls: ix.calls, repeats: ix.repeats.length, lessons: ix.lessons.length, switches: ix.switches.length, rtk: ix.rtk.length, sequences: ix.sequences.length };
      });
      return console.log(`${ix.sessions} sessions, ${ix.calls} shell calls: ${ix.lessons.length} lesson candidates, ${ix.switches.length} tool switches, ${ix.rtk.length} rtk retries, ${ix.sequences.length} sequences, ${ix.friction.length} friction shapes, ${ix.repeats.length} repeats. Next: groundhog report`);
    }
    case 'report': {
      const ix = index(cfg);
      if (flag('--json')) return console.log(JSON.stringify(ix, null, 2));
      const known = new Set(loadLessons(cfg).map(l => l.when));
      const pct = (e) => `${Math.round((100 * e.errors) / e.count)}%`;
      console.log('Lessons: the same error, then the same workaround (accept with: groundhog accept L<n>)');
      ix.lessons.slice(0, 15).forEach((e, i) => console.log(`  L${i + 1}  x${e.count} in ${e.sessions} sessions  ${e.from}  =>  ${e.to}${known.has(fromRecovery(e).when) ? '  [accepted]' : ''}`));
      if (ix.switches?.length) {
        console.log('\nTool switches: a risky shell construct failed, then the Write/Edit tool fixed it (accept with: groundhog accept W<n>)');
        ix.switches.slice(0, 10).forEach((e, i) => console.log(`  W${i + 1}  x${e.count} in ${e.sessions} sessions  ${e.tool}: ${e.kind}  =>  ${e.toExample.split('\n')[0].slice(0, 90)}${known.has(fromSwitch(e)?.when) ? '  [accepted]' : ''}`));
      }
      if (ix.rtk?.length) {
        console.log('\nrtk retries: rerun as `rtk proxy` for raw output (accept with: groundhog accept K<n>)');
        ix.rtk.slice(0, 10).forEach((e, i) => console.log(`  K${i + 1}  x${e.count} in ${e.sessions} sessions  ${e.shape}${known.has(fromRtk(e).when) ? '  [accepted]' : ''}`));
      }
      console.log('\nSequences run by hand again and again (draft a runbook with: groundhog draft S<n>)');
      ix.sequences.slice(0, 12).forEach((e, i) => console.log(`  S${i + 1}  ${e.sessions} sessions  ${e.steps.join('  >  ')}`));
      console.log('\nFriction: repeated commands that fail a lot');
      ix.friction.slice(0, 10).forEach((e, i) => console.log(`  F${i + 1}  ${pct(e)} of ${e.count} fail  ${e.shape}`));
      console.log('\nRepeats: one command shape across many sessions (script candidates; draft with: groundhog draft R<n>)');
      ix.repeats.slice(0, 12).forEach((e, i) => console.log(`  R${i + 1}  ${e.sessions} sessions, ${e.count} runs  ${e.shape}`));
      return;
    }
    case 'accept': {
      const ix = index(cfg), ref = String(rest[0] || '');
      const e = /^w/i.test(ref) ? pick(ix.switches || [], ref, 'W') : /^k/i.test(ref) ? pick(ix.rtk || [], ref, 'K') : pick(ix.lessons, ref, 'L');
      if (!e) throw new Error(`no lesson ${rest[0]} (see groundhog report)`);
      const entry = /^w/i.test(ref) ? fromSwitch(e) : /^k/i.test(ref) ? fromRtk(e) : fromRecovery(e);
      if (!entry) throw new Error(`${ref} has no ledger form`);
      if (loadLessons(cfg).some(l => l.when === entry.when)) return console.log('already in the ledger');
      if (flag('--verify')) {
        const { verdict, verified } = await verifyLesson(cfg, entry, await verifyOpts(cfg));
        console.log(`verification: ${showVerified(verified)}`);
        if (!acceptable(verdict)) { process.exitCode = 1; return console.log(`not accepted (${verdict}). Accept without --verify to add it unproven.`); }
        entry.verified = verified;
      }
      const l = accept(cfg, entry);
      return console.log(l ? `${l.id} added (${l.action}): when /${l.when}/ -> ${l.instead}\nEdit ${cfg.lessons} to refine the wording; commit it.` : 'already in the ledger');
    }
    case 'verify': {
      const o = await verifyOpts(cfg);
      const all = loadLessons(cfg), ids = rest.filter(x => /^L\d+$/i.test(x)).map(x => x.toUpperCase());
      const todo = ids.length ? all.filter(l => ids.includes(l.id)) : all;
      if (!todo.length) throw new Error(ids.length ? `no lesson ${ids.join(', ')} in the ledger` : 'ledger is empty');
      for (const l of todo) {
        console.log(`${l.id} /${l.when}/`);
        const { verdict, verified } = await verifyLesson(cfg, l, { ...o, budgetUsd: o.budgetUsd / todo.length });
        // a lesson that breaks another task stays in the ledger, flagged, for a person to decide
        updateLesson(cfg, l.id, { verified, flagged: verdict === 'regressed' || verdict === 'hurts' ? verdict : undefined });
        console.log(`${l.id} ${showVerified(verified)}`);
      }
      return;
    }
    case 'add': {
      if (!opt('--when') || !opt('--instead')) throw new Error('usage: groundhog add --when <regex> --instead <text>');
      new RegExp(opt('--when')); // validate before it reaches the ledger
      const l = accept(flag('--remind') ? { ...cfg, guard: 'remind' } : cfg, { when: opt('--when'), instead: opt('--instead'), source: 'manual' });
      return console.log(l ? `${l.id} added` : 'already in the ledger');
    }
    case 'lessons': {
      const ls = loadLessons(cfg);
      return console.log(ls.length ? ls.map(l => `${l.id} [${l.action}]${l.flagged ? ` [FLAGGED: ${l.flagged}]` : ''} /${l.when}/  ${l.instead}${l.verified ? `\n    verified ${l.verified.at.slice(0, 10)}: ${showVerified(l.verified)}` : ''}`).join('\n') : 'ledger is empty');
    }
    case 'draft': {
      const ix = index(cfg);
      const ref = String(rest[0] || '');
      const item = /^s/i.test(ref) ? pick(ix.sequences, ref, 'S') : /^r/i.test(ref) ? pick(ix.repeats, ref, 'R') : null;
      if (!item) throw new Error('usage: groundhog draft S<n>|R<n> (see groundhog report)');
      return console.log(`draft written: ${draftRunbook(cfg, item, opt('--name'))}\nReview it, then adopt it into a skill library (e.g. headjack add <dir>).`);
    }
    case 'stats': {
      let s; try { s = JSON.parse(fs.readFileSync(path.join(cfg.root, cfg.stats || '.groundhog-stats.json'), 'utf8')); } catch { return console.log('no stats yet'); }
      return console.log(flag('--json') ? JSON.stringify(s, null, 2) : summarize(s));
    }
    case 'hook':
      return runHook((h) => (rest[0] === 'session' ? sessionStart(cfg) : preToolUse(cfg, h)), rest.slice(1));
    default: console.log(HELP);
  }
}

main().catch((e) => { console.error(`groundhog: ${e.message}`); process.exitCode = cmd === 'hook' ? 0 : 1; });
