// Transcript readers: one small synthetic fixture per platform, read through the shared normalized shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { sessions, cursorSlug } from '../src/transcripts.mjs';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const root = tmp('qb-proj-');
const elsewhere = tmp('qb-other-');
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const lines = (...recs) => recs.map(r => JSON.stringify(r)).join('\n') + '\n';
const ENV = ['CODEX_HOME', 'CURSOR_HOME', 'CURSOR_USER_DIR', 'VSCODE_USER_DIR', 'COPILOT_HOME', 'GEMINI_CLI_HOME', 'OPENCODE_DB', 'PI_CODING_AGENT_DIR'];
const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
for (const k of ENV) process.env[k] = path.join(tmp('qb-empty-'), 'none'); // never read the real machine's transcripts
test.after(() => { for (const k of ENV) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });

const read = (platform, r = root) => [...sessions({ root: r, days: 1, platforms: [platform] })].map(s => ({ ...s, ev: [...s.events()] }));
const of = (ev, t) => ev.filter(e => e.t === t);

// Codex fixtures follow the writer's source (openai/codex@86ee40c): exec_command with a string cmd and a plain-text
// output carrying "Process exited with code N"; the legacy shell tool with an argv and "Exit code: N".
test('codex: rollouts under sessions/YYYY/MM/DD (plain and .zst), scoped by cwd, exit codes read from output text', () => {
  const home = tmp('qb-codex-'); process.env.CODEX_HOME = home;
  const body = (cwd) => lines(
    { timestamp: '2026-10-15T10:00:00.000Z', type: 'session_meta', payload: { session_id: 'abc', id: 'abc', cwd, timestamp: '2026-10-15T10:00:00.000Z', originator: 'codex_cli_rs', history_mode: 'legacy' } },
    { timestamp: '2026-10-15T10:00:00.100Z', type: 'turn_context', payload: { turn_id: 't1', cwd, model: 'gpt-5-codex', approval_policy: 'on-request', sandbox_policy: {} } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>x</environment_context>' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'permissions' }] } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'run the generator' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run the generator' }] } },
    { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'python3 gen.py', workdir: cwd }), call_id: 'c1' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'Chunk ID: ab12\nWall time: 0.0500 seconds\nProcess exited with code 127\nOutput:\npython3: not found\n' } },
    { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['powershell.exe', '-Command', 'py gen.py'] }), call_id: 'c2' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c2', output: [{ type: 'input_text', text: 'Exit code: 0\nWall time: 1 seconds\nOutput:\nok' }] } },
    { type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: {} } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 100 }, last_token_usage: { input_tokens: 80, cached_input_tokens: 30, output_tokens: 20, reasoning_output_tokens: 5 } } } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 100 }, last_token_usage: { input_tokens: 80, cached_input_tokens: 30, output_tokens: 20 } } } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'Generated.' } },
  );
  write(path.join(home, 'sessions', '2026', '10', '15', 'rollout-2026-10-15T10-00-00-abc.jsonl'), body(root));
  write(path.join(home, 'sessions', '2026', '10', '15', 'rollout-2026-10-15T11-00-00-def.jsonl'), body(elsewhere));
  if (zlib.zstdCompressSync) { const f = path.join(home, 'sessions', '2026', '10', '01', 'rollout-2026-10-01T09-00-00-old.jsonl.zst'); write(f, ''); fs.writeFileSync(f, zlib.zstdCompressSync(Buffer.from(body(root)))); }
  const ss = read('codex');
  assert.equal(ss.length, zlib.zstdCompressSync ? 2 : 1); // the other project's rollout is out of scope
  for (const s of ss) {
    assert.deepEqual(of(s.ev, 'user').map(e => e.text), ['run the generator']); // once, not twice; no injected context
    assert.deepEqual(of(s.ev, 'tool').map(e => [e.name, e.input.command]), [['Bash', 'python3 gen.py'], ['PowerShell', 'py gen.py']]);
    assert.deepEqual(of(s.ev, 'result').map(e => e.isError), [true, false]);
    const u = of(s.ev, 'usage');
    assert.equal(u.length, 1);
    assert.deepEqual([u[0].model, u[0].usage.input_tokens, u[0].usage.cache_read_input_tokens, u[0].usage.output_tokens], ['gpt-5-codex', 50, 30, 20]);
    assert.equal(of(s.ev, 'meta')[0].cwd, root);
    assert.equal(of(s.ev, 'text')[0].text, 'Generated.');
  }
});

