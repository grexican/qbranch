// Portable hook runtime. One handler serves every agent platform that has hooks: the input is normalized to Claude
// Code's vocabulary, the handler returns a platform-neutral decision, and the output is written in the caller's shape.
//
//   handler(h) where h = { platform, event, tool, input, prompt, response, sessionId, cwd, transcript, raw }
//   returns   { context?, deny?, updatedInput?, keepPermission?, updatedOutput? } | null
//     context        text added to the agent's context (dropped where the platform cannot inject at that event)
//     deny           reason string: block the tool call / prompt
//     updatedInput   replacement tool input (PreToolUse; dropped where the platform cannot rewrite)
//     keepPermission with updatedInput: leave the user's permission flow alone instead of approving the call. Only
//                    Claude Code can rewrite input without a decision; elsewhere a rewrite IS an approval (see
//                    inputRewriteApproves), so the caller must decide whether that is acceptable for the tool
//     updatedOutput  replacement tool result text the model sees (PostToolUse; see canRewriteOutput)
//
// Platform comes from --platform, else is detected from the input. Hooks never throw: a broken hook must not break
// the agent, so every failure exits 0 with no output.
import { readStdin } from './project.mjs';

// What each platform's hooks can do to a tool call (each platform's hooks reference, 2026-10):
//   result rewrite  claude updatedToolOutput (MCP results are not schema-checked); cursor updated_mcp_tool_output (MCP
//                   only, an object); copilot modifiedResult; codex decision:"block" + reason, which replaces the result
//                   with the reason text. gemini only offers deny (shown as an error) or a tail tool call; windsurf
//                   hooks only observe or block: neither can rewrite a result cleanly.
//   input rewrite   claude updatedInput, with or without a permission decision; cursor updated_input needs
//                   permission "allow"; codex updatedInput needs permissionDecision "allow"; copilot modifiedArgs is
//                   rendered with "allow"; gemini tool_input MERGES (a key cannot be removed); windsurf cannot.
const REWRITE_OUTPUT = new Set(['claude', 'cursor', 'copilot', 'codex']);
export const canRewriteOutput = (platform) => REWRITE_OUTPUT.has(platform);
/** Can a PreToolUse hook remove a key from the tool input? (gemini merges; windsurf cannot rewrite at all) */
export const canStripInput = (platform) => ['claude', 'cursor', 'copilot', 'codex'].includes(platform);
/** Does rewriting the input also approve the call (skipping the user's permission prompt)? */
export const inputRewriteApproves = (platform) => platform !== 'claude';

const EVENTS = {
  // cursor
  beforeSubmitPrompt: 'UserPromptSubmit', preToolUse: 'PreToolUse', postToolUse: 'PostToolUse', sessionStart: 'SessionStart',
  stop: 'Stop', subagentStop: 'SubagentStop', beforeShellExecution: 'PreToolUse', beforeMCPExecution: 'PreToolUse',
  // copilot cli (camelCase)
  userPromptSubmitted: 'UserPromptSubmit', agentStop: 'Stop',
  // gemini
  BeforeAgent: 'UserPromptSubmit', BeforeTool: 'PreToolUse', AfterTool: 'PostToolUse', AfterAgent: 'Stop',
  // windsurf / devin
  pre_user_prompt: 'UserPromptSubmit', pre_run_command: 'PreToolUse', pre_mcp_tool_use: 'PreToolUse',
  pre_write_code: 'PreToolUse', pre_read_code: 'PreToolUse', post_mcp_tool_use: 'PostToolUse', post_run_command: 'PostToolUse',
};
const GEMINI_TOOLS = { run_shell_command: 'Bash', write_file: 'Write', replace: 'Edit', read_file: 'Read' };
const CURSOR_TOOLS = { Shell: 'Bash' };

export function detectPlatform(raw) {
  if (raw.agent_action_name || raw.trajectory_id) return 'windsurf';
  if (raw.cursor_version || raw.conversation_id) return 'cursor';
  if ('toolName' in raw || 'toolArgs' in raw) return 'copilot';
  if (/^(Before|After)(Agent|Tool|Model)$/.test(raw.hook_event_name || '')) return 'gemini';
  return 'claude'; // claude code, codex, and copilot reading Claude-format hooks all speak this shape
}

export function normalize(raw, platform = detectPlatform(raw), eventHint) {
  const eventRaw = raw.hook_event_name || raw.agent_action_name || eventHint || '';
  const event = EVENTS[eventRaw] || eventRaw || eventHint;
  let tool = raw.tool_name || raw.toolName || raw.tool_info?.mcp_tool_name || '';
  let input = raw.tool_input ?? raw.toolArgs ?? raw.tool_info?.mcp_tool_arguments ?? raw.tool_info ?? {};
  if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = { value: input }; } }
  // gemini names MCP tools mcp_<server>_<tool>, which cannot be split reliably: mcp_context carries the parts
  if (platform === 'gemini') tool = raw.mcp_context?.server_name ? `mcp__${raw.mcp_context.server_name}__${raw.mcp_context.tool_name || tool}` : GEMINI_TOOLS[tool] || tool;
  if (platform === 'cursor') {
    // Cursor sends "MCP:<tool>" and (in postToolUse) no server name: "mcp" stands in, so handlers must not rely on it
    if (tool.startsWith('MCP:')) tool = `mcp__${raw.server || raw.mcp_server || raw.server_name || raw.mcp_server_name || 'mcp'}__${tool.slice(4)}`;
    tool = CURSOR_TOOLS[tool] || tool;
  }
  if (platform === 'windsurf' && raw.tool_info?.mcp_server_name) tool = `mcp__${raw.tool_info.mcp_server_name}__${tool}`;
  const response = raw.tool_response ?? raw.tool_output ?? raw.toolResult ?? raw.result ?? null;
  const prompt = raw.prompt ?? raw.user_prompt ?? raw.tool_info?.user_prompt ?? '';
  // some shapes (Copilot CLI camelCase) carry no event name: infer it from the payload
  const inferred = event || (tool ? (response != null ? 'PostToolUse' : 'PreToolUse') : prompt ? 'UserPromptSubmit' : '');
  return {
    platform, event: inferred, tool, input, prompt, response,
    sessionId: raw.session_id || raw.conversation_id || raw.sessionId || raw.trajectory_id || '',
    cwd: raw.cwd || raw.workspace_roots?.[0] || process.env.CLAUDE_PROJECT_DIR || process.cwd(),
    transcript: raw.transcript_path || process.env.CURSOR_TRANSCRIPT_PATH || null,
    raw,
  };
}

