// Replay harness: safety filter, harvest, sandboxed runs, grading and variant comparison, all with a fake agent.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { unsafeAction, guardSource, harvestTasks, splitTasks, runTask, gradeRun, compareVariants, registerAgent, commandKey, signature } from '../src/replay.mjs';

// never read the real machine's other-agent stores (only the synthetic Claude Code fixtures below)
for (const k of ['CODEX_HOME', 'CURSOR_HOME', 'CURSOR_USER_DIR', 'VSCODE_USER_DIR', 'COPILOT_HOME', 'GEMINI_CLI_HOME', 'OPENCODE_DB', 'PI_CODING_AGENT_DIR']) process.env[k] = path.join(os.tmpdir(), 'qbranch-test-none', k);
const tmp = (p) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const sh = (command) => ({ tool: 'Bash', input: { command } });

test('the safety filter flags side effects outside the sandbox and lets local work through', () => {
  const root = path.join(os.tmpdir(), 'proj');
  const why = (a) => unsafeAction(a, { root });
  for (const c of ['npm test', 'git commit -m "x"', 'echo hi > out.txt 2>&1', 'git branch --show-current', 'curl https://example.com', 'mkdir -p build/x', 'py -3 - <<EOF\nprint(1 > 0)\nEOF'])
    assert.equal(why(sh(c)), '', c);
  for (const c of ['git push origin main', 'gh pr create --fill', 'npm publish', 'curl -X POST https://x', 'kubectl apply -f k.yaml', 'git checkout -b feat',
    'cd .. && rm -rf other', 'echo x > ~/.bashrc', 'cp a /etc/hosts', 'claude -p "do it"', 'pip install requests', 'ssh host ls'])
    assert.notEqual(why(sh(c)), '', c);
  assert.equal(why({ tool: 'Write', input: { file_path: path.join(root, 'a.md') } }), '');
  assert.match(why({ tool: 'Edit', input: { file_path: path.join(os.homedir(), 'x.md') } }), /outside/);
  assert.match(why({ tool: 'mcp__tracker__update_ticket', input: {} }), /MCP/);
  assert.equal(why({ tool: 'mcp__tracker__list_tickets', input: {} }), '');
  assert.equal(unsafeAction(sh(`echo x > ${path.join(os.tmpdir(), 'scratch.txt')}`), { root, allow: [os.tmpdir()] }), '');
});

test('the guard script denies through the PreToolUse hook protocol', () => {
  const dir = tmp('qb-guard-'), guard = path.join(dir, 'guard.mjs');
  fs.writeFileSync(guard, guardSource());
  const run = (h) => spawnSync(process.execPath, [guard], { input: JSON.stringify(h), encoding: 'utf8', env: { ...process.env, QBRANCH_REPLAY_ROOT: dir } }).stdout;
  assert.match(JSON.parse(run({ tool_name: 'Bash', tool_input: { command: 'git push' } })).hookSpecificOutput.permissionDecision, /deny/);
  assert.equal(run({ tool_name: 'Bash', tool_input: { command: 'npm test' } }), '');
});

test('command keys and prompt signatures', () => {
  assert.equal(commandKey('cd app && npm test -- --watch=false'), 'npm test');
  assert.equal(commandKey('python3 tools/gen.py'), 'python3');
  assert.equal(commandKey('FOO=1 rtk git status'), 'git status');
  const a = signature('Summarize the inbox notes from 2026-10-14 at C:\\work\\vault\\00-Inbox');
  const b = signature('Summarize the inbox notes from 2026-10-15 at C:\\work\\vault\\00-Inbox');
  assert.deepEqual([...a], [...b]);
});

