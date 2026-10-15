// .moneyball-stats.json: is routing being applied, and what is it worth?
import { createStats } from '@qbranch/core';

const upsertFile = createStats({
  tool: 'moneyball',
  fresh: () => ({
    totals: { dispatches_seen: 0, explicit_model: 0, matched_class: 0, suggestions: 0, rewrites: 0, explored: 0, scans: 0 },
    last_scan: null,       // { runs, classes, spend, credit, graduate, explore, est_saving }
    overhead: null,        // { at, days, sessions, subagents: {n, median, p90}, startup_usd, total_usd, share, attribution? }
    last_experiment: null, // { at, tasks, variants, recommended: [ids], spent }
  }),
  dayFresh: () => ({ dispatches: 0, rewrites: 0, explored: 0 }),
});

export const upsert = (cfg, mutate) => upsertFile(cfg.root, cfg.stats, mutate);

export function summarize(s) {
  const t = s.totals, l = s.last_scan, o = s.overhead, x = s.last_experiment;
  return [
    `moneyball stats since ${s.since.slice(0, 10)} (updated ${s.updated.slice(0, 16).replace('T', ' ')})`,
    `subagent dispatches seen ${t.dispatches_seen} | caller pinned a model ${t.explicit_model} | matched a measured class ${t.matched_class}`,
    `suggestions ${t.suggestions} | rewrites (enforce) ${t.rewrites} | exploration trials ${t.explored}`,
    l ? `last scan: ${l.runs} runs in ${l.classes} classes, $${l.spend.toFixed(2)} measured; ${l.graduate} graduated, ${l.explore} exploring; est. saving $${l.est_saving.toFixed(2)} over the window` : 'no scan yet (run: moneyball scan)',
    o ? `startup tax (${o.at.slice(0, 10)}): median ${o.subagents.median} tokens per subagent, ${o.sessions.median} per session; $${o.startup_usd.toFixed(2)} = ${(o.share * 100).toFixed(1)}% of spend` : 'startup tax not measured yet (run: moneyball overhead)',
    x ? `last experiment (${x.at.slice(0, 10)}): ${x.variants} variants over ${x.tasks} tasks, $${x.spent.toFixed(2)} spent; recommended: ${x.recommended.join(', ') || 'none'}` : null,
  ].filter(Boolean).join('\n');
}
