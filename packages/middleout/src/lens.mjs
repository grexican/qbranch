// The lens: middleout without a second connection. The model calls the MCP tool it was going to call anyway, through
// the harness's own connection and sign-in; the hooks shape what comes back before the model sees it.
//   _middleout sidecar  an extra argument on any MCP call: {select, then, page, pages, each, continue, slot} (an object,
//                       a JSON string, which models often send, or a bare JMESPath string meaning select). PreToolUse
//                       strips it so the server never sees it; PostToolUse applies it to the real result.
//   pagination          when the result says there is more, each page is stored and replaced by a one-line instruction
//                       to call again with the next-page argument; the last page returns everything merged and selected
//   fan-out (each)      the selected array is turned into a list of per-item calls the model issues (in parallel is
//                       fine), each carrying a slot; the call that completes the set returns the assembled result
//   auto-compaction     no sidecar, a big JSON result: empty fields dropped, long strings trimmed, record arrays packed;
//                       the full raw result is saved to a file whose path is in the reply, so nothing is lost
// Only where the platform can rewrite a tool result (core canRewriteOutput); elsewhere middleout_run stays the path.
// Hooks never throw: every failure leaves the native result untouched. Nothing is altered silently: a failed page or
// per-item call, a repeated page, a cap, and integers too big for a JS number are all said out loud.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import jmespath from 'jmespath';
import { canRewriteOutput, canStripInput, inputRewriteApproves } from '@qbranch/core/hooks';
import { findItems, nextRequest, getAt, setAt } from './paginate.mjs';