// synthetic Claude Code transcripts for a project at `root`
function claudeFixture(root, sessions) {
  const home = tmp('qb-claude-');
  const proj = path.join(home, 'projects', path.resolve(root).replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(proj, { recursive: true });
  for (const [n, [name, prompt, calls, final = 'done']] of sessions.entries()) {
    const L = [JSON.stringify({ type: 'user', cwd: root, timestamp: '2026-10-15T10:00:00Z', message: { content: prompt } })];
    calls.forEach(([tool, input, err], i) => {
      L.push(JSON.stringify({ type: 'assistant', message: { id: `${name}-${i}`, model: 'claude-haiku-4-5', usage: { input_tokens: 1000, output_tokens: 100 }, content: [{ type: 'tool_use', id: `${name}-t${i}`, name: tool, input }] } }));
      L.push(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `${name}-t${i}`, is_error: !!err, content: err ? 'Exit code 1' : 'ok' }] } }));
    });
    L.push(JSON.stringify({ type: 'assistant', message: { id: `${name}-f`, content: [{ type: 'text', text: final }] } }));
    fs.writeFileSync(path.join(proj, `${name}.jsonl`), L.join('\n') + '\n');
    const t = new Date(Date.now() - (sessions.length - n) * 60_000); // later sessions are newer
    fs.utimesSync(path.join(proj, `${name}.jsonl`), t, t);
  }
  return home;
}

test('harvest: recurring prompts cluster into one task with derived checks; side effects make a task unsafe', () => {
  const root = tmp('qb-harvest-');
  const home = claudeFixture(root, [
    ['s1', 'Regenerate the API docs for 2026-10-13 and check the build', [['Bash', { command: 'npm run docs' }], ['Write', { file_path: path.join(root, 'docs', 'api.md'), content: 'x' }], ['Bash', { command: 'npm run build' }]]],
    ['s2', 'Regenerate the API docs for 2026-10-14 and check the build', [['Bash', { command: 'python3 gen.py' }, true], ['Bash', { command: 'npm run docs' }]]],
    ['s3', 'Ship the release notes to the team', [['Bash', { command: 'git push origin main' }]]],
    ['s4', 'Ship the release notes to everyone', [['Bash', { command: 'npm run notes' }]]],
  ]);
  process.env.CLAUDE_CONFIG_DIR = home;
  try {
    const all = harvestTasks({ root, days: 1, limit: 10, minRecurrence: 1, filter: () => true });
    const docs = all.find(t => /API docs/.test(t.prompt));
    assert.equal(docs.recurrence, 2);
    assert.equal(docs.sessions.length, 2);
    assert.ok(docs.readOnly);
    assert.ok(docs.history.some(c => c.err && c.cmd === 'python3 gen.py'));
    assert.ok(docs.origCostUsd > 0);
    const notes = all.find(t => /release notes/.test(t.prompt));
    assert.equal(notes.readOnly, false);
    assert.match(notes.unsafe[0], /pushes/);
    // a prompt that points the agent at another project by absolute path is never replay-safe
    const elsewhere = process.platform === 'win32' ? 'D:\\other-project\\out.json' : '/srv/other-project/out.json'; // not under the temp dir
    const home2 = claudeFixture(root, [['s9', `Write the payload to ${elsewhere} and validate it`, [['Bash', { command: 'node build.mjs' }]]]]);
    process.env.CLAUDE_CONFIG_DIR = home2;
    const away = harvestTasks({ root, days: 1, minRecurrence: 1, filter: () => true }).find(t => /payload/.test(t.prompt));
    assert.equal(away.readOnly, false);
    assert.match(away.unsafe.join(' '), /prompt names a path outside the project/);
    process.env.CLAUDE_CONFIG_DIR = home;
    const recurring = harvestTasks({ root, days: 1 }); // defaults: read-only, recurring
    assert.deepEqual(recurring.map(t => t.id), [docs.id]);
    const s1 = harvestTasks({ root, days: 1, minRecurrence: 1, filter: (t) => t.sessionId === 's1' });
    assert.equal(s1.length, 0); // clustered: s2 is the most recent representative
  } finally { delete process.env.CLAUDE_CONFIG_DIR; }
});

