// The public registry tier: skills.sh search, and fetching a skill from GitHub into the project library.
import fs from 'node:fs';
import path from 'node:path';
import { gapTerms, parseSkill, reindex, load } from './library.mjs';

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

/** Fetch owner/repo/skill from GitHub into .headjack/library/<skill> (or a given dir), index it, return it loaded. */
export async function acquire(cfg, extId, { dest } = {}) {
  const [owner, repo, ...rest] = extId.split('/');
  const skillId = rest.join('/');
  if (!owner || !repo || !skillId) throw new Error('id must look like owner/repo/skill');
  const gh = (u) => fetch(u, { headers: { 'User-Agent': 'headjack', ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) } });
  const tr = await gh(`https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`);
  if (!tr.ok) throw new Error(`GitHub tree ${tr.status}`);
  const tree = (await tr.json()).tree;
  const mds = tree.filter(t => t.type === 'blob' && t.path.endsWith('SKILL.md'));
  const hit = mds.find(t => path.posix.basename(path.posix.dirname(t.path)) === skillId) || mds.find(t => t.path.includes(skillId));
  if (!hit) throw new Error(`no SKILL.md for "${skillId}" in ${owner}/${repo}`);
  const base = path.posix.dirname(hit.path);
  const out = path.join(dest || cfg.sharedDir, skillId.replace(/[\\/]/g, '_'));
  for (const f of tree.filter(t => t.type === 'blob' && t.path.startsWith(base + '/') && t.size < 200_000).slice(0, 40)) {
    const raw = await gh(`https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${f.path}`);
    if (!raw.ok) continue;
    const p = path.join(out, f.path.slice(base.length + 1));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.from(await raw.arrayBuffer()));
  }
  const parsed = parseSkill(fs.readFileSync(path.join(out, 'SKILL.md'), 'utf8'));
  if (!parsed) throw new Error('fetched SKILL.md has no name/description frontmatter');
  fs.writeFileSync(path.join(out, '.headjack-source'), `https://github.com/${owner}/${repo}/tree/HEAD/${base}\n`);
  await reindex(cfg);
  return load(cfg, `${dest === cfg.personalDir ? 'personal' : 'shared'}/${parsed.name}`);
}
