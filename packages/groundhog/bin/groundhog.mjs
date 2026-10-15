#!/usr/bin/env node
// groundhog CLI: find the work your agents keep re-doing by hand, keep the lessons, and guard them with hooks.
import fs from 'node:fs';
import path from 'node:path';
import { readJson } from '@utility-belt/core';
import { runHook } from '@utility-belt/core/hooks';
import { loadConfig } from '../src/config.mjs';
import { mine } from '../src/mine.mjs';
import { accept, fromRecovery, loadLessons, preToolUse, recurrences, sessionStart } from '../src/lessons.mjs';
import { draftRunbook } from '../src/draft.mjs';
import { upsert, summarize } from '../src/stats.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const flag = (n) => rest.includes(n);
const opt = (n, d) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : d; };

const HELP = `groundhog: stop re-living the same session.

  groundhog scan [--days N] [--all-projects]   mine transcripts: repeated commands, sequences, error -> fix pairs
  groundhog report [--json]                    numbered candidates: lessons (L), sequences (S), friction (F), repeats (R)
  groundhog accept L<n>                        add mined lesson n to the ledger (groundhog.lessons.json; commit it)
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

async function main() {
  const cfg = loadConfig();
  switch (cmd) {
    case 'scan': {
      const ix = mine(cfg, { days: Number(opt('--days', cfg.days)), allProjects: flag('--all-projects') });
      const rec = recurrences(cfg, ix.allCalls);
      upsert(cfg, (s) => {
        s.totals.scans++; s.recurrences = rec;
        s.last_scan = { sessions: ix.sessions, calls: ix.calls, repeats: ix.repeats.length, lessons: ix.lessons.length, sequences: ix.sequences.length };
      });
      return console.log(`${ix.sessions} sessions, ${ix.calls} shell calls: ${ix.lessons.length} lesson candidates, ${ix.sequences.length} sequences, ${ix.friction.length} friction shapes, ${ix.repeats.length} repeats. Next: groundhog report`);
    }
    case 'report': {
      const ix = index(cfg);
      if (flag('--json')) return console.log(JSON.stringify(ix, null, 2));
      const known = new Set(loadLessons(cfg).map(l => l.when));
      const pct = (e) => `${Math.round((100 * e.errors) / e.count)}%`;
      console.log('Lessons: the same error, then the same workaround (accept with: groundhog accept L<n>)');
      ix.lessons.slice(0, 15).forEach((e, i) => console.log(`  L${i + 1}  x${e.count} in ${e.sessions} sessions  ${e.from}  =>  ${e.to}${known.has(fromRecovery(e).when) ? '  [accepted]' : ''}`));
      console.log('\nSequences run by hand again and again (draft a runbook with: groundhog draft S<n>)');
      ix.sequences.slice(0, 12).forEach((e, i) => console.log(`  S${i + 1}  ${e.sessions} sessions  ${e.steps.join('  >  ')}`));
      console.log('\nFriction: repeated commands that fail a lot');
      ix.friction.slice(0, 10).forEach((e, i) => console.log(`  F${i + 1}  ${pct(e)} of ${e.count} fail  ${e.shape}`));
      console.log('\nRepeats: one command shape across many sessions (script candidates; draft with: groundhog draft R<n>)');
      ix.repeats.slice(0, 12).forEach((e, i) => console.log(`  R${i + 1}  ${e.sessions} sessions, ${e.count} runs  ${e.shape}`));
      return;
    }
    case 'accept': {
      const e = pick(index(cfg).lessons, rest[0], 'L');
      if (!e) throw new Error(`no lesson ${rest[0]} (see groundhog report)`);
      const l = accept(cfg, fromRecovery(e));
      return console.log(l ? `${l.id} added (${l.action}): when /${l.when}/ -> ${l.instead}\nEdit ${cfg.lessons} to refine the wording; commit it.` : 'already in the ledger');
    }
    case 'add': {
      if (!opt('--when') || !opt('--instead')) throw new Error('usage: groundhog add --when <regex> --instead <text>');
      new RegExp(opt('--when')); // validate before it reaches the ledger
      const l = accept(flag('--remind') ? { ...cfg, guard: 'remind' } : cfg, { when: opt('--when'), instead: opt('--instead'), source: 'manual' });
      return console.log(l ? `${l.id} added` : 'already in the ledger');
    }
    case 'lessons': {
      const ls = loadLessons(cfg);
      return console.log(ls.length ? ls.map(l => `${l.id} [${l.action}] /${l.when}/  ${l.instead}`).join('\n') : 'ledger is empty');
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
