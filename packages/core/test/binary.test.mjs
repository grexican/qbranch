// The binary-behind-plugins note: when to say it, what it says, and that it says it once per session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { binaryNote, cmpVersion, installCommand } from '../src/binary.mjs';
import { render, normalize } from '../src/hooks.mjs';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
function setup({ version, exe = true, platform = 'win32' } = {}) {
  const home = tmp('qb-home-');
  if (exe) fs.writeFileSync(path.join(home, platform === 'win32' ? 'qbranch.exe' : 'qbranch'), '');
  if (version) fs.writeFileSync(path.join(home, 'VERSION'), `${version}\n`);
  return { home, markDir: tmp('qb-marks-'), env: { QBRANCH_HOME: home, PATH: '' }, platform };
}

test('versions compare numerically, ignoring a leading v and suffixes', () => {
  assert.equal(cmpVersion('0.3.1', '0.5.0'), -1);
  assert.equal(cmpVersion('0.10.0', '0.9.9'), 1);
  assert.equal(cmpVersion('v0.5.0', '0.5.0'), 0);
  assert.equal(cmpVersion('0.5.0-rc1', '0.5.0'), 0);
  assert.equal(cmpVersion('1.0', '1.0.0'), 0);
});

test('an older binary gets a one-line note naming `qbranch update` and the Command Prompt one-liner', () => {
  const s = setup({ version: '0.3.1' });
  const n = binaryNote({ sessionId: 's1', version: '0.5.0', ...s });
  assert.match(n, /^qbranch binary v0\.3\.1 is older than the plugins \(v0\.5\.0\): run `qbranch update`/);
  assert.match(n, /Command Prompt: powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https:\/\/raw\.githubusercontent\.com\/grexican\/qbranch\/main\/scripts\/install\.ps1 \| iex"/);
  assert.equal(n.split('\n').length, 1);
});

test('on macOS/Linux the fallback is the curl installer', () => {
  const s = setup({ version: '0.3.1', platform: 'linux' });
  assert.match(binaryNote({ sessionId: 's1', version: '0.5.0', ...s }), /curl -fsSL https:\/\/raw\.githubusercontent\.com\/grexican\/qbranch\/main\/scripts\/install\.sh \| sh/);
  assert.match(installCommand('linux', { QBRANCH_REPO: 'me/fork' }), /me\/fork/);
});

test('once per session, across every plugin (shared marker)', () => {
  const s = setup({ version: '0.3.1' });
  assert.ok(binaryNote({ sessionId: 'abc', version: '0.5.0', ...s }));
  assert.equal(binaryNote({ sessionId: 'abc', version: '0.5.0', ...s }), null); // a second plugin, same session
  assert.ok(binaryNote({ sessionId: 'def', version: '0.5.0', ...s })); // a new session hears it again
});

test('silence: no binary, same or newer binary, a source build, or no plugin version', () => {
  assert.equal(binaryNote({ sessionId: 'a', version: '0.5.0', ...setup({ exe: false }) }), null);
  assert.equal(binaryNote({ sessionId: 'a', version: '0.5.0', ...setup({ version: '0.5.0' }) }), null);
  assert.equal(binaryNote({ sessionId: 'a', version: '0.5.0', ...setup({ version: '0.6.0' }) }), null);
  assert.equal(binaryNote({ sessionId: 'a', version: '0.5.0', ...setup({ version: 'dev' }) }), null);
  assert.equal(binaryNote({ sessionId: 'a', version: null, ...setup({ version: '0.1.0' }) }), null);
});

test('a binary installed before VERSION files existed is treated as older', () => {
  const s = setup({});
  assert.match(binaryNote({ sessionId: 'x', version: '0.5.1', ...s }), /older than the plugins \(v0\.5\.1; it was installed before versions were tracked\)/);
});

test('when the binary bin/ precedes a plugin bin/ on PATH, the note says its commands shadow the newer ones', () => {
  const s = setup({ version: '0.3.1' });
  const pluginBin = path.join(tmp('qb-cache-'), 'plugins', 'cache', 'qbranch', 'middleout', '0.5.0', 'bin');
  fs.mkdirSync(pluginBin, { recursive: true });
  fs.writeFileSync(path.join(pluginBin, 'middleout'), '');
  const first = binaryNote({ sessionId: 'p1', version: '0.5.0', ...s, env: { ...s.env, PATH: [path.join(s.home, 'bin'), pluginBin].join(path.delimiter) } });
  assert.match(first, /shadow the plugins' newer ones/);
  const second = binaryNote({ sessionId: 'p2', version: '0.5.0', ...s, env: { ...s.env, PATH: [pluginBin, path.join(s.home, 'bin')].join(path.delimiter) } });
  assert.doesNotMatch(second, /shadow/);
});

test('never throws, even with a broken environment', () => {
  assert.equal(binaryNote({ sessionId: 'z', version: '0.5.0', env: { QBRANCH_HOME: '\0bad' }, markDir: '\0bad' }), null);
});

test('rendered for Claude Code SessionStart as additionalContext', () => {
  const h = normalize({ hook_event_name: 'SessionStart', session_id: 's' }, 'claude');
  const out = JSON.parse(render(h, { context: 'qbranch binary v0.3.1 is older' }).stdout);
  assert.deepEqual(out, { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'qbranch binary v0.3.1 is older' } });
});
