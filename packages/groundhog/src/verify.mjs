// Prove a lesson before it is trusted: replay real past tasks with and without it (@qbranch/core/replay).
//   target tasks  read-only tasks whose transcripts show this lesson's failure: does the lesson help there?
//   held-out      unrelated recurring tasks, replayed with the full ledger: does the lesson break anything else?
// Both variants run the real groundhog hooks in the sandbox, so what is measured is the lesson as enforced, not a
// paragraph in a prompt. The verdict and its evidence go into the ledger entry as `verified`.
import fs from 'node:fs';
import path from 'node:path';
import { harvestTasks, compareVariants } from '@qbranch/core/replay';
import { runScenario } from '@qbranch/core/scenarios';
import { loadLessons } from './lessons.mjs';

const test = (re, s) => { try { return new RegExp(re, 'i').test(s); } catch { return false; } };
/** Did this past command run into the lesson's failure? (a call a hook denied is not a failure) */
const hit = (l, c) => c.err && !c.denied && (!l.tool || l.tool === c.tool) && test(l.when, c.cmd);
const cheapest = (a, b) => (a.origCostUsd ?? 0) - (b.origCostUsd ?? 0);

/** The tasks to replay for a lesson: the cheapest read-only tasks that hit it, and a held-out sample of the rest. */
export function lessonTasks(cfg, lesson, { days = cfg.days, tasks = 2, heldOut = 2, harvest = harvestTasks } = {}) {
  const all = harvest({ root: cfg.root, days, limit: 1000, minRecurrence: 1, filter: (t) => t.readOnly });
  const target = all.filter(t => t.history?.some(c => hit(lesson, c))).sort(cheapest).slice(0, tasks)
    .map(t => ({ ...t, checks: [...(t.checks || []), { kind: 'noFailure', pattern: lesson.when, ...(lesson.tool ? { tool: lesson.tool } : {}), hard: true }] }));
  const others = all.filter(t => t.recurrence >= 2 && !t.history?.some(c => hit(lesson, c)));
  // the held-out set is everything the lesson was not derived from; cheapest first, so a small budget still covers it
  return { target, held: others.sort(cheapest).slice(0, heldOut), candidates: all.length };
}

/** A variant: this ledger in the sandbox, and groundhog's own hooks enforcing it. */
export const ledgerVariant = (cfg, lessons, hookCommand) => async (dir) => {
  fs.writeFileSync(path.join(dir, cfg.lessons), JSON.stringify({ lessons }, null, 2) + '\n');
  if (!hookCommand) return {};
  return { settings: { hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: `${hookCommand} hook session` }] }],
    PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: `${hookCommand} hook pre` }] }],
  } } };
};

const rate = (v) => (v ? { runs: v.runs, passRate: v.passRate == null ? null : +v.passRate.toFixed(3), meanScore: v.meanScore == null ? null : +v.meanScore.toFixed(3) } : null);
const paired = (r) => (r ? r.perTask.filter(t => t.variants.without.runs && t.variants.with.runs).length : 0);

/**
 * Replay a lesson's tasks without and with it, then a held-out sample with the full ledger.
 * verdict: helps | neutral (accept) · hurts | regressed (reject) · no-evidence | inconclusive (nothing to decide on)
 */
export async function verifyLesson(cfg, lesson, { budgetUsd, model, days, tasks = 2, heldOut = 2, repeats = 1, agent = 'claude', hookCommand, timeoutMs = 300_000, compare = compareVariants, harvest, scenarios = null, log = () => {} } = {}) {
  if (!(budgetUsd > 0)) throw new Error('verification spends money: pass --budget <usd>');
  const ledger = loadLessons(cfg).filter(l => l.when !== lesson.when);
  const cand = { id: lesson.id || `L${ledger.length + 1}`, action: lesson.action || (cfg.guard === 'remind' ? 'remind' : 'deny-once'), ...lesson };
  const { target, held: recurring, candidates } = lessonTasks(cfg, cand, { days, tasks, heldOut, harvest });
  // validated history scenarios as the held-out set: does the lesson break building, not just recurring read-only work?
  const held = scenarios ? scenarios.slice(0, heldOut) : recurring;
  const at = new Date().toISOString();
  const base = { at, model: model || null, agent, repeats };
  if (!target.length) return { verdict: 'no-evidence', verified: { ...base, tasks: 0, before: null, after: null, regressions: [], costUsd: 0, verdict: 'no-evidence', note: `none of ${candidates} replayable tasks hit this failure` } };

  const variants = { without: ledgerVariant(cfg, ledger, hookCommand), with: ledgerVariant(cfg, [...ledger, cand], hookCommand) };
  const opts = { variants, repeats, agent, model, timeoutMs, onRun: ({ task, variant, grade, run, spent }) => log(`  ${variant.padEnd(7)} ${task.id}  ${grade.pass ? 'pass' : 'fail'} ${grade.score.toFixed(2)}  $${(run.costUsd || 0).toFixed(3)} (spent $${spent.toFixed(3)})${grade.pass ? '' : `  ${(grade.reasons || []).join('; ').slice(0, 140)}`}`) };
  log(`replaying ${target.length} task(s) where the failure happened, without and with ${cand.id}`);
  const a = await compare({ ...opts, tasks: target, budgetUsd: held.length ? budgetUsd * 0.6 : budgetUsd });
  let b = null;
  if (held.length && budgetUsd - a.spentUsd > 0.02) {
    log(`no-regression gate: ${held.length} held-out ${scenarios ? 'history scenario' : 'recurring task'}(s)`);
    b = await compare({ ...opts, tasks: held, budgetUsd: budgetUsd - a.spentUsd, ...(scenarios ? { runner: runScenario, timeoutMs: Math.max(timeoutMs, 1_200_000) } : {}) });
  }

  const before = rate(a.perVariant.without), after = rate(a.perVariant.with);
  const regressions = [...a.regressions, ...(b?.regressions || [])].map(r => r.task);
  const ran = paired(a);
  const verdict = !ran ? 'inconclusive'
    : regressions.length ? 'regressed'
    : after.passRate < before.passRate || after.meanScore < before.meanScore ? 'hurts'
    : after.passRate > before.passRate || after.meanScore > before.meanScore ? 'helps' : 'neutral';
  const verified = { ...base, tasks: ran + paired(b), before, after, regressions,
    heldOut: b ? { tasks: paired(b), before: rate(b.perVariant.without), after: rate(b.perVariant.with), skipped: b.skipped.length } : { tasks: 0, skipped: held.length },
    costUsd: +(a.spentUsd + (b?.spentUsd || 0)).toFixed(4), verdict };
  return { verdict, verified, report: { target: a, heldOut: b } };
}

export const acceptable = (verdict) => verdict === 'helps' || verdict === 'neutral';
