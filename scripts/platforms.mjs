// Platform translation: the canonical Claude Code plugin layout (packages/<tool>) -> every other agent's native format.
// Shared by sync.mjs (generated adapter packages) and install.mjs (project-level install). Hook handlers normalize
// their own input and filter tool names themselves, so a hook here only needs the right event and command.
//
// Sources: each platform's hooks/MCP/skills docs as of 2026-10 (Cursor, Codex, Gemini CLI, Copilot CLI + VS Code,
// Windsurf/Devin). Marked UNVERIFIED where the docs were silent.
import fs from 'node:fs';
import path from 'node:path';

export const TOOLS = ['headjack', 'middleout', 'moneyball', 'groundhog'];
export const PLATFORMS = ['claude', 'cursor', 'codex', 'gemini', 'copilot', 'windsurf'];

/** Canonical hook entries of a tool: [{ event, matcher, args, timeout }] (args = everything after the script path). */
export function hookEntries(pkgDir) {
  const f = path.join(pkgDir, 'hooks', 'hooks.json');
  if (!fs.existsSync(f)) return [];
  const out = [];
  for (const [event, groups] of Object.entries(JSON.parse(fs.readFileSync(f, 'utf8')).hooks || {})) {
    for (const g of groups) for (const h of g.hooks) {
      const args = h.command.replace(/^node\s+"[^"]+"\s*/, '');
      out.push({ event, matcher: g.matcher, args, timeout: h.timeout || 10 });
    }
  }
  return out;
}

/** Canonical MCP servers of a tool: { name: { args } } (args after the script path). */
export function mcpServers(pkgDir) {
  const f = path.join(pkgDir, '.mcp.json');
  if (!fs.existsSync(f)) return {};
  const out = {};
  for (const [name, s] of Object.entries(JSON.parse(fs.readFileSync(f, 'utf8')).mcpServers || {})) out[name] = { args: s.args.slice(1) };
  return out;
}

const EVENTS = {
  cursor:   { UserPromptSubmit: 'beforeSubmitPrompt', PreToolUse: 'preToolUse', PostToolUse: 'postToolUse', SessionStart: 'sessionStart' },
  codex:    { UserPromptSubmit: 'UserPromptSubmit', PreToolUse: 'PreToolUse', PostToolUse: 'PostToolUse', SessionStart: 'SessionStart' },
  gemini:   { UserPromptSubmit: 'BeforeAgent', PreToolUse: 'BeforeTool', PostToolUse: 'AfterTool', SessionStart: 'SessionStart' },
  copilot:  { UserPromptSubmit: 'userPromptSubmitted', PreToolUse: 'preToolUse', PostToolUse: 'postToolUse', SessionStart: 'sessionStart' },
};
// Tool-name matchers that translate cleanly. Anything else is dropped: the handler filters by tool name itself.
const MATCHERS = {
  cursor: { 'Bash|PowerShell': 'Shell' },
  codex:  { 'Bash|PowerShell': 'Bash', 'mcp__.*': 'mcp__.*' },
  gemini: { 'Bash|PowerShell': 'run_shell_command' },
};

/**
 * Render a platform's hooks config.
 *   cmd(args) -> { sh, ps } : the command line for POSIX shells and for PowerShell / Windows
 * Returns the JSON object for that platform's hooks file, or null when nothing applies.
 */
export function renderHooks(platform, entries, cmd) {
  const hooks = {};
  const add = (ev, entry) => (hooks[ev] ||= []).push(entry);
  for (const e of entries) {
    const c = cmd(`${e.args} --platform ${platform === 'claude' ? 'claude' : platform}`);
    if (platform === 'claude' || platform === 'codex') {
      const ev = platform === 'claude' ? e.event : EVENTS.codex[e.event];
      const h = { type: 'command', command: c.sh, timeout: e.timeout };
      if (platform === 'codex' && c.ps !== c.sh) h.commandWindows = c.ps;
      const m = platform === 'claude' ? e.matcher : MATCHERS.codex[e.matcher];
      add(ev, { ...(m ? { matcher: m } : {}), hooks: [h] });
    } else if (platform === 'cursor') {
      // UserPromptSubmit cannot inject context in Cursor (block only): headjack's suggestion hook is skipped there.
      if (e.event === 'UserPromptSubmit') continue;
      const m = MATCHERS.cursor[e.matcher];
      add(EVENTS.cursor[e.event], { command: c.sh, timeout: e.timeout, ...(m ? { matcher: m } : {}) });
    } else if (platform === 'gemini') {
      const m = MATCHERS.gemini[e.matcher];
      add(EVENTS.gemini[e.event], { ...(m ? { matcher: m } : {}), hooks: [{ type: 'command', command: c.sh, timeout: e.timeout * 1000 }] });
    } else if (platform === 'copilot') {
      // Copilot CLI drops userPromptSubmitted output: skip it.
      if (e.event === 'UserPromptSubmit') continue;
      add(EVENTS.copilot[e.event], { type: 'command', bash: c.sh, powershell: c.ps, timeoutSec: e.timeout });
    } else if (platform === 'windsurf') {
      // Windsurf hooks can only block (exit 2): no context injection, no input rewrite. Only the guards carry over.
      const ev = e.event === 'PreToolUse' && e.matcher === 'Bash|PowerShell' ? 'pre_run_command'
        : e.event === 'PreToolUse' && e.matcher === 'mcp__.*' ? 'pre_mcp_tool_use' : null;
      if (ev) add(ev, { command: c.sh, powershell: c.ps, show_output: false });
    }
  }
  if (!Object.keys(hooks).length) return null;
  if (platform === 'cursor' || platform === 'copilot') return { version: 1, hooks };
  return { hooks };
}

/** Render MCP servers in a platform's config shape: { file-shape object } or null. cmd(args) -> { command, args }. */
export function renderMcp(platform, servers, cmd) {
  const names = Object.keys(servers);
  if (!names.length) return null;
  const entries = Object.fromEntries(names.map(n => [n, cmd(servers[n].args)]));
  if (platform === 'cursor') return { mcpServers: Object.fromEntries(names.map(n => [n, { type: 'stdio', ...entries[n] }])) };
  if (platform === 'codex') return { toml: names.map(n => `[mcp_servers.${n}]\ncommand = ${JSON.stringify(entries[n].command)}\nargs = ${JSON.stringify(entries[n].args)}\n`).join('\n') };
  return { mcpServers: entries }; // claude (.mcp.json), gemini (settings.json), copilot (.mcp.json), windsurf (user mcp_config.json)
}

/** agentskills.io spec: name 1-64 of a-z0-9-, no leading/trailing/double hyphen, matches folder; description <= 1024. */
export function checkSkill(dir, meta) {
  const errs = [];
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(meta.name || '') || meta.name.length > 64) errs.push(`name "${meta.name}" breaks the spec`);
  if (meta.name !== path.basename(dir)) errs.push(`name "${meta.name}" != folder "${path.basename(dir)}"`);
  if (!meta.description || meta.description.length > 1024) errs.push('description missing or over 1024 chars');
  return errs;
}
