// Read agent session transcripts from disk into a normalized event stream. One reader per platform registers below;
// every reader yields the same shape:
//   session: { platform, id, file, kind: 'main'|'subagent', parent?, meta: {agentType, description, cwd?}, mtime, events() }
//   events:  { t:'usage', model, usage, id } | { t:'tool', name, input, id } | { t:'result', id, isError, text }
//            | { t:'user', text } | { t:'text', text } (assistant prose) | { t:'meta', cwd, at, entrypoint? } (once, early)
// Tool names are normalized to Claude Code's vocabulary (Bash, PowerShell, Read, Write, Edit) so one consumer serves all.
//
// Locations and formats start from Microsoft SkillOpt's harvesters (github.com/microsoft/SkillOpt,
// skillopt_sleep/harvest_*.py, MIT), which keep only prompts and tool names; ours also keep tool inputs, results and
// usage. Each reader's header records what it was verified against and when: real data on a machine (`verified`),
// the writer's own source at a commit (`verifiedAgainstSource`), or SkillOpt. Readers parse defensively: a record they
// do not understand is skipped, never thrown, and when a format drifts the header says what to re-check.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ---------- pricing ($ per million tokens: input, output, cache write, cache read) ----------
export const PRICES = {
  'claude-fable-5-1': [10, 50, 12.5, 0.25], 'claude-fable-5': [10, 50, 12.5, 0.25],
  'claude-opus-5-5': [4, 20, 5, 0.2], 'claude-opus-5': [5, 25, 6.25, 0.25], 'claude-opus-4-8': [5, 25, 6.25, 0.5],
  'claude-sonnet-5-5': [2, 10, 2.5, 0.2], 'claude-sonnet-5': [2, 10, 2.5, 0.2], 'claude-sonnet-4-6': [3, 15, 3.75, 0.3],
  'claude-haiku-5-5': [0.1, 0.5, 0.125, 0.01], 'claude-haiku-4-5': [1, 5, 1.25, 0.1],
};
export const modelId = (m) => (m || '').replace(/-\d{8}$/, '');
/** Tier of a model id: haiku | sonnet | opus | fable | other */
export const tierOf = (m) => (/haiku/.test(m) ? 'haiku' : /sonnet/.test(m) ? 'sonnet' : /opus/.test(m) ? 'opus' : /fable|mythos/.test(m) ? 'fable' : 'other');
export function costOf(model, u, prices = PRICES) {
  const p = prices[modelId(model)]; if (!p || !u) return 0;
  return ((u.input_tokens || 0) * p[0] + (u.output_tokens || 0) * p[1] + (u.cache_creation_input_tokens || 0) * p[2] + (u.cache_read_input_tokens || 0) * p[3]) / 1e6;
}

// ---------- shared helpers ----------
const home = (env, dir) => process.env[env] || path.join(os.homedir(), dir);
const mtimeOf = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
const isDir = (d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } };
const ls = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
/** Is `p` the directory `root` or inside it? (case-insensitive on Windows, via path.relative) */
export const within = (p, root) => { if (!p || !root) return false; const r = path.relative(path.resolve(root), path.resolve(p)); return !r.startsWith('..') && !path.isAbsolute(r); };
/** A file's text; .zst files are decompressed where this Node has zstd (22.15+), else read as empty. */
function readText(file) {
  if (!file.endsWith('.zst')) return fs.readFileSync(file, 'utf8');
  return zlib.zstdDecompressSync ? zlib.zstdDecompressSync(fs.readFileSync(file)).toString('utf8') : '';
}
function jsonl(file) {
  const out = [];
  let raw; try { raw = readText(file); } catch { return out; }
  for (const line of raw.split('\n')) { if (!line.trim()) continue; try { const v = JSON.parse(line); if (v && typeof v === 'object') out.push(v); } catch { /* torn line */ } }
  return out;
}
function* walk(dir, pred, depth = 6) {
  for (const f of ls(dir)) {
    const p = path.join(dir, f);
    if (isDir(p)) { if (depth > 0) yield* walk(p, pred, depth - 1); } else if (pred(f, p)) yield p;
  }
}
const textOf = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.map(b => typeof b === 'string' ? b : (b?.text ?? '')).filter(Boolean).join('\n') : (c?.text ?? '');
const parseArgs = (a) => { if (a && typeof a === 'object') return a; try { return JSON.parse(a); } catch { return { value: a }; } };
const SHELLS = { bash: 'Bash', shell: 'Bash', sh: 'Bash', run_shell_command: 'Bash', run_terminal_cmd: 'Bash', Shell: 'Bash', powershell: 'PowerShell', pwsh: 'PowerShell' };
const FILES = { write: 'Write', write_file: 'Write', create: 'Write', edit: 'Edit', replace: 'Edit', str_replace: 'Edit', read: 'Read', read_file: 'Read', view: 'Read' };
/** Claude Code tool vocabulary for another agent's tool name. */
const toolName = (n) => SHELLS[n] || FILES[n] || n;
// sqlite readers load node:sqlite lazily: a static import would print an ExperimentalWarning in every hook process.
const require_ = createRequire(import.meta.url);
/**
 * Open another agent's live SQLite store read-only, in place. Editors keep these stores in WAL mode, which is built for
 * a reader alongside a live writer: a read-only connection takes no write lock and sees a consistent snapshot.
 * (Measured on an 11 GB Cursor store: 75 ms in place vs ~9 s and 11 GB of disk for a copy.) Only if the in-place
 * open fails (an exclusive lock, an unusual journal mode) do we fall back to a temporary copy, deleted on exit.
 */
function openSqlite(file) {
  const { DatabaseSync } = require_('node:sqlite');
  try {
    return new DatabaseSync(`${pathToFileURL(file).href}?mode=ro`, { readOnly: true });
  } catch {
    return new DatabaseSync(snapshotSqlite(file), { readOnly: true });
  }
}

// ---------- Claude Code ----------
const claudeHome = () => home('CLAUDE_CONFIG_DIR', '.claude');
export const encodeProject = (dir) => path.resolve(dir).replace(/[^A-Za-z0-9]/g, '-');

function claudeProjectDirs(root) {
  const base = path.join(claudeHome(), 'projects');
  if (!fs.existsSync(base)) return [];
  if (!root) return fs.readdirSync(base).map(d => path.join(base, d)).filter(d => fs.statSync(d).isDirectory());
  const enc = encodeProject(root);
  // exact project dir, plus worktree / subdir dirs that start with it (e.g. <proj>--claude-worktrees-x)
  return fs.readdirSync(base).filter(d => d === enc || d.startsWith(enc + '-')).map(d => path.join(base, d));
}