// Cursor IDE store fixture: the shape observed in a real global state.vscdb (2026-10-15), with invented content.
test('cursor ide: conversations from a snapshot of the global store, mapped to their workspace', () => {
  const user = tmp('qb-cursor-user-'); process.env.CURSOR_USER_DIR = user;
  write(path.join(user, 'workspaceStorage', 'ws1', 'workspace.json'), JSON.stringify({ folder: pathToFileURL(root).href }));
  fs.mkdirSync(path.join(user, 'globalStorage'), { recursive: true });
  const db = new DatabaseSync(path.join(user, 'globalStorage', 'state.vscdb'));
  db.exec(`CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
    CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INT, lastUpdatedAt INT, isArchived INT, isSubagent INT, recency INT, checkpointAt INT, value TEXT, subagentTypeName TEXT);`);
  const put = (k, v) => db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run(k, JSON.stringify(v));
  const now = Date.now();
  put('composerData:c1', { _v: 18, composerId: 'c1', createdAt: now - 1000, lastUpdatedAt: now, modelConfig: { modelName: 'claude-sonnet-4-6' }, fullConversationHeadersOnly: [{ bubbleId: 'b1', type: 1 }, { bubbleId: 'b2', type: 2 }, { bubbleId: 'b3', type: 2 }, { bubbleId: 'b4', type: 2 }] });
  put('composerData:c2', { _v: 18, composerId: 'c2', createdAt: now, lastUpdatedAt: now, fullConversationHeadersOnly: [{ bubbleId: 'x1', type: 1 }], subagentInfo: { parentComposerId: 'c1' } });
  put('composerData:draft', { _v: 18, composerId: 'draft', createdAt: now, lastUpdatedAt: now, fullConversationHeadersOnly: [] });
  put('bubbleId:c1:b1', { _v: 3, type: 1, bubbleId: 'b1', text: 'regenerate the client', tokenCount: { inputTokens: 0, outputTokens: 0 } });
  put('bubbleId:c1:b2', { _v: 3, type: 2, bubbleId: 'b2', text: '', toolFormerData: { name: 'run_terminal_command_v2', toolCallId: 't1', status: 'completed', params: JSON.stringify({ command: 'python3 gen.py', cwd: root }), result: JSON.stringify({ output: 'not found', rejected: false, exitCode: 9009 }) } });
  put('bubbleId:c1:b3', { _v: 3, type: 2, bubbleId: 'b3', text: 'Done.', toolFormerData: { name: 'edit_file_v2', toolCallId: 't2', status: 'completed', params: JSON.stringify({ relativeWorkspacePath: 'src/client.ts' }), result: '{}' } });
  put('bubbleId:c1:b4', { _v: 3, type: 2, bubbleId: 'b4', toolFormerData: { name: 'mcp-docs-project-0-docs-search_docs', toolCallId: 't3', status: 'error', params: '{}', result: '{}' } });
  put('bubbleId:c2:x1', { _v: 3, type: 1, bubbleId: 'x1', text: 'look around' });
  db.prepare('INSERT INTO composerHeaders (composerId, workspaceId) VALUES (?, ?)').run('c1', 'ws1');
  db.prepare('INSERT INTO composerHeaders (composerId, workspaceId) VALUES (?, ?)').run('c2', 'ws1');
  db.close();
  const ss = read('cursor');
  assert.deepEqual(ss.map(s => [s.id, s.kind]).sort(), [['c1', 'main'], ['c2', 'subagent']]);
  const c1 = ss.find(s => s.id === 'c1');
  assert.equal(c1.meta.cwd, root);
  assert.equal(of(c1.ev, 'user')[0].text, 'regenerate the client');
  assert.deepEqual(of(c1.ev, 'tool').map(e => e.name), ['Bash', 'Edit', 'mcp__docs__search_docs']);
  assert.equal(of(c1.ev, 'tool')[1].input.file_path, 'src/client.ts');
  assert.deepEqual(of(c1.ev, 'result').map(e => e.isError), [true, false, true]);
  assert.equal(of(c1.ev, 'usage').length, 0); // Cursor records zero token counts: no invented usage
  assert.ok(fs.existsSync(path.join(user, 'globalStorage', 'state.vscdb'))); // read through a snapshot, original untouched
  process.env.CURSOR_USER_DIR = path.join(tmp('qb-empty-'), 'none');
});

