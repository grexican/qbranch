// Built-in guard (no lesson needed): an inline script whose backslashes will not survive the shell.
//
// On Windows, Git Bash (the MSYS runtime) re-parses its command line and turns \\ into \ before bash sees it, even
// inside a quoted heredoc ('EOF') or a '...' string. So `node -e '..."a\\b"...'` or a heredoc-written regex arrives with
// half its backslashes: a silent change, or a SyntaxError two steps later. POSIX bash keeps them, so the guard fires
// only on Windows (escapeGuard: "auto"); "on" forces it anywhere, "off" disables it.
//
// Measured on 30 days of real transcripts (2,193 sessions, all Git Bash): inline scripts containing \\ failed 39.8% of
// the time (n=668), against 17.8% for inline scripts without a backslash and 7.5% for ordinary shell commands; 31.9%
// were followed by a switch to the Write/Edit tools. Broader triggers measured worse: any backslash 18.1% (no better
// than no backslash at all), \s \d regex escapes 23.3%. ~22 matching commands a day across every project on the
// machine, before the once-per-session-per-kind limit below.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { upsert } from './stats.mjs';

const HEREDOC = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n([\s\S]*?)(\n\2\s*(?:$|\n)|$)/;
const EVAL = /\b(node|nodejs|python3?|py|deno|bun|perl|ruby|php)(?:\s+-\S+)*\s+(-e|-c|-r|--eval|eval)\s+(['"])([\s\S]*?)(\3|$)/;

/** The inline script of a shell command: { kind: 'heredoc' | 'eval', body } or null. */
export function inlineScript(cmd) {
  const h = cmd.match(HEREDOC);
  if (h) return { kind: 'heredoc', body: h[3] };
  const e = cmd.match(EVAL);
  if (e) return { kind: 'eval', body: e[4] };
  return null;
}

/** The risky construct in a command, or null: an inline script whose text holds a doubled backslash. */
export function escapeRisk(cmd) {
  const s = inlineScript(cmd || '');
  return s && s.body.includes('\\\\') ? s.kind : null;
}

export const WORDING = {
  heredoc: 'groundhog: Git Bash on Windows turns \\\\ into \\ before this runs, even in a quoted heredoc, so the script will not get the backslashes you wrote. Write the file with the Write tool, then run it.',
  eval: 'groundhog: Git Bash on Windows turns \\\\ into \\ before this runs, even inside quotes, so this inline script will not get the backslashes you wrote. Write it to a file with the Write tool, then run the file.',
};

const applies = (cfg, platform) => cfg.escapeGuard === 'on' || (cfg.escapeGuard !== 'off' && platform === 'win32');

// The guard is about bash. Claude Code's Bash tool is bash (Git Bash on Windows). Other harnesses normalize their shell
// tool to "Bash" too (Cursor's Shell), but on Windows that is usually PowerShell: fire there only when the hook input
// says the shell is bash. Unknown shell: stay quiet.
const BASHY = /(^|[\\/])(ba|z)?sh(\.exe)?$|git[\\/]bin|bash/i;
function isBash(h) {
  if (h.tool !== 'Bash') return false;
  if (!h.platform || h.platform === 'claude') return true;
  const r = h.raw || {};
  const shell = r.shell ?? r.shell_type ?? r.tool_input?.shell ?? r.tool_info?.shell ?? r.toolArgs?.shell;
  return typeof shell === 'string' && BASHY.test(shell);
}

// once-per-session markers live in a per-user folder and expire after two days
const MARK_TTL = 2 * 864e5;
function markDir() {
  let user = 'user'; try { user = os.userInfo().username.replace(/\W/g, '') || user; } catch { /* no user info */ }
  const d = path.join(os.tmpdir(), `groundhog-${user}`, 'marks');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function sweep(dir, now = Date.now()) {
  for (const f of fs.readdirSync(dir)) {
    if (!f.startsWith('esc-')) continue;
    try { if (now - fs.statSync(path.join(dir, f)).mtimeMs > MARK_TTL) fs.rmSync(path.join(dir, f), { force: true }); } catch { /* raced */ }
  }
}
// the session a marker belongs to: the session id, else the transcript, else the agent process (never one global key)
const sessionKey = (h) => (h.sessionId || h.transcript || `ppid${process.ppid}`).replace(/[^A-Za-z0-9]/g, '').slice(-80);

/** PreToolUse: annotate (never deny) a bash command whose inline script will lose backslashes. Once per session per kind. */
export function escapeGuard(cfg, h, { platform = process.platform } = {}) {
  if (!isBash(h) || !applies(cfg, platform)) return null;
  const kind = escapeRisk(h.input?.command);
  if (!kind) return null;
  try {
    const dir = markDir();
    const mark = path.join(dir, `esc-${sessionKey(h)}-${kind}`);
    if (fs.existsSync(mark)) return null;
    fs.writeFileSync(mark, '1');
    sweep(dir);
  } catch { /* no tmp: fire anyway */ }
  upsert(cfg, (s, day) => { s.totals.escape_guard++; day.escape_guard = (day.escape_guard || 0) + 1; });
  return { context: WORDING[kind] };
}
export const _test = { markDir, sweep, sessionKey, isBash };
