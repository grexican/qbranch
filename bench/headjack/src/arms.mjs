// The four arms. Each builds a template project once per library (cached), and every run copies the template into a
// throwaway sandbox with makeSandbox from @qbranch/core/replay (mode 'copy': never the live tree).
//   none          no skills
//   native        every library skill in .claude/skills
//   native-again  the same as native, run again (the A/A noise floor)
//   headjack      root skills only; the library is an in-place source with a prebuilt index; the hook on every prompt
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO, CACHE_DIR, BENCH } from './paths.mjs';

export const ARMS = ['none', 'native', 'native-again', 'headjack'];
const HJ = path.join(REPO, 'packages', 'headjack');
const fwd = (p) => p.split(path.sep).join('/');
export const THRESHOLDS_FILE = path.join(BENCH, 'frozen-thresholds.json');

export function thresholds() {
  try { return JSON.parse(fs.readFileSync(THRESHOLDS_FILE, 'utf8')); } catch { return null; }
}

/** A PATH directory with a `headjack` command (sh and cmd), so the root skills' `headjack get` works unchanged. */
export function shimDir() {
  const dir = path.join(CACHE_DIR, 'shim');
  const bin = fwd(path.join(HJ, 'bin', 'headjack.mjs'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'headjack'), `#!/bin/sh\nexec node "${bin}" "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'headjack.cmd'), `@node "${bin.replace(/\//g, '\\')}" %*\r\n`);
  return dir;
}

const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };


/**
 * Template dir for an arm over a materialized library dir. Returns { dir, settings(), env() } where settings/env are
 * applied per run (absolute paths that must not be copied into the template).
 */
export async function armTemplate(arm, { libDir, key, thresholds: th = thresholds() || {} }) {
  const base = path.join(CACHE_DIR, 'arms', arm === 'native-again' ? 'native' : arm, key || 'none');
  const stamp = path.join(base, '.stamp');
  const want = JSON.stringify({ libDir, v: 4 });
  const dir = path.join(base, 'project');
  if (!(fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === want)) {
    fs.rmSync(base, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    if (arm === 'native' || arm === 'native-again') {
      fs.cpSync(libDir, path.join(dir, '.claude', 'skills'), { recursive: true });
    } else if (arm === 'headjack') {
      for (const s of ['find-skill', 'load-skill']) fs.cpSync(path.join(HJ, 'skills', s), path.join(dir, '.claude', 'skills', s), { recursive: true });
      writeConfig(dir, libDir, th);
      fs.mkdirSync(path.join(dir, '.headjack', 'library'), { recursive: true });
      await buildIndex(dir);
    }
    write(stamp, want);
  }
  if (arm === 'headjack') writeConfig(dir, libDir, th);
  return {
    dir,
    settings: () => (arm === 'headjack' ? { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `node "${fwd(path.join(HJ, 'bin', 'headjack.mjs'))}" hook`, timeout: 60 }] }] } } : {}),
    env: () => (arm === 'headjack' ? headjackEnv() : {}),
  };
}

/** headjack's personal space points at an empty temp dir: the user's ~/.headjack is never read. */
export function headjackEnv() {
  const home = path.join(os.tmpdir(), 'hjbench-headjack-home');
  fs.mkdirSync(path.join(home, 'library'), { recursive: true });
  const sep = process.platform === 'win32' ? ';' : ':';
  return { HEADJACK_HOME: home, PATH: `${shimDir()}${sep}${process.env.PATH || process.env.Path || ''}`, HEADJACK_STATS: '1' };
}

function writeConfig(dir, libDir, th) {
  const cfg = { sources: [fwd(libDir)], external: false, stats: '.headjack-stats.json', ...(th.strong != null ? { strong: th.strong } : {}), ...(th.suggestMax != null ? { suggestMax: th.suggestMax } : {}) };
  write(path.join(dir, 'headjack.config.json'), JSON.stringify(cfg, null, 2) + '\n');
}

async function buildIndex(dir) {
  const prev = { home: process.env.HEADJACK_HOME };
  process.env.HEADJACK_HOME = headjackEnv().HEADJACK_HOME;
  try {
    const { loadConfig } = await import('../../../packages/headjack/src/config.mjs');
    const { reindex, db } = await import('../../../packages/headjack/src/library.mjs');
    const cfg = loadConfig(dir);
    await reindex(cfg);
    db(cfg).close?.();
  } finally { if (prev.home === undefined) delete process.env.HEADJACK_HOME; else process.env.HEADJACK_HOME = prev.home; }
}

/** Files the arm put in the template, which are never counted as the agent's output. */
export const TEMPLATE_PATHS = /^(headjack\.config\.json|\.headjack-stats\.json|\.claude\/|\.headjack\/)/;
