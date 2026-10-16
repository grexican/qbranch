// History scenarios: mine, validate, run and grade against a tiny synthetic repo, with fake agents (no model calls).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mineScenarios, validateScenario, runScenario, runnerFromScript, testCommand, glob, scenarioPrompt, depsGuard, saveScenario, loadScenarios, scenariosDir } from '../src/scenarios.mjs';
import { registerAgent, gradeRun, compareVariants } from '../src/replay.mjs';

const tmp = (p) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const git = (cwd, ...a) => { const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
const put = (root, files) => { for (const [p, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), c); } };
const commit = (root, msg, files) => { put(root, files); git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', msg); return git(root, 'rev-parse', 'HEAD'); };

const FIXED_ADD = 'export const add = (a, b) => a + b;\n';
const ADD_TEST = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/add.mjs';\ntest('add', () => assert.equal(add(2, 3), 5));\n";

// a function with a bug, a commit that fixes it and adds a test, a docs commit (no tests), a tests-only commit, and a
// commit whose new test already passes at its parent. A dependency lives only in the live checkout's node_modules.
function fixture() {
  const root = tmp('qb-scn-');
  git(root, 'init', '-q');
  commit(root, 'initial', {
    '.gitignore': 'node_modules\n',
    'package.json': JSON.stringify({ name: 'demo', type: 'module', scripts: { test: 'node --test "test/*.test.mjs"' } }),
    'src/add.mjs': 'export const add = (a, b) => a - b;\n',
    'src/mul.mjs': "import { twice } from 'helper-dep';\nexport const mul = (a, b) => a * b;\nexport const double = (a) => twice(a);\n",
    'test/mul.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { mul, double } from '../src/mul.mjs';\ntest('mul', () => { assert.equal(mul(2, 3), 6); assert.equal(double(4), 8); });\n",
  });
  put(root, { 'node_modules/helper-dep/package.json': JSON.stringify({ name: 'helper-dep', type: 'module', main: 'index.js' }), 'node_modules/helper-dep/index.js': 'export const twice = (a) => a * 2;\n' });
  const fix = commit(root, 'Fix add: it subtracted\n\nadd() must return the sum of its arguments.\n\nCo-Authored-By: Someone <x@y>', { 'src/add.mjs': FIXED_ADD, 'test/add.test.mjs': ADD_TEST });
  commit(root, 'docs: readme', { 'README.md': '# demo\n' });
  commit(root, 'test: more mul cases', { 'test/mul.test.mjs': fs.readFileSync(path.join(root, 'test/mul.test.mjs'), 'utf8') + "test('mul 0', () => assert.equal(mul(0, 9), 0));\n" });
  const passes = commit(root, 'mul: comment, plus a test', { 'src/mul.mjs': '// multiply\n' + fs.readFileSync(path.join(root, 'src/mul.mjs'), 'utf8'), 'test/mul2.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { mul } from '../src/mul.mjs';\ntest('mul2', () => assert.equal(mul(1, 1), 1));\n" });
  return { root, fix, passes, head: git(root, 'rev-parse', 'HEAD') };
}
const liveState = (root) => [git(root, 'rev-parse', 'HEAD'), git(root, 'status', '--porcelain'), git(root, 'worktree', 'list').split('\n').length, fs.existsSync(path.join(root, 'node_modules/helper-dep/index.js'))];

test('runner detection, globs, prompt and the deps guard', () => {
  assert.equal(runnerFromScript('vitest'), 'vitest run');
  assert.equal(runnerFromScript('vitest run --passWithNoTests && echo ok'), 'vitest run --passWithNoTests');
  assert.equal(runnerFromScript('cross-env TZ=UTC jest --ci'), 'jest --runTestsByPath --ci');
  assert.equal(runnerFromScript('node --test --import tsx "packages/*/test/*.test.mjs"'), 'node --test --import tsx');
  assert.equal(runnerFromScript('npm-run-all test:*'), null);
  const files = { 'package.json': '{"scripts":{"test":"npm-run-all a b"}}', 'apps/web/package.json': '{"scripts":{"test":"vitest run"}}', 'lib/package.json': '{"devDependencies":{"jest":"1"}}' };
  const read = (p) => files[p] ?? null;
  assert.deepEqual(testCommand(read, 'apps/web/src/a.test.ts'), { cwd: 'apps/web', cmd: 'vitest run' });
  assert.deepEqual(testCommand(read, 'lib/x/b.test.js'), { cwd: 'lib', cmd: 'jest --runTestsByPath' });
  assert.equal(testCommand(read, 'other/c.test.js'), null);
  assert.deepEqual(testCommand(read, 'other/c.test.js', { test: 'make test {files}' }), { cwd: '', cmd: 'make test {files}' });
  assert.ok(glob('tests/db/**').test('tests/db/a/b.test.ts'));
  assert.ok(glob('**/*.e2e.test.ts').test('x/y.e2e.test.ts') && glob('**/*.e2e.test.ts').test('y.e2e.test.ts'));
  assert.ok(glob('tests/db').test('tests/db/a.test.ts') && !glob('tests/db').test('tests/dbx/a.test.ts'));
  const p = scenarioPrompt('Fix it\n\nBody.\n\nCo-Authored-By: A <a@b>', { number: 7, title: 'Fix it', body: 'Because.' });
  assert.match(p, /Fix it[\s\S]*Body\.[\s\S]*Pull request #7: Fix it[\s\S]*Because\./);
  assert.doesNotMatch(p, /Co-Authored-By/);
  assert.match(depsGuard({ tool: 'Bash', input: { command: 'npm install left-pad' } }), /dependencies/);
  assert.match(depsGuard({ tool: 'Bash', input: { command: 'rm -rf node_modules' } }), /dependencies/);
  assert.match(depsGuard({ tool: 'Edit', input: { file_path: 'node_modules/x/index.js' } }), /dependencies/);
  assert.equal(depsGuard({ tool: 'Bash', input: { command: 'npm test' } }), '');
});

test('mine keeps commits with tests and a code change, and says why it skipped the rest', () => {
  const { root, fix } = fixture();
  const m = mineScenarios({ root, pr: false });
  assert.equal(m.scanned, 5);
  assert.deepEqual(m.rejected.map(r => r.reason).sort(), ['no test files changed', 'root commit', 'tests only (no code change to reproduce)']);
  assert.equal(m.scenarios.length, 2);
  const s = m.scenarios.find(x => x.sha === fix);
  assert.deepEqual(s.files.tests, ['test/add.test.mjs']);
  assert.deepEqual(s.files.source.map(f => f.path), ['src/add.mjs']);
  assert.ok(s.readOnly && s.parent && s.status === 'candidate');
  // the prompt is the message, never the diff or the hidden test
  assert.match(s.prompt, /Fix add: it subtracted/);
  assert.doesNotMatch(s.prompt, /a \+ b|assert|Co-Authored-By/);
  // a config can exclude test paths
  fs.writeFileSync(path.join(root, 'qbranch.scenarios.json'), JSON.stringify({ exclude: ['test/add*'] }));
  assert.ok(!mineScenarios({ root, pr: false }).scenarios.some(x => x.sha === fix));
});

test('validation keeps a scenario that discriminates and rejects one whose parent already passes; the live repo is untouched', async () => {
  const { root, fix, passes } = fixture();
  const before = liveState(root);
  const { scenarios } = mineScenarios({ root, pr: false });
  const good = await validateScenario(scenarios.find(s => s.sha === fix));
  assert.equal(good.status, 'valid', good.reason);
  assert.equal(good.validation.parent.pass, false);
  assert.equal(good.validation.commit.pass, true);
  assert.deepEqual(good.plan.neighbours.flatMap(g => g.files), ['test/mul.test.mjs']); // pass-to-pass needed the linked dependency
  assert.deepEqual(good.checks.map(c => c.name), ['fail-to-pass', 'pass-to-pass']);
  const bad = await validateScenario(scenarios.find(s => s.sha === passes));
  assert.equal(bad.status, 'rejected');
  assert.match(bad.reason, /parent already passes/);
  assert.deepEqual(liveState(root), before);
  // cache round trip, with its own .gitignore
  saveScenario(good); saveScenario(bad);
  assert.equal(fs.readFileSync(path.join(scenariosDir(root), '.gitignore'), 'utf8'), '*\n');
  assert.deepEqual(loadScenarios(root, { status: 'valid' }).map(s => s.id), [good.id]);
  assert.equal(git(root, 'status', '--porcelain'), '');
});

test('run: the agent sees the parent without the hidden tests or the future, and is graded by them afterwards', async () => {
  const { root, fix } = fixture();
  const before = liveState(root);
  const s = await validateScenario(mineScenarios({ root, pr: false }).scenarios.find(x => x.sha === fix));
  const seen = {};
  const agent = (write) => async ({ prompt, dir }) => {
    seen.prompt = prompt;
    seen.hidden = fs.existsSync(path.join(dir, 'test/add.test.mjs'));
    seen.commits = spawnSync('git', ['rev-list', '--all', '--count'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
    seen.dep = fs.existsSync(path.join(dir, 'node_modules/helper-dep/index.js'));
    if (write) { fs.writeFileSync(path.join(dir, 'src/add.mjs'), FIXED_ADD); fs.writeFileSync(path.join(dir, 'test/add.test.mjs'), 'tampered'); }
    return { exitCode: 0, costUsd: 0.01, finalText: 'done', events: [] };
  };
  registerAgent('scn-fixer', agent(true));
  registerAgent('scn-idle', agent(false));
  const ok = await runScenario(s, { agent: 'scn-fixer', budgetUsd: 1 });
  assert.deepEqual([seen.hidden, seen.commits, seen.dep], [false, '1', true]);
  assert.match(seen.prompt, /Fix add/);
  assert.equal(ok.suites['fail-to-pass'].pass, true, ok.suites['fail-to-pass'].tail);
  assert.equal(ok.suites['pass-to-pass'].pass, true);
  assert.equal((await gradeRun(s, ok)).pass, true);
  const idle = await runScenario(s, { agent: 'scn-idle', budgetUsd: 1 });
  const g = await gradeRun(s, idle);
  assert.equal(g.pass, false);
  assert.match(g.reasons.join(' '), /fail-to-pass failed/);
  await assert.rejects(runScenario({ ...s, status: 'candidate' }, { agent: 'scn-idle', budgetUsd: 1 }), /validate it first/);
  // scenarios plug into compareVariants as tasks
  const rep = await compareVariants({ tasks: [s], variants: { baseline: async () => {}, other: async () => {} }, budgetUsd: 2, perRunUsd: 1, agent: 'scn-fixer', runner: runScenario });
  assert.equal(rep.perVariant.baseline.passRate, 1);
  assert.equal(rep.perVariant.other.passRate, 1);
  assert.deepEqual(liveState(root), before);
});
