// Lite usage stats, upserted into a dotfile at the project root (default .headjack-stats.json).
// Purpose: after installing headjack in a repo, answer "is it being used, and is it worth it?"
import { createStats } from '@qbranch/core';

const upsertFile = createStats({
  tool: 'headjack',
  fresh: () => ({
    totals: { prompts: 0, suggested_prompts: 0, suggestions: 0, suggested_then_loaded: 0, searches: 0, weak_searches: 0,
      external_searches: 0, loads: 0, acquires: 0, est_tokens_injected: 0,
      sessions: 0, startup_tokens_saved: 0, skipped_system: 0, repeat_suppressed: 0, external_suggestions: 0 },
    startup_tokens_per_context: 0, // library skill descriptions kept out of the always-loaded skills listing
    skills: {},   // id -> { suggested, loaded, last_loaded }
    gaps: [],     // last 25 requests the library had no strong match for: your harvest list
    trail: [],    // last 30 suggestions { at, q, ids, sim }: why each skill was named, for tuning
  }),
  dayFresh: () => ({ prompts: 0, suggested: 0, loaded: 0 }),
  derive: (s) => { s.gaps = s.gaps.slice(-25); s.trail = s.trail.slice(-30); },
});

/** Read-modify-write the stats file. mutate(stats, day) edits in place. Never throws: stats must not break the agent. */
export const upsert = (cfg, mutate) => upsertFile(cfg.root, cfg.stats, mutate);

export const skillStat = (s, id) => (s.skills[id] ??= { suggested: 0, loaded: 0, last_loaded: null });

const num = (n) => Math.round(n).toLocaleString('en-US');

/** Human summary of a stats file: the verdict first, then usage, noise and gaps. */
export function summarize(s) {
  const t = { sessions: 0, startup_tokens_saved: 0, skipped_system: 0, repeat_suppressed: 0, external_suggestions: 0, ...s.totals };
  const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '-');
  const per = s.startup_tokens_per_context || 0, saved = t.startup_tokens_saved, net = saved - t.est_tokens_injected;
  const top = Object.entries(s.skills).filter(([, v]) => v.loaded).sort((a, b) => b[1].loaded - a[1].loaded).slice(0, 10);
  const ignored = Object.entries(s.skills).filter(([, v]) => v.suggested >= 3 && v.loaded === 0).sort((a, b) => b[1].suggested - a[1].suggested);
  const example = (id) => (s.trail || []).filter(e => e.ids.includes(id)).at(-1);
  const verdict = !t.prompts ? 'no prompts seen yet'
    : !t.sessions ? `startup saving not measured yet (stats predate session counting) | ${num(t.est_tokens_injected)} tokens injected | ` +
      `suggestion -> load conversion ${pct(t.suggested_then_loaded, t.suggestions)} (${t.suggested_then_loaded}/${t.suggestions}) | loads ${t.loads}`
    : `${net >= 0 ? 'net +' : 'net '}${num(net)} tokens (${num(saved)} kept out of startup, ${num(t.est_tokens_injected)} injected) | ` +
      `suggestion -> load conversion ${pct(t.suggested_then_loaded, t.suggestions)} (${t.suggested_then_loaded}/${t.suggestions}) | loads ${t.loads}`;
  return [
    `headjack stats since ${s.since.slice(0, 10)} (updated ${s.updated.slice(0, 16).replace('T', ' ')})`,
    `worth it? ${verdict}`,
    t.sessions && `~${num(saved)} tokens kept out of startup (${t.sessions} sessions, ${num(per)} each today; subagents not counted; assumes these skills would otherwise be installed)`,
    `prompts ${t.prompts} | with suggestions ${t.suggested_prompts} (${pct(t.suggested_prompts, t.prompts)}) | harness prompts skipped ${t.skipped_system} | repeats suppressed ${t.repeat_suppressed}`,
    `searches ${t.searches} (weak ${t.weak_searches}, external ${t.external_searches}) | registry suggestions ${t.external_suggestions} | acquires ${t.acquires}`,
    top.length ? `most loaded (loads/suggested): ${top.map(([k, v]) => `${k} ${v.loaded}/${v.suggested}`).join(', ')}` : 'no skills loaded yet',
    ignored.length ? `suggested often, never loaded (tune its description or remove it):\n  ${ignored.slice(0, 8).map(([k, v]) => {
      const e = example(k); return `${k} x${v.suggested}${e ? ` -- e.g. "${e.q.replace(/\s+/g, ' ').slice(0, 80)}"${e.sim != null ? ` (sim ${e.sim})` : ''}` : ''}`;
    }).join('\n  ')}` : '',
    s.gaps.length ? `library gaps (no strong match):\n  - ${s.gaps.slice(-10).map(g => g.q).join('\n  - ')}` : '',
  ].filter(Boolean).join('\n');
}
