// Turn measured runs into per-class routing. A class graduates to a cheaper tier only on evidence:
// that tier ran the class at least minRuns times with a success rate >= bar and within margin of the bigger tier.
// Ladder per the cost guidance: try lower effort on the same model first (caches are model-scoped, so a model switch
// costs a cold cache), then step one tier down. Never skip tiers.
import { cheaperOf, parseKey, sameModel } from './ladder.mjs';
import { db } from './store.mjs';

export function classStats(cfg) {
  const d = db(cfg);
  const rows = d.prepare(`select c.id, c.label, c.prior, r.tier, count(*) n, sum(r.ok) ok, coalesce(sum(r.cost), 0) cost, sum(r.cost is not null) priced, sum(coalesce(r.credit, 0)) credit
    from runs r join classes c on c.id = r.class_id group by c.id, r.tier`).all();
  const classes = new Map();
  for (const r of rows) {
    const c = classes.get(r.id) || classes.set(r.id, { id: r.id, label: r.label, prior: r.prior, tiers: {}, n: 0, cost: 0, credit: 0 }).get(r.id);
    // per completed task, net of the delegation credit (parent context the subagent kept out; see scan.mjs)
    c.tiers[r.tier] = { n: r.n, ok: r.ok, rate: r.ok / r.n, cost: r.cost, priced: r.priced, credit: r.credit, perTask: r.ok ? (r.cost - r.credit) / r.ok : Infinity };
    c.n += r.n; c.cost += r.cost; c.credit += r.credit;
  }
  const secs = new Map();
  for (const r of d.prepare('select class_id, tier, secs from runs where secs is not null').all()) {
    const k = `${r.class_id}|${r.tier}`; (secs.get(k) || secs.set(k, []).get(k)).push(r.secs);
  }
  for (const c of classes.values()) for (const [t, v] of Object.entries(c.tiers)) {
    v.lb = wilson(v.ok, v.n); v.secs = median(secs.get(`${c.id}|${t}`));
  }
  return [...classes.values()];
}

