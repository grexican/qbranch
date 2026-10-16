// History scenarios: SWE-bench from your own repositories. A real past commit becomes a graded build task.
//   sandbox       a snapshot of the commit's parent in a fresh one-commit repo (the agent cannot see the future)
//   prompt        the commit message, plus the PR title and body when `gh` finds one. Never the diff.
//   hidden tests  the test files the commit added or changed, applied only after the agent finishes
//   grading       fail-to-pass (hidden tests), pass-to-pass (their neighbours), optional lint and typecheck
// A scenario is accepted only when the parent fails its hidden tests and the real commit passes them.
//
//   mineScenarios({ root, limit, since })                          -> { scanned, scenarios, rejected }
//   validateScenario(s, { install })                               -> s with status valid | rejected | needs-install
//   runScenario(s, { agent, model, setup, budgetUsd, timeoutMs })  -> run (with run.suites), gradeable by gradeRun
// Scenarios are tasks: compareVariants({ tasks: scenarios, runner: runScenario, ... }) works unchanged.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { runTask, killTree } from './replay.mjs';

const git = (args, opts = {}) => spawnSync('git', args, { encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024, ...opts });
const json = (t) => { try { return JSON.parse(t); } catch { return null; } };
const posix = (p) => p.split(path.sep).join('/');

// ---------- what counts as a test ----------

/** A runnable test file: *.test.* / *.spec.*, anything under __tests__, or a JS file under test/ (node --test's default). */
export const isTestFile = (p) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) || /(^|\/)__tests__\/.+\.[cm]?[jt]sx?$/.test(p) || /(^|\/)test\/.+\.[cm]?js$/.test(p);
/** Support that belongs to the tests (fixtures, snapshots, helpers in a tests dir): hidden with them, never run. */
const isTestSupport = (p) => /(^|\/)(tests?|__tests__|__fixtures__|fixtures|__snapshots__)\//.test(p) || /\.snap$/.test(p);
const DEP_FILES = /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|bun\.lockb?)$/;

