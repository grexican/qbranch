// Scan transcripts: measure every subagent run (model, cost, errors) and judge whether it succeeded.
// A run counts as FAILED when (a) the same task class was dispatched again in the same parent session within 30 minutes
// (a redo), (b) the report it returned to its parent reads as a failure, or (c) most of its tool calls errored.
// Cost per completed task is what matters: a cheap run that needs a redo is not cheaper.
import path from 'node:path';
import { sessions, costOf, modelId, PRICES } from '@qbranch/core';
import { rung } from './ladder.mjs';
import { db, classify, SCHEMA } from './store.mjs';

const promptTokens = (u) => !u ? 0 : (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
const MAX_CARRY = 50; // parent turns we credit at most: long sessions compact, so context is not carried forever

/**
 * Delegation credit ($): what the parent did NOT pay because the work happened in a subagent. Done inline, the
 * subagent's working context (its peak prompt minus its own startup prompt) would have sat in the parent's context
 * for every later parent turn; delegated, only the report does. Priced at the parent's cache-read rate. A verbose
 * report earns less credit, so a cheaper model that pads its reports is not as cheap as its per-run price.
 */
export function delegationCredit({ startup, peak, report = '', parent }) {
  if (!parent?.model || !startup) return 0;
  const kept = Math.max(0, peak - startup - Math.ceil(report.length / 4));
  return (kept * Math.min(parent.turns, MAX_CARRY) * (PRICES[modelId(parent.model)]?.[3] || 0)) / 1e6;
}

// Parent rework: the parent edits a file the subagent edited within this many of its next tool calls after the report
// came back. The work did not stand, whatever the report said. File keys are normalized (separators; case on win32).
const REWORK_WINDOW = 10;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const fileKey = (p) => { const r = path.resolve(p).replace(/\\/g, '/'); return process.platform === 'win32' ? r.toLowerCase() : r; };
export function editedFile(e) {
  if (!EDIT_TOOLS.has(e.name)) return null;
  const p = e.input?.file_path ?? e.input?.notebook_path ?? e.input?.path;
  return typeof p === 'string' && p ? fileKey(p) : null;
}
// Wall-clock seconds from the first transcript line to the last write. null when unknown or implausible (a transcript
// touched again much later, e.g. a resumed session, would otherwise read as a 3-day run).
const MAX_SECS = 6 * 3600;
const duration = (startMs, endMs) => { const s = (endMs - startMs) / 1000; return Number.isFinite(s) && s >= 0 && s <= MAX_SECS ? Math.round(s) : null; };

// The agent admitting, in its own voice, that it did not do (part of) its task. Measured on 940 real background reports:
// the old bare-phrase list ("failed to", "blocked") fired on 17%, mostly reports ABOUT the product failing (a QA run
// finding bugs) or a sub-step worked around ("X failed to connect, so I used Y"); this fires on 3%, all genuine gaps.
export const FAIL = /\bI (could not|couldn't|was unable to|wasn't able to|am unable to|was not able to|failed to|did not (finish|complete|get to)|didn't (finish|complete|get to)|gave up|ran out of)\b(?![^.\n]{0,100}\b(so I|instead|by using|using)\b)/i;
const REDO_WINDOW_MS = 30 * 60_000;
const words = (t) => new Set(t.toLowerCase().split(/[^a-z0-9#]+/).filter(Boolean));
/** Jaccard >= 0.6 on description words, numbers and ticket ids included (so "QA #12" != "QA #13"). */
export function similar(a, b) {
  const A = words(a), B = words(b); if (!A.size || !B.size) return false;
  const ids = (S) => [...S].filter(w => /\d/.test(w)).sort().join();
  if (ids(A) !== ids(B)) return false; // different ticket / item ids: a batch, not a redo
  let i = 0; for (const w of A) if (B.has(w)) i++;
  return i / (A.size + B.size - i) >= 0.6;
}

export async function scan(cfg, { days = cfg.days, allProjects = false, onProgress } = {}) {
  const d = db(cfg);
  const known = new Set(d.prepare('select id from runs where measured_by >= ?').all(SCHEMA).map(r => r.id));
  const parentReports = new Map(); // toolUseId -> report text the subagent returned to its parent
  const parentAfter = new Map();   // toolUseId -> { turns: parent tool calls after the dispatch, model: the parent's model }
  const parentFailed = new Set();  // toolUseIds whose (late) report came back with a failed/killed status
  const parentEdits = new Map();   // toolUseId -> files the parent edited in the REWORK_WINDOW tool calls after the result came back
  const subs = [];
  for (const s of sessions({ root: allProjects ? null : cfg.root, days })) {
    if (s.kind === 'main') {
      const tools = [], models = {}, files = [], returned = [];
      for (const e of s.events()) {
        if (e.t === 'result') { parentReports.set(e.id, e.text); if (e.late && e.isError) parentFailed.add(e.id); returned.push([e.id, tools.length]); }
        else if (e.t === 'tool') { tools.push(e.id); files.push(editedFile(e)); }
        else if (e.t === 'usage') models[e.model] = (models[e.model] || 0) + 1;
      }
      const model = Object.entries(models).sort((a, b) => b[1] - a[1])[0]?.[0];
      tools.forEach((id, i) => parentAfter.set(id, { turns: tools.length - 1 - i, model }));
      for (const [id, at] of returned) parentEdits.set(id, new Set(files.slice(at, at + REWORK_WINDOW).filter(Boolean)));
      continue;
    }
    subs.push(s);
  }
  let added = 0;
  const rows = [];
  for (const s of subs) {
    const id = `${s.platform}:${s.id}`;
    if (known.has(id)) continue;
    const models = {}; let cost = 0, priced = false, calls = 0, toolCalls = 0, toolErrors = 0, startup = null, peak = 0, startedAt = null;
    const edited = new Set();
    for (const e of s.events()) {
      if (e.t === 'meta') startedAt = Date.parse(e.at);
      if (e.t === 'tool') { const f = editedFile(e); if (f) edited.add(f); }
      if (e.t === 'usage') {
        // usage null = the platform records no tokens (e.g. Cursor bills per request): unpriced, not free
        const m = modelId(e.model); models[m] = (models[m] || 0) + 1; calls++;
        if (e.usage) { cost += costOf(e.model, e.usage); priced = true; }
        if (e.usage) { const ctx = promptTokens(e.usage); startup ??= ctx; peak = Math.max(peak, ctx); }
      }
      else if (e.t === 'tool') toolCalls++;
      else if (e.t === 'result' && e.isError) toolErrors++;
    }
    if (!calls) continue;
    const model = Object.entries(models).sort((a, b) => b[1] - a[1])[0][0];
    const desc = s.meta.description || '';
    const report = parentReports.get(s.meta.toolUseId) || '';
    const after = parentEdits.get(s.meta.toolUseId);
    const rework = after && [...edited].some(f => after.has(f)) ? 1 : 0;
    rows.push({ secs: duration(startedAt, s.mtime), rework, id, session: s.parent || s.id, platform: s.platform, agent_type: s.meta.agentType || 'agent', description: desc, model, tier: rung(model).key,
      cost: priced ? cost : null, calls, tool_calls: toolCalls, tool_errors: toolErrors, fail_words: FAIL.test(report.slice(-1500)) || parentFailed.has(s.meta.toolUseId) ? 1 : 0, mtime: s.mtime,
      startup_tokens: startup || 0, credit: delegationCredit({ startup, peak, report, parent: parentAfter.get(s.meta.toolUseId) }) });
    onProgress?.(rows.length);
  }
  for (const r of rows) r.class_id = classify(cfg, r.agent_type, r.description);
  // redo detection: same class, same parent session, a near-identical description, dispatched again within the window.
  // Classes are coarse (verb level), so "QA #12" then "QA #13" is a batch, not a redo: the descriptions must match too.
  const bySession = new Map();
  for (const r of rows) { const k = `${r.session}|${r.class_id}`; (bySession.get(k) || bySession.set(k, []).get(k)).push(r); }
  for (const list of bySession.values()) {
    list.sort((a, b) => a.mtime - b.mtime);
    list.forEach((r, i) => { r.redo = list.slice(i + 1).some(n => n.mtime - r.mtime < REDO_WINDOW_MS && similar(r.description, n.description)) ? 1 : 0; });
  }
  const ins = d.prepare(`insert or replace into runs (id, session, platform, agent_type, description, class_id, model, tier, cost, calls,
    tool_calls, tool_errors, redo, fail_words, ok, mtime, startup_tokens, credit, secs, rework, measured_by) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  d.exec('begin');
  // rows indexed before the cross-vendor ladder carry the old Claude-only tier: re-key them from their model
  for (const x of d.prepare('select id, model, tier from runs').all()) { const k = rung(x.model).key; if (k !== x.tier) d.prepare('update runs set tier = ? where id = ?').run(k, x.id); }
  // rows indexed under an older class-key rule move to today's key (the description is stored, so no transcript is needed)
  const rekey = d.prepare('update runs set class_id = ? where id = ?');
  for (const x of d.prepare('select id, agent_type, description, class_id from runs').all()) { const c = classify(cfg, x.agent_type, x.description); if (c !== x.class_id) rekey.run(c, x.id); }
  for (const r of rows) {
    const ok = !r.redo && !r.fail_words && !r.rework && !(r.tool_calls >= 4 && r.tool_errors / r.tool_calls > 0.5) ? 1 : 0;
    ins.run(r.id, r.session, r.platform, r.agent_type, r.description, r.class_id, r.model, r.tier, r.cost, r.calls, r.tool_calls, r.tool_errors, r.redo || 0, r.fail_words, ok, r.mtime,
      r.startup_tokens, r.credit, r.secs, r.rework, SCHEMA);
    added++;
  }
  d.exec('update classes set n = (select count(*) from runs where runs.class_id = classes.id)');
  d.prepare("insert or replace into meta values ('last_scan', ?)").run(new Date().toISOString());
  d.exec('commit');
  return { scanned: subs.length, added };
}
