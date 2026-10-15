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
export function createStats({ tool, fresh, dayFresh, derive }) {
  return function upsert(root, file, mutate) {
    if (!file || process.env[`${tool.toUpperCase()}_STATS`] === '0') return;
    const f = path.join(root, file);
    const release = lock(f);
    try {
      let s; try { s = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { s = { tool, schema: 1, since: new Date().toISOString(), ...fresh() }; }
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
