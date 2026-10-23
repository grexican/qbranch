// The public registry tier: skills.sh search, and fetching a skill from GitHub into the project library.
import fs from 'node:fs';
import path from 'node:path';
import { gapTerms, keyTerms, parseSkill, reindex, load } from './library.mjs';
import { record, skillHash } from './ledger.mjs';

export async function searchRegistry(query, k = 5) {
  const r = await fetch(`https://skills.sh/api/search?q=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`skills.sh ${r.status}`);
  return ((await r.json()).skills || []).slice(0, k).map(s => ({ id: s.id, name: s.name, installs: s.installs }));
}

/** skills.sh is keyword-indexed: full sentences return nothing. Query it with the request's gap terms, rarest first. */
export async function searchRegistryByGap(cfg, request, k = 5) {
  const seen = new Map();
  for (const t of gapTerms(cfg, request)) for (const s of await searchRegistry(t, 3)) if (!seen.has(s.id)) seen.set(s.id, s);
  return [...seen.values()].slice(0, k);
}

// skills.sh matches substrings, so an idiom ("crush it", "dive in") returns objection-crusher and user-deep-dive.
// A candidate is relevant only when the request names what the skill is about: its name shares two meaningful words
// with the request, or at least half of its name's words. Light stemming only (-s/-es/-ing/-ed): "crusher" is not "crush".
const GENERIC = new Set(['skill', 'skills', 'tool', 'tools', 'agent', 'agents', 'helper', 'kit', 'pro', 'expert', 'guide']);
const stem = (w) => w.replace(/(ing|ed|es|s)$/, (m) => (w.length - m.length >= 4 ? '' : m));
// keyTerms keeps 4+ letter words; tool names are often 3 (sql, pdf, api, css, seo): take those too, minus filler
const SHORT_FILLER = new Set('the and for you all are but not can use get got let its our out own any one two new now how why who way per via yes too did had has was see'.split(' '));
export function relevantExternal(request, candidates) {
  const short = String(request).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length === 3 && !SHORT_FILLER.has(w));
  const terms = new Set([...keyTerms(request), ...short].map(stem));
  return candidates.filter((c) => {
    const words = [...new Set(String(c.name || c.id.split('/').pop()).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !GENERIC.has(w)).map(stem))];
    const shared = words.filter(w => terms.has(w)).length;
    return shared >= 2 || (shared >= 1 && shared / words.length >= 0.5);
  });
}

/** Fetch owner/repo/skill from GitHub into .headjack/library/<skill> (or a given dir), index it, return it loaded. */
export async function acquire(cfg, extId, { dest } = {}) {
  const [owner, repo, ...rest] = extId.split('/');
  const skillId = rest.join('/');
  if (!owner || !repo || !skillId) throw new Error('id must look like owner/repo/skill');
  const gh = (u) => fetch(u, { headers: { 'User-Agent': 'headjack', ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) } });
  // pin the exact commit, so the ledger records which version was installed (and an update can be diffed later)
  const cr = await gh(`https://api.github.com/repos/${owner}/${repo}/commits/HEAD`);
  const sha = cr.ok ? (await cr.json()).sha : 'HEAD';
  const tr = await gh(`https://api.github.com/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`);
  if (!tr.ok) throw new Error(`GitHub tree ${tr.status}`);
  const tree = (await tr.json()).tree;
  const mds = tree.filter(t => t.type === 'blob' && t.path.endsWith('SKILL.md'));
  const hit = mds.find(t => path.posix.basename(path.posix.dirname(t.path)) === skillId) || mds.find(t => t.path.includes(skillId));
  if (!hit) throw new Error(`no SKILL.md for "${skillId}" in ${owner}/${repo}`);
  const base = path.posix.dirname(hit.path);
  const out = path.join(dest || cfg.sharedDir, skillId.replace(/[\\/]/g, '_'));
  for (const f of tree.filter(t => t.type === 'blob' && t.path.startsWith(base + '/') && t.size < 200_000).slice(0, 40)) {
    const raw = await gh(`https://raw.githubusercontent.com/${owner}/${repo}/${sha}/${f.path}`);
    if (!raw.ok) continue;
    const p = path.join(out, f.path.slice(base.length + 1));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.from(await raw.arrayBuffer()));
  }
  const parsed = parseSkill(fs.readFileSync(path.join(out, 'SKILL.md'), 'utf8'));
  if (!parsed) throw new Error('fetched SKILL.md has no name/description frontmatter');
  const url = `https://github.com/${owner}/${repo}/tree/${sha}/${base}`;
  fs.writeFileSync(path.join(out, '.headjack-source'), `${url}\n`);
  const space = dest === cfg.personalDir ? 'personal' : 'shared';
  record(cfg, space, { action: 'acquire', name: parsed.name, from: extId, to: out, source: `registry:${url}`, hash: skillHash(out) });
  await reindex(cfg);
  return load(cfg, `${space}/${parsed.name}`);
}
