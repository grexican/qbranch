// The hook that makes middleout first-class. Runs on every MCP tool call (input normalized by @qbranch/core hooks).
//   post: measure raw MCP traffic that bypassed middleout, classified (addressable | unwrapped | binary | write), nudge
//         when a big raw result came from a wrapped server, and count a nudge as converted when the same session next
//         fetches that server through middleout.
//   pre:  in "gate" mode, deny the first raw call to a wrapped server per session, pointing at middleout_run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { upsert, toolStat, isWrite, isWrapped, norm } from './stats.mjs';
import { planTools } from './plan.mjs';
import { maybeNeedsLogin, loginCommand } from './oauth.mjs';
import { lensPre, lensPost, responseOf } from './lens.mjs';
import { canRewriteOutput } from '@qbranch/core/hooks';

const parse = (name) => { const m = name.match(/^mcp__(.+?)__(.+)$/); return m ? { server: m[1], tool: m[2] } : null; };
const srvName = (cfg, server) => Object.keys(cfg.servers || {}).find(n => norm(n) === norm(server)) || server;
const isOurs = (server) => server === 'middleout' || /middleout/.test(server);
const mark = (kind, session, server) => path.join(os.tmpdir(), `middleout-${kind}-${String(session || 'x').replace(/[^\w-]/g, '_')}-${norm(server)}`);

/** Image / audio / blob content anywhere in an MCP result: compressing it is not middleout's job. */
function hasBinary(v, depth = 0) {
  if (!v || typeof v !== 'object' || depth > 4) return false;
  if (Array.isArray(v)) return v.some(x => hasBinary(x, depth + 1));
  if (v.type === 'image' || v.type === 'audio' || typeof v.blob === 'string') return true;
  return Object.values(v).some(x => hasBinary(x, depth + 1));
}

function classify(cfg, t, response) {
  if (hasBinary(response)) return 'binary';
  if (isWrite(t.tool)) return 'write';
  return isWrapped(cfg, t.server) ? 'addressable' : 'unwrapped';
}

/** The text of an MCP tool response, whatever shape the platform hands it over in. */
const responseText = (r) => (typeof r === 'string' ? r : Array.isArray(r) ? r.map(x => x?.text || '').join('')
  : Array.isArray(r?.content) ? r.content.map(x => x?.text || '').join('') : '');

/** A successful middleout call: which servers did it fetch? Converts any pending nudge for them in this session. */
function converted(cfg, h) {
  if (/^\s*middleout error/.test(responseText(h.response))) return null; // a failed attempt is not a conversion
  const input = h.input || {};
  const refs = h.tool.endsWith('middleout_shape') ? [input.tool] : h.tool.endsWith('middleout_run') ? planTools(input.plan) : [];
  const servers = new Set(refs.filter(r => typeof r === 'string').map(r => (r.includes('.') ? r.split('.')[0] : Object.keys(cfg.servers)[0])).filter(Boolean));
  let n = 0;
  for (const srv of servers) { const f = mark('nudge', h.sessionId, srv); if (fs.existsSync(f)) { fs.rmSync(f, { force: true }); n++; } }
  if (n) upsert(cfg, (s) => { s.totals.nudges_converted += n; });
  return null;
}

export function post(cfg, h) {
  const t = parse(h.tool || '');
  if (!t) return null;
  if (isOurs(t.server)) { try { return converted(cfg, h); } catch { return null; } }
  // the lens first: where the platform can rewrite the result, shape it here (sidecar, pagination, fan-out, compaction)
  let lp = null; try { lp = lensPost(cfg, h); } catch { lp = null; }
  if (lp?.updatedOutput != null) {
    const raw = responseOf(h.response).text.length, returned = lp.updatedOutput.length;
    upsert(cfg, (s, day) => {
      s.totals.lens_calls++; s.totals.lens_raw_bytes += raw; s.totals.lens_returned_bytes += returned;
      day.lens_calls = (day.lens_calls || 0) + 1;
      if (lp.stat?.pending && !lp.stat?.fanout) s.totals.lens_pages++;
      if (lp.stat?.fanout && lp.stat?.pending) s.totals.lens_fanouts++;
      if (lp.stat?.compacted) s.totals.lens_compactions++;
      const k = toolStat(s, `${t.server}.${t.tool}`); k.lens_calls++; k.lens_raw += raw; k.lens_returned += returned;
    });
    return { updatedOutput: lp.updatedOutput };
  }
  const bytes = JSON.stringify(h.response ?? '').length;
  const cls = classify(cfg, t, h.response);
  const nudge = cfg.mode !== 'off' && cls === 'addressable' && bytes > cfg.nudgeBytes;
  // one pending mark per session and server: repeated nudges before a conversion are tracked as one opportunity
  let tracked = false;
  if (nudge) { try { fs.writeFileSync(mark('nudge', h.sessionId, t.server), String(Date.now()), { flag: 'wx' }); tracked = true; } catch { /* pending already */ } }
  upsert(cfg, (s, day) => {
    s.totals.raw_calls_seen++; s.totals.raw_bytes_seen += bytes; day.raw_calls_seen++;
    const k = toolStat(s, `${t.server}.${t.tool}`); k.raw_calls++; k.raw_bytes_seen += bytes;
    k.class = k.class === 'binary' ? 'binary' : cls; // a tool that returns images sometimes (a browser) stays out of the misses
    if (nudge) s.totals.nudges++;
    if (tracked) s.totals.nudges_tracked++;
  });
  if (!nudge) return null;
  if (cfg.lens && canRewriteOutput(h.platform)) return { context:
    `That raw ${t.server}.${t.tool} result was ${Math.round(bytes / 1024)} KB (~${Math.round(bytes / 3.5 / 1000)}k tokens). ` +
    'On the next call, add an argument "_middleout": {"select": "<JMESPath>"} to get only the fields you need (middleout strips it before the server sees it, and fetches every page).' };
  return { context:
    `That raw ${t.server}.${t.tool} result was ${Math.round(bytes / 1024)} KB (~${Math.round(bytes / 3.5 / 1000)}k tokens). ` +
    `For the next fetch from ${t.server}, use middleout_run with a "select" (and "each" for per-item calls): it returns only the fields you need and fetches every page.` +
    (maybeNeedsLogin(srvName(cfg, t.server), cfg.servers[srvName(cfg, t.server)]) ? ` If middleout says ${t.server} needs sign-in, ask the user to run \`${loginCommand(srvName(cfg, t.server))}\` once, and fetch raw until then.` : '') };
}

export function pre(cfg, h) {
  const t = parse(h.tool || '');
  if (t && !isOurs(t.server)) { try { const lp = lensPre(cfg, h); if (lp) return lp; } catch { /* leave the call as it is */ } }
  // where the lens can shape results, raw calls are fine: gate only where middleout_run is the only route
  if (cfg.lens && canRewriteOutput(h.platform)) return null;
  if (cfg.mode !== 'gate' || !t || !isWrapped(cfg, t.server) || isWrite(t.tool)) return null;
  const f = mark('gate', h.sessionId, t.server);
  if (fs.existsSync(f)) return null; // deny once per server per session, then allow (never deadlock)
  fs.writeFileSync(f, '1');
  upsert(cfg, (s) => { s.totals.gated++; });
  return { deny: `Fetch ${t.server} data through middleout_run (select only the fields you need; it handles per-item calls and pagination). ` +
      'If this call writes data or middleout cannot do it, retry it as-is.' };
}
