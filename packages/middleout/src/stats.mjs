// Lite usage stats, upserted into a dotfile at the project root (default .middleout-stats.json).
// Answers "is middleout worth it?": what it kept out of context, how much of the traffic it could handle went through
// it, whether its nudges work, and what still bypasses it (split so screenshots and writes never count as misses).
import { createStats } from '@qbranch/core';
import { maybeNeedsLogin, loginCommand } from './oauth.mjs';
import { scrub } from './config.mjs';

export const CLASSES = ['addressable', 'unwrapped', 'binary', 'write'];

const upsertFile = createStats({
  tool: 'middleout',
  fresh: () => ({
    totals: { runs: 0, api_calls: 0, raw_bytes: 0, returned_bytes: 0, auto_pages: 0, errors: 0,
      raw_calls_seen: 0, raw_bytes_seen: 0, nudges: 0, nudges_tracked: 0, nudges_converted: 0, gated: 0,
      // the lens: native calls whose result the hooks shaped (lens_pages / lens_fanouts count the continuation steps)
      lens_calls: 0, lens_raw_bytes: 0, lens_returned_bytes: 0, lens_pages: 0, lens_fanouts: 0, lens_compactions: 0 },
    // nudges_tracked: nudges since conversion tracking began (v0.3); older nudges cannot be matched to a conversion
    // "server.tool" -> through middleout: via_middleout (API calls), runs, raw_bytes, returned_bytes;
    //                  bypassing it: raw_calls, raw_bytes_seen, class (addressable | unwrapped | binary | write)
    tools: {},
    bypass: {},        // derived: class -> { calls, bytes } over the tools map
    recent_errors: [], // last 10 failed runs: { at, message, tools }
  }),
  dayFresh: () => ({ runs: 0, raw_bytes: 0, returned_bytes: 0, raw_calls_seen: 0 }),
  derive: (s) => {
    const t = s.totals;
    // Weissman score (after Silicon Valley's compression metric): here simply raw bytes in / bytes handed to the model
    const raw = t.raw_bytes + (t.lens_raw_bytes || 0), ret = t.returned_bytes + (t.lens_returned_bytes || 0);
    s.weissman = ret ? +(raw / ret).toFixed(1) : null;
    s.est_tokens_saved = Math.round((raw - ret) / 3.5);
    s.bypass = {};
    for (const v of Object.values(s.tools)) if (v.raw_calls) {
      const b = (s.bypass[v.class || 'unclassified'] ??= { calls: 0, bytes: 0 }); b.calls += v.raw_calls; b.bytes += v.raw_bytes_seen || 0;
    }
    s.recent_errors = (s.recent_errors || []).slice(-10);
  },
});

export const upsert = (cfg, mutate) => upsertFile(cfg.root, cfg.stats, mutate);

const TOOL_FRESH = () => ({ via_middleout: 0, runs: 0, raw_bytes: 0, returned_bytes: 0, raw_calls: 0, raw_bytes_seen: 0, lens_calls: 0, lens_raw: 0, lens_returned: 0 });
export const toolStat = (s, ref) => (s.tools[ref] = { ...TOOL_FRESH(), ...s.tools[ref] });

/** Record one middleout run (or failure). st = engine stats {calls, rawBytes, autoPages, byTool: {ref: {calls, rawBytes}}, returnedBytes}. */
export function recordRun(cfg, st, { ok = true, error = null, tools = [] } = {}) {
  upsert(cfg, (s, day) => {
    s.totals.runs++; day.runs++;
    s.totals.api_calls += st.calls || 0; s.totals.auto_pages += st.autoPages || 0;
    s.totals.raw_bytes += st.rawBytes || 0; day.raw_bytes += st.rawBytes || 0;
    s.totals.returned_bytes += st.returnedBytes || 0; day.returned_bytes += st.returnedBytes || 0;
    const refs = Object.entries(st.byTool || {});
    for (const [ref, b] of refs) {
      const k = toolStat(s, ref);
      k.via_middleout += b.calls; k.runs++; k.raw_bytes += b.rawBytes;
      // a run returns one result: share its bytes out in proportion to what each tool contributed raw
      k.returned_bytes += Math.round((st.returnedBytes || 0) * (st.rawBytes ? b.rawBytes / st.rawBytes : 1 / refs.length));
    }
    if (!ok) {
      s.totals.errors++;
      // the engine scrubs its own errors; scrub again here, since this file sits at the project root and may get committed
      s.recent_errors.push({ at: new Date().toISOString(), message: scrub(error || 'unknown error').slice(0, 300), tools });
    }
  });
}