// VS Code chat operation log: container shape from a real install, request shape from SkillOpt's fixture; content invented.
test('copilot chat (VS Code): the operation log is replayed into requests, tools and results', () => {
  const user = tmp('qb-vscode-'); process.env.VSCODE_USER_DIR = user;
  write(path.join(user, 'workspaceStorage', 'w1', 'workspace.json'), JSON.stringify({ folder: pathToFileURL(root).href }));
  write(path.join(user, 'workspaceStorage', 'w1', 'chatSessions', 's1.jsonl'), lines(
    { kind: 0, v: { version: 3, creationDate: Date.now(), sessionId: 's1', requests: [], inputState: {} } },
    { kind: 1, k: ['responderUsername'], v: 'GitHub Copilot' },
    { kind: 2, k: ['requests'], v: [{ requestId: 'r1', message: { text: 'fix the failing test' }, response: [], modelId: 'copilot/gpt-5' }] },
    { kind: 2, k: ['requests', 0, 'response'], v: [{ value: 'partial' }] },
    { kind: 2, k: ['requests', 0, 'response'], i: 0, v: [{ value: 'Running the tests.' }, { kind: 'toolInvocationSerialized', toolId: 'run_in_terminal', toolCallId: 'k1', isComplete: true, toolSpecificData: { kind: 'terminal', language: 'pwsh', commandLine: { original: 'npm test' }, terminalCommandState: { exitCode: 1 } } }, { kind: 'toolInvocationSerialized', toolId: 'copilot_readFile', toolCallId: 'k2', isComplete: true }] },
    { kind: 1, k: ['requests', 0, 'result'], v: { usage: { promptTokens: 900, completionTokens: 40 } } },
    { kind: 2, k: ['requests'], v: [{ requestId: 'r2', message: { text: 'scratch' }, response: [] }] },
    { kind: 3, k: ['requests', 1] },
  ));
  const [s, ...more] = read('copilot-chat');
  assert.equal(more.length, 0);
  assert.deepEqual(of(s.ev, 'user').map(e => e.text), ['fix the failing test']); // the deleted request is gone
  assert.deepEqual(of(s.ev, 'text').map(e => e.text), ['Running the tests.']); // the truncated partial is gone
  assert.deepEqual(of(s.ev, 'tool').map(e => [e.name, e.input.command]), [['PowerShell', 'npm test'], ['Read', undefined]]);
  assert.deepEqual(of(s.ev, 'result').map(e => e.isError), [true, false]);
  assert.deepEqual([of(s.ev, 'usage')[0].usage.input_tokens, of(s.ev, 'usage')[0].model], [900, 'copilot/gpt-5']);
  process.env.VSCODE_USER_DIR = path.join(tmp('qb-empty-'), 'none');
});

test('cursor: agent-transcripts per workspace slug, Shell maps to Bash, subagents kept apart', () => {
  const home = tmp('qb-cursor-'); process.env.CURSOR_HOME = home;
  const dir = path.join(home, 'projects', cursorSlug(root).replace(/^./, c => c.toLowerCase()), 'agent-transcripts', 's1');
  write(path.join(dir, 's1.jsonl'), lines(
    { role: 'user', message: { content: [{ type: 'text', text: '<user_info>os</user_info>\n<user_query>\nfix the build\n</user_query>' }] } },
    { role: 'assistant', message: { content: [{ type: 'text', text: 'Running it.' }, { type: 'tool_use', name: 'Shell', input: { command: 'npm run build', description: 'build' } }] } },
    { role: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { path: 'src/a.ts', contents: 'x' } }] } },
    { type: 'turn_ended', status: 'success' },
  ));
  write(path.join(dir, 'subagents', 'sub1.jsonl'), lines({ role: 'user', message: { content: [{ type: 'text', text: 'look around' }] } }));
  const ss = read('cursor');
  const main = ss.find(s => s.kind === 'main'), sub = ss.find(s => s.kind === 'subagent');
  assert.equal(of(main.ev, 'user')[0].text, 'fix the build');
  assert.deepEqual(of(main.ev, 'tool').map(e => e.name), ['Bash', 'Write']);
  assert.equal(of(main.ev, 'tool')[1].input.file_path, 'src/a.ts');
  assert.equal(of(main.ev, 'result').length, 0); // Cursor records no tool results
  assert.equal(sub.parent, 's1');
});