test('splitTasks is stable and never leaves the held-out set empty', () => {
  const tasks = Array.from({ length: 12 }, (_, i) => ({ id: `task_${i}` }));
  const a = splitTasks(tasks), b = splitTasks([...tasks].reverse());
  assert.deepEqual(a.holdout.map(t => t.id).sort(), b.holdout.map(t => t.id).sort());
  assert.ok(a.holdout.length > 0 && a.train.length > 0);
  assert.equal(splitTasks([{ id: 'x' }, { id: 'y' }], { holdout: 0 }).holdout.length, 1);
});

// a fake agent: writes what the variant asks for and reports scripted shell calls; costs a fixed amount
let seen = [];
registerAgent('fake', async ({ prompt, dir, budgetUsd }) => {
  seen.push({ prompt, dir, budgetUsd });
  const mode = fs.existsSync(path.join(dir, 'variant.txt')) ? fs.readFileSync(path.join(dir, 'variant.txt'), 'utf8') : 'base';
  fs.writeFileSync(path.join(dir, 'out.md'), `done by ${mode}`);
  const fail = mode === 'bad' && /flaky/.test(prompt);
  return { exitCode: 0, costUsd: 0.1, finalText: fail ? 'gave up' : 'all good', isError: false,
    events: [{ t: 'tool', name: 'Bash', input: { command: fail ? 'python3 x.py' : 'npm test' }, id: 't1' }, { t: 'result', id: 't1', isError: fail, text: fail ? 'Exit code 1' : 'ok' }, { t: 'usage', model: 'x', usage: { input_tokens: 1200 }, id: 'u' }] };
});

function gitRepo() {
  const dir = tmp('qb-repo-');
  const g = (...a) => spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-C', dir, ...a], { encoding: 'utf8' });
  g('init', '-q'); fs.writeFileSync(path.join(dir, 'README.md'), 'hi\n'); g('add', '.'); g('commit', '-qm', 'init');
  return { dir, g };
}

test('runTask: sandboxed in a throwaway worktree, prompt paths re-pointed, live tree untouched, sandbox removed', async () => {
  const { dir, g } = gitRepo();
  seen = [];
  const task = { id: 't', prompt: `Update ${dir}${path.sep}out.md`, cwd: dir, readOnly: true, checks: [{ kind: 'completed', hard: true }, { kind: 'fileChanged', path: 'out.md', hard: true }] };
  const run = await runTask(task, { agent: 'fake', budgetUsd: 0.5, setup: (d) => { fs.writeFileSync(path.join(d, 'variant.txt'), 'good'); } });
  assert.ok(run.ok);
  assert.notEqual(seen[0].dir, dir);
  assert.ok(seen[0].prompt.includes(seen[0].dir) && !seen[0].prompt.includes(dir));
  assert.ok(run.changedFiles.includes('out.md') && !run.changedFiles.includes('variant.txt')); // setup files are not the agent's work
  assert.equal(run.startupTokens, 1200);
  assert.ok(!fs.existsSync(path.join(dir, 'out.md')));
  assert.ok(!fs.existsSync(run.sandboxDir));
  assert.equal(g('worktree', 'list').stdout.trim().split('\n').length, 1);
  assert.deepEqual(await gradeRun(task, run), { pass: true, score: 1, reasons: [] });
});

test('runTask refuses to spend without a budget, and refuses unsafe tasks', async () => {
  const task = { id: 't', prompt: 'x', cwd: os.tmpdir(), readOnly: true };
  await assert.rejects(runTask(task, { agent: 'fake' }), /budgetUsd/);
  await assert.rejects(runTask({ ...task, readOnly: false, unsafe: ['pushes to a remote'] }, { agent: 'fake', budgetUsd: 1 }), /not read-only/);
});

