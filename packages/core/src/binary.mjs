// The native binary (qbranch / qbranch.exe) is installed apart from the plugins, so `claude plugin update` never
// refreshes it. At session start each plugin compares the binary's VERSION file with its own version (stamped into the
// bundle at build time) and, once per session across all plugins, says when the binary is behind. File reads only:
// the binary itself is never spawned, so the check stays fast. Plugin-only users (no binary) are never told anything.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

/** A SessionStart decision with the binary note appended (once per session), or the decision unchanged. */
export function withBinaryNote(h, d = null, opts = {}) {
  const n = binaryNote({ sessionId: h?.sessionId || '', ...opts });
  if (!n) return d;
  return d ? { ...d, context: d.context ? `${d.context}\n\n${n}` : n } : { context: n };
}

/**
 * One-line note when the installed binary is older than this plugin, else null.
 *   sessionId  one note per session across every plugin (a per-user marker file)
 *   version    this plugin's version (default: the stamped VERSION)
 */
export function binaryNote({ sessionId = '', version = VERSION, env = process.env, platform = process.platform, markDir = markDirDefault() } = {}) {
  try {
    if (!version || version === 'dev') return null;
    const home = qbranchHome(env);
    const exe = path.join(home, platform === 'win32' ? 'qbranch.exe' : 'qbranch');
    let bin = null;
    try { bin = fs.readFileSync(path.join(home, 'VERSION'), 'utf8').trim(); } catch { /* installers before v0.5.1 wrote none */ }
    if (bin === 'dev') return null; // a source build: nothing to compare against
    const hasExe = fs.existsSync(exe);
    if (!bin && !hasExe) return null; // no binary installed: plugin-only users are never nagged
    if (bin && cmpVersion(bin, version) >= 0) return null;
    const key = (sessionId || `ppid-${process.ppid}`).replace(/[^A-Za-z0-9_.-]/g, '_');
    const mark = path.join(markDir, `binary-${key}`);
    if (fs.existsSync(mark)) return null;
    fs.mkdirSync(markDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(mark, version, { mode: 0o600 });
    // when the binary's bin/ comes first on PATH, its older commands shadow the plugin's newer ones
    // compare case-insensitively only where the file system is (Windows, macOS); look files up by the real spelling
    const fold = platform === 'linux' ? (d) => d : (d) => d.toLowerCase();
    const dirs = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean).map(d => path.resolve(d));
    const homeBin = dirs.findIndex(d => fold(d) === fold(path.resolve(home, 'bin')));
    const pluginBin = dirs.findIndex(d => /[\\/]plugins[\\/]/i.test(d) && /[\\/]bin$/i.test(d) && SHIMS.some(s => fs.existsSync(path.join(d, s))));
    const shadow = homeBin >= 0 && pluginBin >= 0 && homeBin < pluginBin
      ? ` Until then its commands (${path.join(home, 'bin')}) come first on PATH and shadow the plugins' newer ones.` : '';
    const what = bin ? `qbranch binary v${bin.replace(/^v/, '')} is older than the plugins (v${version})` : `qbranch binary is older than the plugins (v${version}; it was installed before versions were tracked)`;
    const alt = platform === 'win32' ? `Command Prompt: ${installCommand(platform, env)}` : installCommand(platform, env);
    return `${what}: run \`qbranch update\` (or ${alt}).${shadow}`;
  } catch { return null; } // a version note must never break a session
}
