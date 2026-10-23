// The public-registry fallback must not suggest skills that merely share a stem with an idiom in the prompt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { relevantExternal } from '../src/registry.mjs';

process.env.HEADJACK_EMBED = '0';
const { loadConfig } = await import('../src/config.mjs');
const { suggest } = await import('../src/suggest.mjs');

test('relevance gate: idioms do not pull in registry skills; real tool names do', () => {
  const crush = 'ok do it! dive in and crush all 5 of them and anything else that could use some care';
  const cands = [
    { id: 'a/b/objection-crusher', name: 'objection-crusher', installs: 350 },
    { id: 'c/d/crushable-wingman', name: 'crushable-wingman', installs: 92 },
    { id: 'e/f/user-deep-dive', name: 'user-deep-dive', installs: 188 },
    { id: 'g/h/diversification', name: 'diversification', installs: 716 },
  ];
  assert.deepEqual(relevantExternal(crush, cands), []);
  const tf = 'write a terraform module for a private bucket';
  assert.deepEqual(relevantExternal(tf, [{ id: 'x/y/terraform-module-library', name: 'terraform-module-library' }, { id: 'x/y/terraform', name: 'terraform' }, { id: 'x/y/bucket-list-goals', name: 'bucket-list-goals' }]).map(c => c.name),
    ['terraform-module-library', 'terraform']);
  // three-letter tool names and hyphenated requests count too
  assert.deepEqual(relevantExternal('help me optimize this sql query plan', [{ id: 'x/y/sql-optimizer', name: 'sql-optimizer' }]).map(c => c.name), ['sql-optimizer']);
  assert.deepEqual(relevantExternal('fill in the pdf-form for the lease', [{ id: 'x/y/pdf', name: 'pdf' }]).map(c => c.name), ['pdf']);
});

test('suggest: registry candidates are gated, and offered at most once per session', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'headjack-reg-'));
  fs.mkdirSync(path.join(proj, '.git'));
  process.env.HEADJACK_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'headjack-reghome-'));
  const cfg = { ...loadConfig(proj), external: true };
  const registry = async () => [{ id: 'a/b/objection-crusher', name: 'objection-crusher', installs: 350 }, { id: 'x/y/terraform', name: 'terraform', installs: 900 }];
  assert.equal(await suggest(cfg, 'dive in and crush all of them, make it amazing', { sessionId: 's0', registry: async () => [{ id: 'a/b/objection-crusher', name: 'objection-crusher', installs: 350 }] }), '');
  const t1 = await suggest(cfg, 'write a terraform module for a private bucket', { sessionId: 's1', registry });
  assert.match(t1, /x\/y\/terraform/);
  assert.doesNotMatch(t1, /objection-crusher/);
  assert.equal(await suggest(cfg, 'write another terraform module for logs', { sessionId: 's1', registry }), '');
  const s = JSON.parse(fs.readFileSync(path.join(proj, '.headjack-stats.json'), 'utf8'));
  assert.equal(s.totals.external_suggestions, 1);
});
