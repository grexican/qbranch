// Replay harness (docs/replay-contract.md): mine recurring tasks from transcripts, re-run one in a throwaway sandbox
// under a controlled change, grade the run, and A/B variants with a hard budget.
//
//   harvestTasks({ root, days, limit, filter })          -> [task]
//   runTask(task, { agent, model, setup, budgetUsd, timeoutMs }) -> run
//   gradeRun(task, run, { judge })                        -> { pass, score, reasons }
//   compareVariants({ tasks, variants, repeats, budgetUsd }) -> { perVariant, perTask, regressions, ... }
//
// Ideas taken from Microsoft SkillOpt-Sleep (github.com/microsoft/SkillOpt, MIT): one task per session's first real
// prompt, deduplicated across sessions; a stable-hash held-out split (assign_splits); hard = every check passes and
// soft = the fraction that pass; and gate_no_regression, which rejects a candidate that turns any held-out task's pass
// into a fail. What is different here: tasks replay as real headless agent runs with tools inside a sandbox (SkillOpt
// replays tasks as single-shot, tool-less text); checks are derived from what the original run actually did (commands
// that succeeded, files it changed) before any LLM judge; a strict read-only filter decides what may replay at all, and
// the same rules run again as a PreToolUse guard during the replay; every run has a hard dollar cap and a kill timer.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { sessions, claudeEvents, encodeProject, costOf, within } from './transcripts.mjs';

// ---------- safety: what a replay may never do ----------

/**
 * Why a tool call would have side effects outside `root`, or '' when it is safe. Self-contained on purpose: the
 * function's source is also written into each sandbox as the PreToolUse guard, so it may not use imports or outer names.
 * Best effort by construction: it reads tool inputs and shell text, so a script that writes or calls out on its own is
 * invisible to it. The git pre-push hook in each sandbox and the dollar cap are the backstops for that.
 */
