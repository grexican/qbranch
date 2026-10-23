// Classes, recommendations, the routing hook, and a scan over synthetic Claude Code transcripts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lexKey, prior, db } from '../src/store.mjs';
import { similar, scan, FAIL } from '../src/scan.mjs';
import { decide, wilson, signal } from '../src/recommend.mjs';
import { preToolUse, writeRoutes } from '../src/route.mjs';
import { DEFAULTS } from '../src/config.mjs';
import { summarize } from '../src/stats.mjs';

const BIN = fileURLToPath(new URL('../bin/moneyball.mjs', import.meta.url));
const tmpCfg = (over = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moneyball-'));
  return { ...DEFAULTS, root, dataDir: path.join(root, '.moneyball'), ...over };
};
const tier = (n, ok, cost) => ({ n, ok, rate: ok / n, cost, perTask: ok ? cost / ok : Infinity });

test('class keys are agent type + leading verb; priors split mechanical from judgment', () => {
  assert.equal(lexKey('general-purpose', 'QA ticket #2256 on dev'), 'general-purpose:qa');
  assert.equal(lexKey('Explore', 'Finding the auth entrypoints'), 'Explore:find');
  assert.equal(lexKey('general-purpose', 'Status of the nightly build'), 'general-purpose:status');
  assert.equal(prior('summariz'), 'mechanical');
  assert.equal(prior('fix'), 'judgment');
  assert.equal(prior('ashgrove'), 'unclear');
});

test('a batch is not a redo; a near-identical re-dispatch is', () => {
  assert.equal(similar('QA ticket #12 on dev', 'QA ticket #13 on dev'), false);
  assert.equal(similar('Research pricing for vendor tools', 'Research pricing for vendor tools again'), true);
});

test('graduate only on evidence, judged per completed task', () => {
  const cfg = { ...DEFAULTS };
  const base = { prior: 'mechanical' };
  assert.equal(decide(cfg, { ...base, tiers: { opus: tier(30, 29, 30), sonnet: tier(12, 12, 6) } }).action, 'graduate');
  assert.equal(decide(cfg, { ...base, tiers: { opus: tier(30, 29, 30), sonnet: tier(12, 9, 6) } }).action, 'keep');      // 75% < bar
  assert.equal(decide(cfg, { ...base, tiers: { opus: tier(30, 29, 30), sonnet: tier(4, 4, 2) } }).action, 'explore');    // not enough trials yet
  assert.equal(decide(cfg, { prior: 'judgment', tiers: { opus: tier(30, 29, 30) } }).action, 'keep');
  assert.equal(decide(cfg, { prior: 'unclear', tiers: { opus: tier(30, 29, 30) } }).action, 'try-effort');
  assert.match(decide(cfg, { ...base, tiers: { sonnet: tier(20, 10, 4), opus: tier(10, 10, 10) } }).why, /move it up/);
  // a platform that records no tokens (Cursor): graduate on outcomes alone, saving unknown, never "free"
  const unpriced = (n, ok) => ({ ...tier(n, ok, 0), priced: 0 });
  const g = decide(cfg, { ...base, tiers: { opus: unpriced(30, 29), sonnet: unpriced(12, 12) } });
  assert.equal(g.action, 'graduate');
  assert.equal(g.saving, null);
  assert.match(g.why, /cost not recorded/);
});

