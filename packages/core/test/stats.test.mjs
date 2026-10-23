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
