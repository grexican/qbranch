// Lite usage stats, upserted into a dotfile at the project root (one per tool, e.g. .headjack-stats.json).
// Lock-protected and atomic (hooks, CLIs and MCP servers may write concurrently); never throws into the agent.
import fs from 'node:fs';
import path from 'node:path';

const KEEP_DAYS = 90;
export const today = () => new Date().toISOString().slice(0, 10);

function lock(file) {
  const l = file + '.lock';
  for (let i = 0; i < 40; i++) {
    try { fs.writeFileSync(l, String(process.pid), { flag: 'wx' }); return () => fs.rmSync(l, { force: true }); }
    catch {
      try { if (Date.now() - fs.statSync(l).mtimeMs > 2000) fs.rmSync(l, { force: true }); } catch {}
      const until = Date.now() + 25; while (Date.now() < until) { /* short spin; writers are short-lived */ }
    }
  }
  return () => {};
}

/**
 * Create an upserter for one tool's stats file.
 *   fresh()        -> initial object (must have `days: {}`)
 *   dayFresh()     -> initial per-day bucket
 *   derive(s)      -> optional: recompute derived fields before writing
 * Returns upsert(root, file, mutate) where mutate(stats, dayBucket) edits in place. file=false disables.
 */
// Stats are per-person usage, not project content: committed, every teammate's writes would collide. Keep them out of git
// through the clone's own .git/info/exclude (never committed, so it cannot collide either, and plugin installs, which
// run no install step in the project, are covered too). The pattern also covers the .lock and .tmp siblings.
const ignored = new Set();
export function ensureIgnored(root, file) {
  const key = path.join(root, file);
  if (ignored.has(key)) return;
  ignored.add(key);
  try {
    let git = path.join(root, '.git');
    if (fs.statSync(git).isFile()) { // a worktree: .git says where its gitdir is; exclude lives in the common dir
      git = path.resolve(root, fs.readFileSync(git, 'utf8').match(/gitdir:\s*(.+)/)[1].trim());
      try { git = path.resolve(git, fs.readFileSync(path.join(git, 'commondir'), 'utf8').trim()); } catch { /* not a linked worktree */ }
    }
    const ex = path.join(git, 'info', 'exclude');
    const line = `/${file.split(path.sep).join('/')}*`;
    let cur = ''; try { cur = fs.readFileSync(ex, 'utf8'); } catch { /* no exclude file yet */ }
    if (cur.split(/\r?\n/).some(l => l.trim() === line || l.trim() === file || l.trim() === `/${file}`)) return;
    fs.mkdirSync(path.dirname(ex), { recursive: true });
    fs.appendFileSync(ex, `${cur && !cur.endsWith('\n') ? '\n' : ''}${line}\n`);
  } catch { /* not a git repo, or unwritable: nothing to do */ }
}

export function createStats({ tool, fresh, dayFresh, derive }) {
  return function upsert(root, file, mutate) {
    if (!file || process.env[`${tool.toUpperCase()}_STATS`] === '0') return;
    const f = path.join(root, file);
    ensureIgnored(root, file);
    const release = lock(f);
    try {
      let s; try { s = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { s = { tool, schema: 1, since: new Date().toISOString(), ...fresh() }; }
      // files written by an older version lack newer counters: fill them in (one level deep) so mutate can use ++ safely
      for (const [k, v] of Object.entries(fresh())) {
        if (!(k in s)) s[k] = v;
        else if (v && typeof v === 'object' && !Array.isArray(v) && s[k] && typeof s[k] === 'object') s[k] = { ...v, ...s[k] };
      }
      s.days ??= {};
      s.days[today()] ??= dayFresh();
      mutate(s, s.days[today()]);
      if (derive) derive(s);
      s.updated = new Date().toISOString();
      for (const d of Object.keys(s.days)) if ((Date.now() - Date.parse(d)) / 864e5 > KEEP_DAYS) delete s.days[d];
      const tmp = `${f}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n');
      fs.renameSync(tmp, f);
    } catch { /* stats must never break the agent */ } finally { release(); }
  };
}

export const readStats = (root, file) => { try { return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')); } catch { return null; } };