/** A path glob (`**`, `*`, `?`) as a RegExp; a pattern with no wildcard matches that path or anything under it. */
export function glob(g) {
  g = String(g).replace(/^\.\//, '');
  if (!/[*?]/.test(g)) { const p = g.replace(/\/$/, ''); return { test: (x) => x === p || x.startsWith(p + '/') }; }
  const re = g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\u0000').replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '(.*/)?').replace(/\u0001/g, '.*');
  return new RegExp(`^${re}$`);
}

/**
 * Per-repo settings, from qbranch.scenarios.json at the repo root (all optional):
 *   test        command run from the repo root; {files} is replaced by the test files (else they are appended)
 *   lint, typecheck   a command, or false to skip; default: the repo's own `lint` / `typecheck` script
 *   include, exclude  globs over test file paths: only included, non-excluded test files are run
 *   maxFiles    commits that change more non-test files than this are skipped (default 20)
 *   neighbours  how many unchanged test files beside the hidden ones form the pass-to-pass set (default 10)
 *   testTimeoutSec    per test command (default 600)
 *   interface   false: do not tell the agent which new names the hidden tests import (default: tell it)
 * QBRANCH_SCENARIOS_CONFIG names another file (settings for a repo you may not write to).
 */
export function scenarioConfig(root) {
  const file = process.env.QBRANCH_SCENARIOS_CONFIG || path.join(root, 'qbranch.scenarios.json'); // env: settings without touching the repo
  const c = json(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'null') || {};
  return { maxFiles: 20, neighbours: 10, testTimeoutSec: 600, ...c, include: (c.include || []).map(glob), exclude: (c.exclude || []).map(glob) };
}
const runnable = (cfg, p) => isTestFile(p) && (!cfg.include.length || cfg.include.some(g => g.test(p))) && !cfg.exclude.some(g => g.test(p));

// ---------- how to run tests ----------

const VALUED = /^(--import|--require|-r|--loader|--experimental-loader|--test-reporter|--test-reporter-destination|--test-concurrency|--test-name-pattern|--test-skip-pattern|--test-timeout|--env-file|--conditions|-C)$/;
/** The test runner a package.json test script calls, as a command that takes test files; null when it is not one we know. */
export function runnerFromScript(script) {
  const t = String(script).split(/&&|\|\||;/)[0].trim().match(/"[^"]*"|'[^']*'|\S+/g) || [];
  while (t.length && (/^\w+=/.test(t[0]) || t[0] === 'cross-env')) t.shift();
  if (/^(npx|bunx|pnpx)$/.test(t[0])) t.shift();
  else if (/^(pnpm|yarn|bun)$/.test(t[0]) && /^(exec|x)$/.test(t[1] || '')) t.splice(0, 2);
  else if (t[0] === 'yarn' && /^(vitest|jest)$/.test(t[1] || '')) t.shift();
  const [prog, ...args] = t;
  if (prog === 'vitest') return ['vitest', 'run', ...(/^(run|watch|dev)$/.test(args[0] || '') ? args.slice(1) : args)].join(' ');
  if (prog === 'jest') return ['jest', '--runTestsByPath', ...args].join(' '); // paths, not regexes (Windows separators)
  if ((prog === 'node' || prog === 'tsx') && args.includes('--test')) {
    // keep the options, drop the script's own file globs: the caller passes the files to run
    const keep = [];
    for (let i = 0; i < args.length; i++) if (args[i].startsWith('-')) { keep.push(args[i]); if (VALUED.test(args[i]) && args[i + 1]) keep.push(args[++i]); }
    return [prog, ...keep].join(' ');
  }
  return null;
}
const runnerFromDeps = (pkg) => { const d = { ...pkg?.dependencies, ...pkg?.devDependencies }; return d.vitest ? 'vitest run' : d.jest ? 'jest --runTestsByPath' : null; };

const CONFIGS = { vitest: ['vitest.config', 'vite.config', 'vitest.workspace'], jest: ['jest.config'] };
const hasConfig = (read, d, cmd, pkg) => {
  const runner = cmd.split(' ')[0];
  if (runner === 'jest' && pkg.jest) return true;
  return (CONFIGS[runner] || []).some(n => ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'].some(e => read(d === '.' ? `${n}.${e}` : `${d}/${n}.${e}`) != null));
};
/**
 * Where and how a test file runs (or the config's `test`): among the package.json files above it whose test script we
 * can drive, the nearest one with its own runner config, else the nearest one. A workspace package whose script says
 * `vitest run` but has no config of its own is run by the root config in practice.
 */
export function testCommand(read, file, cfg = {}) {
  if (cfg.test) return { cwd: '', cmd: cfg.test };
  const found = [];
  for (let d = path.posix.dirname(file); ; d = path.posix.dirname(d)) {
    const pkg = json(read(d === '.' ? 'package.json' : `${d}/package.json`));
    const cmd = pkg && ((pkg.scripts?.test && runnerFromScript(pkg.scripts.test)) || runnerFromDeps(pkg));
    if (cmd) { const c = { cwd: d === '.' ? '' : d, cmd }; if (hasConfig(read, d, cmd, pkg)) return c; found.push(c); }
    if (d === '.' || d === '/' || d === '') return found[0] || null;
  }
}
/** Test files grouped into one command per package: [{ cwd, cmd, files }] (files relative to cwd). */
export function testPlan(read, files, cfg) {
  const groups = new Map();
  for (const f of files) {
    const t = testCommand(read, f, cfg);
    if (!t) continue;
    const k = `${t.cwd}\u0000${t.cmd}`;
    if (!groups.has(k)) groups.set(k, { ...t, files: [] });
    groups.get(k).files.push(t.cwd ? path.posix.relative(t.cwd, f) : f);
  }
  return [...groups.values()];
}
export const packageManager = (has) => (has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm');
/** The repo's own lint / typecheck command, unless the config names one or turns it off. */
function repoCommand(read, has, cfg, key, scripts) {
  if (cfg[key] === false) return null;
  if (typeof cfg[key] === 'string') return cfg[key];
  const s = json(read('package.json'))?.scripts || {};
  const name = scripts.find(n => s[n]);
  return name ? `${packageManager(has)} run ${name}` : null;
}

const quote = (f) => (/[\s"&|<>^()]/.test(f) ? `"${f}"` : f);
function sh(cmd, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(cmd, { cwd, env, shell: true, windowsHide: true, detached: process.platform !== 'win32' });
    let out = '', killed = false;
    const add = (d) => { out += d; if (out.length > 400_000) out = out.slice(-200_000); };
    const timer = setTimeout(() => { killed = true; killTree(child); }, timeoutMs);
    child.stdout.on('data', add); child.stderr.on('data', add);
    const done = (code) => { clearTimeout(timer); resolve({ pass: code === 0 && !killed, exitCode: code, killed, ms: Date.now() - t0, tail: out.replace(/\x1b\[[0-9;]*m/g, '').slice(-2000) }); };
    child.on('error', (e) => { add(e.message); done(-1); });
    child.on('close', (c) => done(c ?? -1));
    child.on('exit', (c) => setTimeout(() => done(c ?? -1), 5000).unref()); // an orphan holding the pipes must not hang us
    child.stdin.on('error', () => {}); child.stdin.end();
  });
}
/** Environment for a command in the sandbox: its node_modules/.bin dirs first, git confined, no inherited test context. */
function cmdEnv(sb, cwd) {
  const env = { ...process.env, ...sb.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' };
  delete env.NODE_TEST_CONTEXT; // set by an outer `node --test`; a nested runner would report to it instead of exiting
  const key = Object.keys(env).find(k => /^path$/i.test(k)) || 'PATH';
  const bins = [];
  for (let d = cwd; ; d = path.dirname(d)) { bins.push(path.join(d, 'node_modules', '.bin')); if (path.resolve(d) === path.resolve(sb.root) || path.dirname(d) === d) break; }
  env[key] = [...bins, env[key]].join(path.delimiter);
  return env;
}
/** Run test groups in the sandbox; pass only when every group passes. */
async function runGroups(sb, groups, cfg) {
  const results = [];
  for (const g of groups) {
    const files = g.files.map(quote).join(' ');
    const cmd = g.cmd.includes('{files}') ? g.cmd.replace('{files}', files) : `${g.cmd} ${files}`;
    const cwd = path.join(sb.root, g.cwd);
    results.push({ cmd, cwd: g.cwd, ...(await sh(cmd, { cwd, env: cmdEnv(sb, cwd), timeoutMs: cfg.testTimeoutSec * 1000 })) });
  }
  return { pass: results.length > 0 && results.every(r => r.pass), ms: results.reduce((a, r) => a + r.ms, 0), tail: results.filter(r => !r.pass).map(r => `$ ${r.cmd}\n${r.tail}`).join('\n').slice(-2000), groups: results.map(({ tail, ...r }) => r) };
}
const runOne = async (sb, cmd, cfg) => ({ cmd, ...(await sh(cmd, { cwd: sb.root, env: cmdEnv(sb, sb.root), timeoutMs: cfg.testTimeoutSec * 1000 })) });

// ---------- sandbox: a snapshot of one commit ----------

/**
 * A throwaway one-commit repository holding `ref`'s tree. Unlike a worktree it shares nothing with the live repository:
 * no refs, no objects, so the agent cannot read the commit it is asked to reproduce. The tree is exported through a
 * temporary index (the live index and working tree are never touched). Same shape as replay's makeSandbox.
 */
export function snapshotSandbox(root, ref) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'qbranch-replay-')));
  const hooks = path.join(base, 'git-hooks'), work = path.join(base, 'work');
  fs.mkdirSync(hooks); fs.mkdirSync(work);
  fs.writeFileSync(path.join(hooks, 'pre-push'), '#!/bin/sh\necho "qbranch replay sandbox: push refused" >&2\nexit 1\n', { mode: 0o755 });
  const fail = (what, r) => { fs.rmSync(base, { recursive: true, force: true }); throw new Error(`${what} failed: ${(r.stderr || '').trim().slice(0, 300)}`); };
  const idx = { env: { ...process.env, GIT_INDEX_FILE: path.join(base, 'index') } };
  let r = git(['-C', root, 'read-tree', ref], idx);
  if (r.status !== 0) fail(`git read-tree ${ref}`, r);
  r = git(['-C', root, `--work-tree=${work}`, 'checkout-index', '-a', '-f'], idx);
  if (r.status !== 0) fail('git checkout-index', r);
  fs.rmSync(path.join(base, 'index'), { force: true });
  const env = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: hooks };
  const genv = { env: { ...process.env, ...env } };
  const id = ['-c', 'user.name=qbranch', '-c', 'user.email=qbranch@localhost', '-c', 'commit.gpgsign=false', '-c', 'core.safecrlf=false'];
  for (const a of [['init', '-q', work], ['-C', work, ...id, 'add', '-A'], ['-C', work, ...id, 'commit', '-q', '--no-verify', '--allow-empty', '-m', 'snapshot']]) {
    r = git(a, genv); if (r.status !== 0) fail(`git ${a.filter(x => !x.includes('=') && x !== '-c' && x !== '-C' && x !== work).join(' ')}`, r);
  }
  const links = [];
  const status = () => git(['-C', work, 'status', '--porcelain', '-uall'], genv).stdout || '';
  const cleanup = () => {
    for (const l of links.splice(0)) try { fs.unlinkSync(l); } catch { /* already gone */ } // links first: never recurse into the live node_modules
    try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a locked file on Windows: left for the OS temp cleaner */ }
  };
  return { base, root: work, dir: work, git: true, env, status, cleanup, links };
}