/** Decide one class. Returns { action, from, to, why, saving } — action: keep | try-effort | explore | graduate. */
export function decide(cfg, c) {
  // rungs the user actually chooses ("default"/"auto" is the editor's pick; unknown models have no ladder)
  const used = Object.keys(c.tiers).filter(t => !['auto', 'other'].includes(parseKey(t).vendor));
  const top = used.sort((a, b) => c.tiers[b].n - c.tiers[a].n)[0]; // the rung this class mostly runs on today
  if (!top) return { action: 'keep', from: Object.keys(c.tiers)[0], why: 'the model was chosen by the editor (auto), nothing to tune' };
  const ladder = cheaperOf(top);
  if (!ladder.length) return { action: 'keep', from: top, why: 'already on the cheapest rung' };
  const cur = c.tiers[top];
  if (cur.n >= cfg.minRuns && cur.rate < cfg.bar) {
    const up = used.find(t => cheaperOf(t).includes(top) && c.tiers[t]?.n >= 5 && c.tiers[t].rate >= cfg.bar);
    return up
      ? { action: 'keep', from: top, why: `${top} succeeds only ${pct(cur.rate)} but ${up} ${pct(c.tiers[up].rate)}: this class is under-powered, move it up` }
      : { action: 'keep', from: top, why: `${top} itself succeeds only ${pct(cur.rate)}: fix the brief before shopping for a cheaper model` };
  }
  // the nearest cheaper rung that already has evidence; otherwise the nearest rung (effort first, then size)
  const down = ladder.find(t => c.tiers[t]?.n >= cfg.minRuns) || ladder[0];
  const step = sameModel(top, down) ? 'lower effort, same model' : 'smaller model';
  const cand = c.tiers[down];
  // judgment work: the evidence must be strong enough to overrule the prior, so the 95% lower bound has to clear the bar
  if (cand && c.prior === 'judgment' && !sameModel(top, down) && cand.n >= cfg.minRuns && cand.rate >= cfg.bar && wilson(cand.ok, cand.n) < cfg.bar) {
    return { action: 'keep', from: top, to: down, step,
      why: `judgment work: ${down} passed ${cand.ok}/${cand.n} but the 95% lower bound is ${pct(wilson(cand.ok, cand.n))} (< ${pct(cfg.bar)}); about ${runsFor(cfg.bar)} clean runs would settle it` };
  }
  if (cand && cand.n >= cfg.minRuns && cand.rate >= cfg.bar && cand.rate >= cur.rate - cfg.margin) {
    const perRun = cur.cost / cur.n, perRunDown = cand.cost / cand.n;
    // the platform records no tokens (e.g. Cursor bills per request): graduate on outcomes alone, saving unknown
    if (cur.priced === 0 || cand.priced === 0) {
      return { action: 'graduate', from: top, to: down, step, why: `${down} passed ${cand.ok}/${cand.n} (${pct(cand.rate)}) vs ${top} ${pct(cur.rate)} (${step}); cost not recorded on this platform`, saving: null };
    }
    // false savings: judge on cost per completed task, not per run
    if (cand.perTask < cur.perTask) {
      return { action: 'graduate', from: top, to: down, step, why: `${down} passed ${cand.ok}/${cand.n} (${pct(cand.rate)}) vs ${top} ${pct(cur.rate)} (${step})`,
        saving: (cur.perTask - cand.perTask) * cur.ok, perRun, perRunDown };
    }
    return { action: 'keep', from: top, why: `${down} succeeds but retries make it dearer per completed task` };
  }
  if (cand && cand.n >= cfg.minRuns) return { action: 'keep', from: top, why: `${down} measured ${pct(cand.rate)} over ${cand.n} runs (< ${pct(cfg.bar)})` };
  if (c.prior === 'judgment' && !sameModel(top, down)) return { action: 'keep', from: top, why: 'judgment work: leave it on the strong model' };
  const have = cand?.n || 0;
  if ((c.prior === 'mechanical' || sameModel(top, down)) && cur.n >= cfg.minRuns) {
    const r = priceRatio(top, down);
    return { action: 'explore', from: top, to: down, step, why: `${c.prior === 'mechanical' ? 'mechanical, ' : ''}${cur.n} runs on ${top}, ${have}/${cfg.minRuns} trials on ${down} (${step})`,
      saving: r == null || cur.priced === 0 ? null : cur.cost * (1 - r) };
  }
  if (cur.n >= cfg.minRuns) return { action: 'try-effort', from: top, why: 'unclear class: try lower effort on the same model before a smaller one' };
  return { action: 'keep', from: top, why: `only ${cur.n} runs so far` };
}

// output-heavy approximation of the price step between rungs (see core PRICES); an effort step mostly cuts thinking
// tokens. Unknown steps return null: no invented savings.
const RATIO = { fable: { opus: 0.4 }, opus: { sonnet: 0.5 }, sonnet: { haiku: 0.05 } };
const priceRatio = (from, to) => (sameModel(from, to) ? 0.6 : RATIO[parseKey(from).base]?.[parseKey(to).base] ?? null);
const pct = (x) => `${Math.round(x * 100)}%`;

