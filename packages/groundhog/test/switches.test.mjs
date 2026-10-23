// The built-in escape guard, tool-switch lessons and rtk retry lessons.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { escapeGuard, escapeRisk, inlineScript } from '../src/guard.mjs';
import { mine, riskKind, toolSwitches, rtkRetries, heredocFile } from '../src/mine.mjs';
import { accept, fromSwitch, fromRtk, preToolUse } from '../src/lessons.mjs';
import { DEFAULTS } from '../src/config.mjs';

for (const k of ['CODEX_HOME', 'CURSOR_HOME', 'CURSOR_USER_DIR', 'VSCODE_USER_DIR', 'COPILOT_HOME', 'GEMINI_CLI_HOME', 'OPENCODE_DB', 'PI_CODING_AGENT_DIR']) process.env[k] = path.join(os.tmpdir(), 'qbranch-test-none', k);
const tmpCfg = (over = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'groundhog-sw-'));
  return { ...DEFAULTS, root, dataDir: path.join(root, '.groundhog'), ...over };
};
const RUN = Date.now().toString(36); // guard marks are per session id: unique ids per test run
const BS2 = '\\\\'; // two backslash characters, as an agent writes them in a JS regex or string

const heredocRisky = `cat > /tmp/fix.cjs <<'EOF'\nconst re = /a${BS2}s+b/;\nEOF`;
const evalRisky = `node -e 'console.log("a${BS2}b".length)'`;
const heredocSafe = `cat > /tmp/fix.cjs <<'EOF'\nconsole.log("ok \\n single escapes survive");\nEOF`;

test('escape risk: only an inline script holding a doubled backslash (the construct Git Bash collapses)', () => {
  assert.equal(escapeRisk(heredocRisky), 'heredoc');
  assert.equal(escapeRisk(evalRisky), 'eval');
  assert.equal(escapeRisk(heredocSafe), null); // \n, \s ... survive; measured no riskier than no backslash
  assert.equal(escapeRisk(`grep -rn "a${BS2}.b" src`), null); // not an inline script
  assert.equal(escapeRisk('cd C:\\\\work && npm test'), null);
  assert.equal(inlineScript(`python3 - <<EOF\nprint(1)\nEOF`).kind, 'heredoc');
  assert.equal(inlineScript(`deno eval "console.log(1)"`).kind, 'eval');
});

test('escape guard: annotates (never denies) Bash on Windows, once per session per kind; quiet elsewhere', () => {
  const cfg = tmpCfg();
  const h = (cmd, sessionId = `s-esc-1-${RUN}`, tool = 'Bash') => ({ tool, input: { command: cmd }, sessionId });
  const first = escapeGuard(cfg, h(heredocRisky), { platform: 'win32' });
  assert.match(first.context, /Write tool/);
  assert.equal(first.deny, undefined);
  assert.equal(escapeGuard(cfg, h(heredocRisky), { platform: 'win32' }), null); // same kind, same session
  assert.ok(escapeGuard(cfg, h(evalRisky), { platform: 'win32' })); // another kind still fires once
  assert.ok(escapeGuard(cfg, h(heredocRisky, `s-esc-2-${RUN}`), { platform: 'win32' })); // a new session
  assert.equal(escapeGuard(cfg, h(heredocRisky, `s-esc-3-${RUN}`), { platform: 'linux' }), null); // POSIX bash keeps backslashes
  assert.equal(escapeGuard(cfg, h(heredocRisky, `s-esc-4-${RUN}`, 'PowerShell'), { platform: 'win32' }), null);
  assert.ok(escapeGuard({ ...cfg, escapeGuard: 'on' }, h(heredocRisky, `s-esc-5-${RUN}`), { platform: 'linux' }));
  assert.equal(escapeGuard({ ...cfg, escapeGuard: 'off' }, h(heredocRisky, `s-esc-6-${RUN}`), { platform: 'win32' }), null);
  const s = JSON.parse(fs.readFileSync(path.join(cfg.root, cfg.stats), 'utf8'));
  assert.equal(s.totals.escape_guard, 4);
});

test('escape guard: only a shell known to be bash; other harnesses\' "Bash" (Cursor Shell, often PowerShell on Windows) stays quiet unless the input says bash', () => {
  const cfg = tmpCfg();
  const h = (extra) => ({ tool: 'Bash', input: { command: heredocRisky }, sessionId: `s-plat-${RUN}-${Math.random()}`, ...extra });
  assert.equal(escapeGuard(cfg, h({ platform: 'cursor', raw: {} }), { platform: 'win32' }), null);
  assert.equal(escapeGuard(cfg, h({ platform: 'codex', raw: {} }), { platform: 'win32' }), null);
  assert.ok(escapeGuard(cfg, h({ platform: 'cursor', raw: { shell: 'C:\\Program Files\\Git\\bin\\bash.exe' } }), { platform: 'win32' }));
  assert.equal(escapeGuard(cfg, h({ platform: 'cursor', raw: { shell: 'powershell.exe' } }), { platform: 'win32' }), null);
  assert.ok(escapeGuard(cfg, h({ platform: 'claude' }), { platform: 'win32' }));
});