/** Write files as they are at `sha` into the sandbox (status D deletes). entries: [{ path, status }] */
export function applyFiles(work, root, sha, entries) {
  for (const e of entries) {
    const dst = path.join(work, e.path);
    if (e.status === 'D') { fs.rmSync(dst, { force: true }); continue; }
    const r = spawnSync('git', ['-C', root, 'cat-file', 'blob', `${sha}:${e.path}`], { windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`cannot read ${e.path} at ${sha.slice(0, 8)}`);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, r.stdout);
  }
}

const SKIP_NM = new Set(['.vite', '.vitest', '.cache', '.tmp', '.turbo']); // caches: a run's writes stay in the sandbox
/**
 * Reuse the live checkout's installed dependencies: each node_modules dir of a package becomes a real dir in the
 * sandbox whose entries are junctions (symlinks elsewhere) into the live one. Links that point at the repo's own
 * workspace packages are re-pointed at the sandbox's copy, so tests import the code under test, not the live tree.
 */
export function linkDeps(live, work, links = []) {
  const pkgs = (git(['-C', live, 'ls-files', '--', 'package.json', '*/package.json']).stdout || '').split('\n').filter(Boolean).filter(p => !/node_modules\//.test(p));
  const liveReal = fs.realpathSync.native(live);
  const target = (real) => {
    const rel = path.relative(liveReal, real);
    return !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.split(path.sep).includes('node_modules') ? path.join(work, rel) : real;
  };
  const linkDir = (src, dst) => {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      if (SKIP_NM.has(e.name)) continue;
      const s = path.join(src, e.name), d = path.join(dst, e.name);
      if (fs.existsSync(d)) continue;
      let real; try { real = fs.realpathSync.native(s); } catch { continue; } // a dangling link
      const st = fs.statSync(real);
      if (!st.isDirectory()) { fs.copyFileSync(real, d); continue; }
      if (e.name.startsWith('@') && e.isDirectory()) { linkDir(s, d); continue; } // a scope: link its packages one by one
      const t = target(real);
      if (!fs.existsSync(t)) continue; // a workspace package the snapshot does not have yet
      fs.symlinkSync(t, d, 'junction'); links.push(d);
    }
  };
  for (const p of pkgs) {
    const rel = path.posix.dirname(p), src = path.join(live, rel, 'node_modules'), dst = path.join(work, rel, 'node_modules');
    if (fs.existsSync(src) && fs.existsSync(path.dirname(dst)) && !fs.existsSync(dst)) linkDir(src, dst);
  }
  return links;
}

