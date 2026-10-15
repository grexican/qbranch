// Scan transcripts: measure every subagent run (model, cost, errors) and judge whether it succeeded.
// A run counts as FAILED when (a) the same task class was dispatched again in the same parent session within 30 minutes
// (a redo), (b) the report it returned to its parent reads as a failure, or (c) most of its tool calls errored.
// Cost per completed task is what matters: a cheap run that needs a redo is not cheaper.
import { sessions, costOf, tierOf, modelId } from '@qbranch/core';
import { db, classify } from './store.mjs';

const FAIL = /\b(could not|couldn't|unable to|failed to|did not complete|blocked( on)?|gave up|not able to|cannot proceed|no access|timed out)\b/i;
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
  const known = new Set(d.prepare('select id from runs').all().map(r => r.id));
  const parentReports = new Map(); // toolUseId -> report text the subagent returned to its parent
  const subs = [];
  for (const s of sessions({ root: allProjects ? null : cfg.root, days })) {
    if (s.kind === 'main') {
      for (const e of s.events()) if (e.t === 'result') parentReports.set(e.id, e.text);
      continue;
    }
    subs.push(s);
  }
  let added = 0;
  const rows = [];
  for (const s of subs) {
    const id = `${s.platform}:${s.id}`;
    if (known.has(id)) continue;
    const models = {}; let cost = 0, calls = 0, toolCalls = 0, toolErrors = 0;
    for (const e of s.events()) {
      if (e.t === 'usage') { const m = modelId(e.model); models[m] = (models[m] || 0) + 1; cost += costOf(e.model, e.usage); calls++; }
      else if (e.t === 'tool') toolCalls++;
      else if (e.t === 'result' && e.isError) toolErrors++;
    }
    if (!calls) continue;
    const model = Object.entries(models).sort((a, b) => b[1] - a[1])[0][0];
    const desc = s.meta.description || '';
    const report = parentReports.get(s.meta.toolUseId) || '';
    rows.push({ id, session: s.parent || s.id, platform: s.platform, agent_type: s.meta.agentType || 'agent', description: desc, model, tier: tierOf(model),
      cost, calls, tool_calls: toolCalls, tool_errors: toolErrors, fail_words: FAIL.test(report.slice(-1500)) ? 1 : 0, mtime: s.mtime });
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
    tool_calls, tool_errors, redo, fail_words, ok, mtime) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  d.exec('begin');
  for (const r of rows) {
    const ok = !r.redo && !r.fail_words && !(r.tool_calls >= 4 && r.tool_errors / r.tool_calls > 0.5) ? 1 : 0;
    ins.run(r.id, r.session, r.platform, r.agent_type, r.description, r.class_id, r.model, r.tier, r.cost, r.calls, r.tool_calls, r.tool_errors, r.redo || 0, r.fail_words, ok, r.mtime);
    added++;
  }
  for (const c of d.prepare('select class_id, count(*) n from runs group by class_id').all()) d.prepare('update classes set n = ? where id = ?').run(c.n, c.class_id);
  d.prepare("insert or replace into meta values ('last_scan', ?)").run(new Date().toISOString());
  d.exec('commit');
  return { scanned: subs.length, added };
}
