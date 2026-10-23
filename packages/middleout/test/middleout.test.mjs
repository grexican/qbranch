// Engine, hook and stats tests against the fixture CRM server.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEngine } from '../src/engine.mjs';
import { post, pre } from '../src/hook.mjs';
import { upsert, summarize, recordRun } from '../src/stats.mjs';

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

test('bypass traffic is split: addressable, unwrapped, binary (images), write', () => {
  const cfg = tmp();
  post(cfg, { tool: 'mcp__crm__list_deals', response: 'x'.repeat(500) });
  post(cfg, { tool: 'mcp__crm__delete_deal', response: '{"deleted":true}' });
  post(cfg, { tool: 'mcp__other__list_things', response: 'x'.repeat(5000) });
  post(cfg, { tool: 'mcp__browser__screenshot', response: [{ type: 'image', data: 'A'.repeat(9000), mimeType: 'image/png' }] });
  const s = JSON.parse(fs.readFileSync(path.join(cfg.root, cfg.stats), 'utf8'));
  assert.equal(s.bypass.addressable.calls, 1);
  assert.equal(s.bypass.write.calls, 1);
  assert.equal(s.bypass.unwrapped.calls, 1);
  assert.equal(s.bypass.binary.calls, 1);
  assert.equal(s.tools['crm.delete_deal'].class, 'write');
  assert.equal(s.totals.nudges, 0); // the only big wrapped result was a screenshot from an unwrapped server
  const text = summarize(s, cfg);
  assert.match(text, /crm\.list_deals/);
  assert.doesNotMatch(text.split('ignored')[0], /screenshot|delete_deal/);
});

test('hook matches wrapped servers whose names the host normalizes (dots, dashes)', () => {
  const cfg = { ...tmp(), servers: { 'crm.io': servers.crm } };
  assert.match(post(cfg, { tool: 'mcp__crm_io__list_deals', response: 'x'.repeat(5000) }).context, /middleout_run/);
});

test('a nudge for an HTTP server that was never signed in says how to sign in', () => {
  process.env.MIDDLEOUT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'middleout-home-'));
  const cfg = { ...tmp(), servers: { web: { type: 'http', url: 'https://example.com/mcp' } } };
  assert.match(post(cfg, { tool: 'mcp__web__search', response: 'x'.repeat(5000) }).context, /middleout login web/);
  const keyed = { ...tmp(), servers: { web: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer k' } } } };
  assert.doesNotMatch(post(keyed, { tool: 'mcp__web__search', response: 'x'.repeat(5000) }).context, /login/);
});

test('a nudge counts as converted when the same session next fetches that server through middleout', () => {
  const cfg = tmp(); const sessionId = `conv${Date.now()}`;
  post(cfg, { tool: 'mcp__crm__list_deals', sessionId, response: 'x'.repeat(5000) });
  const run = { tool: 'mcp__plugin_middleout_middleout__middleout_run', sessionId, input: { plan: { tool: 'crm.list_deals', each: { tool: 'crm.get_contact' } } }, response: 'ok' };
  assert.equal(post(cfg, run), null);
  post(cfg, run); // converts once per nudge
  post(cfg, { ...run, sessionId: 'someone-else' });
  const s = JSON.parse(fs.readFileSync(path.join(cfg.root, cfg.stats), 'utf8'));
  assert.equal(s.totals.nudges, 1);
  assert.equal(s.totals.nudges_converted, 1);
  assert.equal(s.totals.raw_calls_seen, 1);
  assert.match(summarize(s, cfg), /1\/1 nudges converted \(100%\)/);
});

test('runs are attributed per tool (returned bytes in proportion to raw) and errors are kept', () => {
  const cfg = tmp();
  recordRun(cfg, { calls: 3, rawBytes: 1000, autoPages: 1, returnedBytes: 100, byTool: { 'a.x': { calls: 2, rawBytes: 750 }, 'b.y': { calls: 1, rawBytes: 250 } } }, { ok: true });
  recordRun(cfg, { calls: 0, rawBytes: 0, autoPages: 0, returnedBytes: 0, byTool: {} }, { ok: false, error: 'at plan[0]: boom', tools: ['a.x'] });
  const s = JSON.parse(fs.readFileSync(path.join(cfg.root, cfg.stats), 'utf8'));
  assert.deepEqual({ ...s.tools['a.x'] }, { ...s.tools['a.x'], via_middleout: 2, runs: 1, raw_bytes: 750, returned_bytes: 75 });
  assert.equal(s.tools['b.y'].returned_bytes, 25);
  assert.equal(s.totals.errors, 1);
  assert.equal(s.recent_errors[0].message, 'at plan[0]: boom');
  assert.deepEqual(s.recent_errors[0].tools, ['a.x']);
  const text = summarize(s, cfg);
  assert.match(text, /a\.x\s+1 run, 2 API calls/);
  assert.match(text, /boom/);
});

test('a stats file written by an older version still summarizes sensibly', () => {
  const cfg = tmp();
  const legacy = { tool: 'middleout', schema: 1, since: '2026-10-23T06:36:33.561Z', updated: '2026-10-23T06:59:32.373Z',
    totals: { runs: 4, api_calls: 6, raw_bytes: 86681, returned_bytes: 34909, auto_pages: 3, errors: 1, raw_calls_seen: 5, raw_bytes_seen: 600000, nudges: 4, gated: 0 },
    tools: {
      'crm.list_deals': { via_middleout: 6, raw_calls: 2, raw_bytes_seen: 19239 },
      'crm.delete_deal': { via_middleout: 0, raw_calls: 1, raw_bytes_seen: 122 },
      'docs.search': { via_middleout: 0, raw_calls: 13, raw_bytes_seen: 318433 },
      'browser.computer': { via_middleout: 0, raw_calls: 12, raw_bytes_seen: 491583 },
    }, days: {}, weissman: 2.5, est_tokens_saved: 14792 };
  fs.writeFileSync(path.join(cfg.root, cfg.stats), JSON.stringify(legacy));
  upsert(cfg, () => {}); // any write upgrades the file in place
  const s = JSON.parse(fs.readFileSync(path.join(cfg.root, cfg.stats), 'utf8'));
  const text = summarize(s, cfg);
  assert.match(text.split('\n')[0], /~14\.8k tokens kept out of context/);
  assert.match(text, /4 runs, 6 API calls/);
  assert.match(text, /not wrapped[^\n]*\n\s+docs\.search/);
  assert.doesNotMatch(text.split('ignored')[0], /browser\.computer|delete_deal/);
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
