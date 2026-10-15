// The hook that makes middleout first-class. Runs on every MCP tool call (input normalized by @utility-belt/core hooks).
//   post: measure raw MCP traffic that bypassed middleout (stats), and nudge when a big raw result came from a wrapped server.
//   pre:  in "gate" mode, deny the first raw call to a wrapped server per session, pointing at middleout_run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { upsert, toolStat } from './stats.mjs';

const parse = (name) => { const m = name.match(/^mcp__(.+?)__(.+)$/); return m ? { server: m[1], tool: m[2] } : null; };

export function post(cfg, h) {
  const t = parse(h.tool || '');
  if (!t || t.server === 'middleout' || /middleout/.test(t.server)) return null;
  const bytes = JSON.stringify(h.response ?? '').length;
  const wrapped = !!cfg.servers[t.server];
  const nudge = cfg.mode !== 'off' && wrapped && bytes > cfg.nudgeBytes;
  upsert(cfg, (s, day) => {
    s.totals.raw_calls_seen++; s.totals.raw_bytes_seen += bytes; day.raw_calls_seen++;
    const k = toolStat(s, `${t.server}.${t.tool}`); k.raw_calls++; k.raw_bytes_seen += bytes;
    if (nudge) s.totals.nudges++;
  });
  if (!nudge) return null;
  return { context:
    `That raw ${t.server}.${t.tool} result was ${Math.round(bytes / 1024)} KB (~${Math.round(bytes / 3.5 / 1000)}k tokens). ` +
    `For the next fetch from ${t.server}, use middleout_run with a "select" (and "each" for per-item calls): it returns only the fields you need and fetches every page.` };
}

export function pre(cfg, h) {
  const t = parse(h.tool || '');
  if (cfg.mode !== 'gate' || !t || !cfg.servers[t.server]) return null;
  const mark = path.join(os.tmpdir(), `middleout-gate-${h.sessionId || 'x'}-${t.server}`);
  if (fs.existsSync(mark)) return null; // deny once per server per session, then allow (never deadlock)
  fs.writeFileSync(mark, '1');
  upsert(cfg, (s) => { s.totals.gated++; });
  return { deny: `Fetch ${t.server} data through middleout_run (select only the fields you need; it handles per-item calls and pagination). ` +
      'If this call writes data or middleout cannot do it, retry it as-is.' };
}
