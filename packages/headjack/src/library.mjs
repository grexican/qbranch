// The skill library: SKILL.md folders on disk, indexed into one SQLite file (.headjack/index.db) with
// BM25 (FTS5) + local MiniLM embeddings fused by reciprocal-rank fusion. Nothing here is preloaded into the model.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { embed as coreEmbed, toBlob, fromBlob, parseFrontmatter } from '@qbranch/core';

const dbs = new Map();
export function db(cfg) {
  if (dbs.has(cfg.dataDir)) return dbs.get(cfg.dataDir);
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const d = new DatabaseSync(path.join(cfg.dataDir, 'index.db'));
  d.exec(`
    create table if not exists skills (id text primary key, name text, description text, source text, tier text,
      dir text, body text, hash text, embedding blob);
    create virtual table if not exists skills_fts using fts5(id unindexed, name, description, body, tokenize='porter unicode61');
    create table if not exists recent (id text, ts integer);`);
  dbs.set(cfg.dataDir, d);
  return d;
}

// ---------- embeddings (optional: HEADJACK_EMBED=0 or a failed load falls back to BM25 only) ----------
const embed = (texts) => coreEmbed(texts, { disabled: process.env.HEADJACK_EMBED === '0' || process.env.QB_EMBED === '0' });

// ---------- parsing ----------
export function parseSkill(text) {
  const { meta, body } = parseFrontmatter(text);
  return meta.name && meta.description ? { name: meta.name, description: meta.description, body } : null;
}

function findSkillFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) findSkillFiles(p, out);
    else if (e.name === 'SKILL.md') out.push(p);
  }
  return out;
}

// ---------- indexing: cheap when nothing changed (hash check), so the hook can call it every prompt ----------
// ids are "<space>/<name>": shared/x, personal/x, or <source-folder>/x. A skill fetched from the public
// registry carries a .headjack-source file and is indexed as tier "external" (shown as unvetted when loaded).
export async function reindex(cfg) {
  const d = db(cfg);
  const items = [];
  for (const src of cfg.sourceDirs) for (const f of findSkillFiles(src.dir)) {
    const s = parseSkill(fs.readFileSync(f, 'utf8'));
    const dir = path.dirname(f);
    if (s) items.push({ ...s, source: src.label, tier: fs.existsSync(path.join(dir, '.headjack-source')) ? 'external' : 'library', dir, id: `${src.label}/${s.name}` });
  }
  const seen = new Set(items.map(s => s.id));
  for (const { id } of d.prepare('select id from skills').all())
    if (!seen.has(id)) { d.prepare('delete from skills where id = ?').run(id); d.prepare('delete from skills_fts where id = ?').run(id); }
  return upsertSkills(cfg, items);
}

export async function upsertSkills(cfg, items) {
  const d = db(cfg);
  const have = new Map(d.prepare('select id, hash from skills').all().map(r => [r.id, r.hash]));
  const todo = items.filter(s => (s.hash = createHash('sha1').update(s.name + s.description + s.body + s.dir).digest('hex')) !== have.get(s.id));
  for (let i = 0; i < todo.length; i += 32) {
    const batch = todo.slice(i, i + 32);
    const vecs = await embed(batch.map(s => `${s.name}: ${s.description}\n${s.body.slice(0, 600)}`));
    d.exec('begin');
    batch.forEach((s, j) => {
      d.prepare('delete from skills_fts where id = ?').run(s.id);
      d.prepare('insert or replace into skills values (?,?,?,?,?,?,?,?,?)').run(s.id, s.name, s.description, s.source, s.tier, s.dir, s.body, s.hash, toBlob(vecs?.[j]));
      d.prepare('insert into skills_fts (id,name,description,body) values (?,?,?,?)').run(s.id, s.name, s.description, s.body);
    });
    d.exec('commit');
  }
  return { total: items.length, updated: todo.length };
}

// ---------- search ----------
const ftsQuery = (q) => (q.toLowerCase().match(/[a-z0-9]{2,}/g) || []).map(t => `"${t}"`).join(' OR ');