// Tool names that change things: never a middleout candidate, whatever server they come from.
// The verb must LEAD the tool name, optionally after one prefix segment ("tracker_create_task"), so a read of a
// write-ish noun ("get_post", "list_posts", "search_messages") is not a write.
export const WRITE = /^(create|update|delete|add|remove|set|send|post|put|patch|move|merge|start|stop|attach|upsert|insert|edit|write|archive|unarchive|close|cancel|assign|react|share|trash|upload|publish|approve|respond|click|type|navigate|submit|execute|exec|run|eval|evaluate|drop|truncate|kill|deploy|invoke)$/i;
const VERB = /^(get|list|search|find|fetch|read|describe|lookup|count|show|filter|retrieve|view|browse|query)$/i;
export const isWrite = (tool) => {
  const seg = String(tool).replace(/([a-z0-9])([A-Z])/g, '$1_$2').split(/[_\-.]+/).filter(Boolean);
  if (WRITE.test(seg[0] || '')) return true;
  // a leading read verb settles it ("get_type" is a read); otherwise the first segment may be a prefix ("browser_click")
  return !VERB.test(seg[0] || '') && seg.length >= 2 && WRITE.test(seg[1]);
};
const BINARY_NAME = /(^|[_\-.])(screenshot|computer|image|capture|snapshot)([_\-.]|$)/i; // pre-v0.3 entries only: newer ones look at the payload
export const norm = (name) => String(name).replace(/[^A-Za-z0-9]/g, '_').toLowerCase();
export const isWrapped = (cfg, server) => Object.keys(cfg?.servers || {}).some(n => norm(n) === norm(server));

/** Class of a tools entry; entries recorded before the split are classified by name (and cfg, when given). */
function classOf(ref, v, cfg) {
  if (v.class) return v.class;
  const [server, tool = ''] = ref.split(/\.(.*)/s);
  if (isWrite(tool)) return 'write';
  if (BINARY_NAME.test(tool)) return 'binary';
  if (!cfg) return 'unclassified';
  return isWrapped(cfg, server) ? 'addressable' : 'unwrapped';
}

