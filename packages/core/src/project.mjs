// Project root resolution and small cross-platform helpers shared by every tool.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Nearest ancestor with .git (or any of the given marker files); falls back to the start dir. */
export function projectRoot(markers = [], start = process.env.CLAUDE_PROJECT_DIR || process.env.CURSOR_PROJECT_DIR || process.cwd()) {
  let d = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(d, '.git')) || markers.some(m => fs.existsSync(path.join(d, m)))) return d;
    const up = path.dirname(d);
    if (up === d) return path.resolve(start);
    d = up;
  }
}

/** Expand a leading ~ and resolve against a base directory (Windows, macOS and Linux). */
export const expandPath = (p, base = process.cwd()) => path.resolve(base, p.replace(/^~(?=$|[\\/])/, os.homedir()));

export const readJson = (f, fallback = {}) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };

/** Read stdin fully (hook input). Resolves '' when there is no stdin. */
export async function readStdin() {
  if (process.stdin.isTTY) return '';
  let raw = ''; for await (const c of process.stdin) raw += c; return raw;
}

/**
 * How to re-invoke a tool from inside itself: the native binary (multi-call, `<binary> <tool> ...`) when running as a
 * single executable, else `node <script>`. Returns [file, argsPrefix].
 */
export async function selfCommand(tool, script) {
  try { const sea = await import('node:sea'); if (sea.isSea()) return [process.execPath, [tool]]; } catch { /* not a SEA build */ }
  return [process.execPath, [script]];
}