export function* claudeEvents(file) {
  const seen = new Map();
  let meta = false;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (!meta && m.cwd) { meta = true; yield { t: 'meta', cwd: m.cwd, at: m.timestamp, entrypoint: m.entrypoint }; }
    if (m.type === 'assistant' && m.message) {
      if (m.message.usage) seen.set(m.message.id || m.uuid, { t: 'usage', model: m.message.model, usage: m.message.usage, id: m.message.id });
      for (const b of m.message.content || []) {
        if (b.type === 'tool_use') yield { t: 'tool', name: b.name, input: b.input || {}, id: b.id };
        else if (b.type === 'text' && b.text) yield { t: 'text', text: b.text };
      }
    } else if (m.type === 'user' && m.message) {
      const c = m.message.content;
      if (typeof c === 'string') { if (!c.startsWith('<')) yield { t: 'user', text: c }; continue; }
      for (const b of c || []) {
        if (b.type === 'tool_result') yield { t: 'result', id: b.tool_use_id, isError: !!b.is_error, text: typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '') };
        else if (b.type === 'text' && !b.text.startsWith('<')) yield { t: 'user', text: b.text };
      }
    }
  }
  yield* seen.values(); // streamed assistant messages repeat; usage is emitted once per message id, last copy wins
}

function* claudeSessions({ root, days }) {
  const since = Date.now() - days * 864e5;
  for (const pdir of claudeProjectDirs(root)) {
    for (const f of fs.readdirSync(pdir)) {
      const fp = path.join(pdir, f);
      if (f.endsWith('.jsonl')) {
        const mtime = fs.statSync(fp).mtimeMs;
        if (mtime > since) yield { platform: 'claude-code', id: f.replace('.jsonl', ''), file: fp, kind: 'main', meta: {}, mtime, events: () => claudeEvents(fp) };
      }
      const sdir = path.join(fp, 'subagents');
      if (fs.existsSync(sdir) && fs.statSync(sdir).isDirectory()) {
        for (const sf of fs.readdirSync(sdir).filter(x => x.endsWith('.jsonl'))) {
          const sp = path.join(sdir, sf); const mtime = fs.statSync(sp).mtimeMs;
          if (mtime <= since) continue;
          const metaF = sp.replace(/\.jsonl$/, '.meta.json');
          let meta = {}; try { meta = JSON.parse(fs.readFileSync(metaF, 'utf8')); } catch {}
          yield { platform: 'claude-code', id: sf.replace('.jsonl', ''), parent: f, file: sp, kind: 'subagent', meta, mtime, events: () => claudeEvents(sp) };
        }
      }
    }
  }
}

// ---------- OpenAI Codex CLI ----------
// verified: false (no local Codex data). verifiedAgainstSource: 'openai/codex@86ee40c3801a8c4fbb35b1159c32da1447cf09d9'
// (2026-10-15, codex-rs/). Paths below are in that tree.
// $CODEX_HOME (default ~/.codex)/sessions/YYYY/MM/DD/rollout-<local time>-<thread uuid>.jsonl, and archived_sessions/
// (rollout/src/lib.rs, rollout_file_name.rs). Rollouts older than 7 days are rewritten as .jsonl.zst
// (rollout/src/compression.rs). Each line is { timestamp, type, payload } (history/src/rollout_payload.rs):
//   session_meta   payload.cwd (protocol/src/protocol.rs SessionMeta; no model here)
//   turn_context   payload.cwd, payload.model: the model is recorded per turn
//   response_item  message { role, content: [input_text|output_text] }, function_call { name, arguments: JSON string,
//                  call_id }, function_call_output { call_id, output: a string OR an array of { type:'input_text', text } },
//                  custom_tool_call { name, input: string }, local_shell_call { action: { command: argv } }
//   event_msg      user_message, agent_message (legacy history mode only), token_count { info: { last_token_usage,
//                  total_token_usage } } where input_tokens INCLUDES cached_input_tokens and output_tokens INCLUDES
//                  reasoning_output_tokens (protocol.rs TokenUsage); info may be null.
// Surprises: the current shell tool is exec_command with a STRING cmd (core/src/tools/handlers/unified_exec.rs), not an
// argv; its output is plain text with a "Process exited with code N" line (core/src/tools/context.rs), and the legacy
// shell tools print "Exit code: N". exec_command_end events are never persisted (rollout/src/policy.rs), so the exit code
// exists only inside that text. Injected context arrives as role:user messages starting with "<" or "# AGENTS.md".
// SkillOpt's reader reads archived_sessions only and keeps tool names only; it agrees on everything it reads.
function codexShell(name, a) {
  let c = a.command ?? a.cmd ?? a.action?.command;
  if (c == null || !/shell|exec|command/i.test(name)) return null;
  let tool = 'Bash';
  if (Array.isArray(c)) {
    if (/^(pwsh|powershell)(\.exe)?$/i.test(path.basename(String(c[0] || '')))) tool = 'PowerShell';
    const i = c.findIndex(x => /^-(lc|c|command)$/i.test(x));
    c = (i >= 0 ? c.slice(i + 1) : c).join(' ');
  }
  return { name: tool, input: { command: String(c), ...(a.workdir ? { cwd: a.workdir } : {}) } };
}
function codexOutput(o) {
  let text = typeof o === 'string' ? o : Array.isArray(o) ? textOf(o) : JSON.stringify(o ?? ''), code = null;
  try { const j = JSON.parse(text); if (j && typeof j === 'object') { code = j.metadata?.exit_code ?? j.exit_code ?? null; text = j.output ?? text; } } catch {}
  if (code == null) { const m = String(text).match(/(?:exit code|exit_code|exited with code)[:\s]+(-?\d+)/i); if (m) code = Number(m[1]); }
  return { text: String(text), isError: code != null && code !== 0 };
}
export function* codexEvents(file) {
  const recs = jsonl(file).map(r => (r.payload && typeof r.payload === 'object' ? { ...r.payload, _w: r.type, _ts: r.timestamp } : r));
  // newer rollouts log each user/agent message twice (response_item and event_msg): prefer the event_msg copy
  const evUser = recs.some(p => p.type === 'user_message'), evAgent = recs.some(p => p.type === 'agent_message');
  let model = '', lastTotal = -1, n = 0, meta = false;
  for (const p of recs) {
    if (!meta && p.cwd) { meta = true; yield { t: 'meta', cwd: p.cwd, at: p.timestamp || p._ts }; }
    if (p.model && (p._w === 'turn_context' || !p.type)) model = p.model;
    const say = (role, text) => {
      text = (text || '').trim();
      if (!text || text.startsWith('<') || text.startsWith('# AGENTS.md')) return null; // environment / instructions blocks
      return role === 'user' ? { t: 'user', text } : { t: 'text', text };
    };
    let e = null;
    switch (p.type) {
      case 'message': if (p.role === 'user' && !evUser) e = say('user', textOf(p.content)); else if (p.role === 'assistant' && !evAgent) e = say('assistant', textOf(p.content)); break;
      case 'user_message': e = say('user', textOf(p.message)); break;
      case 'agent_message': e = say('assistant', textOf(p.message)); break;
      case 'function_call': case 'custom_tool_call': case 'local_shell_call': {
        const a = p.type === 'local_shell_call' ? { command: p.action?.command } : parseArgs(p.arguments ?? p.input);
        const sh = codexShell(p.type === 'local_shell_call' ? 'shell' : p.name || '', a);
        e = sh ? { t: 'tool', ...sh, id: p.call_id || p.id } : { t: 'tool', name: toolName(p.name || p.type), input: typeof a === 'object' ? a : { value: a }, id: p.call_id || p.id };
        break;
      }
      case 'function_call_output': case 'custom_tool_call_output': e = { t: 'result', id: p.call_id, ...codexOutput(p.output) }; break;
      case 'token_count': {
        const tot = p.info?.total_token_usage?.total_tokens, u = p.info?.last_token_usage;
        if (!u || tot === lastTotal) break; // the same count is re-emitted when nothing ran
        lastTotal = tot;
        const cached = u.cached_input_tokens || 0, wrote = u.cache_write_input_tokens || 0; // both are part of input_tokens
        e = { t: 'usage', model, id: `codex-${n++}`, usage: { input_tokens: Math.max(0, (u.input_tokens || 0) - cached - wrote), output_tokens: u.output_tokens || 0, cache_read_input_tokens: cached, cache_creation_input_tokens: wrote } };
        break;
      }
    }
    if (e) yield e;
  }
}
/** The first value `pick` finds in a JSONL file's records, read from the head of the file (whole file if compressed). */
function headCwd(file, pick) {
  let head = '';
  if (file.endsWith('.zst')) { try { head = readText(file); } catch {} }
  else { let fd; try { fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(1 << 20); head = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0)).toString('utf8'); } catch {} finally { if (fd !== undefined) fs.closeSync(fd); } }
  for (const line of head.split('\n')) { try { const c = pick(JSON.parse(line)); if (c) return c; } catch {} }
  return '';
}
function* codexSessions({ root, days }) {
  const since = Date.now() - days * 864e5, base = home('CODEX_HOME', '.codex');
  const isRollout = (f) => /^rollout-.*\.jsonl(\.zst)?$/.test(f);
  const files = [...walk(path.join(base, 'sessions'), isRollout), ...walk(path.join(base, 'archived_sessions'), isRollout, 0)];
  for (const file of files) {
    const mtime = mtimeOf(file); if (mtime <= since) continue;
    const cwd = headCwd(file, (r) => (r.payload || r).cwd);
    if (root && !within(cwd, root)) continue;
    yield { platform: 'codex', id: path.basename(file).replace(/\.jsonl(\.zst)?$/, ''), file, kind: 'main', meta: { cwd }, mtime, events: () => codexEvents(file) };
  }
}

