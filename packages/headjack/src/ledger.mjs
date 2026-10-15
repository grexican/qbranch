// The install ledger: an append-only record of every skill that entered or left a library space, with where it
// came from. One file per space, next to the library: .headjack/ledger.jsonl (shared: commit it with the team's
// skills) and ~/.headjack/ledger.jsonl (personal). It is what makes `release` able to put things back exactly.
//   { at, action, space, name, from, to, source, hash }
//   action: adopt | add | acquire | new | bundle | move-in | move-out | release
//   source: where the content originally came from ("path:<dir>", "registry:<url>", "scaffold", "bundle:<a,b,c>")
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const file = (cfg, space) => path.join(path.dirname(space === 'personal' ? cfg.personalDir : cfg.sharedDir), 'ledger.jsonl');

/** sha1 of a skill's SKILL.md: tells `release` whether the skill was edited while it lived in the library. */
export const skillHash = (dir) => { try { return createHash('sha1').update(fs.readFileSync(path.join(dir, 'SKILL.md'))).digest('hex').slice(0, 12); } catch { return null; } };

// Paths are stored portably (the shared ledger is committed and read on other machines): relative to the project
// root, or ~/ for the home directory, always with forward slashes. Registry refs and other strings pass through.
const portable = (cfg, p) => {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return p;
  const slash = (s) => s.split(path.sep).join('/');
  const inside = (base) => { const r = path.relative(base, p); return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : null; };
  const r = inside(cfg.root); if (r) return slash(r);
  const h = inside(os.homedir()); if (h) return `~/${slash(h)}`;
  return slash(p);
};
export const resolvePath = (cfg, p) => (p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : path.resolve(cfg.root, p));

export function record(cfg, space, entry) {
  const f = file(cfg, space);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const e = { at: new Date().toISOString(), space, ...entry, from: portable(cfg, entry.from), to: portable(cfg, entry.to) };
  if (e.source?.startsWith('path:')) e.source = `path:${portable(cfg, e.source.slice(5))}`;
  fs.appendFileSync(f, JSON.stringify(e) + '\n');
}

export function history(cfg, { space, name } = {}) {
  const out = [];
  for (const sp of space ? [space] : ['shared', 'personal']) {
    try {
      for (const line of fs.readFileSync(file(cfg, sp), 'utf8').split('\n')) if (line.trim()) out.push(JSON.parse(line));
    } catch { /* no ledger yet */ }
  }
  return out.filter(e => !name || e.name === name).sort((a, b) => a.at.localeCompare(b.at));
}

/** Where a skill came from before it entered the library: the last adopt (a path on disk), if any. */
export function origin(cfg, space, name) {
  const h = history(cfg, { space, name }).filter(e => e.action === 'adopt' || e.action === 'add');
  const last = h[h.length - 1];
  return last?.from && !last.from.includes('://') ? { dir: resolvePath(cfg, last.from), hash: last.hash } : null;
}

/** Provenance of a skill folder at entry: a registry fetch leaves a .headjack-source marker with its URL. */
export function sourceOf(dir, fallback) {
  try { return `registry:${fs.readFileSync(path.join(dir, '.headjack-source'), 'utf8').trim()}`; } catch { return fallback; }
}