/** A fresh install inside the sandbox (opt-in: --install). Lifecycle scripts never run: a repo's prepare script may edit git config. */
async function installDeps(sb, cfg) {
  const has = (f) => fs.existsSync(path.join(sb.root, f));
  const pm = packageManager(has);
  const cmd = { npm: has('package-lock.json') ? 'npm ci --ignore-scripts --no-audit --no-fund' : 'npm install --ignore-scripts --no-audit --no-fund',
    pnpm: 'pnpm install --frozen-lockfile --ignore-scripts', yarn: 'yarn install --ignore-scripts', bun: 'bun install --ignore-scripts' }[pm];
  const r = await sh(cmd, { cwd: sb.root, env: cmdEnv(sb, sb.root), timeoutMs: Math.max(cfg.testTimeoutSec, 900) * 1000 });
  if (!r.pass) throw new Error(`${cmd} failed: ${r.tail.slice(-300)}`);
  return r;
}

/**
 * Extra PreToolUse guard for scenario runs on linked dependencies: the sandbox's node_modules entries point into the
 * live checkout, so installs and deletes there would reach it. Self-contained: its source is written into the sandbox.
 */
export function depsGuard({ tool = '', input = {} } = {}) {
  input = input || {};
  const f = String(input.file_path ?? input.path ?? input.notebook_path ?? '');
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(tool) && /(^|[\\/])node_modules([\\/]|$)/.test(f)) return 'edits installed dependencies (they are shared with the live checkout)';
  if (!/^(Bash|PowerShell|Shell)$/.test(tool)) return '';
  const cmd = String(input.command || '');
  if (/\b(npm|pnpm|yarn|bun)\s+(i|install|ci|add|remove|rm|uninstall|un|update|up|upgrade|link|unlink|prune|dedupe|rebuild)\b/.test(cmd) || /^\s*yarn\s*$/m.test(cmd)) return 'changes installed dependencies (they are shared with the live checkout); work with what is installed';
  if (/\b(rm|rmdir|del|rd|mv|move|Remove-Item|Move-Item|ri|mi)\b[^\n;&|]*node_modules/i.test(cmd)) return 'removes installed dependencies (they are shared with the live checkout)';
  return '';
}
const depsGuardSource = () => `// qbranch scenario guard (generated per run): installed dependencies are shared with the live checkout.
const depsGuard = ${depsGuard.toString()};
let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  let h = {}; try { h = JSON.parse(raw); } catch {}
  const why = depsGuard({ tool: h.tool_name, input: h.tool_input });
  if (why) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'scenario sandbox: ' + why + '.' } }));
});
`;

