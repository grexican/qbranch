// Lite usage stats, upserted into a dotfile at the project root (default .middleout-stats.json).
// Answers "is middleout being used, and how much is it saving?", including raw MCP traffic that bypassed it.
import { createStats } from '@utility-belt/core';

const upsertFile = createStats({
  tool: 'middleout',
  fresh: () => ({
    totals: { runs: 0, api_calls: 0, raw_bytes: 0, returned_bytes: 0, auto_pages: 0, errors: 0,
      raw_calls_seen: 0, raw_bytes_seen: 0, nudges: 0, gated: 0 },
    tools: {},     // "server.tool" -> { via_middleout, raw_calls, raw_bytes_seen }
  }),
  dayFresh: () => ({ runs: 0, raw_bytes: 0, returned_bytes: 0, raw_calls_seen: 0 }),
  derive: (s) => {
    const t = s.totals;
    // Weissman score (after Silicon Valley's compression metric): here simply raw bytes in / bytes handed to the model
    s.weissman = t.returned_bytes ? +(t.raw_bytes / t.returned_bytes).toFixed(1) : null;
    s.est_tokens_saved = Math.round((t.raw_bytes - t.returned_bytes) / 3.5);
  },
});

export const upsert = (cfg, mutate) => upsertFile(cfg.root, cfg.stats, mutate);

export const toolStat = (s, ref) => (s.tools[ref] ??= { via_middleout: 0, raw_calls: 0, raw_bytes_seen: 0 });

export function summarize(s) {
  const t = s.totals; const kb = (b) => `${Math.round(b / 1024)} KB`;
  const missed = Object.entries(s.tools).filter(([, v]) => v.raw_calls).sort((a, b) => b[1].raw_bytes_seen - a[1].raw_bytes_seen).slice(0, 8);
  return [
    `middleout stats since ${s.since.slice(0, 10)} (updated ${s.updated.slice(0, 16).replace('T', ' ')})`,
    `runs ${t.runs} | API calls through middleout ${t.api_calls} | auto-fetched pages ${t.auto_pages} | errors ${t.errors}`,
    `raw ${kb(t.raw_bytes)} -> returned ${kb(t.returned_bytes)} | Weissman score ${s.weissman ?? '-'} | ~${s.est_tokens_saved} tokens kept out of context`,
    `raw MCP calls that bypassed middleout: ${t.raw_calls_seen} (${kb(t.raw_bytes_seen)}) | nudges ${t.nudges} | gated ${t.gated}`,
    missed.length ? `biggest raw callers (candidates for middleout):\n  ${missed.map(([k, v]) => `${k}: ${v.raw_calls} calls, ${kb(v.raw_bytes_seen)}`).join('\n  ')}` : '',
  ].filter(Boolean).join('\n');
}
