// Turn measured runs into per-class routing. A class graduates to a cheaper tier only on evidence:
// that tier ran the class at least minRuns times with a success rate >= bar and within margin of the bigger tier.
// Ladder per the cost guidance: try lower effort on the same model first (caches are model-scoped, so a model switch
// costs a cold cache), then step one tier down. Never skip tiers.
import { TIERS, cheaper } from './config.mjs';
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
  const used = TIERS.filter(t => c.tiers[t]);
  const top = used.sort((a, b) => c.tiers[b].n - c.tiers[a].n)[0]; // the tier this class mostly runs on today
  if (!top || top === 'haiku' || top === 'other') return { action: 'keep', from: top, why: 'already on the cheapest tier' };
  const cur = c.tiers[top];
  if (cur.n >= cfg.minRuns && cur.rate < cfg.bar) {
    const up = TIERS.slice(TIERS.indexOf(top) + 1).find(t => c.tiers[t]?.n >= 5 && c.tiers[t].rate >= cfg.bar);
    return up
      ? { action: 'keep', from: top, why: `${top} succeeds only ${pct(cur.rate)} but ${up} ${pct(c.tiers[up].rate)}: this class is under-powered, move it up` }
      : { action: 'keep', from: top, why: `${top} itself succeeds only ${pct(cur.rate)}: fix the brief before shopping for a cheaper model` };
  }
  const down = cheaper(top);
  const cand = c.tiers[down];
  if (cand && cand.n >= cfg.minRuns && cand.rate >= cfg.bar && cand.rate >= cur.rate - cfg.margin) {
    const perRun = cur.cost / cur.n, perRunDown = cand.cost / cand.n;
    // the platform records no tokens (e.g. Cursor bills per request): graduate on outcomes alone, saving unknown
    if (cur.priced === 0 || cand.priced === 0) {
      return { action: 'graduate', from: top, to: down, why: `${down} passed ${cand.ok}/${cand.n} (${pct(cand.rate)}) vs ${top} ${pct(cur.rate)}; cost not recorded on this platform`, saving: null };
    }
    // false savings: judge on cost per completed task, not per run
    if (cand.perTask < cur.perTask) {
      return { action: 'graduate', from: top, to: down, why: `${down} passed ${cand.ok}/${cand.n} (${pct(cand.rate)}) vs ${top} ${pct(cur.rate)}`,
        saving: (cur.perTask - cand.perTask) * cur.ok, perRun, perRunDown };
    }
    return { action: 'keep', from: top, why: `${down} succeeds but retries make it dearer per completed task` };
  }
  if (cand && cand.n >= cfg.minRuns) return { action: 'keep', from: top, why: `${down} measured ${pct(cand.rate)} over ${cand.n} runs (< ${pct(cfg.bar)})` };
  if (c.prior === 'judgment') return { action: 'keep', from: top, why: 'judgment work: leave it on the strong model' };
  const have = cand?.n || 0;
  if (c.prior === 'mechanical' && cur.n >= cfg.minRuns) {
    return { action: 'explore', from: top, to: down, why: `mechanical, ${cur.n} runs on ${top}, ${have}/${cfg.minRuns} trials on ${down}`,
      saving: cur.cost * (1 - priceRatio(top, down)) };
  }
  if (cur.n >= cfg.minRuns) return { action: 'try-effort', from: top, why: 'unclear class: try lower effort on the same model before a smaller one' };
  return { action: 'keep', from: top, why: `only ${cur.n} runs so far` };
}

// output-heavy approximation of the price step between adjacent tiers (see core PRICES)
const RATIO = { fable: { opus: 0.4 }, opus: { sonnet: 0.5 }, sonnet: { haiku: 0.05 } };
const priceRatio = (from, to) => RATIO[from]?.[to] ?? 1;
const pct = (x) => `${Math.round(x * 100)}%`;

export function plan(cfg) {
  return classStats(cfg).map(c => ({ ...c, ...decide(cfg, c) })).sort((a, b) => (b.saving || 0) - (a.saving || 0) || b.cost - a.cost);
}

/** Routing table written for the hook: class key -> { to, mode } for graduated / explore classes. */
export function routes(cfg) {
  const d = db(cfg);
  const keys = new Map(d.prepare('select id, key from classes').all().map(r => [r.id, r.key]));
  const out = {};
  for (const p of plan(cfg)) if (p.action === 'graduate' || p.action === 'explore') out[keys.get(p.id)] = { classId: p.id, from: p.from, to: p.to, action: p.action };
  return out;
}
