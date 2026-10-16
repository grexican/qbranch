// The lessons ledger (groundhog.lessons.json, committed): things this project's agents keep re-learning, each with
// a command pattern and what to do instead. Two hooks enforce it, so a lesson costs no prompt tokens until it applies:
//   SessionStart  injects the ledger as a short list
//   PreToolUse    on a shell command matching a lesson: remind, or deny once per session pointing at the fix
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJson } from '@qbranch/core';
import { head } from './mine.mjs';
import { upsert } from './stats.mjs';

const file = (cfg) => path.join(cfg.root, cfg.lessons);
export const loadLessons = (cfg) => readJson(file(cfg), { lessons: [] }).lessons || [];
export function saveLessons(cfg, lessons) {
  fs.writeFileSync(file(cfg), JSON.stringify({ lessons }, null, 2) + '\n');
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Regex source matching a shape: literal tokens kept, generalized ones (S, P, N) become \S+. */
export function shapeRegex(shape) {
  return shape.split(' ').map(t => (/^[SPN]$/.test(t) ? '\\S+' : esc(t))).join('\\s+');
}

/** Turn a mined error -> workaround pair into a ledger entry. */
export function fromRecovery(r) {
  const a = head(r.from), b = head(r.to);
  const tool = r.tool ? { tool: r.tool } : {}; // a lesson learned in Bash must not block the same text in PowerShell
  const prog = a.split(' ').map(esc).join('\\s+(?:-\\S+\\s+)*'); // "npx tsc" also matches "npx -y tsc"
  if (a !== b) return { ...tool, when: `(^|[\\s;&|(])${prog}(\\s|$)`, instead: `use \`${b}\`, not \`${a}\` (e.g. ${r.toExample.split('\n')[0].slice(0, 120)})`, seen: r.count };
  return { ...tool, when: shapeRegex(r.from), instead: `this form fails here; what worked: ${r.toExample.split('\n')[0].slice(0, 160)}`, seen: r.count };
}

export function accept(cfg, entry) {
  const lessons = loadLessons(cfg);
  if (lessons.some(l => l.when === entry.when)) return null;
  const l = { id: `L${lessons.length + 1}`, action: cfg.guard === 'remind' ? 'remind' : 'deny-once', ...entry, accepted: new Date().toISOString() };
  lessons.push(l);
  saveLessons(cfg, lessons);
  upsert(cfg, (s) => { s.totals.accepted++; });
  return l;
}

/** Merge fields into one ledger entry (e.g. verification evidence). Returns the entry, or null if there is no such id. */
export function updateLesson(cfg, id, patch) {
  const lessons = loadLessons(cfg);
  const l = lessons.find(x => x.id === id);
  if (!l) return null;
  Object.assign(l, patch);
  saveLessons(cfg, lessons);
  return l;
}

const matches = (l, cmd) => { try { return new RegExp(l.when, 'i').test(cmd); } catch { return false; } };

export function sessionStart(cfg) {
  const lessons = loadLessons(cfg);
  if (!lessons.length || cfg.guard === 'off') return null;
  upsert(cfg, (s, day) => { s.totals.injections++; day.injections++; });
  return { context: `Project lessons (groundhog: learned the hard way in earlier sessions):\n${lessons.slice(0, 25).map(l => `- ${l.instead}`).join('\n')}` };
}

export function preToolUse(cfg, h) {
  if (cfg.guard === 'off' || !/^(Bash|PowerShell|Shell)$/.test(h.tool)) return null;
  const cmd = h.input?.command || '';
  const hit = loadLessons(cfg).find(l => (!l.tool || l.tool === h.tool) && matches(l, cmd));
  if (!hit) return null;
  let deny = false;
  if (hit.action === 'deny-once') {
    const mark = path.join(os.tmpdir(), `groundhog-${(h.sessionId || 'x').replace(/\W/g, '')}-${hit.id}`);
    if (!fs.existsSync(mark)) { fs.writeFileSync(mark, '1'); deny = true; } // once per session: never deadlock on a false positive
  }
  upsert(cfg, (s, day) => { s.totals.guard_hits++; day.guard_hits++; if (deny) s.totals.denies++; });
  const msg = `groundhog lesson ${hit.id}: ${hit.instead.replace(/[.\s]+$/, '')}`;
  return deny ? { deny: `${msg}. If this command is right anyway, run it again unchanged.` } : { context: msg };
}

/** After a scan: how often each accepted lesson's failing command still ran (and failed) after it was accepted. */
export function recurrences(cfg, calls) {
  const lessons = loadLessons(cfg);
  return lessons.map(l => ({ id: l.id, since: l.accepted,
    ran: calls.filter(c => c.mtime > Date.parse(l.accepted) && matches(l, c.cmd)).length,
    failed: calls.filter(c => c.mtime > Date.parse(l.accepted) && c.err && matches(l, c.cmd)).length }));
}
