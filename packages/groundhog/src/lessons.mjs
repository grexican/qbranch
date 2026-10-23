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
import { escapeGuard } from './guard.mjs';

const file = (cfg) => path.join(cfg.root, cfg.lessons);
export const loadLessons = (cfg) => readJson(file(cfg), { lessons: [] }).lessons || [];
export function saveLessons(cfg, lessons) {
  fs.writeFileSync(file(cfg), JSON.stringify({ lessons }, null, 2) + '\n');
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// a kept script name ("cu/x.mjs") also matches deeper or absolute paths and Windows separators
const tok = (t) => (/^[SPN]$/.test(t) ? '\\S+' : t.includes('/') ? `(?:\\S*[\\\\/])?${t.split('/').map(esc).join('[\\\\/]')}` : esc(t));
/** Regex source matching a shape: literal tokens kept, generalized ones (S, P, N) become \S+. */
export function shapeRegex(shape) {
  return shape.split(' ').map(tok).join('\\s+');
}

/** Turn a mined error -> workaround pair into a ledger entry. */
export function fromRecovery(r) {
  const a = head(r.from), b = head(r.to);
  const tool = r.tool ? { tool: r.tool } : {}; // a lesson learned in Bash must not block the same text in PowerShell
  const prog = a.split(' ').map(tok).join('\\s+(?:-\\S+\\s+)*'); // "npx tsc" also matches "npx -y tsc"
  if (a !== b) return { ...tool, when: `(^|[\\s;&|(])${prog}(\\s|$)`, instead: `use \`${b}\`, not \`${a}\` (e.g. ${r.toExample.split('\n')[0].slice(0, 120)})`, seen: r.count };
  return { ...tool, when: shapeRegex(r.from), instead: `this form fails here; what worked: ${r.toExample.split('\n')[0].slice(0, 160)}`, seen: r.count };
}

// Tool-switch lessons match the risky construct (any command using it), not one command shape.
const KIND = {
  'inline-backslash-heredoc': { when: /<<-?\s*['"]?\w+['"]?[^\n]*\n[\s\S]*\\\\/.source, instead: 'write scripts that contain backslashes with the Write tool and run the file; heredoc-written ones lost their backslashes here' },
  'inline-backslash-eval': { when: /\b(node|python3?|py|deno|bun|perl|ruby)(\s+-\S+)*\s+(-e|-c|--eval)\s+['"][\s\S]*\\\\/.source, instead: 'put code that contains backslashes in a file (Write tool) and run it; inline -e/-c scripts lost their backslashes here' },
  'heredoc-script': { when: /\b(cat|tee)\s+(-a\s+)?>{0,2}\s*\S+\.(m?[jt]s|c[jt]s|py|sh|ps1|rb|php)\b[^\n]*<<|<<-?\s*['"]?\w+['"]?\s*>{1,2}\s*\S+\.(m?[jt]s|c[jt]s|py|sh|ps1|rb|php)\b/.source, instead: 'write script files with the Write tool, not a heredoc; heredoc-written scripts kept failing here' },
  'inline-eval': { when: /\b(node|python3?|py|deno|bun)(\s+-\S+)*\s+(-e|-c|--eval)\s+['"][^'"]{120,}/.source, instead: 'put anything longer than a one-liner in a file (Write tool) and run it, instead of node -e / python -c' },
  'sed-in-place': { when: /\b(sed\s+(-\S+\s+)*-\S*i|perl\s+-\S*p\S*i|perl\s+-\S*i\S*p)/.source, instead: 'edit files with the Edit tool, not sed -i / perl -pi: the in-place edits kept failing here' },
  'echo-to-file': { when: /(^|[;&|]\s*)(echo|printf)\b[^|\n]*>{1,2}\s*\S+\.(m?[jt]s|c[jt]s|json|py|sh|ps1|ya?ml|md|txt)\b/.source, instead: 'write files with the Write tool, not echo/printf redirects' },
};
/** A mined tool switch (failing risky construct -> Write/Edit) as a ledger entry, or null for an unknown kind. */
export function fromSwitch(e) {
  const k = KIND[e.kind];
  return k ? { tool: e.tool, when: k.when, instead: `${k.instead} (e.g. ${e.toExample.split('\n')[0].slice(0, 120)})`, seen: e.count, source: `switch:${e.kind}` } : null;
}
/** A mined rtk retry as a ledger entry: remind (never deny) to ask rtk for raw output on that command shape. */
export function fromRtk(e) {
  // a number inside a token was generalized too (-20 -> -N, HEAD~3 -> HEAD~N): match any digits there
  const re = shapeRegex(e.shape).replace(/(^|[^A-Za-z\\])N(?=$|[^A-Za-z])/g, '$1\\d+');
  return { tool: e.tool, action: 'remind', when: `^(?!\\s*rtk\\s+proxy\\b)(?:cd\\s+[^;&]+(?:&&|;)\\s*)*(?:rtk\\s+)?${re}`,
    instead: `rtk filters the output of \`${e.shape}\`; when you need it raw, run \`rtk proxy ${e.shape}\``, seen: e.count, source: 'rtk' };
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
  if (!/^(Bash|PowerShell|Shell)$/.test(h.tool)) return null;
  const cmd = h.input?.command || '';
  const hit = cfg.guard === 'off' ? null : loadLessons(cfg).find(l => (!l.tool || l.tool === h.tool) && matches(l, cmd));
  if (!hit) return escapeGuard(cfg, h); // built-in guards apply even with no ledger
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