// ---------- Cursor ----------
// verified: true (real Cursor data on this machine, 2026-10-15: 766 conversations, 13k shell calls with results).
// Two stores, both verified on a real install (Cursor, 2026-10-15):
// 1. The IDE's global store, <Cursor user dir>/globalStorage/state.vscdb (SQLite, often many GB). Table cursorDiskKV
//    holds composerData:<composerId> (one conversation: fullConversationHeadersOnly lists its bubbles in order,
//    subagentInfo.parentComposerId marks a subagent, lastUpdatedAt) and bubbleId:<composerId>:<bubbleId> (one message:
//    type 1 user / 2 assistant, text, modelInfo.modelName, toolFormerData { name, params (JSON string), result (JSON
//    string), status }). Table composerHeaders maps composerId -> workspaceId, and workspaceStorage/<workspaceId>/
//    workspace.json gives the folder. The shell tool is run_terminal_command_v2: params { command, cwd }, result
//    { output, rejected, exitCode (newer builds only) }. Cursor records no usage here: tokenCount is always zero, so
//    these sessions yield no usage events. agentKv:blob:* is a content-addressed checkpoint store, not read.
//    Cursor holds the file open; it is read in place through a read-only WAL connection (see openSqlite).
// 2. The agent CLI, ~/.cursor/projects/<workspace-slug>/agent-transcripts/<session>/<session>.jsonl (+ subagents/):
//    { role, message: { content: [text | tool_use{name,input}] } } and { type: 'turn_ended', status }. No tool ids,
//    results or timestamps, so these carry commands but never errors.
export const cursorSlug = (dir) => path.resolve(dir).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
export function* cursorEvents(file, cwd) {
  if (cwd) yield { t: 'meta', cwd, at: null };
  let n = 0;
  for (const r of jsonl(file)) {
    const role = r.role || r.message?.role, c = r.message?.content;
    if (!role || !c) continue;
    if (role === 'user') {
      let text = textOf(c).trim();
      const q = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>\s*$/); if (q) text = q[1];
      if (text && !text.startsWith('<')) yield { t: 'user', text };
      for (const b of Array.isArray(c) ? c : []) if (b.type === 'tool_result') yield { t: 'result', id: b.tool_use_id, isError: !!b.is_error, text: textOf(b.content) };
    } else if (role === 'assistant') {
      for (const b of Array.isArray(c) ? c : [{ type: 'text', text: c }]) {
        if (b.type === 'tool_use') { const input = b.input || {}; yield { t: 'tool', name: toolName(b.name), input: input.path && !input.file_path ? { ...input, file_path: input.path } : input, id: b.id || `cursor-${n++}` }; }
        else if (b.type === 'text' && b.text) yield { t: 'text', text: b.text };
      }
    }
  }
}
/** Editor user-data dirs (VS Code family) per OS: Cursor, Code, Code - Insiders. $<NAME>_USER_DIR overrides. */
function editorUserDirs(app, env) {
  if (process.env[env]) return [process.env[env]];
  const base = process.platform === 'win32' ? (process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'))
    : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : (process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'));
  return app.map(a => path.join(base, a, 'User'));
}
const uriPath = (u) => { try { return typeof u === 'string' && u.startsWith('file:') ? fileURLToPath(u) : ''; } catch { return ''; } };
/** workspaceStorage/<id>/workspace.json -> the folder each workspace id stands for. */
function editorWorkspaces(user) {
  const out = new Map();
  for (const id of ls(path.join(user, 'workspaceStorage'))) {
    try { const w = JSON.parse(fs.readFileSync(path.join(user, 'workspaceStorage', id, 'workspace.json'), 'utf8')); out.set(id, uriPath(w.folder) || (uriPath(w.workspace) && path.dirname(uriPath(w.workspace)))); } catch {}
  }
  return out;
}
/**
 * Fallback only: a temporary copy of a live SQLite file (plus -wal/-shm) when it can't be opened in place.
 * Never kept: the copy is removed when the process exits, so a large editor store never piles up on disk.
 */
export function snapshotSqlite(file) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbranch-snap-'));
  process.once('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  const snap = path.join(dir, path.basename(file));
  for (const s of ['', '-wal', '-shm']) if (fs.existsSync(file + s)) fs.copyFileSync(file + s, snap + s);
  return snap;
}
const CURSOR_TOOLS = { run_terminal_command_v2: 'Bash', run_terminal_cmd: 'Bash', read_file_v2: 'Read', read_file: 'Read', edit_file_v2: 'Edit', edit_file: 'Edit', search_replace: 'Edit',
  write: 'Write', delete_file: 'Delete', ripgrep_raw_search: 'Grep', grep_search: 'Grep', glob_file_search: 'Glob', list_dir_v2: 'LS', list_dir: 'LS', web_search: 'WebSearch', web_fetch: 'WebFetch', task_v2: 'Task', todo_write: 'TodoWrite' };
/** Cursor's MCP tool names look like mcp-<server>-project-<n>-<server>-<tool>: map to mcp__<server>__<tool>. */
const cursorTool = (n = '') => {
  if (CURSOR_TOOLS[n]) return CURSOR_TOOLS[n];
  const m = n.match(/^mcp-(.+?)-project-\d+-(.+)$/);
  if (m) return `mcp__${m[1]}__${m[2].startsWith(m[1] + '-') ? m[2].slice(m[1].length + 1) : m[2]}`;
  return n.startsWith('mcp-') ? `mcp__cursor__${n.slice(4)}` : n;
};
export function* cursorBubbles(bubbles, { cwd, at, model: fallbackModel } = {}) {
  yield { t: 'meta', cwd: cwd || '', at: at || null };
  for (const b of bubbles) {
    if (!b) continue;
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    if (b.type === 1) { if (text && !text.startsWith('<')) yield { t: 'user', text }; continue; }
    if (text) yield { t: 'text', text };
    const tf = b.toolFormerData;
    if (tf?.name) {
      const id = tf.toolCallId || b.bubbleId, input = parseArgs(tf.params || tf.rawArgs || '{}');
      const file = input.targetFile ?? input.relativeWorkspacePath ?? input.target_file ?? input.path;
      yield { t: 'tool', name: cursorTool(tf.name), input: file && !input.file_path ? { ...input, file_path: file } : input, id };
      if (/^(completed|error|cancelled)$/.test(tf.status || '')) {
        const res = typeof tf.result === 'string' ? parseArgs(tf.result) : (tf.result || {});
        const code = res.exitCode ?? null;
        yield { t: 'result', id, isError: tf.status !== 'completed' || tf.additionalData?.status === 'error' || !!res.rejected || (code != null && code !== 0),
          text: res.rejected ? 'rejected by the user' : String(res.output ?? res.value ?? (typeof tf.result === 'string' ? tf.result : '')) + (code ? `\nexit code ${code}` : '') };
      }
    }
    const u = b.tokenCount;
    if (u && (u.inputTokens || u.outputTokens)) yield { t: 'usage', model: b.modelInfo?.modelName || fallbackModel || '', id: b.bubbleId, usage: { input_tokens: u.inputTokens || 0, output_tokens: u.outputTokens || 0 } };
    // Cursor bills per request and (in every store seen so far) records zero tokens; the model is still known, which
    // is enough to measure whether a model finishes a kind of task. `usage: null` = unpriced, not free.
    else if (b.type === 2 && (b.modelInfo?.modelName || fallbackModel)) yield { t: 'usage', model: b.modelInfo?.modelName || fallbackModel, id: b.bubbleId, usage: null };
  }
}
function* cursorIdeSessions({ root, days }) {
  const since = Date.now() - days * 864e5;
  for (const user of editorUserDirs(['Cursor'], 'CURSOR_USER_DIR')) {
    const file = path.join(user, 'globalStorage', 'state.vscdb');
    if (!fs.existsSync(file)) continue;
    let db; try { db = openSqlite(file); } catch { continue; }
    const ws = editorWorkspaces(user), where = new Map();
    try { for (const h of db.prepare('SELECT composerId, workspaceId FROM composerHeaders').all()) where.set(h.composerId, ws.get(h.workspaceId) || ''); } catch { /* older builds have no headers table */ }
    let rows = []; try { rows = db.prepare("SELECT value FROM cursorDiskKV WHERE key >= 'composerData:' AND key < 'composerData;'").all(); } catch { continue; }
    const bubbles = db.prepare('SELECT key, value FROM cursorDiskKV WHERE key >= ? AND key < ?');
    for (const r of rows) {
      let c; try { c = JSON.parse(r.value); } catch { continue; }
      if (!c?.composerId || !c.fullConversationHeadersOnly?.length) continue; // empty drafts
      const mtime = c.lastUpdatedAt || c.createdAt || 0; if (mtime <= since) continue;
      const cwd = where.get(c.composerId) || c.gitWorktree?.mainWorktreePath || c.gitWorktree?.worktreePath || '';
      if (root && !within(cwd, root)) continue;
      const parent = c.subagentInfo?.parentComposerId;
      yield { platform: 'cursor', id: c.composerId, file: `${file}#${c.composerId}`, kind: parent ? 'subagent' : 'main', ...(parent ? { parent } : {}), meta: { cwd, description: c.name || '' }, mtime,
        events: () => {
          const pre = `bubbleId:${c.composerId}:`, byId = new Map();
          for (const b of bubbles.all(pre, `bubbleId:${c.composerId};`)) { try { byId.set(b.key.slice(pre.length), JSON.parse(b.value)); } catch {} }
          return cursorBubbles(c.fullConversationHeadersOnly.map(h => byId.get(h.bubbleId)), { cwd, at: c.createdAt ? new Date(c.createdAt).toISOString() : null, model: c.modelConfig?.modelName });
        } };
    }
  }
}
function* cursorSessions({ root, days }) {
  const seen = new Set();
  for (const s of cursorIdeSessions({ root, days })) { seen.add(s.id); yield s; }
  const since = Date.now() - days * 864e5, base = path.join(home('CURSOR_HOME', '.cursor'), 'projects');
  const slug = root ? cursorSlug(root).toLowerCase() : null; // the drive letter is lowercased on disk
  for (const d of ls(base)) {
    if (slug && !(d.toLowerCase() === slug || d.toLowerCase().startsWith(slug + '-'))) continue;
    const tdir = path.join(base, d, 'agent-transcripts');
    if (!isDir(tdir)) continue;
    let cwd = root || ''; try { cwd = JSON.parse(fs.readFileSync(path.join(base, d, '.workspace-trusted'), 'utf8')).workspacePath || cwd; } catch {}
    for (const f of walk(tdir, x => x.endsWith('.jsonl'), 2)) {
      const mtime = mtimeOf(f); if (mtime <= since || seen.has(path.basename(f, '.jsonl'))) continue; // the IDE store has it, with results
      const sub = path.basename(path.dirname(f)) === 'subagents';
      const parent = sub ? path.basename(path.dirname(path.dirname(f))) : undefined;
      yield { platform: 'cursor', id: path.basename(f, '.jsonl'), file: f, kind: sub ? 'subagent' : 'main', ...(sub ? { parent } : {}), meta: { cwd }, mtime, events: () => cursorEvents(f, cwd) };
    }
  }
}

// ---------- GitHub Copilot CLI ----------
// verified: partly (the SQLite schema, on a real but empty store, 2026-10-15); events.jsonl: false.
// Per-session event logs at ~/.copilot/session-state/<id>/events.jsonl ($COPILOT_HOME overrides); when a session has
// none, the global index ~/.copilot/session-store.db (sessions, turns, session_files) gives prompts, answers and the
// files tools touched. The SQLite schema is verified against SkillOpt and against a real (empty) store that the VS Code
// Copilot Chat extension keeps under globalStorage/github.copilot-chat/ (2026-10-15). The events.jsonl record types used here
// (session.start, user.message, assistant.message, tool.execution_start/complete, assistant.usage) are NOT verified on
// a real install: they are parsed defensively and anything else is skipped.
export function* copilotEvents(file) {
  let meta = false;
  const tools = new Set();
  for (const r of jsonl(file)) {
    const d = r.data || {};
    const cwd = d.context?.cwd || d.cwd || d.workingDirectory;
    if (!meta && cwd) { meta = true; yield { t: 'meta', cwd, at: r.timestamp || d.startTime }; }
    const tool = (id, name, args) => { if (!id || tools.has(id)) return null; tools.add(id); return { t: 'tool', name: toolName(name), input: parseArgs(args ?? {}), id }; };
    switch (r.type) {
      case 'user.message': { const text = textOf(d.content ?? d.text).trim(); if (text && !text.startsWith('<')) yield { t: 'user', text }; break; }
      case 'assistant.message': {
        const text = textOf(d.content).trim(); if (text) yield { t: 'text', text };
        for (const q of d.toolRequests || []) { const e = tool(q.toolCallId || q.id, q.name, q.arguments); if (e) yield e; }
        break;
      }
      case 'tool.execution_start': { const e = tool(d.toolCallId, d.toolName || d.name, d.arguments); if (e) yield e; break; }
      case 'tool.execution_complete': yield { t: 'result', id: d.toolCallId, isError: d.success === false || !!d.error, text: textOf(d.result?.content ?? d.result ?? d.error?.message ?? '') }; break;
      case 'assistant.usage': yield { t: 'usage', model: d.model || '', id: r.id || d.id, usage: { input_tokens: d.inputTokens || 0, output_tokens: d.outputTokens || 0, cache_read_input_tokens: d.cacheReadTokens || 0, cache_creation_input_tokens: d.cacheWriteTokens || 0 } }; break;
    }
  }
}
function* copilotSessions({ root, days }) {
  const since = Date.now() - days * 864e5, base = home('COPILOT_HOME', '.copilot');
  const logged = new Set();
  for (const d of ls(path.join(base, 'session-state'))) {
    const f = path.join(base, 'session-state', d, 'events.jsonl');
    const mtime = mtimeOf(f); if (!mtime) continue;
    logged.add(d); if (mtime <= since) continue;
    const cwd = headCwd(f, (r) => r.data?.context?.cwd || r.data?.cwd);
    if (root && !within(cwd, root)) continue;
    yield { platform: 'copilot-cli', id: d, file: f, kind: 'main', meta: { cwd }, mtime, events: () => copilotEvents(f) };
  }
  // the CLI's own store, and the one the VS Code Copilot Chat extension keeps for the CLI it embeds (same schema)
  const stores = [path.join(base, 'session-store.db'), ...editorUserDirs(['Code', 'Code - Insiders'], 'VSCODE_USER_DIR').map(u => path.join(u, 'globalStorage', 'github.copilot-chat', 'session-store.db'))];
  for (const store of stores) yield* copilotStore(store, { root, since, logged });
}
function* copilotStore(store, { root, since, logged }) {
  if (!fs.existsSync(store)) return;
  let rows = [], db;
  try { db = openSqlite(store); rows = db.prepare('SELECT id, cwd, created_at, updated_at FROM sessions').all(); } catch { db?.close(); return; } // schema drift: no sessions, never a crash
  for (const s of rows) {
    const mtime = Date.parse(String(s.updated_at || '').replace(' ', 'T')) || 0;
    if (logged.has(String(s.id)) || mtime <= since || !s.cwd || (root && !within(s.cwd, root))) continue;
    yield { platform: 'copilot-cli', id: String(s.id), file: `${store}#${s.id}`, kind: 'main', meta: { cwd: s.cwd }, mtime, events: function* () {
      yield { t: 'meta', cwd: s.cwd, at: s.created_at };
      try {
        for (const t of db.prepare('SELECT user_message, assistant_response FROM turns WHERE session_id = ? ORDER BY turn_index').all(s.id)) {
          if (t.user_message) yield { t: 'user', text: String(t.user_message) };
          if (t.assistant_response) yield { t: 'text', text: String(t.assistant_response) };
        }
        let n = 0;
        for (const f of db.prepare('SELECT file_path, tool_name FROM session_files WHERE session_id = ?').all(s.id)) yield { t: 'tool', name: toolName(f.tool_name || 'edit'), input: { file_path: f.file_path }, id: `copilot-${n++}` };
      } catch { /* schema drift */ }
    } };
  }
}

// ---------- VS Code Copilot Chat ----------
// verified: partly (the operation-log container, on real sessions with no requests, 2026-10-15); requests: false.
// <Code user dir>/workspaceStorage/<id>/chatSessions/<session>.jsonl (workspace.json beside it names the folder), and
// globalStorage/emptyWindowChatSessions/ for windows with no folder. Each file is an operation log: kind 0 sets the
// whole session, 1 sets the value at path k, 2 appends v to the array at k (truncating at i when given), 3 deletes k.
// Older builds wrote the whole session as one .json document. The container format is verified on a real install
// (2026-10-15) whose sessions held no requests; the request shape (requests[].message.text, response parts: markdown
// { value } and toolInvocationSerialized { toolId, toolCallId, toolSpecificData, resultDetails }) is from SkillOpt's
// reader and fixture. The terminal fields (toolSpecificData.kind 'terminal', commandLine.original, language,
// terminalCommandState.exitCode) and result.usage are from VS Code's chat model and NOT verified: parsed defensively.
export function vscodeChatState(file) {
  let state = null;
  if (file.endsWith('.json')) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
  const parent = (k) => { let cur = state; for (const p of k.slice(0, -1)) { cur = cur?.[p]; if (cur == null) return null; } return cur; };
  for (const r of jsonl(file)) {
    if (r.kind === 0 && r.v && typeof r.v === 'object') { state = r.v; continue; }
    if (!state || !Array.isArray(r.k) || !r.k.length) continue;
    const p = parent(r.k), key = r.k[r.k.length - 1];
    if (!p || typeof p !== 'object') continue;
    if (r.kind === 1) p[key] = r.v;
    else if (r.kind === 2 && Array.isArray(p[key])) { if (Number.isInteger(r.i)) p[key].length = Math.min(p[key].length, r.i); p[key].push(...(Array.isArray(r.v) ? r.v : [])); }
    else if (r.kind === 3) { if (Array.isArray(p)) p.splice(key, 1); else delete p[key]; }
  }
  return state;
}
const VSCODE_TOOLS = { readFile: 'Read', createFile: 'Write', replaceString: 'Edit', multiReplaceString: 'Edit', insertEdit: 'Edit', applyPatch: 'Edit', editFile: 'Edit',
  findTextInFiles: 'Grep', findFiles: 'Glob', listDirectory: 'LS', fetchWebPage: 'WebFetch', runInTerminal: 'Bash' };
const vscodeTool = (id = '') => VSCODE_TOOLS[id.replace(/^copilot_/, '')] || toolName(id);
export function* vscodeChatEvents(file, cwd) {
  const s = vscodeChatState(file); if (!s) return;
  yield { t: 'meta', cwd: cwd || '', at: s.creationDate ? new Date(s.creationDate).toISOString() : null };
  let n = 0;
  for (const q of s.requests || []) {
    if (!q || q.isSystemInitiated) continue;
    const ask = String(q.message?.text ?? '').trim();
    if (ask && !ask.startsWith('<')) yield { t: 'user', text: ask };
    let prose = '';
    for (const p of q.response || []) {
      if (!p) continue;
      if (p.kind == null || p.kind === 'markdownContent') { prose += typeof p.value === 'string' ? p.value : (p.value?.value ?? ''); continue; }
      if (p.kind !== 'toolInvocationSerialized') continue;
      if (prose.trim()) { yield { t: 'text', text: prose.trim() }; prose = ''; }
      const d = p.toolSpecificData || {}, id = p.toolCallId || `${q.requestId || 'req'}-${n++}`;
      const terminal = d.kind === 'terminal' || /terminal/i.test(p.toolId || '');
      const command = d.commandLine?.toolEdited ?? d.commandLine?.userEdited ?? d.commandLine?.original ?? d.command;
      yield terminal && command
        ? { t: 'tool', name: /pwsh|powershell/i.test(d.language || '') ? 'PowerShell' : 'Bash', input: { command: String(command) }, id }
        : { t: 'tool', name: vscodeTool(p.toolId || 'tool'), input: parseArgs(d.input ?? d.rawInput ?? {}), id };
      if (p.isComplete !== false) {
        const code = d.terminalCommandState?.exitCode;
        yield { t: 'result', id, isError: !!p.resultDetails?.isError || (code != null && code !== 0), text: textOf(p.resultDetails?.output ?? d.terminalCommandOutput?.text ?? '') };
      }
    }
    if (prose.trim()) yield { t: 'text', text: prose.trim() };
    const u = q.result?.usage || q.result?.metadata?.usage;
    if (u && (u.promptTokens || u.completionTokens)) yield { t: 'usage', model: q.modelId || '', id: q.requestId, usage: { input_tokens: u.promptTokens || 0, output_tokens: u.completionTokens || 0 } };
  }
}
function* vscodeChatSessions({ root, days }) {
  const since = Date.now() - days * 864e5;
  for (const user of editorUserDirs(['Code', 'Code - Insiders'], 'VSCODE_USER_DIR')) {
    const dirs = [...editorWorkspaces(user)].map(([id, cwd]) => [path.join(user, 'workspaceStorage', id, 'chatSessions'), cwd]);
    dirs.push([path.join(user, 'globalStorage', 'emptyWindowChatSessions'), '']);
    for (const [dir, cwd] of dirs) {
      if (root && !within(cwd, root)) continue;
      for (const f of walk(dir, x => /\.jsonl?$/.test(x), 0)) {
        const mtime = mtimeOf(f); if (mtime <= since) continue;
        yield { platform: 'copilot-chat', id: path.basename(f).replace(/\.jsonl?$/, ''), file: f, kind: 'main', meta: { cwd }, mtime, events: () => vscodeChatEvents(f, cwd) };
      }
    }
  }
}

// ---------- Gemini CLI ----------
// verified: false (no local Gemini data). verifiedAgainstSource: 'google-gemini/gemini-cli@06d329873703ddabe8a842d962342ac4ad779e83'
// (2026-10-14, packages/core/src/). Paths below are in that tree.
// $GEMINI_CLI_HOME (default: the home dir)/.gemini/tmp/<project>/chats/session-<YYYY-MM-DDTHH-mm>-<id8>.jsonl, and
// subagent chats in chats/<parent session id>/<session id>.jsonl (services/chatRecordingService.ts).
// Surprise 1: <project> is now a readable slug of the project's basename (config/projectRegistry.ts), mapped in
// .gemini/projects.json { projects: { "<abs path, lowercased on Windows>": "<slug>" } }, with the path also written to
// tmp/<slug>/.project_root. Older installs used tmp/<sha256(project root)>, which the CLI migrates (config/storage.ts).
// Surprise 2: the file is an append-only JSONL log, not one JSON document (older .json documents are still read):
//   { sessionId, projectHash, startTime, kind? }   metadata, merged
//   { id, type: 'user'|'gemini'|'info'|'error'|'warning', content, toolCalls?, tokens?, model? }   a message; the same id
//                                                   re-appended later replaces the earlier copy (tokens arrive late)
//   { $set: {...} }  metadata update      { $patch: { id?, content?, toolCalls?, updates?, removeIds?, orderIds? } }
//   { $rewindTo: <message id> }  drop that message and everything after it
// toolCalls[] = { id, name, args, status: success|error|cancelled, result: [{ functionResponse: { response: { output |
// error } } }] }. Surprise 3: a shell command that exits non-zero still has status 'success'; the exit code is only the
// "Exit Code: N" line inside the output (tools/shell.ts). tokens.input INCLUDES tokens.cached; thoughts are separate
// from output. SkillOpt has no Gemini reader.
export function geminiChat(file) {
  if (file.endsWith('.json')) { try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); return { meta: d, messages: d.messages || [] }; } catch { return null; } }
  const meta = {}, msgs = new Map();
  const patch = (u) => {
    const m = u?.id && msgs.get(u.id); if (!m) return;
    if (u.content !== undefined) m.content = u.content;
    for (const tc of u.toolCalls || []) { const t = (m.toolCalls || []).find(x => x.id === tc.id); if (t) Object.assign(t, tc); }
  };
  for (const r of jsonl(file)) {
    if (r.$rewindTo !== undefined) { const ids = [...msgs.keys()], i = ids.indexOf(r.$rewindTo); for (const id of i < 0 ? ids : ids.slice(i)) msgs.delete(id); }
    else if (r.$set) { const { messages, ...rest } = r.$set; Object.assign(meta, rest); if (Array.isArray(messages)) { msgs.clear(); for (const m of messages) if (m?.id) msgs.set(m.id, m); } }
    else if (r.$patch) {
      const p = r.$patch;
      patch(p); for (const u of p.updates || []) patch(u);
      for (const id of p.removeIds || []) msgs.delete(id);
      for (const id of p.orderIds || []) if (msgs.has(id)) { const m = msgs.get(id); msgs.delete(id); msgs.set(id, m); } // listed ids move to the end
    } else if (typeof r.sessionId === 'string' && typeof r.projectHash === 'string') Object.assign(meta, r);
    else if (typeof r.id === 'string') msgs.set(r.id, r); // a re-append replaces in place (Map keeps first position)
  }
  return { meta, messages: [...msgs.values()] };
}
export function* geminiEvents(file, cwd) {
  const chat = geminiChat(file); if (!chat) return;
  yield { t: 'meta', cwd: cwd || '', at: chat.meta.startTime || null };
  let n = 0;
  for (const m of chat.messages) {
    const text = textOf(m.content).trim();
    if (m.type === 'user') { if (text && !text.startsWith('<') && !text.startsWith('/')) yield { t: 'user', text }; continue; }
    if (m.type !== 'gemini') continue;
    if (text) yield { t: 'text', text };
    for (const c of m.toolCalls || []) {
      const id = c.id || `gemini-${n++}`;
      yield { t: 'tool', name: toolName(c.name), input: parseArgs(c.args ?? {}), id };
      const resp = (Array.isArray(c.result) ? c.result : [c.result]).map(r => r?.functionResponse?.response ?? r).filter(Boolean);
      const out = resp.map(r => (typeof r === 'string' ? r : [r.output, r.error].filter(Boolean).join('\n') || JSON.stringify(r))).join('\n') || (typeof c.resultDisplay === 'string' ? c.resultDisplay : '');
      const code = Number(out.match(/^Exit Code: (-?\d+)/m)?.[1] || 0);
      if (/^(success|error|cancelled)$/.test(c.status || '') || out) yield { t: 'result', id, isError: c.status === 'error' || c.status === 'cancelled' || code !== 0, text: out.replace(/<\/?untrusted_context>\n?/g, '') };
    }
    if (m.tokens) { const cached = m.tokens.cached || 0; yield { t: 'usage', model: m.model || '', id: m.id || `gemini-u${n++}`, usage: { input_tokens: Math.max(0, (m.tokens.input || 0) - cached), output_tokens: (m.tokens.output || 0) + (m.tokens.thoughts || 0), cache_read_input_tokens: cached } }; }
  }
}
function* geminiSessions({ root, days }) {
  const since = Date.now() - days * 864e5, gdir = path.join(process.env.GEMINI_CLI_HOME || os.homedir(), '.gemini'), base = path.join(gdir, 'tmp');
  // which tmp/<dir> belongs to which project: projects.json, .project_root, or the legacy sha256 name
  const owner = new Map();
  try { for (const [p, slug] of Object.entries(JSON.parse(fs.readFileSync(path.join(gdir, 'projects.json'), 'utf8')).projects || {})) owner.set(slug, p); } catch {}
  const hash = root ? crypto.createHash('sha256').update(root).digest('hex') : null;
  for (const d of ls(base)) {
    let cwd = owner.get(d) || '';
    try { cwd = fs.readFileSync(path.join(base, d, '.project_root'), 'utf8').trim() || cwd; } catch {}
    if (!cwd && d === hash) cwd = root;
    if (root && !within(cwd, root)) continue;
    const chats = path.join(base, d, 'chats'), files = new Set(walk(chats, x => /\.jsonl?$/.test(x), 1));
    for (const f of files) {
      if (f.endsWith('.json') && files.has(f + 'l')) continue; // a resumed legacy session: the .jsonl supersedes it
      const mtime = mtimeOf(f); if (mtime <= since) continue;
      const parent = path.dirname(f) !== chats ? path.basename(path.dirname(f)) : undefined;
      yield { platform: 'gemini-cli', id: path.basename(f).replace(/\.jsonl?$/, ''), file: f, kind: parent ? 'subagent' : 'main', ...(parent ? { parent } : {}), meta: { cwd }, mtime, events: () => geminiEvents(f, cwd) };
    }
  }
}