test('escape guard markers: no session id falls back to the transcript (never one global marker); per-user folder; stale markers swept', async () => {
  const { _test } = await import('../src/guard.mjs');
  const cfg = tmpCfg();
  const h = (transcript) => ({ tool: 'Bash', input: { command: evalRisky }, transcript });
  assert.ok(escapeGuard(cfg, h(`/t/${RUN}-a.jsonl`), { platform: 'win32' }));
  assert.ok(escapeGuard(cfg, h(`/t/${RUN}-b.jsonl`), { platform: 'win32' })); // another session without an id still gets its note
  assert.equal(escapeGuard(cfg, h(`/t/${RUN}-a.jsonl`), { platform: 'win32' }), null);
  assert.match(_test.sessionKey({}), /^ppid\d+$/);
  const dir = _test.markDir();
  assert.match(dir, /groundhog-[^\\/]+[\\/]marks$/);
  const stale = path.join(dir, `esc-stale${RUN}-eval`);
  fs.writeFileSync(stale, '1');
  const old = (Date.now() - 3 * 864e5) / 1000; fs.utimesSync(stale, old, old);
  _test.sweep(dir);
  assert.equal(fs.existsSync(stale), false);
});

test('the PreToolUse hook runs the escape guard when no ledger lesson matches (even with an empty ledger)', () => {
  const cfg = tmpCfg({ escapeGuard: 'on' });
  const out = preToolUse(cfg, { tool: 'Bash', input: { command: evalRisky }, sessionId: `s-pre-1-${RUN}` });
  assert.match(out.context, /groundhog: Git Bash/);
});

test('risk kinds and heredoc targets', () => {
  assert.equal(riskKind(heredocRisky), 'inline-backslash-heredoc');
  assert.equal(riskKind(heredocSafe), 'heredoc-script');
  assert.equal(riskKind(`node -e "require('x')"`), 'inline-eval');
  assert.equal(riskKind(`sed -i 's/a/b/' src/app.js`), 'sed-in-place');
  assert.equal(riskKind(`echo '{"a":1}' > cfg.json`), 'echo-to-file');
  assert.equal(riskKind('npm test'), null);
  assert.equal(heredocFile(heredocRisky), '/tmp/fix.cjs');
  assert.equal(heredocFile(`cat <<'EOF' > "out dir/x.py"\nx\nEOF`), 'out dir/x.py');
});

test('tool switch: a failing heredoc-written script, rewritten with Write and run, is one recovery of its kind', () => {
  const tr = [
    { kind: 'shell', tool: 'Bash', cmd: heredocRisky, err: false },
    { kind: 'shell', tool: 'Bash', cmd: 'node /tmp/fix.cjs', err: true }, // fails: blame the heredoc a step earlier
    { kind: 'edit', tool: 'Write', file: 'C:/tmp/fix.cjs' },
    { kind: 'shell', tool: 'Bash', cmd: 'node C:/tmp/fix.cjs', err: false },
  ];
  const sw = toolSwitches(tr);
  assert.equal(sw.length, 1);
  assert.equal(sw[0].kind, 'inline-backslash-heredoc');
  assert.match(sw[0].toExample, /Write fix\.cjs, then: node/);
  // an edit that is never run, or a run that still fails, is not a recovery
  assert.equal(toolSwitches([tr[0], tr[1], tr[2]]).length, 0);
  assert.equal(toolSwitches([tr[0], tr[1], tr[2], { ...tr[3], err: true }]).length, 0);
  // sed -i fixed by an Edit needs no run
  assert.equal(toolSwitches([{ kind: 'shell', tool: 'Bash', cmd: `sed -i 's/a/b/' x.js`, err: true }, { kind: 'edit', tool: 'Edit', file: 'x.js' }])[0].kind, 'sed-in-place');
  // a plain failing command followed by an edit is ordinary debugging, not a tool switch
  assert.equal(toolSwitches([{ kind: 'shell', tool: 'Bash', cmd: 'npm test', err: true }, { kind: 'edit', tool: 'Edit', file: 'src/a.js' }, { kind: 'shell', tool: 'Bash', cmd: 'npm test', err: false }]).length, 0);
});

