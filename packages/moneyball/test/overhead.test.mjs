// The startup tax: measurement from transcripts, static contributors, probe attribution (fake runner), variants and
// patches, tune against a fake replay harness, and the delegation credit.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { measureOverhead, staticContributors, attribute, quantile, sandbox } from '../src/overhead.mjs';
import { sections, deriveVariants, writeVariants, loadVariants, applyVariant, unifiedDiff, tune, condense } from '../src/experiments.mjs';
import { delegationCredit, scan } from '../src/scan.mjs';
import { decide, classStats } from '../src/recommend.mjs';
import { summarize } from '../src/stats.mjs';
import { db } from '../src/store.mjs';
import { DEFAULTS } from '../src/config.mjs';

const BIN = fileURLToPath(new URL('../bin/moneyball.mjs', import.meta.url));
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const tmpCfg = () => { const root = tmp('mb-oh-'); return { ...DEFAULTS, root, dataDir: path.join(root, '.moneyball') }; };
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const withHome = async (home, fn) => { process.env.CLAUDE_CONFIG_DIR = home; try { return await fn(); } finally { delete process.env.CLAUDE_CONFIG_DIR; } };

const CLAUDE_MD = ['# Project', '', 'intro line', '', '## Build', 'run npm test', 'always', '', '## Style', 'terse', '', '## Deploy', 'never on friday', ''].join('\n');

