// Plugins behind the latest release: the cached latest.json, the background refresher, and the combined note.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { binaryNote, readLatest, needsRefresh, maybeRefresh, refreshLatest, latestTag, installedPlugins, withBinaryNote } from '../src/binary.mjs';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const DAY = 864e5;
function setup({ latest, checkedAt = new Date().toISOString(), bin, exe = false, registry } = {}) {
  const home = tmp('qb-home-'), claude = tmp('qb-claude-');
  if (latest !== undefined) fs.writeFileSync(path.join(home, 'latest.json'), JSON.stringify({ version: latest, checkedAt }));
  if (bin) fs.writeFileSync(path.join(home, 'VERSION'), bin);
  if (exe || bin) fs.writeFileSync(path.join(home, 'qbranch.exe'), '');
  if (registry) { fs.mkdirSync(path.join(claude, 'plugins')); fs.writeFileSync(path.join(claude, 'plugins', 'installed_plugins.json'), JSON.stringify(registry)); }
  return { home, env: { QBRANCH_HOME: home, CLAUDE_CONFIG_DIR: claude, PATH: '' }, markDir: tmp('qb-marks-'), platform: 'win32' };
}

test('cache freshness: missing, unreadable, or older than a day is stale', () => {
  const now = Date.now();
  assert.equal(needsRefresh(null, now), true);
  assert.equal(needsRefresh({ version: '1.0.0', checkedAt: new Date(now - DAY - 1000).toISOString() }, now), true);
  assert.equal(needsRefresh({ version: '1.0.0', checkedAt: new Date(now - 1000).toISOString() }, now), false);
  assert.equal(needsRefresh({ version: '1.0.0', checkedAt: 'garbage' }, now), true);
  const s = setup();
  fs.writeFileSync(path.join(s.home, 'latest.json'), '{not json');
  assert.equal(readLatest(s.env), null);
  assert.equal(binaryNote({ sessionId: 'b', version: '0.5.0', ...s }), null); // a broken cache never throws, never notes
});

test('the refresher is spawned only when the cache is stale, once (lock), and never when opted out', async () => {
  const spawned = [];
  const spawner = async (x) => { spawned.push(x.tool); };
  const fresh = setup({ latest: '0.5.2' });
  assert.equal(await maybeRefresh({ env: fresh.env, tool: 'middleout', spawner }), false);
  const stale = setup({ latest: '0.5.2', checkedAt: new Date(Date.now() - 2 * DAY).toISOString() });
  assert.equal(await maybeRefresh({ env: stale.env, tool: 'middleout', spawner }), true);
  assert.equal(await maybeRefresh({ env: stale.env, tool: 'headjack', spawner }), false); // lock held: four plugins, one refresher
  const missing = setup();
  assert.equal(await maybeRefresh({ env: { ...missing.env, QBRANCH_UPDATE_CHECK: '0' }, tool: 'middleout', spawner }), false);
  assert.deepEqual(spawned, ['middleout']);
});

test('refresher: gh first, else the API; checkedAt stamped even on failure; the last known version is kept', async () => {
  const s = setup();
  const viaGh = await refreshLatest({ env: s.env, run: () => 'v0.5.2\n', fetchImpl: async () => assert.fail('gh answered') });
  assert.equal(viaGh.version, '0.5.2');
  assert.equal(readLatest(s.env).version, '0.5.2');
  const failed = await refreshLatest({ env: s.env, run: () => null, fetchImpl: async () => ({ ok: false, status: 503 }) });
  assert.equal(failed.version, '0.5.2'); // kept
  assert.match(failed.error, /503/);
  assert.ok(!needsRefresh(readLatest(s.env))); // a dead network is not retried every session
  assert.equal(await latestTag({ env: {}, run: () => null, fetchImpl: async () => ({ ok: true, json: async () => ({ tag_name: 'v0.6.0' }) }) }), '0.6.0');
  assert.equal(await refreshLatest({ env: { ...s.env, QBRANCH_UPDATE_CHECK: '0' } }), null);
  assert.ok(!fs.existsSync(path.join(s.home, 'latest.json.lock')));
});

