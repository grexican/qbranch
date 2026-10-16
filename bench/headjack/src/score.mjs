// Deterministic scoring: canaries (regex) over the agent's output, and which library skills were loaded.
import fs from 'node:fs';
import path from 'node:path';
import { TEMPLATE_PATHS } from './arms.mjs';

/** Does `text` satisfy the skill's canaries? { used, hits: [rule ids] } */
export function checkCanaries(spec, text) {
  const hits = spec.rules.filter(r => new RegExp(r.re, r.flags || '').test(text)).map(r => r.id);
  return { used: hits.length >= (spec.minHits ?? spec.rules.length), hits };
}

/** Every target whose canaries the text satisfies. */
export function usedTargets(canaries, text) {
  return Object.entries(canaries).filter(([, spec]) => checkCanaries(spec, text).used).map(([n]) => n);
}

const ROOT = new Set(['find-skill', 'load-skill']);
/**
 * Library skills a run loaded, from its tool calls: the Skill tool, `headjack get <id>` in a shell, or reading a
 * skill's SKILL.md directly. `library` is the set of names in the arm's library (built-ins and root skills never count).
 */
export function loadedSkills(events, library) {
  const out = new Set();
  const add = (n) => { n = String(n || '').trim().replace(/^["'`]|["'`]$/g, ''); n = n.split(/[/:]/).pop(); if (library.has(n) && !ROOT.has(n)) out.add(n); };
  for (const e of events || []) {
    if (e.t !== 'tool') continue;
    const inp = e.input || {};
    if (e.name === 'Skill') add(inp.skill ?? inp.name ?? inp.command);
    if (/^(Bash|PowerShell|Shell)$/.test(e.name)) for (const m of String(inp.command || '').matchAll(/headjack(?:\.mjs)?["']?\s+get\s+(?:--acquire\s+)?(?:--\S+\s+)*([^\s;&|"'`]+)/g)) add(m[1]);
    if (/^(Read|Bash|PowerShell)$/.test(e.name)) {
      const s = String(inp.file_path ?? inp.path ?? inp.command ?? '');
      for (const m of s.matchAll(/[\\/]([a-z0-9][a-z0-9-]*)[\\/]SKILL\.md/gi)) add(m[1]);
    }
  }
  return [...out];
}

/** The agent's output: the final answer plus every text file it created or changed in the sandbox. */
export function collectOutput(run, sandboxDir) {
  const parts = [run.finalText || ''];
  const files = [];
  const walk = (d, rel = '') => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (TEMPLATE_PATHS.test(r + (e.isDirectory() ? '/' : '')) || e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, r);
      else if (fs.statSync(p).size < 400_000) { files.push(r); parts.push(`\n----- ${r}\n` + fs.readFileSync(p, 'utf8')); }
    }
  };
  try { walk(sandboxDir); } catch { /* sandbox gone */ }
  return { text: parts.join('\n'), files };
}

/** One run's score against a prompt's answer set. */
export function scoreRun({ prompt, events, outputText, library, canaries }) {
  const loaded = loadedSkills(events, library);
  const used = usedTargets(canaries, outputText);
  const accept = new Set(prompt.answers);
  return {
    loaded, used,
    useHit: prompt.answers.length ? used.some(n => accept.has(n)) : null,
    loadHit: prompt.answers.length ? loaded.some(n => accept.has(n)) : null,
    wrongLoad: loaded.some(n => !accept.has(n)),
    falseLoad: prompt.answers.length ? null : loaded.length > 0,
    falseUse: prompt.answers.length ? null : used.length > 0,
  };
}