/** Wilson score 95% lower bound on a success rate: what ok/n supports with confidence, not just on average. */
export function wilson(ok, n, z = 1.96) {
  if (!n) return 0;
  const p = ok / n, z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n);
}
// clean runs (all passing) needed before the lower bound clears the bar
const runsFor = (bar) => { let n = 1; while (wilson(n, n) < bar && n < 1000) n++; return n; };
export const median = (xs) => { if (!xs?.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// wall-clock minutes the step down would have saved over the window: median time difference x the runs it would take over.
// Only when both rungs have measured durations; a slower smaller model shows as a negative number, not hidden.
function minutesSaved(c, p) {
  const cur = c.tiers[p.from], cand = c.tiers[p.to];
  if (cur?.secs == null || cand?.secs == null) return null;
  return ((cur.secs - cand.secs) * cur.n) / 60;
}

export function plan(cfg) {
  return classStats(cfg).map(c => { const p = { ...c, ...decide(cfg, c) }; if (p.action === 'graduate' || p.action === 'explore') p.minutes = minutesSaved(c, p); return p; })
    .sort((a, b) => (b.saving || 0) - (a.saving || 0) || b.cost - a.cost);
}

// a success signal that almost never fires cannot tell good work from bad: below this share of failing runs, say so
export const SATURATED = 0.03;

/**
 * Index-wide honesty figures: the scan window, and how often the success signals fire at all.
 * { runs, window_days, fail_rate, saturated, by: {redo, fail_words, rework, errors} }
 */
export function signal(cfg) {
  const r = db(cfg).prepare(`select count(*) n, coalesce(sum(1 - ok), 0) failed, coalesce(sum(redo), 0) redo, coalesce(sum(fail_words), 0) fail_words,
    coalesce(sum(rework), 0) rework, coalesce(sum(tool_calls >= 4 and tool_errors * 2 > tool_calls), 0) errors, min(mtime) lo, max(mtime) hi from runs`).get();
  const window_days = r.n ? Math.max(1, (r.hi - r.lo) / 864e5) : 0;
  const fail_rate = r.n ? r.failed / r.n : 0;
  return { runs: r.n, window_days: +window_days.toFixed(1), fail_rate, saturated: r.n > 0 && fail_rate < SATURATED,
    by: { redo: r.redo, fail_words: r.fail_words, rework: r.rework, errors: r.errors } };
}

/** The scan summary written to stats.last_scan: totals, routed classes, savings over the window and per 30 days. */
export function overview(cfg, p = plan(cfg), sig = signal(cfg)) {
  const keys = new Map(db(cfg).prepare('select id, key from classes').all().map(r => [r.id, r.key]));
  const acting = p.filter(c => c.action === 'graduate' || c.action === 'explore');
  const est_saving = p.reduce((a, c) => a + (c.saving || 0), 0);
  const mins = acting.filter(c => c.minutes != null);
  const est_minutes_saved = mins.length ? mins.reduce((a, c) => a + c.minutes, 0) : null;
  const per30 = (x) => (x == null || !sig.window_days ? null : (x * 30) / Math.max(sig.window_days, 1));
  return {
    runs: p.reduce((a, c) => a + c.n, 0), classes: p.length, spend: p.reduce((a, c) => a + c.cost, 0), credit: p.reduce((a, c) => a + (c.credit || 0), 0),
    graduate: p.filter(c => c.action === 'graduate').length, explore: p.filter(c => c.action === 'explore').length,
    est_saving, est_saving_30d: per30(est_saving), est_minutes_saved, est_minutes_30d: per30(est_minutes_saved),
    window_days: sig.window_days, fail_rate: sig.fail_rate, saturated: sig.saturated, signals: sig.by,
    routed: acting.map(c => ({ key: keys.get(c.id), action: c.action, from: c.from, to: c.to, lb: c.tiers[c.to] ? +c.tiers[c.to].lb.toFixed(2) : null, n: c.tiers[c.to]?.n || 0 })),
  };
}

/** Routing table written for the hook: class key -> { to, mode } for graduated / explore classes. */
export function routes(cfg) {
  const d = db(cfg);
  const keys = new Map(d.prepare('select id, key from classes').all().map(r => [r.id, r.key]));
  const out = {};
  // the hook can only set the subagent tool's model alias (Claude Code): other vendors' advice stays in the report
  for (const p of plan(cfg)) {
    if (p.action !== 'graduate' && p.action !== 'explore') continue;
    const to = parseKey(p.to);
    if (to.vendor === 'anthropic' && !to.effort && !to.fast) out[keys.get(p.id)] = { classId: p.id, from: p.from, to: p.to, action: p.action };
  }
  return out;
}