test('hook: suggest, enforce, explore, and caller pins are respected', () => {
  const cfg = tmpCfg();
  writeRoutes(cfg, { 'general-purpose:research': { from: 'opus', to: 'sonnet', action: 'graduate' }, 'general-purpose:qa': { from: 'opus', to: 'sonnet', action: 'explore' } });
  const h = (input) => ({ tool: 'Agent', input: { subagent_type: 'general-purpose', prompt: 'p', ...input } });
  assert.match(preToolUse(cfg, h({ description: 'Research vendor pricing' })).context, /sonnet/);
  assert.equal(preToolUse({ ...cfg, mode: 'enforce' }, h({ description: 'Research vendor pricing' })).updatedInput.model, 'sonnet');
  assert.equal(preToolUse({ ...cfg, mode: 'enforce' }, h({ description: 'Research vendor pricing', model: 'opus' })), null);
  assert.equal(preToolUse({ ...cfg, mode: 'explore' }, h({ description: 'QA ticket 12' }), () => 0.01).updatedInput.model, 'sonnet');
  assert.equal(preToolUse({ ...cfg, mode: 'explore' }, h({ description: 'QA ticket 12' }), () => 0.9), null);
  assert.equal(preToolUse({ ...cfg, mode: 'report' }, h({ description: 'Research vendor pricing' })), null);
  assert.equal(preToolUse(cfg, { tool: 'Bash', input: {} }), null);
  const s = JSON.parse(fs.readFileSync(path.join(cfg.root, cfg.stats), 'utf8'));
  assert.equal(s.totals.dispatches_seen, 6);
  assert.equal(s.totals.explicit_model, 1);
  assert.equal(s.totals.rewrites, 1);
  assert.equal(s.totals.explored, 1);
});

test('hook speaks each platform: Claude updatedInput, Cursor updated_input, Copilot modifiedArgs', () => {
  const cfg = tmpCfg({ mode: 'enforce' });
  writeRoutes(cfg, { 'general-purpose:research': { from: 'opus', to: 'sonnet', action: 'graduate' } });
  const run = (payload) => JSON.parse(execFileSync('node', [BIN, 'hook', 'pre'], { cwd: cfg.root, input: JSON.stringify(payload), encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: cfg.root, MONEYBALL_MODE: 'enforce' } }));
  const input = { subagent_type: 'general-purpose', description: 'Research vendor pricing', prompt: 'p' };
  assert.equal(run({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: input }).hookSpecificOutput.updatedInput.model, 'sonnet');
  assert.equal(run({ hook_event_name: 'preToolUse', conversation_id: 'c', tool_name: 'Task', tool_input: input }).updated_input.model, 'sonnet');
  assert.equal(run({ toolName: 'Task', toolArgs: input }).modifiedArgs.model, 'sonnet');
});