test('copilot cli: events.jsonl per session, session-store.db for the rest', () => {
  const home = tmp('qb-copilot-'); process.env.COPILOT_HOME = home;
  write(path.join(home, 'session-state', 'sess1', 'events.jsonl'), lines(
    { type: 'session.start', data: { sessionId: 'sess1', context: { cwd: root } }, timestamp: '2026-10-15T10:00:00Z' },
    { type: 'user.message', data: { content: 'deploy check' } },
    { type: 'assistant.message', data: { content: 'Checking.', toolRequests: [{ toolCallId: 't1', name: 'bash', arguments: { command: 'make check' } }] } },
    { type: 'tool.execution_start', data: { toolCallId: 't1', toolName: 'bash', arguments: { command: 'make check' } } },
    { type: 'tool.execution_complete', data: { toolCallId: 't1', success: false, result: { content: 'make: *** [check] Error 2' } } },
    { type: 'assistant.usage', data: { model: 'gpt-5', inputTokens: 10, outputTokens: 5 } },
  ));
  const db = new DatabaseSync(path.join(home, 'session-store.db'));
  db.exec(`CREATE TABLE sessions (id TEXT, cwd TEXT, repository TEXT, branch TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE turns (session_id TEXT, turn_index INT, user_message TEXT, assistant_response TEXT);
    CREATE TABLE session_files (session_id TEXT, file_path TEXT, tool_name TEXT);`);
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?)').run('sess2', root, '', 'main', now, now);
  db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?)').run('sess1', root, '', 'main', now, now); // has a log: read from the log
  db.prepare('INSERT INTO turns VALUES (?,?,?,?)').run('sess2', 0, 'summarize the readme', 'It explains setup.');
  db.prepare('INSERT INTO session_files VALUES (?,?,?)').run('sess2', 'README.md', 'view');
  db.close();
  const ss = read('copilot-cli');
  assert.deepEqual(ss.map(s => s.id).sort(), ['sess1', 'sess2']);
  const a = ss.find(s => s.id === 'sess1'), b = ss.find(s => s.id === 'sess2');
  assert.equal(of(a.ev, 'tool').length, 1); // toolRequests and execution_start are the same call
  assert.deepEqual([of(a.ev, 'tool')[0].name, of(a.ev, 'result')[0].isError], ['Bash', true]);
  assert.equal(of(a.ev, 'usage')[0].usage.input_tokens, 10);
  assert.deepEqual([of(b.ev, 'user')[0].text, of(b.ev, 'tool')[0].name, of(b.ev, 'tool')[0].input.file_path], ['summarize the readme', 'Read', 'README.md']);
});