// ---------- mine ----------

const TRAILER = /^(co-authored-by|signed-off-by|reviewed-by|claude-session|change-id|generated-by|on-behalf-of):/i;
/** The task an agent gets: the commit message (trailers dropped) and the PR text. Never the diff or the tests. */
export function scenarioPrompt(message, pr, iface = []) {
  const msg = String(message).split('\n').filter(l => !TRAILER.test(l.trim())).join('\n').trim();
  const byModule = {};
  for (const i of iface) (byModule[i.module] ||= []).push(i.name);
  return ['Make the change described below in this repository.', '', msg,
    ...(pr ? ['', `Pull request #${pr.number}: ${pr.title}`, ...(pr.body?.trim() ? ['', pr.body.trim().slice(0, 4000)] : [])] : []),
    ...(iface.length ? ['', 'The tests import these names, which do not exist yet:', ...Object.entries(byModule).map(([m, n]) => `- ${n.map(x => `\`${x}\``).join(', ')} from \`${m}\``)] : []),
    '', 'When you are done, the change is checked by tests you cannot see, and the existing tests must keep passing.'].join('\n');
}

function prFor(root, sha) {
  const r = spawnSync('gh', ['pr', 'list', '--state', 'all', '--search', sha, '--json', 'number,title,body', '--limit', '1'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  if (r.status !== 0) return { error: (r.stderr || r.error?.message || 'gh failed').trim().slice(0, 200) };
  return { pr: (json(r.stdout) || [])[0] || null };
}

/**
 * Turn the last `limit` non-merge commits into scenario candidates. Structural filter only (no tests run): a commit
 * needs runnable test files, a code change beside them, at most maxFiles non-test files, and a test runner we can drive.
 * pr: look up each candidate's pull request with `gh` (false skips it; the first gh failure stops further lookups).
 */
export function mineScenarios({ root, limit = 100, since, pr = true } = {}) {
  root = (git(['-C', root, 'rev-parse', '--show-toplevel']).stdout || '').trim() || root;
  if (!root || !fs.existsSync(path.join(root, '.git'))) throw new Error(`not a git repository: ${root}`);
  root = path.resolve(root);
  const cfg = scenarioConfig(root);
  const log = git(['-C', root, 'log', '--no-merges', '--no-renames', '--name-status', `-n${limit}`, ...(since ? [`--since=${since}`] : []), '--format=%x1e%H%x1f%P%x1f%aI%x1f%B%x1f']);
  if (log.status !== 0) throw new Error(`git log failed: ${log.stderr.trim()}`);
  const scenarios = [], rejected = [];
  let scanned = 0, gh = pr;
  for (const rec of log.stdout.split('\x1e').slice(1)) {
    const [rawSha, parents, at, message, names = ''] = rec.split('\x1f');
    const sha = rawSha.trim();
    scanned++;
    const reject = (reason) => rejected.push({ sha, subject: message.split('\n')[0].slice(0, 80), reason });
    const parent = parents.trim().split(' ')[0];
    if (!parent) { reject('root commit'); continue; }
    const files = names.split('\n').map(l => l.split('\t')).filter(x => x.length >= 2).map(([status, p]) => ({ status: status[0], path: p }));
    const hidden = files.filter(f => isTestFile(f.path) || isTestSupport(f.path));
    const tests = hidden.filter(f => f.status !== 'D' && runnable(cfg, f.path)).map(f => f.path);
    const source = files.filter(f => !hidden.includes(f));
    if (!hidden.some(f => isTestFile(f.path))) { reject('no test files changed'); continue; }
    if (!tests.length) { reject('changed tests are excluded or deleted'); continue; }
    if (!source.length) { reject('tests only (no code change to reproduce)'); continue; }
    if (source.length > cfg.maxFiles) { reject(`too large (${source.length} non-test files > ${cfg.maxFiles})`); continue; }
    const read = (p) => { const r = git(['-C', root, 'show', `${sha}:${p}`]); return r.status === 0 ? r.stdout : null; };
    const missing = tests.filter(t => !testCommand(read, t, cfg));
    if (missing.length === tests.length) { reject(`no test runner found (${missing[0]})`); continue; }
    let prInfo = null;
    if (gh) { const r = prFor(root, sha); if (r.error) gh = false; else prInfo = r.pr; }
    const subject = message.split('\n')[0].trim();
    scenarios.push({
      id: `scn_${sha.slice(0, 12)}`, kind: 'scenario', platform: 'scenario', cwd: root, repo: root, sha, parent, at, subject, message: message.trim(), pr: prInfo,
      prompt: scenarioPrompt(message, prInfo), files: { hidden, tests: tests.filter(t => !missing.includes(t)), source },
      deps: files.some(f => DEP_FILES.test(f.path)),
      // the scenario writes only inside its snapshot sandbox, and the replay guard still runs: safe to replay
      readOnly: true, status: 'candidate', checks: [], tags: ['scenario'],
    });
  }
  return { root, scanned, scenarios, rejected };
}

// ---------- interface: names the hidden tests need that the parent does not export ----------

const EXTS = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js', '/index.mjs'];
const exportsName = (src, n) => new RegExp(`export\\s+(declare\\s+)?(default\\s+)?(async\\s+)?(function\\*?|const|let|var|class|interface|type|enum|abstract\\s+class)\\s+${n}\\b`).test(src)
  || new RegExp(`export\\s+(type\\s+)?\\{[^}]*\\b${n}\\b[^}]*\\}`).test(src) || /export\s+\*\s+from/.test(src); // a star re-export: assume it is there
/**
 * The interface the hidden tests expect: named imports from the repo's own relative modules that the parent does not
 * export (SWE-bench Pro's "interface" hint). Without it, a scenario measures how well the agent guesses names, not how
 * well it builds. Names only, never the implementation. read(p) reads the sandbox (the parent).
 */
export function missingInterface(read, tests, existsAtCommit) {
  const out = [], seen = new Set();
  for (const t of tests) {
    const src = read(t) || '';
    for (const m of src.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["'](\.{1,2}\/[^"']+)["']/g)) {
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(t), m[2])).replace(/\.(m|c)?js$/, '');
      const at = EXTS.map(e => base + e).find(p => read(p) != null);
      const module = at || EXTS.map(e => base + e).find(existsAtCommit) || base;
      const code = at ? read(at) : '';
      for (const raw of m[1].split(',')) {
        const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
        if (!/^[A-Za-z_$][\w$]*$/.test(name) || seen.has(`${module}:${name}`) || (code && exportsName(code, name))) continue;
        seen.add(`${module}:${name}`); out.push({ name, module });
      }
    }
  }
  return out;
}

