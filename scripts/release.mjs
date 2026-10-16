#!/usr/bin/env node
// Cut a release: one version for every gadget (one release train).
//
//   npm run release:patch        fixes, docs, tuning; a hotfix is a patch released right away
//   npm run release:minor        something new: a gadget, command, platform or capability
//   npm run release:major        breaks something a user wired up: hook contract, config keys, CLI commands or flags,
//                                ledger/stats formats
//   npm run release -- 1.4.0     an explicit version;  add --dry-run to any of them to see the plan only
//
// What it does: preflight (on main, clean tree, in sync with origin, tests pass, generated files current), bump the
// version in every package.json and plugin.json (plugin versions matter: `claude plugin update` only refreshes on a
// version change), regenerate (marketplaces, adapters, bundles), write CHANGELOG.md from the commits since the last
// tag, commit, tag vX.Y.Z, push. CI then builds the native binaries and publishes the GitHub release from the tag.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const bump = args.find(a => !a.startsWith('--'));
const sh = (cmd, a, opts = {}) => execFileSync(cmd, a, { cwd: ROOT, encoding: 'utf8', stdio: opts.show ? 'inherit' : 'pipe', shell: process.platform === 'win32' && cmd === 'npm' }) ?? '';
const git = (...a) => sh('git', a).trim();
const fail = (msg) => { console.error(`release: ${msg}`); process.exit(1); };

if (!bump) fail('which bump? patch | minor | major | <x.y.z>   (add --dry-run to preview)');
const current = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const [M, m, p] = current.split('.').map(Number);
const next = bump === 'major' ? `${M + 1}.0.0` : bump === 'minor' ? `${M}.${m + 1}.0` : bump === 'patch' || bump === 'hotfix' ? `${M}.${m}.${p + 1}`
  : /^\d+\.\d+\.\d+$/.test(bump) ? bump : fail(`"${bump}" is not patch | minor | major | x.y.z`);
const newer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
if (!newer(next, current)) fail(`${next} is not newer than ${current}`);
const tag = `v${next}`;

// ---------- preflight ----------
const step = (s) => console.log(`- ${s}`);
step(`release ${current} -> ${next} (${tag})${dry ? '  [dry run]' : ''}`);
if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') fail('releases are cut from main');
if (git('status', '--porcelain')) fail('the working tree is not clean: commit or stash first');
git('fetch', '-q', 'origin');
if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) fail('main is not in sync with origin/main: pull or push first');
if (git('tag', '-l', tag)) fail(`${tag} already exists`);
step('tests'); sh('npm', ['test']);
step('generated files are current'); sh('npm', ['run', 'sync:check']);

// ---------- changelog from commits since the last tag ----------
const last = (() => { try { return git('describe', '--tags', '--abbrev=0', '--match', 'v*'); } catch { return null; } })();
const log = git('log', '--no-merges', '--format=%s', last ? `${last}..HEAD` : 'HEAD').split('\n').filter(Boolean)
  .filter(s => !/^release v\d/.test(s));
const byGadget = new Map();
for (const s of log) {
  const g = (s.match(/^(core|headjack|middleout|moneyball|groundhog|replay|tune|sync|ci|docs)\b/i)?.[1] || 'other').toLowerCase();
  (byGadget.get(g) || byGadget.set(g, []).get(g)).push(s);
}
const date = new Date().toISOString().slice(0, 10);
const section = [`## ${tag} (${date})`, '', ...[...byGadget].flatMap(([g, list]) => [`**${g}**`, ...list.map(s => `- ${s}`), ''])].join('\n');
step(`changelog: ${log.length} commits since ${last || 'the beginning'}`);
if (dry) { console.log(`\n${section}`); console.log('dry run: nothing written, committed or pushed'); process.exit(0); }

// ---------- bump every version ----------
const files = ['package.json', ...fs.readdirSync(path.join(ROOT, 'packages')).flatMap(d => [
  `packages/${d}/package.json`, `packages/${d}/.claude-plugin/plugin.json`])].filter(f => fs.existsSync(path.join(ROOT, f)));
for (const f of files) {
  const full = path.join(ROOT, f);
  const j = JSON.parse(fs.readFileSync(full, 'utf8'));
  j.version = next;
  for (const k of ['dependencies', 'devDependencies']) if (j[k]?.['@qbranch/core']) j[k]['@qbranch/core'] = next; // one train
  fs.writeFileSync(full, JSON.stringify(j, null, 2) + '\n');
}
step(`bumped ${files.length} manifests`);
sh('npm', ['install', '--package-lock-only', '--silent']);
sh('npm', ['run', 'sync']);
step('regenerated marketplaces, adapters and bundles');
const cl = path.join(ROOT, 'CHANGELOG.md');
const prev = fs.existsSync(cl) ? fs.readFileSync(cl, 'utf8').replace(/^# Changelog\n+/, '') : '';
fs.writeFileSync(cl, `# Changelog\n\n${section}\n${prev}`);
sh('npm', ['test']);   // the bumped tree must still pass before anything leaves the machine

// ---------- commit, tag, push ----------
git('add', '-A');
git('commit', '-q', '-m', `release ${tag}`);
git('tag', '-a', tag, '-m', `release ${tag}`);
git('push', '-q', 'origin', 'main');
git('push', '-q', 'origin', tag);
step(`pushed ${tag}. CI builds the binaries and publishes the release: gh run watch --repo $(git remote get-url origin)`);