const SIDE = '_middleout';
const MAX_FANOUT = 50;
const SIDE_TTL_MS = 60_000;           // a stored sidecar older than this belongs to some other, long-gone call
const STATE_TTL_MS = 2 * 864e5;       // continuation / fan-out state and saved raw results
const MAX_RAW = 50;                   // saved raw results kept per session (newest win)
const kb = (n) => (n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

// Where a rewrite of the arguments also approves the call (Cursor, Codex, Copilot), a sidecar may only ride on a read:
// otherwise an injected "_middleout" would turn a write (or a SQL run, a browser click) into an unprompted approval.
// The verb leads the tool name, optionally after one prefix segment (browser_get_text, tracker_list_tasks).
const READ = /^(get|list|search|find|fetch|read|describe|lookup|count|show|filter|retrieve|view|browse)$/i; // not "query": SQL
const segs = (tool) => String(tool).replace(/([a-z0-9])([A-Z])/g, '$1_$2').split(/[_\-.]+/).filter(Boolean);
export const isRead = (tool) => { const s = segs(tool); return READ.test(s[0] || '') || (s.length >= 2 && READ.test(s[1])); };

// ---------- per-user, per-session state ----------
const me = () => {
  try { if (typeof process.getuid === 'function') return String(process.getuid()); } catch { /* no uid */ }
  try { return os.userInfo().username.replace(/[^\w-]/g, '_') || 'user'; } catch { return 'user'; }
};
/** A directory we may keep raw results in: ours, or (Windows, no uid) inside the per-user temp folder. */
export const ownedByMe = (st) => typeof process.getuid !== 'function' || st.uid === process.getuid();
const DIR = { recursive: true, mode: 0o700 };
function baseDir(cfg) {
  const base = path.join(cfg.lensDir || os.tmpdir(), `middleout-lens-${me()}`);
  if (!fs.existsSync(base)) fs.mkdirSync(base, DIR);
  const st = fs.statSync(base);
  if (!st.isDirectory() || !ownedByMe(st)) throw new Error('lens folder is not ours'); // someone else made it first: no lens
  try { if (process.platform !== 'win32' && (st.mode & 0o077)) fs.chmodSync(base, 0o700); } catch { /* best effort */ }
  return base;
}
const SESSION_RE = /^[\w-]{1,80}$/;
function sessionDir(cfg, h) {
  const base = baseDir(cfg);
  const name = String(h.sessionId || 'nosession').replace(/[^\w-]/g, '_').slice(0, 80);
  const d = path.join(base, name);
  if (!fs.existsSync(d)) {
    fs.mkdirSync(d, DIR);
    // a new session tidies up after old ones, only among the lens's own session folders
    try {
      for (const e of fs.readdirSync(base, { withFileTypes: true })) {
        if (!e.isDirectory() || !SESSION_RE.test(e.name) || e.name === name) continue;
        const p = path.join(base, e.name);
        if (Date.now() - fs.statSync(p).mtimeMs > STATE_TTL_MS) fs.rmSync(p, { recursive: true, force: true });
      }
    } catch { /* best effort */ }
  }
  return d;
}
const OWN_FILE = /^(side-(tu|ak)-[\w-]+|state-[\w-]+|fan-[\w-]+|slot-[\w.-]+|raw-\d+-[0-9a-f]+)\.(json|done)$/;
/** Inside a long session: expire old state by its own mtime and keep only the newest raw results. */
function tidy(d) {
  try {
    const raws = [];
    for (const f of fs.readdirSync(d)) {
      if (!OWN_FILE.test(f)) continue;
      const p = path.join(d, f); const m = fs.statSync(p).mtimeMs;
      if (f.startsWith('raw-')) raws.push([p, m]);
      else if (Date.now() - m > STATE_TTL_MS) fs.rmSync(p, { force: true });
    }
    raws.sort((a, b) => b[1] - a[1]);
    for (const [p] of raws.slice(MAX_RAW)) fs.rmSync(p, { force: true });
  } catch { /* best effort */ }
}

const stable = (v) => (Array.isArray(v) ? `[${v.map(stable).join(',')}]` : v && typeof v === 'object'
  ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}` : JSON.stringify(v));
// keyed by the bare tool name: Cursor's postToolUse carries no server name, so the pre and post names can differ
const bareTool = (tool) => String(tool || '').match(/^mcp__.+?__(.+)$/)?.[1] || String(tool || '');
const argsKey = (tool, args) => crypto.createHash('sha1').update(`${bareTool(tool)}\n${stable(args || {})}`).digest('hex').slice(0, 16);
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const writeJson = (f, v) => { const tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(v), { mode: 0o600 }); fs.renameSync(tmp, f); };
const toolUseId = (h) => h.raw?.tool_use_id || h.raw?.toolUseId || h.raw?.tool_call_id || null;
const safeId = (s) => String(s).replace(/[^\w-]/g, '_');

/** The sidecar in any form a model sends it: object, JSON string, or a bare JMESPath string (= select). */
export function parseSidecar(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t.startsWith('{')) { try { const o = JSON.parse(t); if (o && typeof o === 'object') return o; } catch { /* not JSON */ } }
    if (t) return { select: t };
  }
  return null;
}

/**
 * JSON.parse without losing integers beyond 2^53 (ids from many APIs are 64-bit): such a number is kept as a string of
 * its exact digits, and the count is returned so the reply can say so.
 */
export function parseLossless(text) {
  let out = '', big = 0, i = 0, inStr = false, last = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inStr) { if (ch === '\\') { i += 2; continue; } if (ch === '"') inStr = false; i++; continue; }
    if (ch === '"') { inStr = true; i++; continue; }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let j = i + 1;
      while (j < text.length && text[j] >= '0' && text[j] <= '9') j++;
      const tok = text.slice(i, j);
      if (tok.replace('-', '').length >= 16 && !/[.eE]/.test(text[j] || '') && !Number.isSafeInteger(Number(tok))) {
        out += `${text.slice(last, i)}"${tok}"`; last = j; big++;
      }
      i = j; continue;
    }
    i++;
  }
  return { value: JSON.parse(big ? out + text.slice(last) : text), big };
}
const bigNote = (big) => (big ? [`${big} integer${big === 1 ? '' : 's'} beyond 2^53 kept as strings (exact digits)`] : []);

/** Text, binary and error flags of a tool response, whatever shape the platform hands it over in. */
export function responseOf(r) {
  const blocks = (arr) => ({ text: arr.map(x => (typeof x === 'string' ? x : x?.text || '')).join(''), binary: arr.some(x => x && /^(image|audio|resource|blob)$/.test(x.type)) });
  if (r == null) return { text: '', binary: false, error: false };
  if (typeof r === 'string') {
    // Cursor hands over the JSON-stringified MCP result; unwrap it when it is one
    if (r.startsWith('{') && r.includes('"content"')) { try { const o = JSON.parse(r); if (Array.isArray(o.content)) return { ...blocks(o.content), error: !!o.isError }; } catch { /* plain text */ } }
    return { text: r, binary: false, error: false };
  }
  if (Array.isArray(r)) return { ...blocks(r), error: false };
  if (Array.isArray(r.content)) return { ...blocks(r.content), error: !!r.isError };
  if (typeof r.textResultForLlm === 'string') return { text: r.textResultForLlm, binary: false, error: r.resultType && r.resultType !== 'success' };
  if (typeof r.output === 'string') return { text: r.output, binary: false, error: false };
  return { text: JSON.stringify(r), binary: false, error: !!r.isError };
}

// {{expr}} templates against an item (and {{_parent.x}}); a whole-string template keeps its type
function fill(v, scope) {
  if (typeof v === 'string') {
    const whole = v.match(/^\{\{\s*(.+?)\s*\}\}$/);
    if (whole) return jmespath.search(scope, whole[1]);
    return v.replace(/\{\{\s*(.+?)\s*\}\}/g, (_, e) => String(jmespath.search(scope, e) ?? ''));
  }
  if (Array.isArray(v)) return v.map(x => fill(x, scope));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, scope)]));
  return v;
}

// ---------- PreToolUse ----------
/** Strip the sidecar so the server never sees it, and remember it for PostToolUse. */
export function lensPre(cfg, h) {
  if (!cfg.lens || !canStripInput(h.platform) || !canRewriteOutput(h.platform)) return null;
  const input = h.input || {};
  if (!(SIDE in input)) return null;
  const side = parseSidecar(input[SIDE]);
  if (!side) return null; // an unusable sidecar is never a reason to rewrite (and so approve) a call
  const tool = bareTool(h.tool);
  if (inputRewriteApproves(h.platform) && !isRead(tool)) {
    return { deny: `${tool}: call again without ${SIDE} (it cannot be used on this tool here; it only shapes what read tools return).` };
  }
  const { [SIDE]: _drop, ...rest } = input;
  const d = sessionDir(cfg, h);
  const rec = { side, tool: h.tool, at: Date.now() };
  const id = toolUseId(h);
  // the args key is only the fallback for platforms that carry no call id: with an id it could pair the wrong call
  writeJson(path.join(d, id ? `side-tu-${safeId(id)}.json` : `side-ak-${argsKey(h.tool, rest)}.json`), rec);
  return { updatedInput: rest, keepPermission: true };
}

function takeSide(cfg, h) {
  const d = sessionDir(cfg, h);
  const id = toolUseId(h);
  const f = path.join(d, id ? `side-tu-${safeId(id)}.json` : `side-ak-${argsKey(h.tool, h.input)}.json`);
  const rec = readJson(f);
  if (rec) fs.rmSync(f, { force: true });
  if (!rec || Date.now() - (rec.at || 0) > SIDE_TTL_MS) return null;
  return { side: rec.side, tool: rec.tool };
}

// ---------- PostToolUse ----------
/** Returns { updatedOutput, stat } or null (leave the native result alone). */
export function lensPost(cfg, h) {
  if (!cfg.lens || !canRewriteOutput(h.platform)) return null;
  const r = responseOf(h.response);
  const taken = takeSide(cfg, h); // always consumed first: a sidecar must never outlive its own call
  if (taken) {
    const { side } = taken;
    const ctx = { ...h, tool: called(h.tool, taken.tool) };
    const d = sessionDir(cfg, h);
    let v, big = 0, err = null;
    if (r.error) err = `error: ${r.text.slice(0, 300)}`;
    else if (r.binary) err = 'a binary result (image or file)';
    else if (!r.text) err = 'an empty result';
    else { try { ({ value: v, big } = parseLossless(r.text)); } catch { err = `not JSON: ${r.text.slice(0, 300)}`; } }
    if (side.continue && side.slot != null) return child(cfg, ctx, d, side, v, r.text.length, err, big);
    if (side.continue) return nextPage(cfg, ctx, d, side, v, r.text.length, err, big);
    if (err) return null; // a first call that failed: the native error is what the model should see
    return firstCall(cfg, ctx, d, side, v, r.text.length, big);
  }
  if (r.binary || r.error || !r.text) return null;
  if (r.text.length > cfg.nudgeBytes) return compactResult(cfg, h, r.text);
  return null;
}

// The name the model called: Cursor's post event has no server ("mcp__mcp__x"), the pre event may have had it.
const called = (postTool, preTool) => (/^mcp__mcp__/.test(String(postTool)) && preTool && !/^mcp__mcp__/.test(String(preTool)) ? preTool : postTool);
const shortName = (tool) => { const m = String(tool).match(/^mcp__(.+?)__(.+)$/); return !m ? String(tool) : m[1] === 'mcp' ? m[2] : `${m[1]}.${m[2]}`; };
const sameServerTool = (h, ref) => {
  if (String(ref).startsWith('mcp__')) return ref;
  if (String(ref).includes('.')) { const [srv, t] = String(ref).split(/\.(.*)/s); return `mcp__${srv}__${t}`; }
  const m = String(h.tool).match(/^mcp__(.+?)__(.+)$/);
  if (!m || m[1] === 'mcp') return String(ref); // server unknown (Cursor): name the tool as the model knows it
  return `mcp__${m[1]}__${ref}`; // same server as the call the sidecar rode on
};

function finish(h, side, value, { rawBytes, pages = 1, notes = [] }) {
  let out = value;
  try { if (side.select) out = jmespath.search(out, String(side.select)); } catch (e) { notes.push(`select failed: ${e.message}`); }
  try { if (side.then && !side.each) out = jmespath.search(out, String(side.then)); } catch (e) { notes.push(`then failed: ${e.message}`); }
  const body = JSON.stringify(out ?? null);
  const info = notes.filter(n => /kept as strings/.test(n));
  const gaps = notes.filter(n => !/kept as strings/.test(n));
  const foot = `(middleout: ${pages > 1 ? `${pages} pages merged, ` : ''}${kb(rawBytes)} raw -> ${kb(body.length)}${info.length ? `; ${info.join('; ')}` : ''})`;
  return { updatedOutput: `${body}\n${foot}${gaps.length ? `\nINCOMPLETE: ${gaps.join('; ')}` : ''}`, stat: { rawBytes, returnedBytes: body.length, pages } };
}

function continuation(h, d, state, n) {
  const id = state.id;
  writeJson(path.join(d, `state-${id}.json`), state);
  const add = Object.fromEntries(Object.entries(n.args).filter(([k, v]) => stable(h.input?.[k]) !== stable(v)));
  return {
    updatedOutput: `middleout: page ${state.pages} of ${shortName(h.tool)} stored (${state.items.length} items so far). ` +
      `Call ${shortName(h.tool)} again now with the same arguments plus ${JSON.stringify({ ...add, [SIDE]: { continue: id } })}. ` +
      'Do not answer yet: the merged result comes back with the last page.',
    stat: { rawBytes: state.rawBytes, returnedBytes: 0, pages: 0, pending: true },
  };
}

function firstCall(cfg, h, d, side, v, rawBytes, big) {
  tidy(d);
  const notes = bigNote(big);
  const at = side.page === false ? null : findItems(v);
  if (at !== null) {
    const items = getAt(v, at) || [];
    const n = nextRequest(v, h.input || {}, null, items);
    if (n.args && items.length) {
      const state = { id: crypto.randomBytes(6).toString('hex'), tool: h.tool, at, first: v, items: [...items], pages: 1, side, rawBytes,
        max: Number(side.pages) || 50, fp: stable(items[0] ?? null), big, args: h.input || {} };
      return continuation(h, d, state, n);
    }
    if (n.stop === 'no-param') notes.push(`the result says there is more, but which argument asks for the next page is unclear (${n.style}); fetch further pages yourself`);
  }
  return withEach(cfg, h, d, side, v, { rawBytes, notes, parentArgs: h.input || {} });
}

function nextPage(cfg, h, d, side, v, rawBytes, err, big) {
  const f = path.join(d, `state-${safeId(side.continue)}.json`);
  const state = readJson(f);
  if (!state) {
    if (err) return null;
    return { updatedOutput: `middleout: continuation "${side.continue}" is unknown or expired; the result below is this page only.\n${JSON.stringify(v)}`, stat: { rawBytes, returnedBytes: rawBytes, pages: 1 } };
  }
  const pageNo = state.pages + 1;
  const notes = [];
  state.rawBytes += rawBytes;
  state.big = (state.big || 0) + (big || 0);
  let more = null;
  if (err) notes.push(`page ${pageNo} failed: ${err}`);
  else {
    const page = getAt(v, state.at);
    if (!Array.isArray(page)) notes.push(`page ${pageNo} had no item list where page 1 had one; stopped`);
    else if (page.length && stable(page[0]) === state.fp) notes.push(`page ${pageNo} repeated the previous page (the server ignored the next-page argument); stopped`);
    else if (page.length) {
      state.items.push(...page); state.pages++; state.fp = stable(page[0]);
      const n = nextRequest(v, h.input || {}, null, page);
      if (n.args) { if (state.pages < state.max) more = n; else notes.push(`stopped at ${state.pages} pages (more exist; set "pages" higher)`); }
      else if (n.stop === 'no-param') notes.push(`the result says there is more, but which argument asks for the next page is unclear (${n.style})`);
    }
  }
  if (more) return continuation(h, d, state, more);
  fs.rmSync(f, { force: true });
  return withEach(cfg, h, d, state.side, setAt(state.first, state.at, state.items),
    { rawBytes: state.rawBytes, pages: state.pages, notes: [...bigNote(state.big), ...notes], parentArgs: state.args || {} });
}

// ---------- fan-out ----------
function withEach(cfg, h, d, side, value, meta) {
  if (!side.each) return finish(h, side, value, meta);
  let arr;
  try { arr = side.select ? jmespath.search(value, String(side.select)) : value; } catch (e) { return finish(h, { ...side, each: null }, value, { ...meta, notes: [...(meta.notes || []), `select failed: ${e.message}`] }); }
  if (!Array.isArray(arr)) return finish(h, { ...side, each: null }, value, { ...meta, notes: [...(meta.notes || []), '"each" needs the selected value to be an array'] });
  const notes = [...(meta.notes || [])];
  if (arr.length > MAX_FANOUT) { notes.push(`fan-out limited to the first ${MAX_FANOUT} of ${arr.length} items`); arr = arr.slice(0, MAX_FANOUT); }
  const kids = [].concat(side.each);
  if (!arr.length) return finish(h, { then: side.then }, [], { ...meta, notes });
  const id = crypto.randomBytes(6).toString('hex');
  const calls = [];
  arr.forEach((el, i) => kids.forEach((k, j) => {
    // {{field}} is the item's field, {{_parent.x}} the arguments of the call that produced the list (as in middleout_run)
    const scope = { ...(el && typeof el === 'object' ? el : { value: el }), _parent: meta.parentArgs || {} };
    const args = fill(k.args || {}, scope);
    calls.push({ tool: sameServerTool(h, k.tool), slot: `${i}.${j}`, args: { ...args, [SIDE]: { continue: id, slot: `${i}.${j}`, ...(k.select ? { select: k.select } : {}) } } });
  }));
  writeJson(path.join(d, `fan-${id}.json`), { id, parent: arr, kids: kids.map(k => ({ as: k.as || 'children' })), slots: calls.map(c => c.slot),
    expected: calls.length, then: side.then || null, notes, rawBytes: meta.rawBytes, at: Date.now() });
  return {
    updatedOutput: `middleout: ${calls.length} follow-up call${calls.length === 1 ? '' : 's'} needed. Issue all of them now (in parallel is fine), exactly as given, ` +
      `then wait: the call that completes the set returns the assembled result.\n${calls.map(c => `- ${c.tool} ${JSON.stringify(c.args)}`).join('\n')}`,
    stat: { rawBytes: meta.rawBytes, returnedBytes: 0, pages: 0, pending: true, fanout: calls.length },
  };
}

function child(cfg, h, d, side, v, rawBytes, err, big) {
  const id = safeId(side.continue);
  const fan = readJson(path.join(d, `fan-${id}.json`));
  if (!fan) return null;
  const slot = String(side.slot);
  const slots = fan.slots || [];
  // only the slots this fan-out handed out count toward completion: an invented slot is ignored, not stored
  if (!slots.includes(slot)) return err ? null : { updatedOutput: `middleout: slot "${slot}" is not part of this fan-out; result below unchanged.\n${JSON.stringify(v)}`, stat: { rawBytes, returnedBytes: rawBytes, pages: 1 } };
  let rec;
  if (err) rec = { val: { error: err }, rawBytes, more: 0, failed: 1 };
  else {
    let val = v;
    try { if (side.select) val = jmespath.search(v, String(side.select)); } catch { /* keep the whole child result */ }
    // a child result that has more pages is noted, not chased: the assembled result says so
    const at = findItems(v); const more = at !== null && nextRequest(v, h.input || {}, null, getAt(v, at) || []).args ? 1 : 0;
    rec = { val, rawBytes, more, big: big || 0 };
  }
  writeJson(path.join(d, `slot-${id}-${slot.replace(/[^\w.-]/g, '_')}.json`), rec);
  const have = new Set(fs.readdirSync(d).filter(f => f.startsWith(`slot-${id}-`) && f.endsWith('.json')).map(f => f.slice(`slot-${id}-`.length, -5)));
  const done = slots.filter(s => have.has(s.replace(/[^\w.-]/g, '_'))).length;
  if (done < fan.expected) return { updatedOutput: `middleout: ${done}/${fan.expected} stored. Issue any remaining calls; the assembled result comes back with the last one.`, stat: { rawBytes, returnedBytes: 0, pages: 0, pending: true } };
  try { fs.writeFileSync(path.join(d, `fan-${id}.done`), '1', { flag: 'wx', mode: 0o600 }); } catch {
    return { updatedOutput: `middleout: ${fan.expected}/${fan.expected} stored; another call returned the assembled result.`, stat: { rawBytes, returnedBytes: 0, pages: 0, pending: true } };
  }
  let raw = fan.rawBytes || 0, moreN = 0, failed = 0, missing = 0, bigN = 0, firstErr = '';
  const assembled = fan.parent.map((el, i) => {
    const o = el && typeof el === 'object' ? { ...el } : { value: el };
    fan.kids.forEach((k, j) => {
      const s = readJson(path.join(d, `slot-${id}-${i}.${j}.json`));
      if (!s) missing++;
      if (s?.failed) { failed++; firstErr ||= s.val?.error || ''; }
      o[k.as] = s?.val ?? null; raw += s?.rawBytes || 0; moreN += s?.more || 0; bigN += s?.big || 0;
    });
    return o;
  });
  const notes = [...bigNote(bigN), ...(fan.notes || [])];
  if (failed) notes.push(`${failed} of ${fan.expected} per-item calls failed (their entries hold {"error": ...}; first: ${firstErr.slice(0, 160)})`);
  if (missing) notes.push(`${missing} of ${fan.expected} per-item results are missing (null)`);
  if (moreN) notes.push(`${moreN} per-item result${moreN === 1 ? '' : 's'} had more pages that were not fetched`);
  for (const f of fs.readdirSync(d)) if (f.startsWith(`slot-${id}-`) || f.startsWith(`fan-${id}.`)) fs.rmSync(path.join(d, f), { force: true });
  const out = finish(h, { then: fan.then }, assembled, { rawBytes: raw, notes });
  out.stat.fanout = fan.expected;
  return out;
}

// ---------- auto-compaction ----------
const LONG = 400, KEEP = 300;
const empty = (v) => v == null || v === '' || (Array.isArray(v) && !v.length) || (v && typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);
/**
 * Drop empty fields, pack arrays of like records into {_same, _cols, _rows}, and trim long strings ONLY inside such
 * lists (a description repeated per task is bulk; the body of a single page the agent asked to read is the point).
 */
export function compact(v, stats = { packed: 0, trimmed: 0 }, inList = false) {
  if (typeof v === 'string') { if (inList && v.length > LONG) { stats.trimmed = (stats.trimmed || 0) + 1; return `${v.slice(0, KEEP)}…[+${v.length - KEEP} chars]`; } return v; }
  if (Array.isArray(v)) {
    const arr = v.map(x => compact(x, stats, inList || v.length >= 4));
    const objs = arr.length >= 4 && arr.every(x => x && typeof x === 'object' && !Array.isArray(x));
    if (objs) {
      const cols = [...new Set(arr.flatMap(Object.keys))];
      const avg = arr.reduce((a, x) => a + Object.keys(x).length, 0) / arr.length;
      if (cols.length && cols.length <= avg * 1.5) {
        stats.packed = (stats.packed || 0) + 1;
        // a column with the same value in every record (an audit block, a default) is stated once, not per row
        const same = {};
        for (const c of cols) { const first = stable(arr[0][c] ?? null); if (arr.every(x => stable(x[c] ?? null) === first)) same[c] = arr[0][c] ?? null; }
        const vary = cols.filter(c => !(c in same));
        return { ...(Object.keys(same).length ? { _same: same } : {}), _cols: vary, _rows: arr.map(x => vary.map(c => (c in x ? x[c] : null))) };
      }
    }
    return arr;
  }
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) { const c = compact(x, stats, inList); if (!empty(c)) out[k] = c; }
    return out;
  }
  return v;
}

function compactResult(cfg, h, text) {
  let v, big; try { ({ value: v, big } = parseLossless(text)); } catch { return null; } // plain text is left alone
  const st = { packed: 0, trimmed: 0 };
  const body = JSON.stringify(compact(v, st));
  if (body.length > text.length * 0.8) return null; // not worth a rewrite
  const d = sessionDir(cfg, h);
  const file = path.join(d, `raw-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.json`);
  fs.writeFileSync(file, text, { mode: 0o600 });
  tidy(d);
  const how = ['empty fields dropped', st.trimmed && 'long strings trimmed', st.packed && 'record arrays packed as _cols/_rows (_same: values every record shares)', ...bigNote(big)].filter(Boolean).join(', ');
  return {
    updatedOutput: `${body}\n(middleout: compacted ${kb(text.length)} -> ${kb(body.length)}: ${how}. Full result: ${file.split(path.sep).join('/')} ` +
      `(read it if you need more), or call again with "${SIDE}": {"select": "<JMESPath>"} for exactly the fields you need.)`,
    stat: { rawBytes: text.length, returnedBytes: body.length, pages: 1, compacted: true },
  };
}