export async function search(cfg, query, k = 6) {
  const d = db(cfg);
  const fq = ftsQuery(query);
  const lexical = fq ? d.prepare(`select s.id from skills_fts f join skills s on s.id = f.id where skills_fts match ?
    order by bm25(skills_fts, 0, 10.0, 4.0, 1.0) limit 40`).all(fq).map(r => r.id) : [];
  const [qv] = (await embed([query])) || [];
  const semantic = qv ? d.prepare('select id, embedding from skills where embedding is not null').all().map(r => {
    const v = fromBlob(r.embedding); let dot = 0;
    for (let i = 0; i < v.length; i++) dot += v[i] * qv[i];
    return [r.id, dot];
  }).sort((a, b) => b[1] - a[1]).slice(0, 40) : [];
  const cos = new Map(semantic);
  const score = new Map();
  lexical.forEach((id, r) => score.set(id, (score.get(id) || 0) + 1 / (60 + r)));
  semantic.forEach(([id], r) => score.set(id, (score.get(id) || 0) + 1 / (60 + r)));
  const get = d.prepare('select id, name, description, source, tier from skills where id = ?');
  return [...score].sort((a, b) => b[1] - a[1]).slice(0, k)
    .map(([id]) => ({ ...get.get(id), similarity: qv ? +(cos.get(id) ?? 0).toFixed(3) : null }));
}

/** Strong = a top-3 hit is semantically close (lower-ranked cosine spikes are noise).
 *  Lexical-only mode (no embeddings): a meaningful query term must appear in the hit's name or description. */
export function isStrong(cfg, hits, query = '') {
  const terms = keyTerms(query);
  return hits.slice(0, 3).some(h => (h.similarity != null ? h.similarity >= cfg.strong
    : terms.some(t => `${h.name} ${h.description}`.toLowerCase().includes(t))));
}
export const keyTerms = (q) => [...new Set((q.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) || []).filter(t => !STOP.has(t)))];

/** Terms of a request the library has never seen: what to ask the public registry about ("terraform", "anki"). */
const STOP = new Set('what is the and for with that this from into your their about make write create build turn file files using need want just able will what which then them they have these those there here when where some each other more most very also only like help please over under can could should would'.split(' '));
export function gapTerms(cfg, query, n = 3) {
  const d = db(cfg);
  const terms = [...new Set((query.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) || []).filter(t => !STOP.has(t) && !/\d/.test(t)))];
  return terms.filter(t => d.prepare('select count(*) n from skills_fts where skills_fts match ?').get(`"${t}"`).n === 0).slice(0, n);
}

// ---------- load ----------
export function load(cfg, ref) {
  const d = db(cfg);
  let rows = d.prepare('select * from skills where id = ?').all(ref);
  if (!rows.length) rows = d.prepare('select * from skills where name = ?').all(ref);
  if (!rows.length) return { error: `No skill "${ref}". Use find-skill (headjack find) to get valid ids.` };
  if (rows.length > 1) return { error: `"${ref}" is ambiguous; use one of: ${rows.map(r => r.id).join(', ')}` };
  const s = rows[0];
  const files = [];
  (function walk(dir, depth) {
    if (depth > 3 || !fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      e.isDirectory() ? walk(p, depth + 1) : e.name !== 'SKILL.md' && files.push(p);
    }
  })(s.dir, 0);
  return { ...s, files: files.slice(0, 60) };
}

export function renderSkill(s) {
  if (s.error) return s.error;
  const trust = s.tier === 'external' ? '\n> UNTRUSTED: fetched from a public registry. Read its scripts before running them.' : '';
  const files = s.files.length ? `\n\n---\nSupporting files (read only the ones you need):\n${s.files.map(f => `- ${f}`).join('\n')}` : '';
  return `# Skill loaded: ${s.id}\nBase directory: ${s.dir}${trust}\n\n${s.body}${files}`;
}

// suggestions from the last 30 minutes, so a later load counts as "suggested, then loaded"
export function noteSuggested(cfg, ids) { const d = db(cfg); const ts = Date.now(); for (const id of ids) d.prepare('insert into recent values (?, ?)').run(id, ts); d.prepare('delete from recent where ts < ?').run(ts - 30 * 60_000); }
export const wasSuggested = (cfg, id) => !!db(cfg).prepare('select 1 from recent where id = ? and ts > ?').get(id, Date.now() - 30 * 60_000);
