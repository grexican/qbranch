import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStats } from '../src/stats.mjs';

test('a stats file from an older version gains the newer counters instead of NaN', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-stats-'));
  fs.writeFileSync(path.join(root, 's.json'), JSON.stringify({ tool: 't', schema: 1, since: '2026-01-01', totals: { a: 3 }, days: {} }));
  const upsert = createStats({ tool: 't', fresh: () => ({ totals: { a: 0, b: 0 }, skips: {} }), dayFresh: () => ({ n: 0 }) });
  upsert(root, 's.json', (s, day) => { s.totals.a++; s.totals.b++; day.n++; });
  const s = JSON.parse(fs.readFileSync(path.join(root, 's.json'), 'utf8'));
  assert.deepEqual(s.totals, { a: 4, b: 1 });
  assert.deepEqual(s.skips, {});
});

test('stats files keep themselves out of git via the clone\'s info/exclude (also in a linked worktree)', async () => {
  const { ensureIgnored } = await import('../src/stats.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-ign-'));
  fs.mkdirSync(path.join(root, '.git', 'info'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'info', 'exclude'), '# git ls-files --others --exclude-from=.git/info/exclude');
  const upsert = createStats({ tool: 't', fresh: () => ({ totals: { a: 0 } }), dayFresh: () => ({}) });
  upsert(root, '.t-stats.json', (s) => { s.totals.a++; });
  upsert(root, '.t-stats.json', (s) => { s.totals.a++; });
  const ex = fs.readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8');
  assert.equal(ex.split('\n').filter(l => l === '/.t-stats.json*').length, 1);
  assert.ok(ex.startsWith('# git ls-files')); // appended on a new line, never clobbered
  // a linked worktree: .git is a file pointing at <common>/worktrees/<name>, whose commondir points back
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-wt-'));
  const gd = path.join(root, '.git', 'worktrees', 'w1'); fs.mkdirSync(gd, { recursive: true });
  fs.writeFileSync(path.join(gd, 'commondir'), '../..');
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gd}\n`);
  ensureIgnored(wt, '.u-stats.json');
  assert.match(fs.readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8'), /^\/\.u-stats\.json\*$/m);
  // not a git repo: silently nothing
  ensureIgnored(fs.mkdtempSync(path.join(os.tmpdir(), 'qb-nogit-')), '.v-stats.json');
});