// ---------- validate ----------

const DEPS_ERROR = /Cannot find (module|package) ['"](?![./])|ERR_MODULE_NOT_FOUND|Failed to resolve (import|entry for package) ["'](?![./])|Failed to load url (?![./])/;
/** Neighbours: unchanged runnable test files in the hidden tests' directories (the pass-to-pass set). */
function neighbours(work, s, cfg) {
  const out = [], hidden = new Set(s.files.hidden.map(h => h.path));
  for (const d of [...new Set(s.files.tests.map(t => path.posix.dirname(t)))]) {
    let names = []; try { names = fs.readdirSync(path.join(work, d)); } catch { continue; }
    for (const n of names.sort()) { const p = d === '.' ? n : `${d}/${n}`; if (!hidden.has(p) && runnable(cfg, p) && out.length < cfg.neighbours) out.push(p); }
  }
  return out;
}
const checksFor = (s) => [
  { kind: 'suite', name: 'fail-to-pass', hard: true },
  ...(s.plan.neighbours.length ? [{ kind: 'suite', name: 'pass-to-pass', hard: true }] : []),
  ...(s.plan.lint ? [{ kind: 'suite', name: 'lint', hard: false }] : []),
  ...(s.plan.typecheck ? [{ kind: 'suite', name: 'typecheck', hard: false }] : []),
];
const prepareDeps = async (s, sb, cfg, install) => (install ? installDeps(sb, cfg) : linkDeps(s.repo, sb.root, sb.links));