const size = (b) => (b >= 1024 * 1024 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);
const thou = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '-');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Human summary. Pass cfg to classify entries written by older versions (wrapped vs not). */
export function summarize(s, cfg = null) {
  const t = s.totals;
  const tools = Object.entries(s.tools || {});
  const by = { addressable: [], unwrapped: [], binary: [], write: [], unclassified: [] };
  for (const [ref, v] of tools) if (v.raw_calls) by[classOf(ref, v, cfg)]?.push([ref, v]);
  const sum = (list) => list.reduce((a, [, v]) => a + (v.raw_bytes_seen || 0), 0);
  const calls = (list) => list.reduce((a, [, v]) => a + v.raw_calls, 0);
  const top = (list, n = 5) => [...list].sort((a, b) => b[1].raw_bytes_seen - a[1].raw_bytes_seen).slice(0, n)
    .map(([k, v]) => `    ${k}: ${plural(v.raw_calls, 'call')}, ${size(v.raw_bytes_seen)}`).join('\n');
  const addrBytes = sum(by.addressable);
  const day = (iso) => iso.slice(5, 16).replace('T', ' ');

  const lines = [];
  const lensRaw = t.lens_raw_bytes || 0, lensRet = t.lens_returned_bytes || 0;
  lines.push(t.runs || t.lens_calls
    ? `middleout since ${s.since.slice(0, 10)}: ~${thou(s.est_tokens_saved ?? 0)} tokens kept out of context (an upper bound vs. the raw results: ${size(t.raw_bytes + lensRaw)} raw -> ${size(t.returned_bytes + lensRet)} returned, Weissman score ${s.weissman ?? '-'})`
    : `middleout since ${s.since.slice(0, 10)}: not used yet (0 runs)${addrBytes ? `; ${size(addrBytes)} of raw traffic it could have handled went around it` : ''}`);
  const cov = [by.unclassified.length
    ? 'coverage: not measured yet (raw calls recorded before v0.3 are not classified)'
    : `coverage: ${pct(t.raw_bytes + lensRaw, t.raw_bytes + lensRaw + addrBytes)} of the traffic middleout can handle went through it`];
  if (t.nudges_tracked) cov.push(`${t.nudges_converted || 0}/${t.nudges_tracked} nudges converted (${pct(t.nudges_converted || 0, t.nudges_tracked)})`);
  else if (t.nudges) cov.push(`${t.nudges} nudges (conversion not tracked before v0.3)`);
  if (t.gated) cov.push(`gated ${t.gated}`);
  lines.push(cov.join(' | '));
  if (t.lens_calls) lines.push(`lens (native calls shaped in the hooks): ${plural(t.lens_calls, 'call')}, ${size(lensRaw)} -> ${size(lensRet)}` +
    `${t.lens_pages ? ` | ${t.lens_pages} pages ping-ponged` : ''}${t.lens_fanouts ? ` | ${t.lens_fanouts} fan-outs` : ''}${t.lens_compactions ? ` | ${t.lens_compactions} auto-compacted` : ''}`);
  lines.push(`through middleout: ${plural(t.runs, 'run')}, ${t.api_calls} API calls${t.auto_pages ? `, ${t.auto_pages} pages auto-fetched` : ''} | errors ${t.errors}`);

  const via = tools.filter(([, v]) => v.via_middleout).sort((a, b) => (b[1].raw_bytes || 0) - (a[1].raw_bytes || 0));
  if (via.length) {
    const w = Math.max(...via.map(([k]) => k.length));
    lines.push('  per tool:\n' + via.map(([k, v]) => `    ${k.padEnd(w)}  ${v.runs ? `${plural(v.runs, 'run')}, ` : ''}${v.via_middleout} API calls` +
      (v.raw_bytes ? `  ${size(v.raw_bytes)} -> ${size(v.returned_bytes)} (saved ${size(Math.max(0, v.raw_bytes - v.returned_bytes))})` : '  (bytes per tool not recorded before v0.3)')).join('\n'));
  }
  if (by.addressable.length) {
    const login = [...new Set(by.addressable.map(([k]) => k.split('.')[0]))].map(srv => Object.keys(cfg?.servers || {}).find(n => norm(n) === norm(srv)))
      .filter(n => n && maybeNeedsLogin(n, cfg.servers[n]));
    lines.push(`still raw, could go through middleout (${plural(calls(by.addressable), 'call')}, ${size(addrBytes)}):\n${top(by.addressable)}` +
      (login.length ? `\n    (not signed in: ${login.join(', ')}; if a server needs auth, run: ${loginCommand("<server>")})` : ''));
  }
  if (by.unwrapped.length) lines.push(`not wrapped (middleout cannot reach these servers; add them to .mcp.json or "servers"), ${size(sum(by.unwrapped))}:\n${top(by.unwrapped, 3)}`);
  if (by.unclassified.length) lines.push(`raw calls recorded before v0.3 (not classified; \`middleout stats\` in the project classifies them by server):\n${top(by.unclassified, 5)}`);
  const ign = [];
  if (by.write.length) ign.push(`${plural(calls(by.write), 'write')} (${size(sum(by.write))})`);
  if (by.binary.length) ign.push(`${calls(by.binary)} binary results such as screenshots (${size(sum(by.binary))})`);
  if (ign.length) lines.push(`ignored (not middleout's job): ${ign.join(', ')}`);
  const errs = (s.recent_errors || []).slice(-3);
  if (errs.length) lines.push('recent errors:\n' + errs.map(e => `    ${day(e.at)}  ${e.message.slice(0, 160)}`).join('\n'));
  return lines.join('\n');
}
