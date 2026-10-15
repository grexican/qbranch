// .groundhog-stats.json: are the lessons applied, and are the mistakes stopping?
import { createStats } from '@utility-belt/core';

const upsertFile = createStats({
  tool: 'groundhog',
  fresh: () => ({
    totals: { scans: 0, accepted: 0, injections: 0, guard_hits: 0, denies: 0, drafts: 0 },
    last_scan: null,     // { sessions, calls, repeats, lessons, sequences }
    recurrences: [],     // per lesson: failing command ran / failed again since it was accepted
  }),
  dayFresh: () => ({ injections: 0, guard_hits: 0 }),
});

export const upsert = (cfg, mutate) => upsertFile(cfg.root, cfg.stats, mutate);

export function summarize(s) {
  const t = s.totals, l = s.last_scan;
  const rec = s.recurrences.filter(r => r.ran);
  return [
    `groundhog stats since ${s.since.slice(0, 10)} (updated ${s.updated.slice(0, 16).replace('T', ' ')})`,
    `lessons accepted ${t.accepted} | session injections ${t.injections} | guard hits ${t.guard_hits} (denied ${t.denies}) | drafts ${t.drafts}`,
    l ? `last scan: ${l.sessions} sessions, ${l.calls} shell calls; ${l.repeats} repeated shapes, ${l.lessons} lesson candidates, ${l.sequences} sequences` : 'no scan yet (run: groundhog scan)',
    rec.length ? `still recurring after acceptance:\n  ${rec.map(r => `${r.id}: ran ${r.ran}x, failed ${r.failed}x`).join('\n  ')}` : (s.recurrences.length ? 'no accepted lesson has recurred since it was accepted' : ''),
  ].filter(Boolean).join('\n');
}
