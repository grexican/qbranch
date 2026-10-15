// Classes, recommendations, the routing hook, and a scan over synthetic Claude Code transcripts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lexKey, prior, db } from '../src/store.mjs';
import { similar, scan } from '../src/scan.mjs';
import { decide } from '../src/recommend.mjs';
import { preToolUse, writeRoutes } from '../src/route.mjs';
import { DEFAULTS } from '../src/config.mjs';

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
