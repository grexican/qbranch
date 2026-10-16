// Claude Code adapter for the headjack benchmark: one headless `claude -p` run in a sandbox project, fully isolated
// from the user's own Claude setup.
//
// Isolation (verified by `npm run bench:headjack -- --verify-isolation`):
//   - CLAUDE_CONFIG_DIR points at a fresh temp dir per run, so ~/.claude (user skills, plugins, settings, hooks, memory,
//     transcripts) is never read or written;
//   - --setting-sources project and --strict-mcp-config: only the sandbox's own settings, no MCP servers;
//   - claudeMdExcludes in the sandbox settings lists every CLAUDE.md an ancestor directory could contribute (a sandbox
//     under the home directory would otherwise pick up ~/.claude/CLAUDE.md as an ancestor's project memory);
//   - the parent session's CLAUDE_* variables are dropped, so the child is never treated as a nested session;
//   - the replay guard from @qbranch/core is a PreToolUse hook: no side effects outside the sandbox.
//
// Auth with an empty config dir: ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN from the environment (`claude setup-token`
// prints one). With --auth-from-home the current access token is read from ~/.claude/.credentials.json for each run,
// read-only: it is never refreshed, copied to disk or printed (macOS keeps it in the keychain, so there this option
// does nothing and you need one of the variables).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { exec, guardSource } from '../../../../packages/core/src/replay.mjs';
import { claudeEvents, encodeProject } from '../../../../packages/core/src/transcripts.mjs';

const fwd = (p) => p.split(path.sep).join('/');
export const BIN = () => process.env.QBRANCH_CLAUDE || 'claude';

let versionCache = null;
export function version() {
  if (versionCache) return versionCache;
  const r = spawnSync(BIN(), ['--version'], { encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true });
  return (versionCache = (r.stdout || '').trim() || 'unknown');
}

/** Every CLAUDE.md an ancestor of `dir` could contribute, as absolute forward-slash paths (for claudeMdExcludes). */
export function ancestorMemoryFiles(dir) {
  const out = [];
  let d = path.resolve(dir);
  for (;;) {
    const parent = path.dirname(d);
    for (const f of ['CLAUDE.md', 'CLAUDE.local.md', path.join('.claude', 'CLAUDE.md')]) out.push(fwd(path.join(parent, f)));
    if (parent === d) break;
    d = parent;
  }
  out.push(fwd(path.join(os.homedir(), '.claude', 'CLAUDE.md')));
  return [...new Set(out)];
}

function authEnv({ authFromHome }) {
  if (process.env.ANTHROPIC_API_KEY) return { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN };
  if (authFromHome) {
    try {
      const o = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8')).claudeAiOauth || {};
      if (o.accessToken && (!o.expiresAt || o.expiresAt > Date.now() + 5 * 60_000)) return { CLAUDE_CODE_OAUTH_TOKEN: o.accessToken };
      throw new Error('the access token in ~/.claude/.credentials.json expires within 5 minutes: open Claude Code once to refresh it');
    } catch (e) { throw new Error(`--auth-from-home: ${e.message}`); }
  }
  throw new Error('no auth for an isolated run: set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN (claude setup-token), or pass --auth-from-home');
}

const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|CLAUDECODE$|AI_AGENT$|ANTHROPIC_)/.test(k) && !/^npm_/.test(k)));

/**
 * Run one prompt. `dir` is the sandbox project (already set up by the arm), `settings` extra project settings (hooks),
 * `env` extra environment (PATH shims, HEADJACK_HOME). Returns what the scorer needs.
 */
export async function run({ prompt, dir, model, settings = {}, env = {}, timeoutMs = 600_000, budgetUsd = 2, authFromHome = false, keepTranscript, extraArgs = [] }) {
  const cfgDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hjbench-cfg-')));
  const guard = path.join(cfgDir, 'guard.mjs');
  fs.writeFileSync(guard, guardSource());
  const hooks = { ...(settings.hooks || {}) };
  hooks.PreToolUse = [{ matcher: '*', hooks: [{ type: 'command', command: `node "${fwd(guard)}"` }] }, ...(hooks.PreToolUse || [])];
  const projSettings = { ...settings, hooks, claudeMdExcludes: [...ancestorMemoryFiles(dir), '**/.claude/CLAUDE.md'] };
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify(projSettings, null, 2));
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--max-budget-usd', budgetUsd.toFixed(2),
    '--permission-mode', 'bypassPermissions', '--setting-sources', 'project', '--strict-mcp-config', ...(model ? ['--model', model] : []), ...extraArgs];
  const t0 = Date.now();
  const childEnv = { ...cleanEnv(), ...authEnv({ authFromHome }), ...env, CLAUDE_CONFIG_DIR: cfgDir, QBRANCH_REPLAY_ROOT: dir,
    QBRANCH_REPLAY_ALLOW: JSON.stringify([os.tmpdir()]) };
  const r = await exec(BIN(), args, { cwd: dir, input: prompt, timeoutMs, env: childEnv });
  const lines = r.stdout.split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const init = lines.find(l => l.type === 'system' && l.subtype === 'init') || null;
  const res = lines.filter(l => l.type === 'result').pop() || null;
  const pdir = path.join(cfgDir, 'projects', encodeProject(dir));
  let tfile = res?.session_id && path.join(pdir, `${res.session_id}.jsonl`);
  if (!tfile || !fs.existsSync(tfile)) tfile = (fs.existsSync(pdir) ? fs.readdirSync(pdir).filter(f => f.endsWith('.jsonl')).map(f => path.join(pdir, f)) : [])[0] || null;
  const events = tfile ? [...claudeEvents(tfile)] : [];
  if (tfile && keepTranscript) { fs.mkdirSync(path.dirname(keepTranscript), { recursive: true }); fs.copyFileSync(tfile, keepTranscript); }
  try { fs.rmSync(cfgDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* locked on Windows: left for the temp cleaner */ }
  const u = res?.usage || {};
  return {
    ok: r.exitCode === 0 && !r.killed && !!res && !res.is_error,
    killed: r.killed, exitCode: r.exitCode,
    error: res ? (res.is_error ? String(res.result || res.subtype).slice(0, 300) : '') : (r.killed ? 'timeout' : (r.stderr || '').slice(0, 300)),
    finalText: res?.result ?? (events.filter(e => e.t === 'text').pop()?.text || ''),
    events, init: init ? { skills: init.skills || null, slash_commands: init.slash_commands || null, plugins: init.plugins || null, mcp_servers: init.mcp_servers || null, model: init.model, cwd: init.cwd } : null,
    costUsd: res?.total_cost_usd ?? 0, durationMs: Date.now() - t0, numTurns: res?.num_turns ?? null,
    tokens: { input: u.input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, output: u.output_tokens || 0 },
  };
}

export const meta = () => ({ agent: 'claude', cli: BIN(), version: version() });