test('scan measures subagent transcripts: cost, model, redo-based failure', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-home-'));
  const cfg = tmpCfg();
  const proj = path.join(home, 'projects', path.resolve(cfg.root).replace(/[^A-Za-z0-9]/g, '-'));
  const sub = path.join(proj, 'sess1', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  const line = (id, model) => JSON.stringify({ type: 'assistant', message: { id, model, usage: { input_tokens: 1000, output_tokens: 1000 }, content: [] } });
  const agent = (name, desc, model, t) => {
    fs.writeFileSync(path.join(sub, `${name}.jsonl`), line(`${name}-m1`, model) + '\n');
    fs.writeFileSync(path.join(sub, `${name}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description: desc, toolUseId: `tu-${name}` }));
    fs.utimesSync(path.join(sub, `${name}.jsonl`), t, t);
  };
  const now = Date.now() / 1000;
  agent('a1', 'Research vendor pricing', 'claude-opus-5-5', now - 600);
  agent('a2', 'Research vendor pricing again', 'claude-opus-5-5', now - 300); // redo of a1
  agent('a3', 'Check nightly status', 'claude-sonnet-5-5', now - 100);
  fs.writeFileSync(path.join(proj, 'sess1.jsonl'), '');
  process.env.CLAUDE_CONFIG_DIR = home;
  try {
    const r = await scan(cfg, { days: 1 });
    assert.equal(r.added, 3);
    const rows = db(cfg).prepare('select id, tier, ok, redo, cost from runs order by mtime').all();
    assert.deepEqual(rows.map(x => [x.tier, x.ok]), [['opus', 0], ['opus', 1], ['sonnet', 1]]);
    assert.ok(Math.abs(rows[0].cost - 0.024) < 1e-9); // 1k in @ $4 + 1k out @ $20
    assert.equal((await scan(cfg, { days: 1 })).added, 0); // incremental
  } finally { delete process.env.CLAUDE_CONFIG_DIR; }
});

test('hook records why each dispatch was or was not acted on, per class', () => {
  const cfg = tmpCfg();
  writeRoutes(cfg, { 'general-purpose:research': { from: 'opus', to: 'sonnet', action: 'graduate' }, 'general-purpose:qa': { from: 'opus', to: 'sonnet', action: 'explore' } });
  const h = (input) => ({ tool: 'Agent', input: { subagent_type: 'general-purpose', prompt: 'p', ...input } });
  preToolUse(cfg, h({ description: 'QA ticket 12' }));
  preToolUse(cfg, h({ description: 'QA ticket 13' }));
  preToolUse(cfg, h({ description: 'Research vendor pricing', model: 'opus' }));
  preToolUse(cfg, h({ description: 'Research vendor pricing' }));
  preToolUse(cfg, h({ description: 'Paint the fence' }));
  assert.equal(preToolUse({ ...cfg, mode: 'off' }, h({ description: 'QA ticket 14' })), null); // off: no routing and no stats write
  preToolUse({ ...cfg, mode: 'bogus' }, h({ description: 'Research vendor pricing' }));
  const s = JSON.parse(fs.readFileSync(path.join(cfg.root, cfg.stats), 'utf8'));
  assert.deepEqual(s.skips, { explore_needs_explore_mode: 2, explicit_pinned: 1, acted: 1, no_class: 1, mode_unknown: 1 });
  assert.equal(s.seen['general-purpose:qa'].n, 2);
  assert.equal(s.seen['general-purpose:qa'].action, 'explore');
  const text = summarize(s);
  assert.match(text, /2 general-purpose:qa|3 general-purpose:qa/);
  assert.match(text, /only explore mode trials the cheaper tier/);
  assert.match(text, /1 had no measured class/);
});

test('judgment work graduates only when the 95% lower bound clears the bar', () => {
  const cfg = { ...DEFAULTS };
  assert.ok(Math.abs(wilson(14, 14) - 0.785) < 0.01);
  const j = (n) => decide(cfg, { prior: 'judgment', tiers: { opus: tier(80, 80, 80), sonnet: tier(n, n, n / 4) } });
  const k = j(14);
  assert.equal(k.action, 'keep');
  assert.match(k.why, /lower bound is 78%/);
  assert.equal(j(40).action, 'graduate'); // lb 91%
  // mechanical work keeps the plain rule
  assert.equal(decide(cfg, { prior: 'mechanical', tiers: { opus: tier(30, 29, 30), sonnet: tier(12, 12, 6) } }).action, 'graduate');
});

test('scan measures wall-clock and flags parent rework of the files a subagent edited', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-home-'));
  const cfg = tmpCfg();
  const proj = path.join(home, 'projects', path.resolve(cfg.root).replace(/[^A-Za-z0-9]/g, '-'));
  const sub = path.join(proj, 'sess2', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  const file = path.join(cfg.root, 'src', 'app.js');
  const t0 = Date.now() - 600_000;
  const usage = (id) => ({ type: 'assistant', message: { id, model: 'claude-sonnet-5-5', usage: { input_tokens: 100, output_tokens: 100 }, content: [] } });
  const sublines = (edits) => [
    { type: 'user', cwd: cfg.root, timestamp: new Date(t0).toISOString(), message: { role: 'user', content: 'go' } },
    usage('m1'),
    { type: 'assistant', message: { id: 'm2', model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: edits } }] } },
  ].map(x => JSON.stringify(x)).join('\n') + '\n';
  const agent = (name, edits) => {
    fs.writeFileSync(path.join(sub, `${name}.jsonl`), sublines(edits));
    fs.writeFileSync(path.join(sub, `${name}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description: `Build widget ${name}`, toolUseId: `tu-${name}` }));
    fs.utimesSync(path.join(sub, `${name}.jsonl`), (t0 + 90_000) / 1000, (t0 + 90_000) / 1000);
  };
  agent('b1', file);
  agent('b2', path.join(cfg.root, 'src', 'other.js'));
  // parent: dispatches both, gets both reports, then edits b1's file (different separators/case on Windows)
  const reworked = process.platform === 'win32' ? file.toUpperCase().split(path.sep).join('/') : file;
  const parent = [
    { type: 'assistant', message: { id: 'p1', content: [{ type: 'tool_use', id: 'tu-b1', name: 'Agent', input: {} }, { type: 'tool_use', id: 'tu-b2', name: 'Agent', input: {} }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-b1', content: 'done' }, { type: 'tool_result', tool_use_id: 'tu-b2', content: 'done' }] } },
    { type: 'assistant', message: { id: 'p2', content: [{ type: 'tool_use', id: 'x1', name: 'Edit', input: { file_path: reworked } }] } },
  ];
  fs.writeFileSync(path.join(proj, 'sess2.jsonl'), parent.map(x => JSON.stringify(x)).join('\n') + '\n');
  process.env.CLAUDE_CONFIG_DIR = home;
  try {
    await scan(cfg, { days: 1 });
    const rows = Object.fromEntries(db(cfg).prepare('select id, rework, ok, secs from runs').all().map(r => [r.id.split(':')[1], r]));
    assert.equal(rows.b1.rework, 1);
    assert.equal(rows.b1.ok, 0);
    assert.equal(rows.b2.rework, 0);
    assert.equal(rows.b2.ok, 1);
    assert.equal(rows.b1.secs, 90);
    const sig = signal(cfg);
    assert.equal(sig.by.rework, 1);
    assert.equal(sig.fail_rate, 0.5);
    assert.equal(sig.saturated, false);
  } finally { delete process.env.CLAUDE_CONFIG_DIR; }
});

test('summary opens with "worth it?": routed classes, $ and minutes per 30 days, and a saturated-signal warning', () => {
  const s = { since: '2026-10-01T00:00:00Z', updated: '2026-10-02T00:00:00Z', totals: { dispatches_seen: 0, explicit_model: 0, matched_class: 0, suggestions: 0, rewrites: 0, explored: 0, scans: 1 },
    skips: {}, seen: {}, last_scan: { runs: 1000, classes: 9, spend: 4000, credit: 0, graduate: 1, explore: 0, est_saving: 700, est_saving_30d: 1050, est_minutes_saved: 400, est_minutes_30d: 600,
      window_days: 20, fail_rate: 0.01, saturated: true, routed: [{ key: 'general-purpose:check', action: 'graduate', from: 'opus', to: 'sonnet', lb: 0.91, n: 40 }] } };
  const text = summarize(s);
  const first = text.split('\n')[0];
  assert.match(first, /^worth it\? routing now: general-purpose:check opus->sonnet/);
  assert.match(text, /\$1050\.00\/30d and ~10\.0 h\/30d/);
  assert.match(text, /quota share, not cash/);
  assert.match(text, /confidence: LOW/);
});

test('background subagents: the late task-notification report is judged (failed status fails), and rework counts from it', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-home-'));
  const cfg = tmpCfg();
  const proj = path.join(home, 'projects', path.resolve(cfg.root).replace(/[^A-Za-z0-9]/g, '-'));
  const sub = path.join(proj, 'sess3', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  const file = path.join(cfg.root, 'src', 'late.js');
  const t0 = Date.now() - 600_000;
  const agent = (name) => {
    fs.writeFileSync(path.join(sub, `${name}.jsonl`), [
      { type: 'user', cwd: cfg.root, timestamp: new Date(t0).toISOString(), message: { role: 'user', content: 'go' } },
      { type: 'assistant', message: { id: `${name}m1`, model: 'claude-sonnet-5-5', usage: { input_tokens: 100, output_tokens: 100 }, content: [{ type: 'tool_use', id: `${name}e`, name: 'Edit', input: { file_path: file } }] } },
    ].map(x => JSON.stringify(x)).join('\n') + '\n');
    fs.writeFileSync(path.join(sub, `${name}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description: `Build late ${name}`, toolUseId: `tu-${name}` }));
  };
  agent('c1'); agent('c2');
  const note = (n, status) => `<task-notification>\n<task-id>id${n}</task-id>\n<tool-use-id>tu-${n}</tool-use-id>\n<status>${status}</status>\n<result>report ${n}</result>\n</task-notification>`;
  const parent = [
    { type: 'assistant', message: { id: 'p1', content: [{ type: 'tool_use', id: 'tu-c1', name: 'Agent', input: {} }, { type: 'tool_use', id: 'tu-c2', name: 'Agent', input: {} }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-c1', content: 'Async agent launched successfully.\nagentId: idc1' }, { type: 'tool_result', tool_use_id: 'tu-c2', content: 'Async agent launched successfully.\nagentId: idc2' }] } },
    // the parent edits the file BEFORE c2's report lands: not rework of c2. c1's report says it failed.
    ...Array.from({ length: 12 }, (_, i) => ({ type: 'assistant', message: { id: `q${i}`, content: [{ type: 'tool_use', id: `y${i}`, name: i === 0 ? 'Edit' : 'Read', input: { file_path: file } }] } })),
    { type: 'user', message: { role: 'user', content: note('c1', 'failed') } },
    { type: 'user', message: { role: 'user', content: note('c2', 'completed') } },
  ];
  fs.writeFileSync(path.join(proj, 'sess3.jsonl'), parent.map(x => JSON.stringify(x)).join('\n') + '\n');
  process.env.CLAUDE_CONFIG_DIR = home;
  try {
    await scan(cfg, { days: 1 });
    const rows = Object.fromEntries(db(cfg).prepare('select id, rework, ok, fail_words from runs').all().map(r => [r.id.split(':')[1], r]));
    assert.equal(rows.c1.fail_words, 1);
    assert.equal(rows.c1.ok, 0);
    assert.equal(rows.c2.rework, 0);
    assert.equal(rows.c2.ok, 1);
  } finally { delete process.env.CLAUDE_CONFIG_DIR; }
});

test('failure words: the agent admitting a gap counts; the product failing, or a worked-around step, does not', () => {
  for (const t of ['I couldn\'t check the tenant session on staging.', 'I could not locate the root cause.', 'I ran out of time before step 3.'])
    assert.ok(FAIL.test(t), t);
  for (const t of ['Saving fails with "Failed to save changes".', 'AC3: Blocked. The connect flow fails before the empty state.',
    'The database tool failed to connect, so I used the SQL script instead.', 'I couldn\'t resolve it from the API, so I read the logs.'])
    assert.ok(!FAIL.test(t), t);
});

test('schema upgrade keeps runs whose transcripts have aged out; they are re-measured only if still on disk', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const cfg = tmpCfg();
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const old = new DatabaseSync(path.join(cfg.dataDir, 'index.db'));
  old.exec(`create table runs (id text primary key, session text, platform text, agent_type text, description text, class_id integer, model text, tier text,
    cost real, calls integer, tool_calls integer, tool_errors integer, redo integer, fail_words integer, ok integer, explored integer default 0, mtime real,
    startup_tokens integer default 0, credit real default 0);
    create table classes (id integer primary key, label text, key text unique, n integer default 0, prior text);
    create table meta (k text primary key, v text);
    insert into meta values ('schema', '2');
    insert into classes values (1, 'general-purpose:check', 'general-purpose:check', 1, 'mechanical');
    insert into runs (id, class_id, model, tier, ok, mtime) values ('claude-code:gone', 1, 'claude-sonnet-5-5', 'sonnet', 1, 1);`);
  old.close();
  const row = db(cfg).prepare('select id, measured_by, secs, rework from runs').get();
  assert.equal(row.id, 'claude-code:gone');
  assert.equal(row.measured_by, 0);
  assert.equal(row.rework, 0);
});