/**
 * Prove a candidate can discriminate, with no model: at the parent with the hidden tests applied, they must fail; with
 * the real commit applied, they must pass. Then fix the pass-to-pass set (neighbours that pass at the commit) and keep
 * lint / typecheck only when they pass at the commit. Returns a new scenario: status valid | rejected | needs-install.
 */
export async function validateScenario(s, { install = s.install || false, log = () => {} } = {}) {
  const cfg = scenarioConfig(s.repo);
  const t0 = Date.now();
  const done = (status, reason, extra = {}) => ({ ...s, ...extra, status, reason, install, validatedAt: new Date().toISOString(), validationMs: Date.now() - t0 });
  let sb;
  try { sb = snapshotSandbox(s.repo, s.parent); } catch (e) { return done('rejected', e.message); }
  try {
    await prepareDeps(s, sb, cfg, install);
    const read = (p) => { try { return fs.readFileSync(path.join(sb.root, p), 'utf8'); } catch { return null; } };
    const has = (f) => fs.existsSync(path.join(sb.root, f));
    applyFiles(sb.root, s.repo, s.sha, s.files.hidden);
    const tests = testPlan(read, s.files.tests, cfg);
    if (!tests.length) return done('rejected', 'no test runner found at the parent');
    const iface = cfg.interface === false ? [] : missingInterface(read, s.files.tests, (p) => git(['-C', s.repo, 'cat-file', '-e', `${s.sha}:${p}`]).status === 0);
    s = { ...s, interface: iface, prompt: scenarioPrompt(s.message, s.pr, iface) };
    log(`  parent: ${tests.map(g => g.cmd).join('; ')}`);
    const atParent = await runGroups(sb, tests, cfg);
    if (atParent.pass) return done('rejected', 'the parent already passes the hidden tests (cannot discriminate)', { validation: { parent: atParent } });
    if (atParent.groups.every(g => g.killed)) return done('rejected', 'hidden tests time out at the parent', { validation: { parent: atParent } });
    applyFiles(sb.root, s.repo, s.sha, [...s.files.hidden, ...s.files.source]);
    const atCommit = await runGroups(sb, testPlan(read, s.files.tests, cfg), cfg);
    log(`  commit: ${atCommit.pass ? 'pass' : 'fail'}`);
    if (!atCommit.pass) {
      const deps = !install && (DEPS_ERROR.test(atCommit.tail) || s.deps);
      return done(deps ? 'needs-install' : 'rejected', deps ? 'the real commit fails its tests with the live dependencies (try --install)' : 'the real commit fails its own hidden tests', { validation: { parent: atParent, commit: atCommit } });
    }
    let near = neighbours(sb.root, s, cfg), p2p = null;
    if (near.length) { p2p = await runGroups(sb, testPlan(read, near, cfg), cfg); if (!p2p.pass) near = []; }
    const lintCmd = repoCommand(read, has, cfg, 'lint', ['lint']), typeCmd = repoCommand(read, has, cfg, 'typecheck', ['typecheck', 'type-check']);
    const lint = lintCmd ? await runOne(sb, lintCmd, cfg) : null, typecheck = typeCmd ? await runOne(sb, typeCmd, cfg) : null;
    log(`  pass-to-pass ${near.length} file(s)${lint ? `, lint ${lint.pass ? 'ok' : 'fails at the commit (dropped)'}` : ''}${typecheck ? `, typecheck ${typecheck.pass ? 'ok' : 'fails at the commit (dropped)'}` : ''}`);
    const plan = { tests: testPlan(read, s.files.tests, cfg), neighbours: near.length ? testPlan(read, near, cfg) : [], lint: lint?.pass ? lintCmd : null, typecheck: typecheck?.pass ? typeCmd : null };
    // keep the tail of a failure (why the parent fails is the audit trail of a scenario), not of a pass
    const strip = (r) => r && { pass: r.pass, ms: r.ms, ...(r.groups ? { groups: r.groups } : { cmd: r.cmd, exitCode: r.exitCode }), ...(r.pass ? {} : { tail: String(r.tail).slice(-600) }) };
    const v = { ...s, plan };
    return done('valid', '', { plan, checks: checksFor(v), validation: { parent: strip(atParent), commit: strip(atCommit), passToPass: strip(p2p), lint: strip(lint), typecheck: strip(typecheck), dropped: { passToPass: !!p2p && !p2p.pass } } });
  } catch (e) {
    return done('rejected', `validation error: ${e.message.slice(0, 200)}`);
  } finally { sb.cleanup(); }
}

