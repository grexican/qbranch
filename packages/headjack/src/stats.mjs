// Lite usage stats, upserted into a dotfile at the project root (default .headjack-stats.json).
// Purpose: after installing headjack in a repo, answer "is it being used, and is it making a difference?"
import { createStats } from '@utility-belt/core';

const upsertFile = createStats({
  tool: 'headjack',
  fresh: () => ({
    totals: { prompts: 0, suggested_prompts: 0, suggestions: 0, suggested_then_loaded: 0, searches: 0, weak_searches: 0,
      external_searches: 0, loads: 0, acquires: 0, est_tokens_injected: 0 },
    skills: {},   // id -> { suggested, loaded, last_loaded }
    gaps: [],     // last 25 requests the library had no strong match for: your harvest list
  }),
  dayFresh: () => ({ prompts: 0, suggested: 0, loaded: 0 }),
  derive: (s) => { s.gaps = s.gaps.slice(-25); },
});

/** Read-modify-write the stats file. mutate(stats, day) edits in place. Never throws: stats must not break the agent. */
export const upsert = (cfg, mutate) => upsertFile(cfg.root, cfg.stats, mutate);

export const skillStat = (s, id) => (s.skills[id] ??= { suggested: 0, loaded: 0, last_loaded: null });

/** Human summary of a stats file: usage + the efficacy signals. */
export function summarize(s) {
  const t = s.totals;
  const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '-');
  const top = Object.entries(s.skills).sort((a, b) => b[1].loaded - a[1].loaded).slice(0, 10);
  const ignored = Object.entries(s.skills).filter(([, v]) => v.suggested >= 3 && v.loaded === 0).map(([k]) => k);
  return [
    `headjack stats since ${s.since.slice(0, 10)} (updated ${s.updated.slice(0, 16).replace('T', ' ')})`,
    `prompts seen ${t.prompts} | prompts with suggestions ${t.suggested_prompts} (${pct(t.suggested_prompts, t.prompts)})`,
    `skill loads ${t.loads} | suggestion -> load conversion ${pct(t.suggested_then_loaded, t.suggestions)} | searches ${t.searches} (weak ${t.weak_searches}, external ${t.external_searches}) | acquires ${t.acquires}`,
    `~tokens injected by suggestions: ${t.est_tokens_injected}`,
    top.length ? `most loaded: ${top.map(([k, v]) => `${k} x${v.loaded}`).join(', ')}` : 'no skills loaded yet',
    ignored.length ? `suggested often but never loaded (tune or remove): ${ignored.join(', ')}` : '',
    s.gaps.length ? `library gaps (no strong match):\n  - ${s.gaps.slice(-10).map(g => g.q).join('\n  - ')}` : '',
  ].filter(Boolean).join('\n');
}
