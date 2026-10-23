// Version notes at session start. Two things drift apart without anyone noticing:
//   - the native binary (qbranch / qbranch.exe) is installed apart from the plugins, so `claude plugin update` never
//     refreshes it: each plugin compares the binary's VERSION file with its own version (stamped at build time);
//   - the plugins themselves fall behind the latest release: each plugin compares its version with a cached
//     latest.json that a detached background refresher updates at most once a day (one GitHub request).
// Once per session across all plugins, one combined note says what is behind and the exact commands to fix it.
// SessionStart only reads files (and may spawn the detached refresher): it never waits on the network or the binary.
// Plugin-only users (no binary) are never told about the binary. QBRANCH_UPDATE_CHECK=0 turns the release check off.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { selfCommand } from './project.mjs';

/** This bundle's version (stamped by sync/build); null when running from source. */
export const VERSION = typeof __QBRANCH_VERSION__ === 'string' ? __QBRANCH_VERSION__ : null; // eslint-disable-line no-undef

export const qbranchHome = (env = process.env) => env.QBRANCH_HOME || path.join(os.homedir(), '.qbranch');

const repoOf = (env) => env.QBRANCH_REPO || 'grexican/qbranch';
/** The one-line installer for a shell that has no `irm` (Windows Command Prompt), or the POSIX one. */
export function installCommand(platform = process.platform, env = process.env) {
  const base = `https://raw.githubusercontent.com/${repoOf(env)}/main/scripts`;
  return platform === 'win32'
    ? `powershell -NoProfile -ExecutionPolicy Bypass -Command "irm ${base}/install.ps1 | iex"`
    : `curl -fsSL ${base}/install.sh | sh`;
}

/** Compare x.y.z versions numerically (a leading v and any -suffix are ignored). Returns -1, 0 or 1. */
export function cmpVersion(a, b) {
  const p = (v) => String(v).trim().replace(/^v/, '').split('-')[0].split('.').map(n => Number.parseInt(n, 10) || 0);
  const x = p(a), y = p(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0) ? -1 : 1;
  return 0;
}

const user = () => { try { return os.userInfo().username.replace(/[^A-Za-z0-9_.-]/g, '_'); } catch { return String(process.getuid?.() ?? 'user'); } };
const markDirDefault = () => path.join(os.tmpdir(), `qbranch-${user()}`, 'notes');
const SHIMS = ['headjack', 'middleout', 'moneyball', 'groundhog'];

// ---------- the latest release, cached ----------
const DAY = 864e5;
const STALE_LOCK = 10 * 60_000;
export const latestFile = (env = process.env) => path.join(qbranchHome(env), 'latest.json');
const optedOut = (env) => env.QBRANCH_UPDATE_CHECK === '0';

/** The cached { version, checkedAt } or null (missing or unreadable: never throws). */
export function readLatest(env = process.env) {
  try { const j = JSON.parse(fs.readFileSync(latestFile(env), 'utf8')); return j && typeof j === 'object' && !Array.isArray(j) ? j : null; } catch { return null; }
}
/** True when the cache is missing, unreadable, or was last checked more than a day ago. */
export const needsRefresh = (latest, now = Date.now()) => !(latest && Date.parse(latest.checkedAt) > now - DAY);

const takeLock = (lock) => {
  try { fs.mkdirSync(path.dirname(lock), { recursive: true }); fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); return true; } catch {
    try { if (Date.now() - fs.statSync(lock).mtimeMs > STALE_LOCK) { fs.rmSync(lock, { force: true }); return takeLock(lock); } } catch { /* raced */ }
    return false;
  }
};

const runCmd = (cmd, args) => {
  try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000, windowsHide: true }); } catch { return null; }
};

