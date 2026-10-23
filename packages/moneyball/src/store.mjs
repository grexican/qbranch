// Run index (.moneyball/index.db): every measured subagent run, and the task classes runs cluster into.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const SCHEMA = 3; // bump when a run's measurement changes; older rows are re-measured while their transcript exists

const dbs = new Map();
export function db(cfg) {
  if (dbs.has(cfg.dataDir)) return dbs.get(cfg.dataDir);
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  if (!fs.existsSync(path.join(cfg.dataDir, '.gitignore'))) fs.writeFileSync(path.join(cfg.dataDir, '.gitignore'), '*\n');
  const d = new DatabaseSync(path.join(cfg.dataDir, 'index.db'));
  d.exec(`
    create table if not exists runs (id text primary key, session text, platform text, agent_type text, description text,
      class_id integer, model text, tier text, cost real, calls integer, tool_calls integer, tool_errors integer,
      redo integer, fail_words integer, ok integer, explored integer default 0, mtime real);
    create table if not exists classes (id integer primary key, label text, key text unique, n integer default 0, prior text);
    create table if not exists meta (k text primary key, v text);`);
  // schema 2: startup tokens + delegation credit per run. schema 3: wall-clock seconds + parent rework per run.
  // Rows measured by an older schema are re-measured on the next scan while their transcript is still on disk; rows whose
  // transcript has aged out keep their old measurement (evidence is never thrown away). measured_by marks which is which.
  if (d.prepare("select v from meta where k = 'schema'").get()?.v !== String(SCHEMA)) {
    for (const c of ['startup_tokens integer default 0', 'credit real default 0', 'secs real', 'rework integer default 0', 'measured_by integer default 0'])
      try { d.exec(`alter table runs add column ${c}`); } catch { /* already there */ }
    d.prepare("insert or replace into meta values ('schema', ?)").run(String(SCHEMA));
  }
  dbs.set(cfg.dataDir, d);
  return d;
}

// ---------- task classes ----------
// Prior on a class's leading verb: narrow, checkable, repeatable work (UD's three-question test) vs judgment work.
// Anchored at the start with no trailing boundary, so stems match ("summariz", "verifi", "monitor").
const MECHANICAL = /^(check|status|poll|monitor|watch|list|collect|harvest|gather|fetch|download|scan|search|find|locate|grep|read|summari|extract|count|verif|validat|sync|ping|report|inventor|lookup|qa|screenshot|captur|tail|log|explor|research|audit|map|survey|look)/;
const JUDGMENT = /^(fix|build|implement|design|refactor|review|plan|write|architect|debug|root|migrat|author|decid|council|creat|rewrit|improv|redesign|rebuild|add|wire|port|ship)/;
export const prior = (verb) => (JUDGMENT.test(verb) ? 'judgment' : MECHANICAL.test(verb) ? 'mechanical' : 'unclear');

const STOP = new Set('the a an and or for to of in on at with from by this that is are be it as into via run lane task new'.split(' '));
const stem = (w) => (/(ss|us|is)$/.test(w) ? w : w.replace(/(ing|ed|es|s)$/, (m) => (w.length - m.length >= 3 ? '' : m)));
/**
 * Class key: agent type + the leading verb of the description ("general-purpose:check", "Explore:find").
 * Deliberately coarse. Measured on 1.2k real dispatches, descriptions are near-unique (1,083 distinct 4-word keys), so
 * fine-grained classes never collect evidence; the verb is also all the hook can see at dispatch time.
 */
export function lexKey(agentType, desc) {
  const words = (desc || '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(w => w.length > 1 && !STOP.has(w));
  return `${agentType || 'general-purpose'}:${words.length ? stem(words[0]) : 'misc'}`;
}

export function classify(cfg, agentType, desc) {
  const d = db(cfg);
  const key = lexKey(agentType, desc);
  const hit = d.prepare('select id from classes where key = ?').get(key);
  if (hit) return hit.id;
  const verb = key.split(':')[1];
  const r = d.prepare('insert into classes (label, key, prior) values (?, ?, ?)').run(key, key, prior(verb));
  return Number(r.lastInsertRowid);
}
