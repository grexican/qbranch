// .moneyball-stats.json: is routing being applied, and what is it worth?
import { createStats } from '@utility-belt/core';

const upsertFile = createStats({
  tool: 'moneyball',
  fresh: () => ({
    totals: { dispatches_seen: 0, explicit_model: 0, matched_class: 0, suggestions: 0, rewrites: 0, explored: 0, scans: 0 },
    last_scan: null,   // { runs, classes, spend, graduate, explore, est_monthly_saving }
  }),
  dayFresh: () => ({ dispatches: 0, rewrites: 0, explored: 0 }),
});

export const upsert = (cfg, mutate) => upsertFile(cfg.root, cfg.stats, mutate);

export function summarize(s) {
  const t = s.totals, l = s.last_scan;
  return [
    `moneyball stats since ${s.since.slice(0, 10)} (updated ${s.updated.slice(0, 16).replace('T', ' ')})`,
    `subagent dispatches seen ${t.dispatches_seen} | caller pinned a model ${t.explicit_model} | matched a measured class ${t.matched_class}`,
    `suggestions ${t.suggestions} | rewrites (enforce) ${t.rewrites} | exploration trials ${t.explored}`,
    l ? `last scan: ${l.runs} runs in ${l.classes} classes, $${l.spend.toFixed(2)} measured; ${l.graduate} graduated, ${l.explore} exploring; est. saving $${l.est_saving.toFixed(2)} over the window` : 'no scan yet (run: moneyball scan)',
  ].join('\n');
}