/** The latest release's version: `gh` when it is installed (works for private repos), else the GitHub API. */
export async function latestTag({ env = process.env, run = runCmd, fetchImpl = globalThis.fetch } = {}) {
  const repo = repoOf(env);
  const viaGh = run('gh', ['api', `repos/${repo}/releases/latest`, '--jq', '.tag_name']);
  if (viaGh && viaGh.trim()) return viaGh.trim().replace(/^v/, '');
  const r = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { 'User-Agent': 'qbranch', Accept: 'application/vnd.github+json', ...(env.GITHUB_TOKEN ? { Authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}) },
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  const tag = String((await r.json())?.tag_name || '').replace(/^v/, '');
  if (!tag) throw new Error('no release tag');
  return tag;
}

/**
 * The background refresher (`<tool> refresh-latest`): ask GitHub once, write latest.json atomically. checkedAt is
 * stamped even when the request fails, so a dead network is not retried every session. One refresher at a time.
 */
export async function refreshLatest({ env = process.env, run, fetchImpl } = {}) {
  if (optedOut(env)) return null;
  const f = latestFile(env), lock = `${f}.lock`;
  // the session hook takes the lock before spawning us (so four plugins spawn one refresher) and says so
  if (env.QBRANCH_REFRESH_LOCK_HELD !== '1' && !takeLock(lock)) return null;
  try {
    let version = null, error = null;
    try { version = await latestTag({ env, run, fetchImpl }); } catch (e) { error = String(e?.message || e).slice(0, 200); }
    const prev = readLatest(env);
    const out = { version: version ?? prev?.version ?? null, checkedAt: new Date().toISOString(), ...(error ? { error } : {}) };
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n');
    fs.renameSync(tmp, f);
    return out;
  } catch { return null; } finally { try { fs.rmSync(lock, { force: true }); } catch { /* gone */ } }
}

const defaultSpawner = async ({ tool, script, env }) => {
  const [file, pre] = await selfCommand(tool, script);
  spawn(file, [...pre, 'refresh-latest'], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...env, QBRANCH_REFRESH_LOCK_HELD: '1' } }).unref();
};

/** Start the background refresher when the cache is stale. Returns true when one was started. Never throws. */
export async function maybeRefresh({ env = process.env, tool, script = process.argv[1], spawner = defaultSpawner, now = Date.now() } = {}) {
  try {
    if (optedOut(env) || !tool || !needsRefresh(readLatest(env), now)) return false;
    const lock = `${latestFile(env)}.lock`;
    if (!takeLock(lock)) return false; // another plugin of this session (or a running refresher) has it
    try { await spawner({ tool, script, env }); return true; } catch { fs.rmSync(lock, { force: true }); return false; }
  } catch { return false; }
}

// ---------- which qbranch plugins this session runs ----------
const claudeHome = (env) => env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const within = (dir, root) => { const r = path.relative(path.resolve(root), path.resolve(dir)); return !r.startsWith('..') && !path.isAbsolute(r); };

/** qbranch plugins Claude Code has installed for this directory: [{ name, version }] (user scope, or a project that contains cwd). */
export function installedPlugins({ env = process.env, cwd = process.cwd() } = {}) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(claudeHome(env), 'plugins', 'installed_plugins.json'), 'utf8'));
    const out = [];
    for (const [id, installs] of Object.entries(j?.plugins || {})) {
      const [name, market] = id.split('@');
      if (market !== 'qbranch' || !Array.isArray(installs)) continue;
      // a project install for this directory wins over the user-scope one
      const proj = installs.filter(i => i?.projectPath && within(cwd, i.projectPath)).sort((a, b) => b.projectPath.length - a.projectPath.length)[0];
      const pick = proj || installs.find(i => i?.scope === 'user');
      if (pick?.version) out.push({ name, version: pick.version });
    }
    return out;
  } catch { return []; }
}

// ---------- the note ----------
/** A SessionStart decision with the version note appended (once per session), or the decision unchanged. */
export async function withBinaryNote(h, d = null, opts = {}) {
  await maybeRefresh({ tool: opts.tool, script: opts.script, env: opts.env, spawner: opts.spawner });
  const n = binaryNote({ sessionId: h?.sessionId || '', harness: h?.platform || 'claude', cwd: h?.cwd, ...opts });
  if (!n) return d;
  return d ? { ...d, context: d.context ? `${d.context}\n\n${n}` : n } : { context: n };
}

