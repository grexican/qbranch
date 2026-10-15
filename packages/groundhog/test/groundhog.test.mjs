// Shapes, mining over synthetic transcripts, the lessons ledger and its hooks, runbook drafts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shape, head, inspect, related, mine } from '../src/mine.mjs';
import { accept, fromRecovery, loadLessons, preToolUse, sessionStart, shapeRegex } from '../src/lessons.mjs';
import { draftRunbook } from '../src/draft.mjs';
import { DEFAULTS } from '../src/config.mjs';
import { parseFrontmatter } from '@qbranch/core';

// never read the real machine's other-agent stores (only the synthetic Claude Code fixtures below)
for (const k of ['CODEX_HOME', 'CURSOR_HOME', 'CURSOR_USER_DIR', 'VSCODE_USER_DIR', 'COPILOT_HOME', 'GEMINI_CLI_HOME', 'OPENCODE_DB', 'PI_CODING_AGENT_DIR']) process.env[k] = path.join(os.tmpdir(), 'qbranch-test-none', k);
const tmpCfg = (over = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'groundhog-'));
  return { ...DEFAULTS, root, dataDir: path.join(root, '.groundhog'), ...over };
};

test('shape strips cd prefixes and generalizes paths, strings and numbers', () => {
  assert.equal(shape('cd /repo/app && pnpm test --filter "api" 2>&1'), 'pnpm test --filter S');
  assert.equal(shape('Set-Location C:\\work\\x; dotnet test tests/Api.Tests --no-build'), 'dotnet test P --no-build');
  assert.equal(shape('FOO=1 gh run view 123456'), 'gh run view N');
});

test('runner subcommands are the program; wrappers and cd style are stripped', () => {
  assert.equal(head('npx tsc --noEmit N>&N'), 'npx tsc');
  assert.equal(head('npm run lint'), 'npm run lint');
  assert.equal(head('pnpm -s db:seed --env'), 'pnpm db:seed');
  assert.equal(shape('rtk proxy npx vitest run'), 'npx vitest run');
  assert.equal(shape('timeout 300 dotnet test x/y'), 'dotnet test P');
  assert.ok(!related('npx tsc --noEmit', 'npx vitest run --project'));
});

test('a lesson learned in one shell does not fire in another', () => {
  const cfg = tmpCfg();
  accept(cfg, fromRecovery({ tool: 'Bash', from: 'Set-Location P', to: 'cd P', toExample: 'cd app && npm test', count: 3 }));
  const h = (tool) => ({ tool, input: { command: 'Set-Location app; npm test' }, sessionId: `s${Math.random()}` });
  assert.match(preToolUse(cfg, h('Bash')).deny, /use `cd`/);
  assert.equal(preToolUse(cfg, h('PowerShell')), null);
});

test('exploration is not a procedure; a fix must relate to what failed', () => {
  assert.ok(inspect('grep -rn S P') && inspect('python - <<S') && inspect('git status --short'));
  assert.ok(!inspect('pnpm build') && !inspect('git add P'));
  assert.ok(related('python3 manage.py migrate', 'py manage.py migrate'));
  assert.ok(related('pnpm -s db:seed --env', 'pnpm db:seed --env dev'));
  assert.ok(!related('dotnet test P', 'npm run lint'));
});

