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

test('a BOM-prefixed hook payload (PowerShell pipes add one) still parses', async () => {
  const { execFileSync } = await import('node:child_process');
  const script = `import { runHook } from ${JSON.stringify(new URL('../src/hooks.mjs', import.meta.url).href)};
runHook((h) => ({ deny: 'seen ' + h.tool }));`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script],
    { input: '﻿' + JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'x' } }), encoding: 'utf8' });
  assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecisionReason, 'seen Bash');
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

test('a replacement tool result renders in each platform\'s shape, and is dropped where it cannot be clean', async () => {
  const { canRewriteOutput } = await import('../src/hooks.mjs');
  const post = (platform) => render({ platform, event: 'PostToolUse' }, { updatedOutput: 'SMALL' });
  assert.equal(JSON.parse(post('claude').stdout).hookSpecificOutput.updatedToolOutput, 'SMALL');
  assert.deepEqual(JSON.parse(post('cursor').stdout).updated_mcp_tool_output, { content: [{ type: 'text', text: 'SMALL' }] });
  assert.deepEqual(JSON.parse(post('copilot').stdout).modifiedResult, { resultType: 'success', textResultForLlm: 'SMALL' });
  const codex = JSON.parse(post('codex').stdout);
  assert.deepEqual([codex.decision, codex.reason], ['block', 'SMALL']);
  assert.ok(!JSON.stringify(codex).includes('updatedMCPToolOutput')); // codex marks that field as a failed hook
  assert.equal(post('gemini').stdout, '');
  assert.equal(post('windsurf').stdout, '');
  assert.deepEqual(['claude', 'cursor', 'copilot', 'codex', 'gemini', 'windsurf'].map(canRewriteOutput), [true, true, true, true, false, false]);
});

test('input rewrite: Claude Code keeps the permission flow when asked; codex needs allow', () => {
  const d = { updatedInput: { a: 1 }, keepPermission: true };
  const c = JSON.parse(render({ platform: 'claude', event: 'PreToolUse' }, d).stdout).hookSpecificOutput;
  assert.deepEqual(c.updatedInput, { a: 1 });
  assert.equal(c.permissionDecision, undefined);
  assert.equal(JSON.parse(render({ platform: 'codex', event: 'PreToolUse' }, d).stdout).hookSpecificOutput.permissionDecision, 'allow');
  // without keepPermission a rewrite still approves (moneyball's model rewrite relies on it)
  assert.equal(JSON.parse(render({ platform: 'claude', event: 'PreToolUse' }, { updatedInput: {} }).stdout).hookSpecificOutput.permissionDecision, 'allow');
});

test('MCP tool names: gemini via mcp_context, cursor without a server name', () => {
  const g = normalize({ hook_event_name: 'AfterTool', tool_name: 'mcp_my_crm_list_deals', mcp_context: { server_name: 'my_crm', tool_name: 'list_deals' }, tool_response: {} });
  assert.equal(g.tool, 'mcp__my_crm__list_deals');
  const c = normalize({ hook_event_name: 'postToolUse', conversation_id: 'c', tool_name: 'MCP:list_deals', tool_output: '{}' });
  assert.equal(c.tool, 'mcp__mcp__list_deals');
});