test('gradeRun: hard checks gate the pass, soft ones only the score; a hook denial is not a failure', async () => {
  const task = { checks: [{ kind: 'completed', hard: true }, { kind: 'noFailure', pattern: 'python3?\\s', hard: true }, { kind: 'commandOk', key: 'npm test', hard: false }] };
  const ev = (cmd, isError, text) => [{ t: 'tool', name: 'Bash', input: { command: cmd }, id: cmd }, { t: 'result', id: cmd, isError, text }];
  const denied = await gradeRun(task, { ok: true, events: [...ev('python x.py', true, 'groundhog lesson L1: use py'), ...ev('npm test', false, 'ok')] });
  assert.deepEqual([denied.pass, denied.score], [true, 1]);
  const failed = await gradeRun(task, { ok: true, events: ev('python x.py', true, 'Exit code 9009') });
  assert.equal(failed.pass, false);
  assert.equal(failed.reasons.length, 2);
  const judged = await gradeRun({ checks: [{ kind: 'completed', hard: true }, { kind: 'rubric', text: 'r' }] }, { ok: true, finalText: 'x' }, { judge: async () => ({ pass: true, score: 0.8, reason: 'fine' }) });
  assert.deepEqual([judged.pass, judged.score, judged.judged], [true, 0.8, true]);
});

test('compareVariants: per-variant rates, regressions against the baseline, and a hard total budget', async () => {
  const { dir } = gitRepo();
  const task = (id, prompt) => ({ id, prompt, cwd: dir, readOnly: true, checks: [{ kind: 'completed', hard: true }, { kind: 'noFailure', pattern: 'python3', hard: true }] });
  const variants = { base: (d) => fs.writeFileSync(path.join(d, 'variant.txt'), 'base'), bad: (d) => fs.writeFileSync(path.join(d, 'variant.txt'), 'bad') };
  const r = await compareVariants({ tasks: [task('a', 'steady job'), task('b', 'flaky job')], variants, agent: 'fake', budgetUsd: 1 });
  assert.deepEqual([r.perVariant.base.passRate, r.perVariant.bad.passRate], [1, 0.5]);
  assert.deepEqual(r.regressions.map(x => [x.task, x.variant, x.before, x.after]), [['b', 'bad', 1, 0]]);
  assert.equal(r.perVariant.base.startupTokens, 1200);
  assert.ok(r.complete);
  assert.equal(r.spentUsd, 0.4);
  const tight = await compareVariants({ tasks: [task('a', 'x'), task('b', 'y'), task('c', 'z')], variants, agent: 'fake', budgetUsd: 0.25, minRunUsd: 0.04 });
  assert.equal(tight.complete, false);
  assert.deepEqual(tight.skipped.map(s => s.id), ['b', 'c']); // whole tasks are skipped, never half a pair
  await assert.rejects(compareVariants({ tasks: [], variants }), /budgetUsd/);
  // a plan that starves each replay is refused up front, with the budget it would need
  await assert.rejects(compareVariants({ tasks: [task('a', 'x'), task('b', 'y'), task('c', 'z')], variants, agent: 'fake', budgetUsd: 0.25 }), /needs about \$0\.25 to finish\. Raise the budget to \$2/);
});

test('compareVariants: a run cut off by its budget or timer is inconclusive, never a failure', async () => {
  const { dir } = gitRepo();
  const t = { id: 'a', prompt: 'job', cwd: dir, readOnly: true, checks: [{ kind: 'completed', hard: true }] };
  const runner = async (task, { setup }) => (setup.name === 'starved'
    ? { ok: false, costUsd: 0.25, error: 'error_max_budget_usd', killed: false, events: [] }
    : { ok: true, exitCode: 0, costUsd: 0.1, finalText: 'done', events: [] });
  const starved = async function starved() {}, base = async function base() {};
  const r = await compareVariants({ tasks: [t], variants: { base, starved }, budgetUsd: 1, runner });
  assert.equal(r.perVariant.base.passRate, 1);
  assert.equal(r.perVariant.starved.runs, 0);          // not scored
  assert.equal(r.perVariant.starved.passRate, null);
  assert.deepEqual(r.inconclusive.map(x => [x.variant, x.why]), [['starved', 'error_max_budget_usd']]);
  assert.equal(r.regressions.length, 0);
  assert.equal(r.complete, false);
});