// Gemini fixtures follow the writer's source (google-gemini/gemini-cli@06d3298): a JSONL log under tmp/<slug>/chats,
// with projects.json mapping the project to its slug, re-appended messages, $set/$patch/$rewindTo records.
test('gemini cli: JSONL chat logs under tmp/<slug>/chats are replayed; legacy hash dirs still read', () => {
  const home = tmp('qb-gemini-'); process.env.GEMINI_CLI_HOME = home;
  const g = path.join(home, '.gemini');
  write(path.join(g, 'projects.json'), JSON.stringify({ projects: { [process.platform === 'win32' ? root.toLowerCase() : root]: 'proj' } }));
  const tc = (status, output) => [{ id: 'k1', name: 'run_shell_command', args: { command: 'npm run lint' }, status, result: [{ functionResponse: { id: 'k1', name: 'run_shell_command', response: { output } } }], displayName: 'Shell' }];
  write(path.join(g, 'tmp', 'proj', 'chats', 'session-2026-10-15T10-00-a1b2c3d4.jsonl'), lines(
    { sessionId: 'a1b2c3d4-1', projectHash: 'h', startTime: '2026-10-15T10:00:00.000Z', lastUpdated: '2026-10-15T10:00:00.000Z' },
    { id: 'u1', timestamp: '2026-10-15T10:00:01.000Z', type: 'user', content: [{ text: 'lint the code' }] },
    { $set: { lastUpdated: '2026-10-15T10:00:01.000Z' } },
    { id: 'g1', timestamp: '2026-10-15T10:00:02.000Z', type: 'gemini', content: '', model: 'gemini-3-pro', tokens: null, toolCalls: tc('success', '<untrusted_context>\nOutput: 2 problems\nExit Code: 1\n</untrusted_context>') },
    { id: 'g1', timestamp: '2026-10-15T10:00:02.000Z', type: 'gemini', content: '', model: 'gemini-3-pro', tokens: { input: 100, output: 10, cached: 40, thoughts: 5, tool: 0, total: 115 }, toolCalls: tc('success', '<untrusted_context>\nOutput: 2 problems\nExit Code: 1\n</untrusted_context>') },
    { id: 'g2', timestamp: '2026-10-15T10:00:03.000Z', type: 'gemini', content: 'draft answer' },
    { $patch: { id: 'g2', content: 'Two lint problems.' } },
    { id: 'u2', timestamp: '2026-10-15T10:00:04.000Z', type: 'user', content: 'never mind' },
    { $rewindTo: 'u2' },
  ));
  write(path.join(g, 'tmp', 'proj', 'chats', 'a1b2c3d4-1', 'sub1.jsonl'), lines({ sessionId: 'sub1', projectHash: 'h', startTime: '2026-10-15T10:00:00.000Z', kind: 'subagent' }, { id: 'u1', type: 'user', content: 'scan the repo' }));
  const legacy = crypto.createHash('sha256').update(root).digest('hex');
  write(path.join(g, 'tmp', legacy, 'chats', 'session-old.json'), JSON.stringify({ sessionId: 'old', projectHash: legacy, startTime: '2026-10-15T09:00:00Z', messages: [{ id: 'm1', type: 'user', content: 'old format' }] }));
  write(path.join(g, 'tmp', 'other', 'chats', 'session-x.jsonl'), lines({ sessionId: 'x', projectHash: 'h2' }, { id: 'u1', type: 'user', content: 'other project' }));
  write(path.join(g, 'tmp', 'other', '.project_root'), elsewhere);
  const ss = read('gemini-cli');
  assert.deepEqual(ss.map(s => s.kind).sort(), ['main', 'main', 'subagent']);
  const s = ss.find(x => x.id.startsWith('session-2026'));
  assert.deepEqual(of(s.ev, 'user').map(e => e.text), ['lint the code']); // rewound turn dropped
  assert.deepEqual(of(s.ev, 'tool').map(e => [e.name, e.input.command]), [['Bash', 'npm run lint']]); // re-append replaced, not doubled
  assert.equal(of(s.ev, 'result')[0].isError, true); // status success, but Exit Code: 1
  assert.deepEqual([of(s.ev, 'usage')[0].usage.input_tokens, of(s.ev, 'usage')[0].usage.output_tokens], [60, 15]);
  assert.deepEqual(of(s.ev, 'text').map(e => e.text), ['Two lint problems.']);
  assert.equal(of(s.ev, 'meta')[0].cwd.toLowerCase(), root.toLowerCase());
  assert.equal(of(ss.find(x => x.id === 'session-old').ev, 'user')[0].text, 'old format');
});