// ---------- OpenCode ----------
// verified: false (no local data). verifiedAgainst: SkillOpt skillopt_sleep/harvest_opencode.py (2026-10-15).
// opencode.db (SQLite) under $XDG_DATA_HOME/opencode, %LOCALAPPDATA%/opencode or ~/.local/share/opencode ($OPENCODE_DB
// overrides): tables session (id, parent_id, directory, time_updated), message (id, session_id, data) and part (id,
// message_id, session_id, data). Locations and tables verified against SkillOpt; the part payloads used here
// ({ type:'tool', tool, callID, state:{ status, input, output } }, { type:'text' }, { type:'step-finish', tokens })
// are from OpenCode's message format, not verified on a real install.
function opencodeDb() {
  if (process.env.OPENCODE_DB) return process.env.OPENCODE_DB;
  const bases = [process.env.XDG_DATA_HOME, process.env.LOCALAPPDATA, process.env.APPDATA, path.join(os.homedir(), '.local', 'share')].filter(Boolean);
  return bases.map(b => path.join(b, 'opencode', 'opencode.db')).find(f => fs.existsSync(f)) || '';
}
export function* opencodeEvents(db, s) {
  yield { t: 'meta', cwd: s.directory, at: s.time_created ? new Date(Number(s.time_created)).toISOString() : null };
  const obj = (raw) => { try { return JSON.parse(raw); } catch { return {}; } };
  const parts = new Map();
  for (const p of db.prepare('SELECT message_id, data FROM part WHERE session_id = ? ORDER BY message_id, id').all(s.id)) {
    if (!parts.has(p.message_id)) parts.set(p.message_id, []); parts.get(p.message_id).push(obj(p.data));
  }
  for (const m of db.prepare('SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id').all(s.id)) {
    const msg = obj(m.data);
    for (const p of parts.get(m.id) || []) {
      if (p.type === 'text' && p.text && !p.synthetic) yield msg.role === 'user' ? { t: 'user', text: p.text } : { t: 'text', text: p.text };
      else if (p.type === 'tool' && msg.role === 'assistant') {
        const st = p.state || {}, input = st.input || {}, id = p.callID || p.id;
        yield { t: 'tool', name: toolName(p.tool), input: input.filePath && !input.file_path ? { ...input, file_path: input.filePath } : input, id };
        if (st.status === 'completed' || st.status === 'error') yield { t: 'result', id, isError: st.status === 'error' || (st.metadata?.exit ?? 0) !== 0, text: String(st.output ?? st.error ?? '') };
      } else if (p.type === 'step-finish' && p.tokens) {
        yield { t: 'usage', model: msg.modelID || '', id: p.id, usage: { input_tokens: p.tokens.input || 0, output_tokens: (p.tokens.output || 0) + (p.tokens.reasoning || 0), cache_read_input_tokens: p.tokens.cache?.read || 0, cache_creation_input_tokens: p.tokens.cache?.write || 0 } };
      }
    }
  }
}
function* opencodeSessions({ root, days }) {
  const file = opencodeDb(); if (!file || !fs.existsSync(file)) return;
  const since = Date.now() - days * 864e5;
  let db, rows; try { db = openSqlite(file); rows = db.prepare('SELECT id, parent_id, directory, time_created, time_updated FROM session WHERE time_updated > ?').all(since); } catch { db?.close(); return; }
  for (const s of rows) {
    if (!s.directory || (root && !within(s.directory, root))) continue;
    yield { platform: 'opencode', id: String(s.id), file: `${file}#${s.id}`, kind: s.parent_id ? 'subagent' : 'main', ...(s.parent_id ? { parent: String(s.parent_id) } : {}), meta: { cwd: s.directory }, mtime: Number(s.time_updated), events: () => opencodeEvents(db, s) };
  }
}