/** Render a decision in the platform's output shape. Returns { stdout, exitCode, stderr }. */
export function render(h, d) {
  if (!d || (!d.context && !d.deny && !d.updatedInput && d.updatedOutput == null)) return { stdout: '', exitCode: 0 };
  const { platform, event } = h;
  const out = event === 'PostToolUse' && d.updatedOutput != null && canRewriteOutput(platform) ? String(d.updatedOutput) : null;
  if (platform === 'windsurf') return d.deny ? { stdout: '', stderr: d.deny, exitCode: 2 } : { stdout: '', exitCode: 0 };
  if (platform === 'cursor') {
    if (event === 'PreToolUse') {
      const o = d.deny ? { permission: 'deny', agent_message: d.deny, user_message: d.deny } : { permission: 'allow' };
      if (d.updatedInput && !d.deny) o.updated_input = d.updatedInput;
      return { stdout: JSON.stringify(o), exitCode: 0 };
    }
    if (event === 'UserPromptSubmit') return { stdout: JSON.stringify(d.deny ? { continue: false, user_message: d.deny } : { continue: true }), exitCode: 0 };
    // updated_mcp_tool_output is an object that replaces the MCP result: given in the MCP result shape
    const o = {};
    if (out != null) o.updated_mcp_tool_output = { content: [{ type: 'text', text: out }] };
    if (d.context) o.additional_context = d.context;
    return { stdout: Object.keys(o).length ? JSON.stringify(o) : '', exitCode: 0 };
  }
  if (platform === 'copilot') {
    if (event === 'PreToolUse') {
      const o = d.deny ? { permissionDecision: 'deny', permissionDecisionReason: d.deny } : { permissionDecision: 'allow' };
      if (d.updatedInput && !d.deny) o.modifiedArgs = d.updatedInput;
      return { stdout: JSON.stringify(o), exitCode: 0 };
    }
    const o = {};
    if (out != null) o.modifiedResult = { resultType: 'success', textResultForLlm: out };
    if (d.context) o.additionalContext = d.context;
    return { stdout: Object.keys(o).length ? JSON.stringify(o) : '', exitCode: 0 };
  }
  if (platform === 'gemini') {
    if (d.deny) return { stdout: JSON.stringify({ decision: 'deny', reason: d.deny }), exitCode: 0 };
    const hso = {};
    if (d.context) hso.additionalContext = d.context;
    if (d.updatedInput) hso.tool_input = d.updatedInput;
    return { stdout: Object.keys(hso).length ? JSON.stringify({ hookSpecificOutput: hso }) : '', exitCode: 0 };
  }
  // claude code / codex
  const hso = { hookEventName: event };
  if (event === 'PreToolUse') {
    if (d.deny) Object.assign(hso, { permissionDecision: 'deny', permissionDecisionReason: d.deny });
    else if (d.updatedInput) {
      // Claude Code applies updatedInput on its own: without a decision the user's permission flow still runs.
      // Codex only accepts updatedInput together with "allow".
      if (!(d.keepPermission && platform === 'claude')) hso.permissionDecision = 'allow';
      hso.updatedInput = d.updatedInput;
    }
    if (d.context) hso.additionalContext = d.context;
    return { stdout: JSON.stringify({ hookSpecificOutput: hso }), exitCode: 0 };
  }
  if (d.deny && event === 'UserPromptSubmit') return { stdout: JSON.stringify({ decision: 'block', reason: d.deny }), exitCode: 0 };
  if (d.context) hso.additionalContext = d.context;
  // codex: block + reason replaces the result with the reason (its updatedMCPToolOutput marks the hook failed)
  if (out != null && platform === 'codex') return { stdout: JSON.stringify({ decision: 'block', reason: out, hookSpecificOutput: hso }), exitCode: 0 };
  if (out != null) hso.updatedToolOutput = out;
  return { stdout: JSON.stringify({ hookSpecificOutput: hso }), exitCode: 0 };
}

/** Parse --platform/--event from argv, read stdin, run the handler, write the output. Never throws. */
export async function runHook(handler, argv = process.argv.slice(2)) {
  const flag = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  let out = { stdout: '', exitCode: 0 };
  try {
    const text = await readStdin();
    // PowerShell (and any host that pipes through it, e.g. Windows hook runners) prefixes stdin with a UTF-8 BOM
    const body = text.replace(/^﻿/, '');
    const raw = body.trim() ? JSON.parse(body) : {};
    const h = normalize(raw, flag('platform') || detectPlatform(raw), flag('event'));
    out = render(h, await handler(h));
  } catch (e) {
    if (process.env.QB_HOOK_DEBUG) process.stderr.write(`hook error: ${e.stack}\n`);
  }
  if (out.stdout) process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(out.stderr);
  process.exitCode = out.exitCode;
}
