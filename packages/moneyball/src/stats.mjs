// .moneyball-stats.json: is routing being applied, and what is it worth?
import { createStats } from '@qbranch/core';

const upsertFile = createStats({
  tool: 'moneyball',
  fresh: () => ({
    totals: { dispatches_seen: 0, explicit_model: 0, matched_class: 0, suggestions: 0, rewrites: 0, explored: 0, scans: 0 },
    skips: {},             // why each dispatch was (not) acted on: no_class | explicit_pinned | explore_needs_explore_mode | explore_not_sampled | mode_report | mode_unknown | acted
    seen: {},              // class key -> { n, action, to, why: {reason: n} } (first 50 keys)
    last_scan: null,       // overview(): runs, window_days, est_saving(_30d), est_minutes_saved/_30d, fail_rate, saturated, routed[] ...
    overhead: null,        // { at, days, sessions, subagents: {n, median, p90}, startup_usd, total_usd, share, attribution? }
    last_experiment: null, // { at, tasks, variants, recommended: [ids], spent }
  }),
  dayFresh: () => ({ dispatches: 0, rewrites: 0, explored: 0 }),
});

export const upsert = (cfg, mutate) => upsertFile(cfg.root, cfg.stats, mutate);

const money = (x) => `$${(x || 0).toFixed(2)}`;
const pct = (x) => `${Math.round((x || 0) * 100)}%`;
const mins = (m) => (m == null ? null : Math.abs(m) >= 90 ? `${(m / 60).toFixed(1)} h` : `${Math.round(m)} min`);
const REASON = {
  explicit_pinned: 'the caller pinned a model (respectExplicit)',
  explore_needs_explore_mode: 'class is exploring; only explore mode trials the cheaper tier',
  explore_not_sampled: 'exploring, not sampled this time',
  mode_report: 'report mode measures only',
  mode_unknown: 'the mode is not one of report, suggest, enforce, explore',
  acted: 'acted on',
};

/** "Is it worth it?" first (routed now, projected savings, confidence), then the detail. */
function headline(s) {
  const l = s.last_scan;
  if (!l) return ['worth it? unknown yet: no scan (run: moneyball scan)'];
  if (!('routed' in l)) return ['worth it? unknown yet: the last scan predates v0.3 (run: moneyball scan to refresh it)'];
  const routed = l.routed?.length
    ? l.routed.map(r => `${r.key} ${r.from}->${r.to} (${r.action === 'graduate' ? 'graduated' : 'exploring'}${r.n ? `, ${r.n} runs, lb ${pct(r.lb)}` : ''})`).join('; ')
    : 'nothing yet: no class has evidence for a cheaper tier';
  const per30 = l.est_saving_30d != null
    ? `${money(l.est_saving_30d)}/30d${l.est_minutes_30d != null ? ` and ~${mins(l.est_minutes_30d)}/30d of wall-clock` : ''} (window ${l.window_days} days: ${money(l.est_saving)})`
    : `${money(l.est_saving)} over the scan window`;
  const conf = l.saturated
    ? `confidence: LOW. Only ${pct(l.fail_rate)} of ${l.runs} runs fail on any signal, so a pass means "no failure signal fired", not proven quality; treat graduations as hypotheses and test them in explore mode.`
    : l.fail_rate != null ? `confidence: success signals fire on ${pct(l.fail_rate)} of ${l.runs} runs (redo, failure words, parent rework, tool errors), so pass rates discriminate.` : null;
  return [
    `worth it? routing now: ${routed}`,
    `  projected: ${per30}. $ is API-equivalent: on a subscription plan it is quota share, not cash.`,
    conf && `  ${conf}`,
  ].filter(Boolean);
}

/** Plain-words account of why dispatches were or were not acted on. */
function why(s) {
  const t = s.totals, sk = s.skips || {};
  if (!t.dispatches_seen) return null;
  const matched = Object.entries(s.seen || {}).filter(([, v]) => v.action).sort((a, b) => b[1].n - a[1].n);
  const parts = matched.slice(0, 4).map(([k, v]) => {
    const top = Object.entries(v.why || {}).sort((a, b) => b[1] - a[1])[0];
    return `${v.n} ${k} (${v.action === 'explore' ? 'exploring' : 'graduated'} -> ${v.to}; ${REASON[top?.[0]] || top?.[0] || ''})`;
  });
  const lines = [`${t.matched_class} of ${t.dispatches_seen} dispatches matched a measured class${parts.length ? `: ${parts.join(', ')}` : ''}`];
  if (t.matched_class && !matched.length) lines.push('  (why each dispatch was or was not acted on is recorded from v0.3 on)');
  if (sk.no_class) lines.push(`  ${sk.no_class} had no measured class yet (new task kinds collect evidence as scans run)`);
  const other = Object.entries(sk).filter(([k]) => k !== 'no_class' && k !== 'acted');
  if (other.length) lines.push(`  not acted on: ${other.map(([k, n]) => `${n} ${REASON[k] || k}`).join(', ')}`);
  return lines.join('\n');
}

export function summarize(s) {
  const t = s.totals, l = s.last_scan, o = s.overhead, x = s.last_experiment;
  return [
    ...headline(s),
    '',
    `moneyball stats since ${s.since.slice(0, 10)} (updated ${s.updated.slice(0, 16).replace('T', ' ')})`,
    `subagent dispatches seen ${t.dispatches_seen} | caller pinned a model ${t.explicit_model} | matched a measured class ${t.matched_class}`,
    `suggestions ${t.suggestions} | rewrites (enforce) ${t.rewrites} | exploration trials ${t.explored}`,
    why(s),
    l ? `last scan: ${l.runs} runs in ${l.classes} classes, ${money(l.spend)} measured${l.window_days ? ` over ${l.window_days} days` : ''}; ${l.graduate} graduated, ${l.explore} exploring` : 'no scan yet (run: moneyball scan)',
    o ? `startup tax (${o.at.slice(0, 10)}): median ${o.subagents.median} tokens per subagent, ${o.sessions.median} per session; ${money(o.startup_usd)} = ${(o.share * 100).toFixed(1)}% of spend` : 'startup tax not measured yet (run: moneyball overhead)',
    x ? `last experiment (${x.at.slice(0, 10)}): ${x.variants} variants over ${x.tasks} tasks, ${money(x.spent)} spent; recommended: ${x.recommended.join(', ') || 'none'}` : null,
  ].filter(v => v != null).join('\n');
}
