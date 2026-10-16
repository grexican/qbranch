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

export function plan(cfg) {
  return classStats(cfg).map(c => ({ ...c, ...decide(cfg, c) })).sort((a, b) => (b.saving || 0) - (a.saving || 0) || b.cost - a.cost);
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