test('opencode: sessions, messages and parts from opencode.db', () => {
  const file = path.join(tmp('qb-opencode-'), 'opencode.db'); process.env.OPENCODE_DB = file;
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE session (id TEXT, parent_id TEXT, directory TEXT, agent TEXT, time_created INT, time_updated INT);
    CREATE TABLE message (id TEXT, session_id TEXT, time_created INT, data TEXT);
    CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INT, data TEXT);`);
  const now = Date.now();
  db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?)').run('o1', null, root, 'build', now, now);
  db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?)').run('o2', null, elsewhere, 'build', now, now);
  db.prepare('INSERT INTO message VALUES (?,?,?,?)').run('m1', 'o1', 1, JSON.stringify({ role: 'user' }));
  db.prepare('INSERT INTO message VALUES (?,?,?,?)').run('m2', 'o1', 2, JSON.stringify({ role: 'assistant', modelID: 'claude-sonnet-4-6' }));
  const part = (id, m, data) => db.prepare('INSERT INTO part VALUES (?,?,?,?,?)').run(id, m, 'o1', 1, JSON.stringify(data));
  part('p1', 'm1', { type: 'text', text: 'add a test' });
  part('p2', 'm2', { type: 'tool', tool: 'bash', callID: 'b1', state: { status: 'completed', input: { command: 'npm test' }, output: 'ok', metadata: { exit: 0 } } });
  part('p3', 'm2', { type: 'tool', tool: 'write', callID: 'w1', state: { status: 'error', input: { filePath: 'x.test.ts' }, error: 'denied' } });
  part('p4', 'm2', { type: 'step-finish', tokens: { input: 7, output: 3, reasoning: 1, cache: { read: 2, write: 0 } } });
  db.close();
  const [s, ...more] = read('opencode');
  assert.equal(more.length, 0);
  assert.equal(of(s.ev, 'user')[0].text, 'add a test');
  assert.deepEqual(of(s.ev, 'tool').map(e => e.name), ['Bash', 'Write']);
  assert.equal(of(s.ev, 'tool')[1].input.file_path, 'x.test.ts');
  assert.deepEqual(of(s.ev, 'result').map(e => e.isError), [false, true]);
  assert.deepEqual([of(s.ev, 'usage')[0].model, of(s.ev, 'usage')[0].usage.output_tokens], ['claude-sonnet-4-6', 4]);
});

test('pi: session header carries cwd; toolCall blocks and toolResult messages', () => {
  const home = tmp('qb-pi-'); process.env.PI_CODING_AGENT_DIR = home;
  write(path.join(home, 'sessions', 'proj', 'p1.jsonl'), lines(
    { type: 'session', id: 'p1', cwd: root, timestamp: '2026-10-15T10:00:00Z', version: 3 },
    { type: 'message', id: 'e1', parentId: null, message: { role: 'user', content: [{ type: 'text', text: 'format everything' }] } },
    { type: 'message', id: 'e2', parentId: 'e1', message: { role: 'assistant', model: 'claude-haiku-4-5', usage: { input: 5, output: 2, cacheRead: 1, cacheWrite: 0 }, content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'toolCall', id: 'tc1', name: 'bash', arguments: { command: 'prettier -w .' } }] } },
    { type: 'message', id: 'e3', parentId: 'e2', message: { role: 'toolResult', toolCallId: 'tc1', toolName: 'bash', isError: false, content: [{ type: 'text', text: 'done' }] } },
  ));
  write(path.join(home, 'sessions', 'other', 'p2.jsonl'), lines({ type: 'session', id: 'p2', cwd: elsewhere, timestamp: '2026-10-15T10:00:00Z' }));
  const [s, ...more] = read('pi');
  assert.equal(more.length, 0);
  assert.deepEqual(of(s.ev, 'tool').map(e => [e.name, e.input.command]), [['Bash', 'prettier -w .']]);
  assert.equal(of(s.ev, 'result')[0].isError, false);
  assert.equal(of(s.ev, 'usage')[0].usage.cache_read_input_tokens, 1);
});

test('one unreadable platform store does not hide the others', () => {
  process.env.OPENCODE_DB = path.join(tmp('qb-bad-'), 'opencode.db');
  fs.writeFileSync(process.env.OPENCODE_DB, 'not a database');
  assert.doesNotThrow(() => [...sessions({ root, days: 1 })]);
});