/**
 * One combined note when this session's plugins are behind the latest release and/or the binary is behind, else null.
 *   sessionId  one note per session across every plugin (a per-user marker file)
 *   version    this plugin's version (default: the stamped VERSION)
 *   tool       this plugin's name (always listed when it is behind)
 *   harness    the agent platform (claude, cursor, codex, ...): decides the upgrade commands
 */
export function binaryNote({ sessionId = '', version = VERSION, tool = null, harness = 'claude', cwd = process.cwd(), env = process.env,
  platform = process.platform, markDir = markDirDefault() } = {}) {
  try {
    if (!version || version === 'dev') return null;
    const latest = optedOut(env) ? null : readLatest(env)?.version || null;
    const pluginsBehind = !!latest && cmpVersion(version, latest) < 0;

    const home = qbranchHome(env);
    let bin = null;
    try { bin = fs.readFileSync(path.join(home, 'VERSION'), 'utf8').trim(); } catch { /* installers before v0.5.1 wrote none */ }
    const hasExe = fs.existsSync(path.join(home, platform === 'win32' ? 'qbranch.exe' : 'qbranch'));
    const target = pluginsBehind ? latest : version; // after the plugin upgrade, the binary should match the release
    const binBehind = bin !== 'dev' && (bin || hasExe) && (!bin || cmpVersion(bin, target) < 0);
    if (!pluginsBehind && !binBehind) return null;

    const key = (sessionId || `ppid-${process.ppid}`).replace(/[^A-Za-z0-9_.-]/g, '_');
    const mark = path.join(markDir, `binary-${key}`);
    if (fs.existsSync(mark)) return null;
    fs.mkdirSync(markDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(mark, version, { mode: 0o600 });

    const parts = [];
    if (pluginsBehind) {
      const fromRegistry = harness === 'claude' ? installedPlugins({ env, cwd }).filter(p => cmpVersion(p.version, latest) < 0).map(p => p.name) : [];
      const names = [...new Set([...(tool ? [tool] : []), ...fromRegistry])].sort();
      const list = names.length ? names : SHIMS;
      parts.push(harness === 'claude'
        ? `qbranch plugins are behind the latest release (v${version} -> v${latest}): run \`claude plugin marketplace update qbranch\`, then \`claude plugin update <name>@qbranch\` for ${list.join(', ')}, then restart Claude Code.`
        : `qbranch plugins are behind the latest release (v${version} -> v${latest}): run \`qbranch update\`, then \`qbranch install ${list.join(' ')} --platform ${harness}\`.`);
    }
    if (binBehind && !(pluginsBehind && harness !== 'claude')) { // the non-Claude upgrade path already starts with `qbranch update`
      // when the binary's bin/ comes first on PATH, its older commands shadow the plugin's newer ones
      // compare case-insensitively only where the file system is (Windows, macOS); look files up by the real spelling
      const fold = platform === 'linux' ? (d) => d : (d) => d.toLowerCase();
      const dirs = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean).map(d => path.resolve(d));
      const homeBin = dirs.findIndex(d => fold(d) === fold(path.resolve(home, 'bin')));
      const pluginBin = dirs.findIndex(d => /[\\/]plugins[\\/]/i.test(d) && /[\\/]bin$/i.test(d) && SHIMS.some(s => fs.existsSync(path.join(d, s))));
      const shadow = homeBin >= 0 && pluginBin >= 0 && homeBin < pluginBin
        ? ` Until then its commands (${path.join(home, 'bin')}) come first on PATH and shadow the plugins' newer ones.` : '';
      const what = bin ? `qbranch binary v${bin.replace(/^v/, '')} is older than the plugins (v${target})` : `qbranch binary is older than the plugins (v${target}; it was installed before versions were tracked)`;
      const alt = platform === 'win32' ? `Command Prompt: ${installCommand(platform, env)}` : installCommand(platform, env);
      parts.push(`${what}: run \`qbranch update\` (or ${alt}).${shadow}`);
    }
    return parts.join(' ');
  } catch { return null; } // a version note must never break a session
}