test('mine finds lessons, sequences and repeats across sessions', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-home-'));
  const cfg = tmpCfg({ minSessions: 2, minRecoveries: 2, minSequence: 2 });
  const proj = path.join(home, 'projects', path.resolve(cfg.root).replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(proj, { recursive: true });
  const session = (name, calls) => {
    const lines = [];
    calls.forEach(([cmd, err], i) => {
      lines.push(JSON.stringify({ type: 'assistant', message: { id: `${name}-${i}`, content: [{ type: 'tool_use', id: `${name}-t${i}`, name: 'Bash', input: { command: cmd } }] } }));
      lines.push(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `${name}-t${i}`, is_error: !!err, content: err ? 'Exit code 1' : 'ok' }] } }));
    });
    fs.writeFileSync(path.join(proj, `${name}.jsonl`), lines.join('\n') + '\n');
  };
  for (const n of ['s1', 's2', 's3']) {
    session(n, [['Set-Location app; npm test', true], ['cd app && npm test'], ['python3 - <<EOF', true], ['py - <<EOF'], ['python3 tools/gen.py', true], ['py tools/gen.py'], ['grep -rn foo src'], ['dotnet build src/App'], ['dotnet test tests/App --no-build']]);
  }
  process.env.CLAUDE_CONFIG_DIR = home;
  try {
    const ix = mine(cfg, { days: 1 });
    assert.equal(ix.sessions, 3);
    const pairs = ix.lessons.map(l => `${l.tool}: ${l.from} => ${l.to}`);
    for (const p of ['Bash: python3 P => py P', 'Bash: Set-Location P => cd P', 'Bash: python3 - <<EOF => py - <<EOF']) assert.ok(pairs.includes(p), p);
    assert.ok(ix.sequences.some(s => s.steps.join(' > ').endsWith('dotnet build P > dotnet test P --no-build'))); // maximal sequence kept
    assert.ok(!ix.repeats.some(r => r.shape.startsWith('grep')));
    assert.ok(fs.existsSync(path.join(cfg.dataDir, 'index.json')));
  } finally { delete process.env.CLAUDE_CONFIG_DIR; }
});

test('a lesson guards matching commands: deny once per session, then remind', () => {
  const cfg = tmpCfg();
  const l = accept(cfg, fromRecovery({ from: 'python3 P', to: 'py P', toExample: 'py tools/gen.py', count: 3 }));
  assert.equal(l.id, 'L1');
  assert.equal(accept(cfg, fromRecovery({ from: 'python3 P', to: 'py P', toExample: 'py x', count: 3 })), null); // dedupe
  const h = { tool: 'Bash', input: { command: 'cd x && python3 tools/gen.py' }, sessionId: `t${Date.now()}` };
  assert.match(preToolUse(cfg, h).deny, /use `py`/);
  assert.match(preToolUse(cfg, h).context, /L1/);
  assert.equal(preToolUse(cfg, { ...h, input: { command: 'py tools/gen.py' } }), null);
  assert.equal(preToolUse(cfg, { ...h, input: { command: 'echo mypython3x' } }), null);
  assert.match(sessionStart(cfg).context, /use `py`/);
  assert.equal(sessionStart({ ...cfg, guard: 'off' }), null);
  assert.equal(loadLessons(cfg).length, 1);
  const s = JSON.parse(fs.readFileSync(path.join(cfg.root, cfg.stats), 'utf8'));
  assert.equal(s.totals.denies, 1);
  assert.equal(s.totals.guard_hits, 2);
});

test('same-program lessons match the failing form only', () => {
  const re = new RegExp(shapeRegex('pnpm -s db:seed --env'));
  assert.ok(re.test('pnpm -s db:seed --env dev'));
  assert.ok(!re.test('pnpm db:seed --env dev'));
});

