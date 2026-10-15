// The portable hook runtime: one decision, every platform's input and output shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, render, detectPlatform } from '../src/hooks.mjs';

test('detects the platform from the input shape', () => {
  assert.equal(detectPlatform({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }), 'claude');
  assert.equal(detectPlatform({ hook_event_name: 'preToolUse', conversation_id: 'c' }), 'cursor');
  assert.equal(detectPlatform({ toolName: 'bash', toolArgs: '{}' }), 'copilot');
  assert.equal(detectPlatform({ hook_event_name: 'BeforeTool', tool_name: 'run_shell_command' }), 'gemini');
  assert.equal(detectPlatform({ agent_action_name: 'pre_run_command', tool_info: {} }), 'windsurf');
});

test('normalizes events, tool names and inputs to Claude Code vocabulary', () => {
  const g = normalize({ hook_event_name: 'BeforeTool', tool_name: 'run_shell_command', tool_input: { command: 'ls' } });
  assert.deepEqual([g.event, g.tool, g.input.command], ['PreToolUse', 'Bash', 'ls']);
  const c = normalize({ hook_event_name: 'preToolUse', conversation_id: 'c', tool_name: 'MCP:list_deals', server: 'crm' });
  assert.equal(c.tool, 'mcp__crm__list_deals');
  const p = normalize({ toolName: 'Task', toolArgs: '{"description":"x"}' });
  assert.deepEqual([p.event, p.input.description], ['PreToolUse', 'x']);
  assert.equal(normalize({ hook_event_name: 'BeforeAgent', prompt: 'hi' }).event, 'UserPromptSubmit');
});

test('renders one decision per platform', () => {
  const pre = (platform) => ({ platform, event: 'PreToolUse' });
  const deny = { deny: 'no' };
  assert.equal(JSON.parse(render(pre('claude'), deny).stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(JSON.parse(render(pre('cursor'), deny).stdout).permission, 'deny');
  assert.equal(JSON.parse(render(pre('copilot'), deny).stdout).permissionDecision, 'deny');
  assert.equal(JSON.parse(render(pre('gemini'), deny).stdout).decision, 'deny');
  assert.deepEqual(render(pre('windsurf'), deny), { stdout: '', stderr: 'no', exitCode: 2 });
  const ctx = { context: 'hello' };
  const ups = (platform) => ({ platform, event: 'UserPromptSubmit' });
  assert.equal(JSON.parse(render(ups('claude'), ctx).stdout).hookSpecificOutput.additionalContext, 'hello');
  assert.equal(JSON.parse(render(ups('gemini'), ctx).stdout).hookSpecificOutput.additionalContext, 'hello');
  assert.equal(JSON.parse(render(ups('cursor'), ctx).stdout).continue, true); // cursor cannot inject at prompt time
  assert.equal(render(ups('windsurf'), ctx).stdout, '');
  assert.equal(render(pre('claude'), null).stdout, '');
});