test('installed plugins come from Claude Code\'s registry: user scope, or the project that contains cwd', () => {
  const proj = tmp('qb-proj-');
  const s = setup({ registry: { version: 2, plugins: {
    'middleout@qbranch': [{ scope: 'user', version: '0.5.0' }, { scope: 'project', projectPath: proj, version: '0.4.0' }],
    'headjack@qbranch': [{ scope: 'project', projectPath: tmp('qb-other-'), version: '0.1.0' }],
    'moneyball@qbranch': [{ scope: 'user', version: '0.5.2' }],
    'something@else': [{ scope: 'user', version: '0.0.1' }],
  } } });
  assert.deepEqual(installedPlugins({ env: s.env, cwd: path.join(proj, 'src') }), [{ name: 'middleout', version: '0.4.0' }, { name: 'moneyball', version: '0.5.2' }]);
});

test('Claude: plugins behind the release get the marketplace + plugin update commands, naming the installed ones', () => {
  const proj = tmp('qb-proj-');
  const s = setup({ latest: '0.5.2', registry: { plugins: {
    'middleout@qbranch': [{ scope: 'user', version: '0.5.0' }], 'groundhog@qbranch': [{ scope: 'user', version: '0.5.0' }],
    'moneyball@qbranch': [{ scope: 'user', version: '0.5.2' }] } } });
  const n = binaryNote({ sessionId: 'c1', version: '0.5.0', tool: 'middleout', harness: 'claude', cwd: proj, ...s });
  assert.match(n, /qbranch plugins are behind the latest release \(v0\.5\.0 -> v0\.5\.2\): run `claude plugin marketplace update qbranch`, then `claude plugin update <name>@qbranch` for groundhog, middleout, then restart Claude Code\./);
  assert.doesNotMatch(n, /moneyball/); // already current
  assert.doesNotMatch(n, /binary/); // no binary installed: plugin-only users hear nothing about it
});

test('other harnesses: qbranch update, then qbranch install for that platform', () => {
  const s = setup({ latest: '0.5.2' });
  const n = binaryNote({ sessionId: 'x1', version: '0.5.0', tool: 'headjack', harness: 'cursor', ...s });
  assert.match(n, /run `qbranch update`, then `qbranch install headjack --platform cursor`\./);
});

test('combined: plugins and binary both behind -> one note, the binary measured against the release', () => {
  const s = setup({ latest: '0.5.2', bin: '0.3.1' });
  const n = binaryNote({ sessionId: 'b1', version: '0.5.0', tool: 'middleout', harness: 'claude', ...s });
  assert.match(n, /plugins are behind the latest release/);
  assert.match(n, /qbranch binary v0\.3\.1 is older than the plugins \(v0\.5\.2\): run `qbranch update`/);
  assert.equal(n.split('\n').length, 1);
  assert.equal(binaryNote({ sessionId: 'b1', version: '0.5.0', tool: 'headjack', ...s }), null); // once per session
  const current = setup({ latest: '0.5.2', bin: '0.5.2' });
  assert.equal(binaryNote({ sessionId: 'b2', version: '0.5.2', tool: 'middleout', ...current }), null); // all current: silence
  const optedOut = setup({ latest: '0.9.0' });
  assert.equal(binaryNote({ sessionId: 'b3', version: '0.5.0', ...optedOut, env: { ...optedOut.env, QBRANCH_UPDATE_CHECK: '0' } }), null);
});

test('withBinaryNote appends the note to a session decision and starts the refresher', async () => {
  const s = setup({ latest: '0.5.2', checkedAt: new Date(Date.now() - 2 * DAY).toISOString() });
  let started = 0;
  const d = await withBinaryNote({ sessionId: 'w1', platform: 'claude', cwd: s.home }, { context: 'lessons' },
    { tool: 'moneyball', version: '0.5.0', env: s.env, markDir: s.markDir, platform: 'win32', spawner: async () => { started++; } });
  assert.equal(started, 1);
  assert.match(d.context, /^lessons\n\nqbranch plugins are behind/);
});