test('draft writes a valid runbook skill', () => {
  const cfg = tmpCfg();
  const dir = draftRunbook(cfg, { steps: ['dotnet build P', 'dotnet test P --no-build'], examples: ['dotnet build src/App', 'dotnet test tests/App --no-build'], sessions: 9 }, 'verify-backend');
  const { meta, body } = parseFrontmatter(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'));
  assert.equal(meta.name, 'verify-backend');
  assert.match(meta.description, /dotnet build P -> dotnet test P --no-build/);
  assert.match(body, /9 sessions/);
});

// ---------- replay verification (fake agent: no model calls) ----------
import { registerAgent } from '@qbranch/core/replay';
import { verifyLesson, lessonTasks, acceptable } from '../src/verify.mjs';
import { updateLesson } from '../src/lessons.mjs';

let regress = false;
// Behaves like an agent on this machine: without a python lesson in the sandbox ledger it tries python first and fails.
registerAgent('fake-gh', async ({ prompt, dir }) => {
  const ledger = JSON.parse(fs.readFileSync(path.join(dir, 'groundhog.lessons.json'), 'utf8')).lessons;
  const knows = ledger.some(l => /python/.test(l.when));
  const call = (id, command, err) => [{ t: 'tool', name: 'Bash', input: { command }, id }, { t: 'result', id, isError: err, text: err ? 'Exit code 9009' : 'ok' }];
  if (/digest/.test(prompt)) return { exitCode: regress && knows ? 1 : 0, isError: regress && knows, costUsd: 0.05, finalText: 'digest', events: call('d', 'npm run digest', false) };
  return { exitCode: 0, isError: false, costUsd: 0.05, finalText: 'generated', events: knows ? call('b', 'py gen.py', false) : [...call('a', 'python gen.py', true), ...call('b', 'py gen.py', false)] };
});

function verifyFixture() {
  const cfg = tmpCfg();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-home-'));
  const proj = path.join(home, 'projects', path.resolve(cfg.root).replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(proj, { recursive: true });
  const session = (name, prompt, calls) => {
    const lines = [JSON.stringify({ type: 'user', cwd: cfg.root, message: { content: prompt } })];
    calls.forEach(([cmd, err], i) => {
      lines.push(JSON.stringify({ type: 'assistant', message: { id: `${name}-${i}`, content: [{ type: 'tool_use', id: `${name}-t${i}`, name: 'Bash', input: { command: cmd } }] } }));
      lines.push(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `${name}-t${i}`, is_error: !!err, content: err ? 'Exit code 9009' : 'ok' }] } }));
    });
    fs.writeFileSync(path.join(proj, `${name}.jsonl`), lines.join('\n') + '\n');
  };
  session('g1', 'Run the code generator for the schema', [['python gen.py', true], ['py gen.py']]);
  session('d1', 'Build the weekly inbox digest', [['npm run digest']]);
  session('d2', 'Build the weekly inbox digest again', [['npm run digest']]);
  session('p1', 'Publish the digest', [['git push origin main']]); // never replayed
  fs.writeFileSync(path.join(cfg.root, 'groundhog.lessons.json'), JSON.stringify({ lessons: [] }));
  return { cfg, home };
}
const pyLesson = () => fromRecovery({ tool: 'Bash', from: 'python P', to: 'py P', toExample: 'py gen.py', count: 3 });

test('verify picks the tasks that hit the failure, plus unrelated recurring held-out tasks', () => {
  const { cfg, home } = verifyFixture();
  process.env.CLAUDE_CONFIG_DIR = home;
  try {
    const { target, held } = lessonTasks(cfg, pyLesson(), { days: 1 });
    assert.deepEqual(target.map(t => t.prompt), ['Run the code generator for the schema']);
    assert.ok(target[0].checks.some(c => c.kind === 'noFailure'));
    assert.deepEqual(held.map(t => t.recurrence), [2]);
  } finally { delete process.env.CLAUDE_CONFIG_DIR; }
});

test('a lesson that stops the failure and breaks nothing verifies; one that breaks a held-out task is rejected', async () => {
  const { cfg, home } = verifyFixture();
  process.env.CLAUDE_CONFIG_DIR = home;
  try {
    await assert.rejects(verifyLesson(cfg, pyLesson(), { agent: 'fake-gh' }), /--budget/);
    regress = false;
    const ok = await verifyLesson(cfg, pyLesson(), { agent: 'fake-gh', budgetUsd: 1, days: 1 });
    assert.equal(ok.verdict, 'helps');
    assert.ok(acceptable(ok.verdict));
    assert.deepEqual([ok.verified.before.passRate, ok.verified.after.passRate, ok.verified.tasks], [0, 1, 2]);
    assert.deepEqual(ok.verified.regressions, []);
    assert.equal(ok.verified.costUsd, 0.2);
    regress = true;
    const bad = await verifyLesson(cfg, pyLesson(), { agent: 'fake-gh', budgetUsd: 1, days: 1 });
    assert.equal(bad.verdict, 'regressed');
    assert.equal(bad.verified.regressions.length, 1);
    assert.ok(!acceptable(bad.verdict));
    const none = await verifyLesson(cfg, fromRecovery({ tool: 'Bash', from: 'cargo build', to: 'cargo build --locked', toExample: 'cargo build --locked', count: 3 }), { agent: 'fake-gh', budgetUsd: 1, days: 1 });
    assert.equal(none.verdict, 'no-evidence');
    const l = accept(cfg, { ...pyLesson(), verified: ok.verified });
    assert.equal(updateLesson(cfg, l.id, { flagged: 'regressed' }).flagged, 'regressed');
    assert.equal(loadLessons(cfg)[0].verified.verdict, 'helps');
  } finally { regress = false; delete process.env.CLAUDE_CONFIG_DIR; }
});