// ---------- Pi (pi-coding-agent) ----------
// verified: false (no local data). verifiedAgainst: SkillOpt skillopt_sleep/harvest_pi.py (2026-10-15).
// ~/.pi/agent/sessions/<project-slug>/<id>.jsonl ($PI_CODING_AGENT_DIR overrides ~/.pi/agent). A 'session' header
// carries cwd; 'message' entries carry { role: user|assistant|toolResult, content, usage, toolCallId, isError };
// assistant blocks of type toolCall carry { id, name, arguments }. Verified against SkillOpt's reader, which documents
// the format. v2/v3 sessions are trees (id/parentId); this reader reads every entry in file order, abandoned branches
// included, which is fine for mining and wrong for exact replay.
export function* piEvents(file) {
  for (const r of jsonl(file)) {
    if (r.type === 'session') { yield { t: 'meta', cwd: r.cwd || '', at: r.timestamp || null }; continue; }
    const m = r.type === 'message' ? r.message : null; if (!m) continue;
    if (m.role === 'user') { const text = textOf(m.content).trim(); if (text && !text.startsWith('<')) yield { t: 'user', text }; }
    else if (m.role === 'assistant') {
      for (const b of Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }]) {
        if (b?.type === 'toolCall') yield { t: 'tool', name: toolName(b.name), input: parseArgs(b.arguments ?? {}), id: b.id };
        else if (b?.type === 'text' && b.text) yield { t: 'text', text: b.text };
      }
      if (m.usage) yield { t: 'usage', model: m.model || '', id: r.id, usage: { input_tokens: m.usage.input || 0, output_tokens: m.usage.output || 0, cache_read_input_tokens: m.usage.cacheRead || 0, cache_creation_input_tokens: m.usage.cacheWrite || 0 } };
    } else if (m.role === 'toolResult') yield { t: 'result', id: m.toolCallId, isError: !!m.isError, text: textOf(m.content) };
  }
}
function* piSessions({ root, days }) {
  const since = Date.now() - days * 864e5, base = path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent'), 'sessions');
  for (const f of walk(base, x => x.endsWith('.jsonl'), 2)) {
    const mtime = mtimeOf(f); if (mtime <= since) continue;
    const cwd = headCwd(f, (r) => (r.type === 'session' ? r.cwd : ''));
    if (root && !within(cwd, root)) continue;
    yield { platform: 'pi', id: path.basename(f, '.jsonl'), file: f, kind: 'main', meta: { cwd }, mtime, events: () => piEvents(f) };
  }
}

const READERS = { 'claude-code': claudeSessions, codex: codexSessions, cursor: cursorSessions, 'copilot-cli': copilotSessions, 'copilot-chat': vscodeChatSessions, 'gemini-cli': geminiSessions, opencode: opencodeSessions, pi: piSessions };
export const registerReader = (platform, fn) => { READERS[platform] = fn; };
export const readers = () => Object.keys(READERS);

/** All sessions for a project (root=null: every project) in the last `days`, across registered platforms. */
export function* sessions({ root = null, days = 30, platforms = Object.keys(READERS) } = {}) {
  for (const p of platforms) {
    if (!READERS[p]) continue;
    try { yield* READERS[p]({ root, days }); } catch { /* one platform's unreadable store must not hide the others */ }
  }
}