// ---------- run ----------

/**
 * Run a validated scenario: the agent works on a snapshot of the parent (dependencies linked, or freshly installed when
 * the scenario needs it), then the hidden tests are applied and every suite in its plan runs. run.suites feeds the
 * `suite` checks in gradeRun. Same options as runTask; the sandbox is always a snapshot.
 */
export async function runScenario(s, { agent = 'claude', model, setup, budgetUsd, timeoutMs = 1_200_000, keep = false, artifactsDir, force = false } = {}) {
  if (s.status !== 'valid' && !force) throw new Error(`scenario ${s.id} is ${s.status || 'not validated'}: validate it first`);
  const cfg = scenarioConfig(s.repo);
  return runTask(s, {
    agent, model, budgetUsd, timeoutMs, keep, ...(artifactsDir ? { artifactsDir } : {}),
    sandbox: () => snapshotSandbox(s.repo, s.parent),
    setup: async (dir, ctx) => {
      await prepareDeps(s, ctx.sandbox, cfg, s.install);
      const v = (setup && await setup(dir, ctx)) || {};
      if (s.install) return v; // its own install: nothing to protect
      const guard = path.join(ctx.sandbox.base, 'deps-guard.mjs');
      fs.writeFileSync(guard, depsGuardSource());
      const hooks = v.settings?.hooks || {};
      return { ...v, settings: { ...v.settings, hooks: { ...hooks, PreToolUse: [...(hooks.PreToolUse || []), { matcher: '*', hooks: [{ type: 'command', command: `node "${posix(guard)}"` }] }] } } };
    },
    after: async (sb) => {
      applyFiles(sb.root, s.repo, s.sha, s.files.hidden); // the agent's version of a hidden file never counts
      const suites = { 'fail-to-pass': await runGroups(sb, s.plan.tests, cfg) };
      if (s.plan.neighbours?.length) suites['pass-to-pass'] = await runGroups(sb, s.plan.neighbours, cfg);
      if (s.plan.lint) suites.lint = await runOne(sb, s.plan.lint, cfg);
      if (s.plan.typecheck) suites.typecheck = await runOne(sb, s.plan.typecheck, cfg);
      return { suites };
    },
  });
}

// ---------- cache: <repo>/.qbranch/scenarios/<id>.json ----------

export const scenariosDir = (root) => path.join(root, '.qbranch', 'scenarios');
export function saveScenario(s, dir = scenariosDir(s.repo)) {
  fs.mkdirSync(dir, { recursive: true });
  const gi = path.join(dir, '.gitignore'); // tool state never shows up in the user's repo
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n');
  fs.writeFileSync(path.join(dir, `${s.id}.json`), JSON.stringify(s, null, 2) + '\n');
}
/** Cached scenarios, newest commit first; status filters (e.g. 'valid'). */
export function loadScenarios(root, { dir = scenariosDir(root), status } = {}) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => /^scn_.*\.json$/.test(f)).map(f => json(fs.readFileSync(path.join(dir, f), 'utf8'))).filter(Boolean)
    .filter(s => !status || [].concat(status).includes(s.status)).sort((a, b) => String(b.at).localeCompare(String(a.at)));
}