/** A fake Claude Code home with one main session (2 requests) and subagents whose first request is a fixed prompt. */
function fakeTranscripts(root, { subs = [40000, 42000, 44000, 60000] } = {}) {
  const home = tmp('mb-oh-home-');
  const proj = path.join(home, 'projects', path.resolve(root).replace(/[^A-Za-z0-9]/g, '-'));
  const msg = (id, model, u, content = []) => JSON.stringify({ type: 'assistant', message: { id, model, usage: u, content } });
  const user = (text) => JSON.stringify({ type: 'user', message: { content: text } });
  write(path.join(proj, 's1.jsonl'), [
    user('x'.repeat(400)), // 100-token first prompt: not part of the tax
    msg('m1', 'claude-opus-5-5', { input_tokens: 100, cache_creation_input_tokens: 30000, cache_read_input_tokens: 0, output_tokens: 1000 },
      [{ type: 'tool_use', id: 'tu-a0', name: 'Agent', input: {} }, { type: 'tool_use', id: 'tu-m', name: 'mcp__docs__search', input: {} }]),
    msg('m2', 'claude-opus-5-5', { input_tokens: 10, cache_read_input_tokens: 40000, output_tokens: 1000 }, [{ type: 'tool_use', id: 't2', name: 'Bash', input: {} }]),
  ].join('\n') + '\n');
  subs.forEach((n, i) => {
    write(path.join(proj, 's1', 'subagents', `a${i}.jsonl`), [
      msg(`a${i}-1`, i % 2 ? 'claude-sonnet-5-5' : 'claude-opus-5-5', { input_tokens: 0, cache_creation_input_tokens: n / 2, cache_read_input_tokens: n / 2, output_tokens: 100 }),
      msg(`a${i}-2`, i % 2 ? 'claude-sonnet-5-5' : 'claude-opus-5-5', { input_tokens: 0, cache_read_input_tokens: n + 20000, output_tokens: 100 }),
    ].join('\n') + '\n');
    write(path.join(proj, 's1', 'subagents', `a${i}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description: `Research topic ${i}`, toolUseId: `tu-a${i}` }));
  });
  return home;
}

test('overhead: first request per session and subagent, separated from the work, priced at its own rates', async () => {
  const cfg = tmpCfg();
  const home = fakeTranscripts(cfg.root);
  const m = await withHome(home, () => measureOverhead({ root: cfg.root, days: 1 }));
  assert.equal(m.subagents.n, 4);
  assert.equal(m.subagents.median, 44000);
  assert.equal(m.subagents.p90, 60000);
  assert.equal(m.sessions.median, 30000); // 30,100 prompt minus the ~100-token first user message
  assert.ok(m.byModel['claude-sonnet-5-5'] && m.byModel['claude-opus-5-5']);
  assert.ok(m.share > 0 && m.share < 1);
  assert.ok(m.startupUsd < m.totalUsd);
  assert.deepEqual(m.mcpCalls, { docs: 1 });
  assert.equal(quantile([], 0.5), 0);
});

test('static contributors: instruction files with imports, rules, skill listing, MCP servers with usage', async () => {
  const cfg = tmpCfg(), home = tmp('mb-oh-home-');
  write(path.join(cfg.root, 'CLAUDE.md'), 'Read @docs/extra.md first.\n' + 'x'.repeat(400));
  write(path.join(cfg.root, 'docs', 'extra.md'), 'y'.repeat(80));
  write(path.join(cfg.root, '.claude', 'rules', 'a.md'), 'z'.repeat(40));
  write(path.join(cfg.root, '.claude', 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: Does a demo thing.\n---\nbody that is not listed');
  write(path.join(cfg.root, '.mcp.json'), JSON.stringify({ mcpServers: { docs: {}, 'old-thing': {} } }));
  const rows = await withHome(home, () => staticContributors(cfg.root, { docs: 3 }));
  const kinds = (k) => rows.filter(r => r.kind === k);
  assert.equal(kinds('project')[0].tokens, Math.ceil((27 + 400) / 4));
  assert.equal(kinds('import')[0].tokens, 20);
  assert.equal(kinds('rules')[0].tokens, 10);
  assert.equal(kinds('skills')[0].count, 1);
  assert.deepEqual(kinds('mcp').map(r => [r.server, r.calls]), [['docs', 3], ['old-thing', 0]]);
});

test('probes: attribute by difference, sandboxed, and stop at the budget', async () => {
  const cfg = tmpCfg(), home = tmp('mb-oh-home-');
  write(path.join(cfg.root, 'CLAUDE.md'), CLAUDE_MD);
  const seen = [];
  // fake `claude -p`: 20k base, +3k instructions (if the sandbox has CLAUDE.md), +8k MCP, +2k skills, +1k plugins, +500 hooks
  const run = (args, cwd) => {
    seen.push(cwd);
    let t = 20000;
    if (fs.existsSync(path.join(cwd, 'CLAUDE.md'))) t += 3000;
    if (!args.includes('--strict-mcp-config')) t += 8000;
    if (!args.includes('--disable-slash-commands')) t += 2000;
    if (!args.join(' ').includes('disableAllHooks')) t += 500;
    return { total_cost_usd: 0.02, usage: { iterations: [{ input_tokens: 10, cache_creation_input_tokens: t - 10, cache_read_input_tokens: 0 }] } };
  };
  const a = await withHome(home, () => attribute(cfg.root, { budget: 1, run }));
  const part = (id) => a.parts.find(p => p.id === id).tokens;
  assert.equal(a.full, 33500);
  assert.equal(part('instructions'), 3000);
  assert.equal(part('mcp'), 8000);
  assert.equal(part('skills'), 2000);
  assert.equal(part('hooks'), 500);
  assert.equal(part('floor'), 20000);
  assert.ok(seen.every(d => !d.startsWith(cfg.root) && !fs.existsSync(d))); // sandboxes, deleted afterwards
  const cheap = await withHome(home, () => attribute(cfg.root, { budget: 0.05, run }));
  assert.ok(cheap.spent <= 0.05);
  assert.ok(cheap.parts.some(p => p.note === 'budget'));
  await assert.rejects(attribute(cfg.root, { run }), /--budget/);
});

test('sandbox copies startup files only; the instructions-off sandbox has none', () => {
  const cfg = tmpCfg();
  write(path.join(cfg.root, 'CLAUDE.md'), CLAUDE_MD);
  write(path.join(cfg.root, 'src', 'big.js'), 'code');
  const on = sandbox(cfg.root), off = sandbox(cfg.root, { instructions: false });
  assert.ok(fs.existsSync(path.join(on, 'CLAUDE.md')) && !fs.existsSync(path.join(on, 'src')));
  assert.ok(!fs.existsSync(path.join(off, 'CLAUDE.md')));
});

test('variants: one per CLAUDE.md section, fresh start, unused MCP; patches are reviewable; live files untouched', () => {
  const cfg = tmpCfg();
  write(path.join(cfg.root, 'CLAUDE.md'), CLAUDE_MD);
  write(path.join(cfg.root, '.claude', 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: d\n---\n');
  write(path.join(cfg.root, '.mcp.json'), JSON.stringify({ mcpServers: { docs: {}, stale: {}, older: {} } }));
  assert.equal(sections(CLAUDE_MD).filter(s => s.title).length, 3);
  const crlf = '# P\r\nintro\r\n## A\r\na\r\n## B\r\nb\r\n';
  assert.equal(sections(crlf).filter(s => s.title !== 'B').map(s => s.text).join(''), '# P\r\nintro\r\n## A\r\na\r\n'); // byte-faithful
  const vs = deriveVariants(cfg.root, { usage: { docs: 4 }, condensed: '# Project\nrun npm test\n' });
  const ids = vs.map(v => v.id);
  for (const id of ['drop-build', 'drop-style', 'drop-deploy', 'condensed', 'fresh-start', 'no-project-skills', 'drop-mcp-stale', 'drop-mcp-older', 'drop-unused-mcp']) assert.ok(ids.includes(id), id);
  assert.ok(!ids.includes('drop-mcp-docs'));
  writeVariants(cfg, vs);
  assert.equal(fs.readFileSync(path.join(cfg.root, 'CLAUDE.md'), 'utf8'), CLAUDE_MD);
  const patch = fs.readFileSync(path.join(cfg.dataDir, 'experiments', 'drop-style', 'patch.diff'), 'utf8');
  assert.match(patch, /^--- a\/CLAUDE\.md\n\+\+\+ b\/CLAUDE\.md\n@@ -6,8 \+6,5 @@/);
  assert.match(patch, /^-## Style$/m);
  assert.match(patch, /^-terse$/m);
  assert.doesNotMatch(patch, /^-## Deploy$/m);
  assert.match(fs.readFileSync(path.join(cfg.dataDir, 'experiments', 'fresh-start', 'patch.diff'), 'utf8'), /\+\+\+ \/dev\/null/);
  assert.equal(loadVariants(cfg).length, vs.length);
  const box = tmp('mb-oh-box-');
  fs.cpSync(cfg.root, box, { recursive: true });
  applyVariant(box, vs.find(v => v.id === 'drop-unused-mcp'));
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(box, '.mcp.json'), 'utf8')).mcpServers), ['docs']);
  applyVariant(box, vs.find(v => v.id === 'fresh-start'));
  assert.ok(!fs.existsSync(path.join(box, 'CLAUDE.md')) && fs.existsSync(path.join(cfg.root, 'CLAUDE.md')));
});

test('unified diff: identical is empty, edits produce valid hunks', () => {
  assert.equal(unifiedDiff('a\nb', 'a\nb', 'f'), '');
  assert.equal(unifiedDiff('a\nb\nc\n', 'a\nB\nc\n', 'f'), '--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n');
  assert.equal(unifiedDiff('x\n', null, 'f'), '--- a/f\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-x\n');
  assert.equal(unifiedDiff(null, 'x', 'f'), '--- /dev/null\n+++ b/f\n@@ -0,0 +1,1 @@\n+x\n\\ No newline at end of file\n');
});

test('tune: recommends only variants that save tokens with no regression at >= 90% of baseline, over the minimum sample', async () => {
  const cfg = tmpCfg();
  write(path.join(cfg.root, 'CLAUDE.md'), CLAUDE_MD);
  writeVariants(cfg, deriveVariants(cfg.root, {}));
  const applied = {};
  const replay = {
    harvestTasks: ({ filter }) => Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, readOnly: i !== 11 })).filter(filter),
    compareVariants: async ({ tasks, variants, budgetUsd }) => {
      assert.equal(tasks.length, 11); assert.equal(budgetUsd, 2);
      for (const [name, setup] of Object.entries(variants)) { // the harness calls setup inside a sandbox copy
        const box = tmp('mb-oh-replay-'); fs.cpSync(cfg.root, box, { recursive: true }); await setup(box);
        applied[name] = fs.existsSync(path.join(box, 'CLAUDE.md')) ? fs.readFileSync(path.join(box, 'CLAUDE.md'), 'utf8') : null;
      }
      return {
        perVariant: {
          baseline: { runs: 11, passRate: 1, meanScore: 0.9, costUsd: 0.5, startupTokens: 30000 },
          'drop-build': { runs: 11, passRate: 0.95, meanScore: 0.88, costUsd: 0.4, startupTokens: 29000 },
          'drop-style': { runs: 11, passRate: 0.7, meanScore: 0.6, costUsd: 0.4, startupTokens: 29900 },
          'drop-deploy': { runs: 11, passRate: 1, meanScore: 0.9, costUsd: 0.4, startupTokens: 29950 },
          'fresh-start': { runs: 11, passRate: 1, meanScore: 0.9, costUsd: 0.4, startupTokens: 30000 },
        },
        perTask: [], regressions: [{ variant: 'drop-deploy', task: 't3' }],
      };
    },
  };
  const r = await tune(cfg, { budget: 2, replay });
  const by = Object.fromEntries(r.variants.map(v => [v.id, v]));
  assert.equal(by['drop-build'].recommend, true);
  assert.match(by['drop-style'].why, /pass rate/);
  assert.match(by['drop-deploy'].why, /regression/);
  assert.match(by['fresh-start'].why, /saves no/);
  assert.equal(applied['fresh-start'], null);
  assert.doesNotMatch(applied['drop-build'], /## Build/);
  assert.equal(applied.baseline, CLAUDE_MD);
  assert.equal(fs.readFileSync(path.join(cfg.root, 'CLAUDE.md'), 'utf8'), CLAUDE_MD); // never auto-applied
  assert.ok(fs.existsSync(path.join(cfg.dataDir, 'experiments', 'last-tune.json')));
  const small = await tune({ ...cfg, minRuns: 50 }, { budget: 2, replay });
  assert.ok(small.variants.every(v => !v.recommend));
  await assert.rejects(tune(cfg, { replay }), /--budget/);
});

test('tune CLI refuses without a budget, and says clearly when the replay harness is missing', () => {
  const cfg = tmpCfg();
  const run = (...a) => spawnSync('node', [BIN, ...a], { cwd: cfg.root, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: cfg.root } });
  assert.match(run('tune').stderr, /--budget/);
  const r = run('tune', '--budget', '1');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /replay harness|no experiments/);
});

test('condense: model-written CLAUDE.md through the injected runner, budget required', async () => {
  const cfg = tmpCfg();
  write(path.join(cfg.root, 'CLAUDE.md'), CLAUDE_MD);
  let stdin = null;
  const c = await condense(cfg.root, { budget: 0.1, run: (args, cwd, input) => { stdin = input; return { result: '# Project\nnpm test', total_cost_usd: 0.01 }; } });
  assert.equal(stdin, CLAUDE_MD);
  assert.equal(c.text, '# Project\nnpm test\n');
  await assert.rejects(condense(cfg.root, {}), /--budget/);
});

test('delegation credit: kept-out context x later parent turns at the parent cache-read rate; verbose reports earn less', () => {
  const parent = { turns: 10, model: 'claude-opus-5-5' }; // cache read $0.2/M
  assert.ok(Math.abs(delegationCredit({ startup: 40000, peak: 140000, report: '', parent }) - 100000 * 10 * 0.2 / 1e6) < 1e-12);
  assert.ok(delegationCredit({ startup: 40000, peak: 140000, report: 'r'.repeat(40000), parent }) < delegationCredit({ startup: 40000, peak: 140000, report: '', parent }));
  assert.equal(delegationCredit({ startup: 40000, peak: 140000, parent: { turns: 500, model: 'claude-opus-5-5' } }), 100000 * 50 * 0.2 / 1e6); // capped
  assert.equal(delegationCredit({ startup: 40000, peak: 140000, parent: undefined }), 0);
});

test('scan stores startup tokens and credit; recommendations judge cost net of the credit', async () => {
  const cfg = tmpCfg();
  const home = fakeTranscripts(cfg.root, { subs: [40000] });
  await withHome(home, () => scan(cfg, { days: 1 }));
  const row = db(cfg).prepare('select startup_tokens, credit from runs').get();
  assert.equal(row.startup_tokens, 40000);
  assert.ok(Math.abs(row.credit - 20000 * 2 * 0.2 / 1e6) < 1e-12); // 20k kept out, 2 parent tool calls after the dispatch
  const c = classStats(cfg)[0];
  assert.ok(c.tiers.opus.perTask < c.tiers.opus.cost);
  // the credit is the parent's, whatever tier the subagent ran on: equal gross saving, but net per completed task decides
  const t = (n, ok, cost, credit) => ({ n, ok, rate: ok / n, cost, credit, perTask: (cost - credit) / ok });
  assert.equal(decide(DEFAULTS, { prior: 'mechanical', tiers: { opus: t(20, 20, 20, 0), sonnet: t(10, 10, 5, 0) } }).saving, 10);
  assert.equal(decide(DEFAULTS, { prior: 'mechanical', tiers: { opus: t(20, 20, 20, 10), sonnet: t(10, 10, 5, 0) } }).action, 'keep');
});

test('stats summary shows the startup tax and the last experiment', () => {
  const s = { since: '2026-10-01T00:00:00Z', updated: '2026-10-15T10:00:00Z', totals: { dispatches_seen: 0, explicit_model: 0, matched_class: 0, suggestions: 0, rewrites: 0, explored: 0 },
    last_scan: null, overhead: { at: '2026-10-15T10:00:00Z', subagents: { median: 47000 }, sessions: { median: 52000 }, startup_usd: 12.5, share: 0.083 },
    last_experiment: { at: '2026-10-15T11:00:00Z', tasks: 12, variants: 5, spent: 3.2, recommended: ['drop-style'] } };
  const out = summarize(s);
  assert.match(out, /median 47000 tokens per subagent.*8\.3% of spend/);
  assert.match(out, /recommended: drop-style/);
});