export function unsafeAction({ tool = '', input = {} } = {}, { root = '', allow = [] } = {}) {
  input = input || {};
  const win = /^[A-Za-z]:/.test(root);
  const slash = (p) => String(p).replace(/\\/g, '/');
  const canon = (abs) => {
    const m = slash(abs).match(/^([A-Za-z]:)?\/(.*)$/); if (!m) return null;
    const out = [];
    for (const s of m[2].split('/')) { if (s === '..') out.pop(); else if (s && s !== '.') out.push(s); }
    const p = (m[1] || '') + '/' + out.join('/');
    return win ? p.toLowerCase() : p;
  };
  const absolute = (p, base) => {
    let s = slash(String(p).replace(/^['"]|['"]$/g, ''));
    if (win) s = s.replace(/^\/([A-Za-z])(\/|$)/, '$1:/'); // git-bash /c/... form
    if (/^(\$TMPDIR|\$\{TMPDIR\}|\$TEMP|\$TMP|%TEMP%|%TMP%|\$env:TEMP|\$env:TMP)/i.test(s)) return 'TMP';
    if (/^(~|\$HOME|\$\{HOME\}|%USERPROFILE%|\$env:USERPROFILE|\$env:APPDATA|%APPDATA%|%LOCALAPPDATA%)/i.test(s)) return null; // home: outside
    if (/^([A-Za-z]:)?\//.test(s)) return canon(s);
    if (/^[A-Za-z]:/.test(s) || !base) return null; // drive-relative, or relative to a cwd that is already outside
    return canon(slash(base) + '/' + s);
  };
  const roots = [root, '/tmp', ...allow].filter(Boolean).map(canon).filter(Boolean);
  const inside = (p, base = root) => {
    if (/^(\/dev\/(null|stdout|stderr)|nul|\$null)$/i.test(String(p))) return true;
    const a = absolute(p, base);
    if (a === 'TMP') return true;
    return !!a && roots.some(r => a === r || a.startsWith(r.replace(/\/$/, '') + '/'));
  };
  // Deleting or moving is stricter than creating: the temp dir is shared with every other process on the machine, so
  // scratch files may be written there, but only the sandbox itself may lose files.
  const own = canon(root);
  const insideSandbox = (p, base = root) => {
    const a = absolute(p, base);
    return !!a && a !== 'TMP' && !!own && (a === own || a.startsWith(own.replace(/\/$/, '') + '/'));
  };

  const file = input.file_path ?? input.path ?? input.notebook_path ?? input.filePath;
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(tool) && file && !inside(file)) return `writes outside the sandbox (${file})`;
  if (/apply_patch/i.test(tool)) {
    for (const m of String(input.patch ?? input.input ?? input.value ?? '').matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) if (!inside(m[1].trim())) return `patches outside the sandbox (${m[1].trim()})`;
  }
  if (/^mcp__/.test(tool) && !/(^|[_-])(get|list|search|read|query|fetch|find|describe|show|view|lookup|status|count|think|recall)([_-]|$)/i.test(tool.split('__').pop())) return `MCP call with side effects (${tool})`;
  if (!/^(Bash|PowerShell|Shell)$/.test(tool)) return '';

  const cmd = String(input.command || '');
  const OUT = [
    [/\bgit\s+(push|send-email)\b|\bgit\s+remote\s+(add|set-url|remove|rm)\b/, 'pushes to a remote'],
    [/\bgit\s+(config\s+(?!--get|-l\b|--list)\S|worktree\s+(add|remove|move|prune)|update-ref|symbolic-ref\s+\S+\s+\S|stash(?!\s+(list|show))\b|gc\b|reflog\s+(expire|delete)|notes\s+(add|edit|remove|append))/, 'changes git state shared with the live repository'],
    [/\bgit\s+(branch\s+(?!(-a|-r|-l|-v|-vv|--list|--show-current|--contains|--merged|--no-merged)\b)[\w-]|tag\s+(?!(-l|--list|-n)\b)[\w-]|(checkout|switch)\s+(-b|-B|-c|-C|--orphan)\b)/, 'creates refs in the live repository'],
    [/\bgh\s+(pr|issue|release|repo|gist|workflow|run|secret|variable|label|project|cache)\s+(create|merge|close|comment|edit|delete|reopen|review|ready|run|rerun|cancel|set|upload|fork|archive|rename|transfer|enable|disable|lock|unlock|pin|transfer|develop)\b/, 'changes GitHub'],
    [/\bgh\s+api\b.*(\s(-X|--method)\s*(POST|PUT|PATCH|DELETE)|\s(-f|-F|--field|--raw-field|--input)\s)/i, 'writes to the GitHub API'],
    [/\b(npm|pnpm|yarn|bun)\s+(publish|unpublish|deprecate|dist-tag|owner|access|login|adduser)\b/, 'publishes a package'],
    [/\b(npm|pnpm|yarn|bun)\s+((i|install|add|remove|uninstall)\s+.*(-g|--global)\b|(-g|--global)\s)|\byarn\s+global\b/, 'installs globally'],
    [/\b(pip3?|uv\s+pip|py(thon3?)?\s+(-\d\s+)?-m\s+pip)\s+(install|uninstall)\b|\b(winget|choco|scoop|brew|apt|apt-get|yum|dnf|pacman|snap)\s+(install|uninstall|remove|upgrade)\b/, 'installs software'],
    [/\b(docker|podman)\s+(push|login|logout)\b|\b(kubectl|oc)\s+(apply|delete|create|patch|replace|scale|rollout|edit|set|annotate|label|exec|drain|cordon)\b|\bhelm\s+(install|upgrade|uninstall|delete|rollback)\b/, 'changes a deployment'],
    [/\b(terraform|tofu)\s+(apply|destroy|import)\b|\bpulumi\s+(up|destroy)\b|\bgcloud\s+.*\b(deploy|create|delete|update)\b|\baz\s+.*\s(create|delete|update|set|deploy|restart|start|stop|purge|upload|assign|add|remove)\b|\baws\s+\S+\s+(put|create|delete|update|send|publish|invoke|start|stop|terminate|run|cp|mv|rm|sync)\b/, 'changes cloud resources'],
    [/\b(vercel|netlify|railway|fly|flyctl|heroku|wrangler|firebase|eas|serverless|sls)\b.*\b(deploy|up|publish|submit|release|push|--prod)\b/, 'deploys'],
    [/\bcurl\b.*(\s(-X|--request)\s*(POST|PUT|PATCH|DELETE)\b|\s(-d|--data\S*|-F|--form|-T|--upload-file|--json)\s)|\bwget\b.*--post-|\b(Invoke-RestMethod|Invoke-WebRequest|irm|iwr)\b.*-Method\s+(Post|Put|Patch|Delete)/i, 'sends data to a server'],
    [/(^|[\s;&|(])(ssh|scp|sftp|rsync|sendmail|mutt|telnet|ftp)\s/, 'talks to another machine'],
    [/(^|[\s;&|(])sudo\s|\b(shutdown|reboot|diskpart|mkfs|setx|schtasks|crontab|launchctl|systemctl)\b|\breg\s+(add|delete|import)\b|\bsc\s+(create|delete|stop|start|config)\b|\b(Set|New|Remove)-ItemProperty\b.*\bHK(LM|CU)/i, 'changes the machine'],
    [/\b(claude|codex|gemini|copilot|opencode|cursor-agent|aider)\s+(-p|--print|exec|run|-c)\b/, 'starts another agent (spend outside the budget)'],
  ];
  for (const [re, why] of OUT) if (re.test(cmd)) return why;

  // writes outside the sandbox: follow cd through the command, then check redirections and file-writing programs
  const WRITERS = /^(rm|rmdir|del|erase|rd|mv|move|cp|copy|xcopy|robocopy|mkdir|md|touch|ln|chmod|chown|tee|install|truncate|remove-item|move-item|copy-item|new-item|set-content|add-content|out-file|rename-item|ri|mi|cpi|ni|sc|ac)$/i;
  let cwd = root;
  for (const seg of cmd.split(/&&|\|\||;|\n|\|/)) {
    const t = seg.trim().match(/"[^"]*"|'[^']*'|\S+/g) || [];
    while (t.length && (/^(rtk|proxy|time|nohup|command|env|exec)$/i.test(t[0]) || /^\w+=/.test(t[0]))) t.shift();
    if (/^timeout$/i.test(t[0] || '')) t.splice(0, 2);
    const prog = (t[0] || '').toLowerCase().replace(/\.exe$/, '');
    if (/^(cd|set-location|pushd|sl|chdir)$/.test(prog)) { const target = t.find((x, i) => i > 0 && !x.startsWith('-')); if (target) { const a = absolute(target, cwd); cwd = a === 'TMP' ? '/tmp' : a; } continue; }
    for (const m of seg.matchAll(/(?:^|[^0-9&<=>-])>>?\s*("[^"]*"|'[^']*'|[^\s;&|>]+)/g)) if (!inside(m[1], cwd)) return `redirects output outside the sandbox (${m[1]})`;
    if (WRITERS.test(prog)) for (const a of t.slice(1)) if (!a.startsWith('-') && !inside(a, cwd)) return `${prog} outside the sandbox (${a})`;
    if (/^(rm|rmdir|del|erase|rd|mv|move|remove-item|ri|move-item|mi|rename-item)$/.test(prog))
      for (const a of t.slice(1)) if (!a.startsWith('-') && !insideSandbox(a, cwd)) return `${prog} removes files outside the sandbox (${a})`;
  }
  return '';
}

/** The guard script written into each sandbox run: a PreToolUse hook that denies what unsafeAction flags. */
export const guardSource = () => `// qbranch replay guard (generated per run): deny tool calls with side effects outside the sandbox.
const unsafeAction = ${unsafeAction.toString()};
let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  let h = {}; try { h = JSON.parse(raw); } catch {}
  let allow = []; try { allow = JSON.parse(process.env.QBRANCH_REPLAY_ALLOW || '[]'); } catch {}
  const why = unsafeAction({ tool: h.tool_name, input: h.tool_input }, { root: process.env.QBRANCH_REPLAY_ROOT || h.cwd || '', allow });
  if (why) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'replay sandbox: ' + why + '. Do the task without it.' } }));
});
`;

// ---------- harvest ----------

const STOP = new Set('the and for with this that are you can please into from about just then also what when your our has have was were will would should could but not all any its use using make need want there here them they how why which been being does did done get got let lets'.split(' '));
/** A prompt's signature: content words, with URLs, paths and numbers generalized. */
export function signature(prompt) {
  return new Set(String(prompt).toLowerCase()
    .replace(/https?:\/\/\S+/g, ' url ').replace(/[a-z]:[\\/]\S*|(^|\s)[.~]?\/\S+/g, ' path ').replace(/\d+/g, ' n ')
    .split(/[^a-z_]+/).filter(w => w.length > 2 && !STOP.has(w)).slice(0, 60));
}
const jaccard = (a, b) => { if (!a.size && !b.size) return 1; let n = 0; for (const x of a) if (b.has(x)) n++; return n / (a.size + b.size - n); };
const isMeta = (t) => { t = t.trim(); return t.length < 8 || t.startsWith('<') || t.startsWith('Caveat:') || t.startsWith('[Pasted text') || (t.startsWith('/') && t.split(/\s+/).length <= 3) || t.startsWith('[Request interrupted'); };

// looking around, and shell syntax that is not a program: neither is evidence that the work got done
const READS = /^(grep|rg|sed|cat|head|tail|ls|dir|echo|sleep|find|wc|pwd|which|where|type|less|awk|sort|uniq|printf|true|test|diff|jq|stat|file|get-content|select-string|get-childitem|start-sleep|write-output|write-host|test-path|cd|set-location|for|while|if|until|case|do|then|foreach|foreach-object|\$\w*|\(|\{|\[)$/i;
/** A command's identity for checks: the program, plus its subcommand when it has one (git commit, npm test, py). */
export function commandKey(cmd) {
  const seg = String(cmd).split(/&&|\|\||;|\n/).map(s => s.trim()).find(s => s && !/^(cd|Set-Location|pushd|export|set)\b/i.test(s)) || '';
  const t = seg.replace(/^(\w+=\S+\s+)+/, '').replace(/^(rtk proxy|rtk|timeout\s+\S+|time|sudo|env|command)\s+/, '').split(/\s+/);
  const prog = path.basename(t[0] || '').replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
  return /^[a-z][\w:-]*$/i.test(t[1] || '') ? `${prog} ${t[1]}` : prog;
}
const SHELL = /^(Bash|PowerShell|Shell)$/;
const DENIED = /hook|denied|replay sandbox|groundhog lesson/i;

/** Digest one session into a task candidate (or null when it has no real prompt). */
function digest(s, root) {
  let meta = {}, prompt = '', finalText = '', cost = 0;
  const calls = [], byId = new Map(), files = [], unsafe = [];
  for (const e of s.events()) {
    if (e.t === 'meta') meta = e;
    else if (e.t === 'user' && !prompt && !isMeta(e.text)) prompt = e.text.trim();
    else if (e.t === 'text') finalText = e.text;
    else if (e.t === 'usage') cost += costOf(e.model, e.usage);
    else if (e.t === 'tool') {
      const cwd = meta.cwd || s.meta?.cwd || root;
      const why = unsafeAction({ tool: e.name, input: e.input }, { root: cwd, allow: [os.tmpdir()] });
      if (why) unsafe.push(why);
      if (SHELL.test(e.name) && e.input?.command) { const c = { tool: e.name, cmd: String(e.input.command).slice(0, 300), err: false, ran: false }; calls.push(c); if (e.id) byId.set(e.id, c); }
      const f = e.input?.file_path ?? e.input?.path;
      if (/^(Write|Edit|MultiEdit)$/.test(e.name) && f && within(path.resolve(cwd, f), cwd)) files.push(path.relative(cwd, path.resolve(cwd, f)).split(path.sep).join('/'));
    } else if (e.t === 'result' && byId.has(e.id)) {
      const c = byId.get(e.id); c.ran = true;
      c.err = !!e.isError || /exit code [1-9]|command not found|not recognized as/i.test((e.text || '').slice(0, 400));
      if (c.err && DENIED.test((e.text || '').slice(0, 200))) c.denied = true;
    }
  }
  if (!prompt || prompt.split(/\s+/).length < 4) return null; // "Reply OK" probes and one-word nudges are not tasks
  const cwd = meta.cwd || s.meta?.cwd || root;
  if (!cwd || /qbranch-replay-/.test(cwd)) return null; // never mine our own replays
  // A prompt that names absolute paths outside its project would send a replay there: the sandbox copies only the
  // project, and a script the agent writes can reach any path. Such a task is never replay-safe.
  for (const p of prompt.match(/(?:\b[A-Za-z]:[\\/]|(?<![\w.])\/(?:[a-z]|Users|home|mnt|var|opt|etc|srv)\/)[^\s'"`<>|)]*/g) || []) {
    const abs = /^\/[a-z]\//i.test(p) ? `${p[1].toUpperCase()}:${p.slice(2)}` : p;
    if (!within(path.resolve(abs), cwd) && !within(path.resolve(abs), os.tmpdir())) unsafe.push(`prompt names a path outside the project (${p.slice(0, 60)})`);
  }
  const ok = calls.filter(c => c.ran && !c.err && !READS.test(commandKey(c.cmd).split(' ')[0]));
  const keys = [...new Map(ok.map(c => [commandKey(c.cmd), c])).values()].slice(-3);
  const checks = [
    { kind: 'completed', hard: true },
    ...[...new Set(files)].slice(-5).map(p => ({ kind: 'fileChanged', path: p, hard: true })),
    ...keys.map(c => ({ kind: 'commandOk', key: commandKey(c.cmd), example: c.cmd.slice(0, 160), hard: false })),
    { kind: 'rubric', text: `Request:\n${prompt.slice(0, 800)}\n\nWhat the original run delivered:\n${finalText.slice(0, 1200)}`, hard: false },
  ];
  return {
    platform: s.platform, prompt, cwd, sessionId: s.parent ? `${s.parent}/${s.id}` : s.id, startedAt: meta.at || new Date(s.mtime).toISOString(),
    readOnly: unsafe.length === 0, unsafe: [...new Set(unsafe)].slice(0, 5), checks, kind: s.kind,
    origCostUsd: +cost.toFixed(4), history: calls.map(({ tool, cmd, err, denied }) => ({ tool, cmd, err, ...(denied ? { denied } : {}) })), mtime: s.mtime,
  };
}

/**
 * Recurring, replayable tasks mined from transcripts (every registered platform reader). A task is a session's first
 * real prompt; sessions in the same directory whose prompts share at least `similarity` of their content words
 * (Jaccard) are one recurring task, represented by its most recent instance.
 */
export function harvestTasks({ root = null, days = 30, limit = 20, filter = (t) => t.readOnly, platforms, minRecurrence = 2, similarity = 0.6, includeSubagents = true } = {}) {
  const clusters = [];
  for (const s of sessions({ root, days, ...(platforms ? { platforms } : {}) })) {
    if (!includeSubagents && s.kind === 'subagent') continue;
    let d; try { d = digest(s, root); } catch { continue; }
    if (!d) continue;
    const sig = signature(d.prompt);
    const c = clusters.find(x => x.cwd === d.cwd && jaccard(x.sig, sig) >= similarity);
    if (c) c.members.push(d); else clusters.push({ cwd: d.cwd, sig, members: [d] });
  }
  const tasks = clusters.map(({ cwd, sig, members }) => {
    members.sort((a, b) => b.mtime - a.mtime);
    const rep = members[0];
    const id = 'task_' + crypto.createHash('sha256').update(`${cwd}::${[...sig].sort().join(' ')}`).digest('hex').slice(0, 12);
    const { mtime, history, ...t } = rep;
    return { id, ...t, readOnly: members.every(m => m.readOnly), unsafe: [...new Set(members.flatMap(m => m.unsafe))].slice(0, 5),
      sessions: members.map(m => m.sessionId), recurrence: members.length, tags: [rep.platform, rep.kind, `recurring:${members.length}`],
      history: members.flatMap(m => m.history).slice(-400), lastSeen: mtime };
  });
  return tasks.filter(t => t.recurrence >= minRecurrence).filter(filter)
    .sort((a, b) => b.recurrence - a.recurrence || b.lastSeen - a.lastSeen).slice(0, limit);
}

/** Stable held-out split (SkillOpt's assign_splits): the same task lands in the same split on every run. */
export function splitTasks(tasks, { holdout = 0.34, seed = 42 } = {}) {
  const bucket = (t) => parseInt(crypto.createHash('sha256').update(`${seed}${t.id}`).digest('hex').slice(0, 8), 16) % 100;
  const out = { train: [], holdout: [] };
  for (const t of tasks) (bucket(t) < Math.round(holdout * 100) ? out.holdout : out.train).push(t);
  if (tasks.length >= 2 && !out.holdout.length) out.holdout.push(out.train.sort((a, b) => bucket(a) - bucket(b)).shift());
  return out;
}

// ---------- sandbox ----------

const git = (args, opts = {}) => spawnSync('git', args, { encoding: 'utf8', windowsHide: true, ...opts });

/**
 * A throwaway copy of `cwd`: a detached git worktree at HEAD when cwd is in a repo (fast, and .gitignored secrets such
 * as .env stay behind), else a plain copy. Git hooks are disabled for the sandbox and a pre-push hook refuses every
 * push, so a script that pushes on its own still cannot reach a remote.
 */
export function makeSandbox(cwd, { mode = 'auto' } = {}) {
  if (!fs.existsSync(cwd)) throw new Error(`task directory no longer exists: ${cwd}`);
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'qbranch-replay-')));
  const hooks = path.join(base, 'git-hooks');
  fs.mkdirSync(hooks);
  fs.writeFileSync(path.join(hooks, 'pre-push'), '#!/bin/sh\necho "qbranch replay sandbox: push refused" >&2\nexit 1\n', { mode: 0o755 });
  const top = mode === 'copy' ? '' : (git(['-C', cwd, 'rev-parse', '--show-toplevel']).stdout || '').trim();
  const work = path.join(base, 'work');
  let dir = work;
  if (top) {
    const r = git(['-c', `core.hooksPath=${hooks}`, '-C', top, 'worktree', 'add', '--detach', work, 'HEAD']);
    if (r.status !== 0) { fs.rmSync(base, { recursive: true, force: true }); throw new Error(`git worktree add failed: ${(r.stderr || '').trim()}`); }
    dir = path.join(work, path.relative(path.resolve(top), path.resolve(cwd)));
  } else {
    fs.cpSync(cwd, work, { recursive: true, filter: (src) => !/[\\/](node_modules|\.git|\.venv|venv|dist|build|\.next)$/.test(src) });
  }
  // every git command inside the sandbox sees the safe hooks dir, not the repository's own hooks
  const env = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: hooks };
  const status = () => (top ? git(['-C', work, 'status', '--porcelain', '-uall'], { env: { ...process.env, ...env } }).stdout || '' : '');
  const cleanup = () => {
    if (top) { git(['-C', top, 'worktree', 'remove', '--force', work]); }
    try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a locked file on Windows: left for the OS temp cleaner */ }
    if (top) git(['-C', top, 'worktree', 'prune']);
  };
  return { base, root: work, dir, git: !!top, env, status, cleanup };
}

// ---------- agents ----------

const AGENTS = {};
/**
 * Register a headless agent adapter:
 *   adapter({ prompt, dir, base, model, budgetUsd, timeoutMs, settings, env }) ->
 *     { exitCode, killed, costUsd, usage, finalText, events, transcriptPath, error? }
 * `settings` is the variant's extra agent settings (Claude Code settings JSON: hooks and the like).
 */
export const registerAgent = (name, adapter) => { AGENTS[name] = adapter; };

function which(bin) {
  if (path.isAbsolute(bin)) return bin;
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const d of (process.env.PATH || '').split(path.delimiter)) for (const e of exts) { const f = path.join(d, bin + e.toLowerCase()); if (fs.existsSync(f)) return f; const g = path.join(d, bin + e); if (fs.existsSync(g)) return g; }
  return bin;
}
function killTree(child) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
}
/** Run a command with stdin, a kill timer, and captured output. */
export function exec(bin, args, { cwd, env, input = '', timeoutMs = 300_000 } = {}) {
  return new Promise((resolve) => {
    const file = which(bin), shim = /\.(cmd|bat)$/i.test(file);
    const q = (a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);
    const child = spawn(shim ? `"${file}"` : file, shim ? args.map(q) : args, { cwd, env, shell: shim, windowsHide: true, detached: process.platform !== 'win32' });
    let stdout = '', stderr = '', killed = false;
    const timer = setTimeout(() => { killed = true; killTree(child); }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ exitCode: -1, stdout, stderr: stderr + e.message, killed }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ exitCode: code ?? -1, stdout, stderr, killed }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const mergeHooks = (...sets) => {
  const out = {};
  for (const s of sets) for (const [ev, list] of Object.entries(s?.hooks || {})) out[ev] = [...(out[ev] || []), ...list];
  return out;
};
const fwd = (p) => p.split(path.sep).join('/');

/**
 * Claude Code, headless: `claude -p --output-format json` in the sandbox, with --max-budget-usd as the hard cap, only
 * the project's own settings (no user hooks or plugins), no MCP servers, and the replay guard as a PreToolUse hook.
 * The session transcript is moved out of ~/.claude/projects so replays never pollute later harvests.
 */
registerAgent('claude', async ({ prompt, dir, base, model, budgetUsd, timeoutMs, settings, env, artifactsDir }) => {
  const guard = path.join(base, 'guard.mjs');
  fs.writeFileSync(guard, guardSource());
  const all = { ...(settings || {}), hooks: mergeHooks({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `node "${fwd(guard)}"` }] }] } }, settings) };
  const settingsFile = path.join(base, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify(all, null, 2));
  const args = ['-p', '--output-format', 'json', '--max-budget-usd', budgetUsd.toFixed(2), '--permission-mode', 'bypassPermissions',
    '--setting-sources', 'project', '--strict-mcp-config', '--settings', settingsFile, ...(model ? ['--model', model] : [])];
  const r = await exec(process.env.QBRANCH_CLAUDE || 'claude', args, { cwd: dir, input: prompt, timeoutMs,
    env: { ...process.env, ...env, QBRANCH_REPLAY_ROOT: dir, QBRANCH_REPLAY_ALLOW: JSON.stringify([os.tmpdir()]), CLAUDECODE: '' } });
  let j = null;
  try { const v = JSON.parse(r.stdout.trim()); j = Array.isArray(v) ? v.find(x => x.type === 'result') : v; } catch { /* killed or crashed: no result object */ }
  // find the transcript: by session id when the CLI answered, else whatever landed in the sandbox's project dir
  const pdir = path.join(claudeHome(), 'projects', encodeProject(dir));
  let transcript = j?.session_id && path.join(pdir, `${j.session_id}.jsonl`);
  if (!transcript || !fs.existsSync(transcript)) transcript = (fs.existsSync(pdir) ? fs.readdirSync(pdir).filter(f => f.endsWith('.jsonl')).map(f => path.join(pdir, f)) : [])[0] || null;
  let events = [], transcriptPath = null;
  if (transcript) {
    events = [...claudeEvents(transcript)];
    fs.mkdirSync(artifactsDir, { recursive: true });
    transcriptPath = path.join(artifactsDir, `${path.basename(base)}.jsonl`);
    fs.copyFileSync(transcript, transcriptPath);
  }
  if (/qbranch-replay-/.test(pdir)) fs.rmSync(pdir, { recursive: true, force: true }); // only ever our own sandbox's dir
  const used = events.filter(e => e.t === 'usage');
  return {
    exitCode: r.exitCode, killed: r.killed,
    costUsd: j?.total_cost_usd ?? used.reduce((s, e) => s + costOf(e.model, e.usage), 0),
    usage: j?.usage ?? null, finalText: j?.result ?? (events.filter(e => e.t === 'text').pop()?.text || ''),
    events, transcriptPath, isError: j ? !!j.is_error || j.subtype !== 'success' : true,
    error: j ? (j.subtype !== 'success' ? j.subtype : '') : (r.killed ? 'timeout' : r.stderr.slice(0, 300)),
  };
});

// ---------- run, grade, compare ----------

/** Point absolute paths in a prompt at the sandbox instead of the live tree (native, forward-slash and JSON-escaped forms). */
const swapRoot = (text, from, to) => {
  const dbl = (p) => p.replace(/\\/g, '\\\\');
  let out = String(text);
  for (const [a, b] of [[dbl(from), dbl(to)], [from, to], [fwd(from), fwd(to)]]) if (a.length > 3) out = out.split(a).join(b);
  return out;
};

/** Run one task in a sandbox (never the live tree) and collect what happened. The sandbox is deleted afterwards. */
export async function runTask(task, { agent = 'claude', model, setup, budgetUsd, timeoutMs = 300_000, sandbox = 'auto', keep = false, allowUnsafe = false, artifactsDir = path.join(os.tmpdir(), 'qbranch-replay-runs') } = {}) {
  if (!(budgetUsd > 0)) throw new Error('runTask needs an explicit budgetUsd (spending is opt-in)');
  if (!task.readOnly && !allowUnsafe) throw new Error(`task ${task.id} is not read-only (${(task.unsafe || []).join('; ')}): refusing to replay it`);
  const adapter = AGENTS[agent];
  if (!adapter) throw new Error(`unknown agent '${agent}' (registered: ${Object.keys(AGENTS).join(', ')})`);
  const sb = makeSandbox(task.cwd, { mode: sandbox });
  const t0 = Date.now();
  try {
    const variant = (setup && await setup(sb.dir, { task, sandbox: sb })) || {};
    const before = new Set(sb.status().split('\n').filter(Boolean));
    const r = await adapter({ prompt: swapRoot(task.prompt, task.cwd, sb.dir), dir: sb.dir, base: sb.base, model, budgetUsd, timeoutMs, settings: variant.settings, env: sb.env, artifactsDir });
    const changed = new Set(sb.status().split('\n').filter(l => l && !before.has(l)).map(l => path.relative(sb.dir, path.join(sb.root, l.slice(3).replace(/^"|"$/g, ''))).split(path.sep).join('/')));
    for (const e of r.events || []) {
      const f = e.t === 'tool' && /^(Write|Edit|MultiEdit)$/.test(e.name) && (e.input?.file_path ?? e.input?.path);
      if (f && within(path.resolve(sb.dir, f), sb.dir)) changed.add(path.relative(sb.dir, path.resolve(sb.dir, f)).split(path.sep).join('/'));
    }
    const usage = r.events?.find(e => e.t === 'usage')?.usage;
    return {
      ok: r.exitCode === 0 && !r.killed && !r.isError, costUsd: r.costUsd || 0, usage: r.usage, durationMs: Date.now() - t0,
      transcriptPath: r.transcriptPath, finalText: r.finalText || '', exitCode: r.exitCode, sandboxDir: sb.dir,
      events: r.events || [], changedFiles: [...changed], killed: !!r.killed, error: r.error || '',
      startupTokens: usage ? (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0) : null,
    };
  } finally { if (!keep) sb.cleanup(); }
}

/** Shell calls of a run, in order: [{ tool, cmd, err, denied }] (a call blocked by a hook is denied, not failed). */
export function runCommands(events) {
  const out = [], byId = new Map();
  for (const e of events || []) {
    if (e.t === 'tool' && SHELL.test(e.name) && e.input?.command) { const c = { tool: e.name, cmd: String(e.input.command), err: false, denied: false, ran: false }; out.push(c); if (e.id) byId.set(e.id, c); }
    else if (e.t === 'result' && byId.has(e.id)) {
      const c = byId.get(e.id), head = (e.text || '').slice(0, 400);
      c.ran = true;
      if (e.isError || /exit code [1-9]|command not found|not recognized as/i.test(head)) { if (DENIED.test(head.slice(0, 200)) && !/exit code/i.test(head)) c.denied = true; else c.err = true; }
    }
  }
  return out;
}

const CHECKS = {
  completed: (t, run) => [run.ok, run.ok ? '' : `run did not complete (${run.error || `exit ${run.exitCode}`})`],
  fileChanged: (t, run, c) => [run.changedFiles?.includes(c.path), `did not change ${c.path}`],
  commandOk: (t, run, c) => [runCommands(run.events).some(x => x.ran && !x.err && !x.denied && commandKey(x.cmd) === c.key), `never ran \`${c.key}\` successfully`],
  noFailure: (t, run, c) => {
    let re; try { re = new RegExp(c.pattern, 'i'); } catch { return [false, `bad pattern ${c.pattern}`]; }
    const bad = runCommands(run.events).filter(x => x.err && (!c.tool || x.tool === c.tool) && re.test(x.cmd));
    return [bad.length === 0, `ran and failed: ${bad[0]?.cmd.slice(0, 120)}`];
  },
  mentions: (t, run, c) => [String(run.finalText).toLowerCase().includes(String(c.text).toLowerCase()), `final answer does not mention ${c.text}`],
};

/**
 * Grade a run against its task's checks. Deterministic checks first: pass = every hard check passes, score = the
 * weighted fraction of checks that pass. The LLM judge (opts.judge) runs only when the task has a rubric and no
 * deterministic check beyond "completed".
 */
export async function gradeRun(task, run, { judge } = {}) {
  const checks = task.checks?.length ? task.checks : [{ kind: 'completed', hard: true }];
  const det = checks.filter(c => CHECKS[c.kind]);
  const rubric = checks.find(c => c.kind === 'rubric');
  if (judge && rubric && det.every(c => c.kind === 'completed')) {
    const j = await judge(task, run, rubric.text);
    return { pass: !!j.pass && run.ok, score: Math.max(0, Math.min(1, Number(j.score) || 0)), reasons: [j.reason || ''].filter(Boolean), judged: true, costUsd: j.costUsd || 0 };
  }
  let got = 0, total = 0, pass = true;
  const reasons = [];
  for (const c of det) {
    const [ok, why] = CHECKS[c.kind](task, run, c);
    const w = c.weight ?? (c.hard ? 1 : 0.5);
    total += w; if (ok) got += w; else { reasons.push(why); if (c.hard) pass = false; }
  }
  return { pass, score: total ? got / total : 0, reasons };
}

/** An LLM judge for rubric-only tasks: one tool-less `claude -p` call, its cost reported back. */
export const claudeJudge = ({ model = 'haiku', budgetUsd = 0.05 } = {}) => async (task, run, rubric) => {
  const prompt = `Grade an AI agent's answer against what an earlier run of the same request delivered. Reply with JSON only: {"pass": true|false, "score": 0..1, "reason": "<one sentence>"}.\n\n${rubric}\n\nNew answer:\n${String(run.finalText).slice(0, 3000)}`;
  const r = await exec(process.env.QBRANCH_CLAUDE || 'claude', ['-p', '--output-format', 'json', '--max-budget-usd', budgetUsd.toFixed(2), '--model', model, '--disallowedTools', '*', '--setting-sources', 'project', '--strict-mcp-config'], { cwd: os.tmpdir(), input: prompt, timeoutMs: 120_000 });
  try { const j = JSON.parse(r.stdout); const v = JSON.parse(String(j.result).match(/\{[\s\S]*\}/)[0]); return { ...v, costUsd: j.total_cost_usd || 0 }; }
  catch { return { pass: false, score: 0, reason: 'judge gave no verdict', costUsd: 0 }; }
};

/**
 * A/B variants over tasks with a total budget. variants = { name: setup(dir) }, the first one is the baseline. Each
 * task's variants run back to back, so running out of budget skips whole tasks, never half a comparison. A regression
 * is a task whose pass rate under a variant is lower than under the baseline (SkillOpt's gate_no_regression).
 */
export async function compareVariants({ tasks, variants, repeats = 1, concurrency = 1, budgetUsd, perRunUsd, minRunUsd = 0.25, agent = 'claude', model, timeoutMs, judge, runner = runTask, onRun = () => {}, sandbox } = {}) {
  if (!(budgetUsd > 0)) throw new Error('compareVariants needs an explicit budgetUsd (spending is opt-in)');
  const names = Object.keys(variants);
  const planned = Math.max(1, tasks.length * names.length * repeats);
  const per = perRunUsd ?? budgetUsd / planned;
  // A replay starved of budget stops mid-task and would read as a failure: refuse a plan that can't produce evidence.
  if (per < minRunUsd) {
    throw new Error(`the budget gives $${per.toFixed(3)} per replay (${tasks.length} tasks x ${names.length} variants x ${repeats}), but a replay needs about $${minRunUsd.toFixed(2)} to finish. `
      + `Raise the budget to $${Math.ceil(planned * minRunUsd)}, or test fewer variants or tasks.`);
  }
  let spent = 0;
  const perTask = [], skipped = [], runs = [], inconclusive = [];
  const stat = () => ({ runs: 0, passes: 0, scoreSum: 0, costUsd: 0, startup: [] });
  const totals = Object.fromEntries(names.map(n => [n, stat()]));
  for (const task of tasks) {
    const row = { id: task.id, prompt: task.prompt.slice(0, 120), variants: Object.fromEntries(names.map(n => [n, stat()])), reasons: {} };
    for (let rep = 0; rep < repeats; rep++) {
      // start a pair only when the rest of the budget can pay for all of it (at the planned cap, up to $0.10 a run)
      if (budgetUsd - spent < names.length * Math.min(per, 0.1)) { skipped.push({ id: task.id, rep, why: 'budget' }); continue; }
      // the variants of one (task, repeat) pair run side by side, up to `concurrency` sandboxes at a time
      const one = async (name, i) => {
        const cap = concurrency > 1 ? per : Math.min(per, (budgetUsd - spent) / (names.length - i));
        let run, grade;
        try {
          run = await runner(task, { agent, model, setup: variants[name], budgetUsd: cap, timeoutMs, ...(sandbox ? { sandbox } : {}) });
          grade = await gradeRun(task, run, { judge });
        } catch (e) { run = { ok: false, costUsd: 0, error: e.message, events: [] }; grade = { pass: false, score: 0, reasons: [e.message] }; }
        spent += (run.costUsd || 0) + (grade.costUsd || 0);
        // cut off by its own budget cap or the timer: no evidence either way, so it is not scored as a failure
        if (run.killed || /max_budget|timeout/i.test(run.error || '')) {
          inconclusive.push({ task: task.id, variant: name, rep, why: run.killed ? 'timeout' : run.error });
          onRun({ task, variant: name, rep, run, grade, spent, inconclusive: true });
          return;
        }
        for (const s of [row.variants[name], totals[name]]) {
          s.runs++; s.passes += grade.pass ? 1 : 0; s.scoreSum += grade.score; s.costUsd += (run.costUsd || 0) + (grade.costUsd || 0);
          if (run.startupTokens != null) s.startup.push(run.startupTokens);
        }
        if (grade.reasons.length) row.reasons[name] = grade.reasons;
        runs.push({ task: task.id, variant: name, rep, pass: grade.pass, score: grade.score, costUsd: run.costUsd || 0, transcriptPath: run.transcriptPath || null });
        onRun({ task, variant: name, rep, run, grade, spent });
      };
      const queue = names.map((n, i) => [n, i]);
      await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => { while (queue.length) await one(...queue.shift()); }));
    }
    perTask.push(row);
  }
  const summary = (s) => ({ runs: s.runs, passRate: s.runs ? s.passes / s.runs : null, meanScore: s.runs ? s.scoreSum / s.runs : null, costUsd: +s.costUsd.toFixed(4),
    startupTokens: s.startup.length ? Math.round(s.startup.reduce((a, b) => a + b, 0) / s.startup.length) : null });
  for (const row of perTask) for (const n of names) row.variants[n] = summary(row.variants[n]);
  const regressions = [];
  const [base, ...rest] = names;
  for (const row of perTask) for (const n of rest) {
    const b = row.variants[base], v = row.variants[n];
    if (b.runs && v.runs && v.passRate < b.passRate) regressions.push({ task: row.id, variant: n, before: b.passRate, after: v.passRate, reasons: row.reasons[n] || [] });
  }
  return { perVariant: Object.fromEntries(names.map(n => [n, summary(totals[n])])), perTask, regressions, skipped, inconclusive, runs, spentUsd: +spent.toFixed(4), complete: skipped.length === 0 && inconclusive.length === 0 };
}
