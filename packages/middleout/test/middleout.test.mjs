// Engine, hook and stats tests against the fixture CRM server.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEngine } from '../src/engine.mjs';
import { post, pre } from '../src/hook.mjs';
import { upsert, summarize } from '../src/stats.mjs';

const FIXTURE = path.resolve(import.meta.dirname, 'fixtures/crm-server.mjs');
const servers = { crm: { command: 'node', args: [FIXTURE] } };
const engine = createEngine({ servers });
after(() => engine.close());

test('by default every tool is wrapped: most servers never set readOnlyHint, and a POST is often a search', async () => {
  const refs = (await engine.tools()).map(t => t.ref);
  assert.ok(refs.includes('crm.list_deals'));
  assert.ok(refs.includes('crm.delete_deal'));
});

test('readonly: true still restricts to tools their own server annotates readOnlyHint', async () => {
  const ro = createEngine({ servers, readonly: true });
  try {
    const refs = (await ro.tools()).map(t => t.ref);
    assert.ok(refs.includes('crm.list_deals'));
    assert.ok(!refs.includes('crm.delete_deal'));
    await assert.rejects(ro.run({ tool: 'crm.delete_deal', args: { id: 'deal_1' } }), /not available through middleout/);
  } finally { await ro.close(); }
});

test('allow narrows middleout to the tools you list, whatever their annotations', async () => {
  const narrow = createEngine({ servers, allow: '^crm\\.list_' });
  try {
    const refs = (await narrow.tools()).map(t => t.ref);
    assert.ok(refs.includes('crm.list_deals'));
    assert.ok(!refs.includes('crm.delete_deal'));
  } finally { await narrow.close(); }
});

test('automatic pagination returns every page in the normal shape', async () => {
  const { result, stats } = await engine.run({ tool: 'crm.list_deals', select: 'length(deals)' });
  assert.equal(result, 25);
  assert.equal(stats.calls, 3);
  assert.equal(stats.autoPages, 2);
});

test('"page": false returns only the first page', async () => {
  const { result } = await engine.run({ tool: 'crm.list_deals', page: false, select: 'length(deals)' });
  assert.equal(result, 10);
});

test('projection keeps only the selected fields (and compresses hard)', async () => {
  const { result, stats } = await engine.run({ tool: 'crm.list_deals', args: { stage: 'negotiation' }, select: 'deals[?amount > `60000`].name' });
  assert.deepEqual(result, ['Deal 13', 'Deal 15', 'Deal 17', 'Deal 19', 'Deal 21', 'Deal 23']);
  assert.ok(stats.rawBytes / stats.returnedBytes > 50);
});

test('fan-out and nesting attach child results; {{field}} templates resolve', async () => {
  const { result } = await engine.run({
    tool: 'crm.list_accounts', args: { tier: 'enterprise' }, select: 'accounts[].{id: id, name: name}',
    each: { as: 'deals', tool: 'crm.list_deals', args: { account_id: '{{id}}', stage: 'negotiation' }, select: 'deals[].{id: id, cid: contact_id}',
      each: [
        { as: 'email', tool: 'crm.get_contact', args: { id: '{{cid}}' }, select: 'email' },
        { as: 'calls', tool: 'crm.list_activities', args: { deal_id: '{{id}}' }, select: "length([?type=='call'])" },
      ] },
  });
  assert.equal(result.length, 2);
  const d1 = result.flatMap(a => a.deals).find(d => d.id === 'deal_1');
  assert.equal(d1.email, 'person1@example.com');
  assert.equal(d1.calls, 1);
});

test('empty-string args are dropped (LLMs send them; APIs reject them)', async () => {
  const { result } = await engine.run({ tool: 'crm.list_accounts', args: { tier: '' }, select: 'length(accounts)' });
  assert.equal(result, 3);
});

test('errors name the failing node', async () => {
  await assert.rejects(engine.run({ tool: 'crm.list_accounts', select: 'accounts', each: { as: 'x', tool: 'crm.nope' } }), /at plan\[0\]\.x/);
});

const tmp = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'middleout-')); return { root, servers, mode: 'nudge', nudgeBytes: 1000, stats: '.middleout-stats.json' }; };

test('post hook records raw MCP traffic and nudges on big results from wrapped servers', () => {
  const cfg = tmp();
  const big = { tool: 'mcp__crm__list_deals', response: 'x'.repeat(5000) };
  assert.match(post(cfg, big).context, /middleout_run/);
  assert.equal(post(cfg, { tool: 'mcp__other__thing', response: 'x'.repeat(5000) }), null); // not wrapped: measured, no nudge
  assert.equal(post(cfg, { tool: 'mcp__middleout__middleout_run', response: 'x' }), null);   // our own calls are not "raw"
  const s = JSON.parse(fs.readFileSync(path.join(cfg.root, cfg.stats), 'utf8'));
  assert.equal(s.totals.raw_calls_seen, 2);
  assert.equal(s.totals.nudges, 1);
});

test('gate mode denies the first raw call to a wrapped server, then allows', () => {
  const cfg = { ...tmp(), mode: 'gate' };
  const input = { tool: 'mcp__crm__list_deals', sessionId: `t${Date.now()}` };
  assert.equal(typeof pre(cfg, input).deny, 'string');
  assert.equal(pre(cfg, input), null);
  assert.equal(pre({ ...cfg, mode: 'nudge' }, { ...input, sessionId: 'other' }), null);
});

test('stats compute a Weissman score and summarize', () => {
  const cfg = tmp();
  upsert(cfg, (s) => { s.totals.runs++; s.totals.raw_bytes += 100000; s.totals.returned_bytes += 2000; });
  const s = JSON.parse(fs.readFileSync(path.join(cfg.root, cfg.stats), 'utf8'));
  assert.equal(s.weissman, 50);
  assert.match(summarize(s), /Weissman score 50/);
});
