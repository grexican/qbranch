// Maintainer step: pin the public filler repos and write filler/manifest.json. Needs network and the gh CLI.
//   node bench/headjack/src/build-manifest.mjs
// Licenses verified by hand on 2026-10-16 (repo license via the GitHub API; anthropics/skills per skill folder,
// keeping only the Apache-2.0 skills). CC-BY-SA and unlicensed repos were left out.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildManifest, MANIFEST, RESERVED } from './filler.mjs';
import { TARGETS } from '../testbed/authoring/targets.mjs';
import { DECOYS } from '../testbed/authoring/decoys.mjs';

const REPOS = [
  { repo: 'anthropics/skills', commit: 'dbd4588f9e1033efb41dad4bef2f7947c8993d44', license: 'Apache-2.0 (per skill)', perSkillLicense: true },
  { repo: 'obra/superpowers', commit: 'bb92a77741419a4ab5f06e711a283343f1ada0c3', license: 'MIT' },
  { repo: 'hashicorp/agent-skills', commit: 'f706481af9b8fedb66de909f6243ad29601afa0c', license: 'MPL-2.0' },
  { repo: 'huggingface/skills', commit: 'c3ff942be3e07116b475253f0a8fc4f54682c1a8', license: 'Apache-2.0' },
  { repo: 'K-Dense-AI/claude-scientific-skills', commit: 'a1043ef544e3a100c28e70a736b6cf32554d0677', license: 'MIT' },
  { repo: 'alirezarezvani/claude-skills', commit: '19392f7a08264ed00486a251f5b2098321771f94', license: 'MIT' },
];
const gh = (args) => { const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 1 << 28, shell: process.platform === 'win32' }); if (r.status) throw new Error(r.stderr); return r.stdout; };
const exclude = new Set([...RESERVED, ...TARGETS.map(t => t.name), ...DECOYS.map(d => d.name)]);
const m = await buildManifest(REPOS, { exclude, gh });
fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 1) + '\n');
console.log(m.repos.map(r => `${r.repo}: ${r.skills.length}`).join('\n'), '\ntotal', m.repos.reduce((s, r) => s + r.skills.length, 0));
