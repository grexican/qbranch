// Public filler skills: listed in filler/manifest.json (repo, pinned commit, path, sha256, license), fetched at run time
// into .cache/filler/ and never vendored. `buildManifest` is the maintainer step that writes the manifest.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseFrontmatter } from '../../../packages/core/src/frontmatter.mjs';
import { BENCH } from './paths.mjs';

export const MANIFEST = path.join(BENCH, 'filler', 'manifest.json');
export const CACHE = path.join(BENCH, '.cache', 'filler');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
export const RAW = 'https://raw.githubusercontent.com';

/** Names a filler skill may not take: the targets, decoys, headjack's root skills and Claude Code's built-ins. */
export const RESERVED = new Set(['find-skill', 'load-skill', 'dataviz', 'update-config', 'keybindings-help', 'code-review', 'simplify',
  'fewer-permission-prompts', 'loop', 'schedule', 'claude-api', 'workflow-authoring', 'run', 'init', 'security-review']);

/** A filler entry is usable when its SKILL.md has a spec-valid name and a description. */
export function usableSkill(text) {
  const { meta } = parseFrontmatter(text);
  if (!meta.name || !meta.description) return null;
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(meta.name) || meta.name.length > 64) return null;
  if (meta.description.length > 1024 || /[<>]/.test(meta.description)) return null;
  return { name: meta.name, description: meta.description };
}

/**
 * Fetch every manifest entry into the cache (skips files already there with the right hash). `get(url)` returns a
 * Buffer; it is injectable so tests run offline. Returns [{ name, description, file, repo, license }].
 */
export async function fetchFiller({ manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')), cache = CACHE, base = RAW, get = httpGet, concurrency = 16, log = () => {} } = {}) {
  const jobs = manifest.repos.flatMap(r => r.skills.map(s => ({ r, s })));
  const out = [];
  let i = 0, fetched = 0;
  const worker = async () => {
    while (i < jobs.length) {
      const { r, s } = jobs[i++];
      const file = path.join(cache, r.repo.replace('/', '__'), r.commit.slice(0, 12), ...s.path.split('/'));
      let buf = fs.existsSync(file) ? fs.readFileSync(file) : null;
      if (!buf || sha256(buf) !== s.sha256) {
        buf = await get(`${base}/${r.repo}/${r.commit}/${s.path}`);
        if (sha256(buf) !== s.sha256) throw new Error(`hash mismatch for ${r.repo}@${r.commit.slice(0, 8)}/${s.path}`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, buf);
        fetched++;
      }
      const u = usableSkill(buf.toString('utf8'));
      out.push({ name: s.name, description: u?.description || '', file, repo: r.repo, license: s.license || r.license });
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  log(`filler: ${out.length} skills (${fetched} fetched, ${out.length - fetched} cached)`);
  const order = new Map(jobs.map(({ r, s }, k) => [`${r.repo}/${s.name}`, k]));
  return out.sort((a, b) => order.get(`${a.repo}/${a.name}`) - order.get(`${b.repo}/${b.name}`));
}

export async function httpGet(url, tries = 4) {
  for (let t = 0; ; t++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) { if (t >= tries) throw e; await new Promise(res => setTimeout(res, 500 * 2 ** t)); }
  }
}

// ---------- maintainer step: build the manifest from pinned commits (needs network and the gh CLI) ----------

/** repos: [{ repo, commit, license, perSkillLicense? }]. Writes filler/manifest.json. */
export async function buildManifest(repos, { exclude = new Set(), gh }) {
  const seen = new Set(exclude);
  const outRepos = [];
  for (const r of repos) {
    const tree = JSON.parse(gh(['api', `repos/${r.repo}/git/trees/${r.commit}?recursive=1`])).tree;
    const paths = tree.map(t => t.path).filter(p => /(^|\/)SKILL\.md$/.test(p) && !/^template\//.test(p)).sort();
    const skills = [];
    for (const p of paths) {
      let license = r.license;
      if (r.perSkillLicense) {
        const lic = tree.find(t => t.path === p.replace(/SKILL\.md$/, 'LICENSE.txt'));
        if (!lic) continue;
        const head = (await httpGet(`${RAW}/${r.repo}/${r.commit}/${lic.path}`)).toString('utf8').slice(0, 400);
        if (!/Apache License/i.test(head)) continue; // the source-available document skills are excluded
        license = 'Apache-2.0';
      }
      const buf = await httpGet(`${RAW}/${r.repo}/${r.commit}/${p}`);
      const s = usableSkill(buf.toString('utf8'));
      if (!s || seen.has(s.name)) continue;
      seen.add(s.name);
      skills.push({ name: s.name, path: p, sha256: sha256(buf), license });
    }
    outRepos.push({ repo: r.repo, commit: r.commit, license: r.license, skills });
  }
  return { note: 'Public filler skills at pinned commits. Fetched at run time by src/filler.mjs into .cache/ and never vendored. Only SKILL.md is fetched.', repos: outRepos };
}