test('tool switch: one incident counts once (a failing heredoc, the failed run of its file, a retry, then the fix)', () => {
  const failingHeredoc = { kind: 'shell', tool: 'Bash', cmd: heredocRisky, err: true };
  const tr = [
    failingHeredoc,
    { kind: 'shell', tool: 'Bash', cmd: 'node /tmp/fix.cjs', err: true },       // the same incident: blamed on the heredoc
    { kind: 'shell', tool: 'Bash', cmd: 'node /tmp/fix.cjs', err: true },       // a retry of it
    { kind: 'edit', tool: 'Write', file: '/tmp/fix2.cjs' },
    { kind: 'shell', tool: 'Bash', cmd: 'node /tmp/fix2.cjs', err: false },
  ];
  assert.equal(toolSwitches(tr).length, 1);
  // two separate incidents in one trail are two counts
  assert.equal(toolSwitches([...tr, { ...failingHeredoc }, { kind: 'edit', tool: 'Write', file: '/tmp/fix3.cjs' }, { kind: 'shell', tool: 'Bash', cmd: 'node /tmp/fix3.cjs', err: false }]).length, 2);
});

test('rtk retry: several filtered copies before one raw retry is one event', () => {
  const tr = [
    { kind: 'shell', tool: 'Bash', cmd: 'git log --oneline -20' },
    { kind: 'shell', tool: 'Bash', cmd: 'git log --oneline -20' },
    { kind: 'shell', tool: 'Bash', cmd: 'rtk proxy git log --oneline -20' },
  ];
  assert.equal(rtkRetries(tr).length, 1);
});

test('rtk retry: the same command rerun as rtk proxy, by shape', () => {
  const tr = [
    { kind: 'shell', tool: 'Bash', cmd: 'cd /repo && git log --oneline -20', err: false },
    { kind: 'shell', tool: 'Bash', cmd: 'rtk proxy git log --oneline -20', err: false },
    { kind: 'shell', tool: 'Bash', cmd: 'rtk proxy npm ls', err: false }, // never run filtered first: not a retry
  ];
  const r = rtkRetries(tr);
  assert.equal(r.length, 1);
  // the retry usually cuts the output differently: still the same command
  assert.equal(rtkRetries([{ kind: 'shell', tool: 'Bash', cmd: 'cd /r && npx vitest run --project unit 2>&1 | tail -25' },
    { kind: 'shell', tool: 'Bash', cmd: 'cd /r && rtk proxy npx vitest run --project unit 2>&1 | grep -n FAIL' }])[0]?.shape, 'npx vitest run --project');
  assert.equal(r[0].shape, 'git log --oneline -N');
  const entry = fromRtk({ tool: 'Bash', shape: r[0].shape, count: 4 });
  const re = new RegExp(entry.when, 'i');
  assert.ok(re.test('git log --oneline -5') && re.test('rtk git log --oneline -5') && re.test('cd x && git log --oneline -5'));
  assert.ok(!re.test('rtk proxy git log --oneline -5')); // already raw: stay quiet
  assert.equal(entry.action, 'remind');
});

test('mine aggregates tool switches by kind and rtk retries by shape across sessions; accept turns them into ledger entries', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-sw-home-'));
  const cfg = tmpCfg({ minRecoveries: 2 });
  const proj = path.join(home, 'projects', path.resolve(cfg.root).replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(proj, { recursive: true });
  const session = (name, steps) => {
    const lines = [];
    steps.forEach((st, i) => {
      const input = st.write ? { file_path: st.write, content: 'x' } : { command: st.cmd };
      lines.push(JSON.stringify({ type: 'assistant', message: { id: `${name}-${i}`, content: [{ type: 'tool_use', id: `${name}-t${i}`, name: st.write ? 'Write' : 'Bash', input }] } }));
      lines.push(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `${name}-t${i}`, is_error: !!st.err, content: st.err ? 'SyntaxError: Invalid regular expression' : 'ok' }] } }));
    });
    fs.writeFileSync(path.join(proj, `${name}.jsonl`), lines.join('\n') + '\n');
  };
  for (const n of ['a', 'b', 'c']) session(n, [
    { cmd: heredocRisky }, { cmd: 'node /tmp/fix.cjs', err: true }, { write: `/tmp/fix-${n}.cjs` }, { cmd: `node /tmp/fix-${n}.cjs` },
    { cmd: 'git status' }, { cmd: 'rtk proxy git status' },
  ]);
  process.env.CLAUDE_CONFIG_DIR = home;
  try {
    const ix = mine(cfg, { days: 1 });
    assert.equal(ix.switches.length, 1);
    assert.equal(ix.switches[0].kind, 'inline-backslash-heredoc');
    assert.equal(ix.switches[0].sessions, 3);
    assert.equal(ix.rtk[0].shape, 'git status');
    const l = accept(cfg, fromSwitch(ix.switches[0]));
    assert.ok(new RegExp(l.when, 'i').test(heredocRisky));
    assert.ok(!new RegExp(l.when, 'i').test(heredocSafe));
    assert.equal(accept(cfg, fromRtk(ix.rtk[0])).action, 'remind');
  } finally { delete process.env.CLAUDE_CONFIG_DIR; }
});
