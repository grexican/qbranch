// The lens: shaping native MCP results in the hooks (sidecar select, pagination ping-pong, fan-out, auto-compaction).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pre, post } from '../src/hook.mjs';
import { loadConfig } from '../src/config.mjs';
import { parseSidecar, compact } from '../src/lens.mjs';
import { render } from '@qbranch/core/hooks';

function mkcfg(over = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mo-lens-'));
  return { ...loadConfig(root), lensDir: path.join(root, 'lens'), ...over };
}
const blocks = (v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }];
let n = 0;
/** One native call through both hooks, as Claude Code runs them. api(args) is the server. */
function call(cfg, tool, input, api, { platform = 'claude', session = 's1', id = `tu${++n}` } = {}) {
  const p = pre(cfg, { platform, event: 'PreToolUse', tool, input, sessionId: session, raw: { tool_use_id: id } });
  if (p?.deny) return { denied: p.deny };
  const sent = p?.updatedInput ?? input;
  const response = api(sent);
  const q = post(cfg, { platform, event: 'PostToolUse', tool, input: sent, response, sessionId: session, raw: { tool_use_id: id } });
  return { sent, out: q?.updatedOutput ?? null, pre: p };
}
const nextArgs = (text) => JSON.parse(text.match(/plus (\{.*\})\. Do not answer/)[1]);

const DEALS = Array.from({ length: 25 }, (_, i) => ({ id: `d${i}`, name: `Deal ${i}`, stage: i % 2 ? 'won' : 'open', notes: null, custom: {} }));
const listDeals = ({ page = 0 }) => blocks({ deals: DEALS.slice(page * 10, page * 10 + 10), page, has_more: (page + 1) * 10 < 25 });

test('the sidecar comes as an object, a JSON string, or a bare JMESPath', () => {
  assert.deepEqual(parseSidecar({ select: 'a' }), { select: 'a' });
  assert.deepEqual(parseSidecar('{"select": "a"}'), { select: 'a' });
  assert.deepEqual(parseSidecar('deals[].name'), { select: 'deals[].name' });
});

test('pre strips the sidecar without approving the call on Claude Code; the server never sees it', () => {
  const cfg = mkcfg();
  const r = call(cfg, 'mcp__crm__list_deals', { stage: 'open', _middleout: '{"select":"deals[].name","page":false}' }, (a) => { assert.ok(!('_middleout' in a)); return listDeals(a); });
  assert.deepEqual(r.sent, { stage: 'open' });
  assert.equal(r.pre.keepPermission, true);
  assert.equal(JSON.parse(render({ platform: 'claude', event: 'PreToolUse' }, r.pre).stdout).hookSpecificOutput.permissionDecision, undefined);
  assert.match(r.out, /^\["Deal 0","Deal 1",/);
});

test('where a rewrite approves the call (codex, cursor, copilot), a write tool with a sidecar is refused, a read is fine', () => {
  const cfg = mkcfg();
  assert.match(call(cfg, 'mcp__crm__delete_deal', { id: 'd1', _middleout: { select: 'x' } }, () => blocks({}), { platform: 'codex' }).denied, /call again without _middleout/);
  assert.equal(call(cfg, 'mcp__crm__delete_deal', { id: 'd1', _middleout: { select: 'deleted' } }, () => blocks({ deleted: true }), { platform: 'claude' }).out.split('\n')[0], 'true');
  assert.equal(call(cfg, 'mcp__crm__list_deals', { _middleout: { select: 'length(deals)', page: false } }, listDeals, { platform: 'cursor' }).out.split('\n')[0], '10');
});

test('no lens where the platform cannot rewrite a result (gemini, windsurf) or when it is off', () => {
  for (const platform of ['gemini', 'windsurf']) {
    const r = call(mkcfg(), 'mcp__crm__list_deals', { _middleout: { select: 'x' } }, listDeals, { platform });
    assert.equal(r.out, null);
  }
  assert.equal(call(mkcfg({ lens: false }), 'mcp__crm__list_deals', { _middleout: { select: 'x' } }, listDeals).out, null);
});

test('pagination ping-pong: each page becomes a one-line instruction; the last returns everything merged and selected', () => {
  const cfg = mkcfg();
  let r = call(cfg, 'mcp__crm__list_deals', { _middleout: { select: 'deals[].name' } }, listDeals);
  assert.match(r.out, /^middleout: page 1 of crm\.list_deals stored \(10 items so far\)/);
  let steps = 0;
  while (r.out.startsWith('middleout: page')) {
    const add = nextArgs(r.out);
    r = call(cfg, 'mcp__crm__list_deals', { ...add }, listDeals);
    steps++;
  }
  assert.equal(steps, 2);
  const names = JSON.parse(r.out.split('\n')[0]);
  assert.equal(names.length, 25);
  assert.equal(names.at(-1), 'Deal 24');
  assert.match(r.out, /3 pages merged/);
  const s = JSON.parse(fs.readFileSync(path.join(cfg.root, cfg.stats), 'utf8'));
  assert.equal(s.totals.lens_calls, 3);
  assert.equal(s.totals.lens_pages, 2);
});

test('pagination ping-pong stops at "pages" and says INCOMPLETE', () => {
  const cfg = mkcfg();
  const endless = ({ page = 0 }) => blocks({ events: [{ id: `e${page}` }], page, has_more: true });
  let r = call(cfg, 'mcp__crm__list_events', { _middleout: { pages: 3 } }, endless);
  while (r.out.startsWith('middleout: page')) r = call(cfg, 'mcp__crm__list_events', nextArgs(r.out), endless);
  assert.equal(JSON.parse(r.out.split('\n')[0]).events.length, 3);
  assert.match(r.out, /INCOMPLETE: stopped at 3 pages/);
});

test('fan-out: the selected array becomes per-item calls (parallel-safe); the call that completes the set assembles', () => {
  const cfg = mkcfg();
  const accounts = () => blocks({ accounts: [{ id: 'a1', name: 'A' }, { id: 'a2', name: 'B' }, { id: 'a3', name: 'C' }] });
  const contact = ({ account_id }) => blocks({ contact: { name: `owner of ${account_id}`, email: `${account_id}@x.test`, phone: null } });
  const r = call(cfg, 'mcp__crm__list_accounts', { _middleout: { select: 'accounts', each: { tool: 'get_contact', args: { account_id: '{{id}}' }, select: 'contact.name', as: 'owner' } } }, accounts);
  const lines = r.out.split('\n').filter(l => l.startsWith('- '));
  assert.equal(lines.length, 3);
  const issued = lines.map(l => { const m = l.match(/^- (\S+) (\{.*\})$/); return { tool: m[1], args: JSON.parse(m[2]) }; });
  assert.equal(issued[0].tool, 'mcp__crm__get_contact');
  // the model issues them in any order (parallel): the last one stored returns the assembled result
  const outs = [issued[2], issued[0], issued[1]].map(c => call(cfg, c.tool, c.args, contact).out);
  assert.match(outs[0], /1\/3 stored/);
  const final = JSON.parse(outs[2].split('\n')[0]);
  assert.deepEqual(final.map(a => a.owner), ['owner of a1', 'owner of a2', 'owner of a3']);
  assert.deepEqual(final.map(a => a.name), ['A', 'B', 'C']);
});

test('auto-compaction: a big JSON result shrinks, the full result is saved, the path is in the reply', () => {
  const cfg = mkcfg();
  const big = { tasks: Array.from({ length: 60 }, (_, i) => ({ id: `t${i}`, name: `Task ${i}`, status: 'open', assignee: null, tags: [], custom_fields: {}, description: `t${i} ${'x'.repeat(900)}`, url: `https://example.test/t/${i}` })) };
  const r = call(cfg, 'mcp__crm__search_tasks', { q: 'x' }, () => blocks(big));
  const [body, foot] = r.out.split('\n');
  assert.ok(body.length < JSON.stringify(big).length * 0.5);
  const packed = JSON.parse(body).tasks;
  assert.deepEqual(packed._same, { status: 'open' }); // a value every record shares is stated once
  assert.deepEqual(packed._cols, ['id', 'name', 'description', 'url']); // empty fields gone, records packed
  assert.match(packed._rows[0][2], /^t0 x+…\[\+603 chars\]$/);
  const file = foot.match(/Full result: (\S+) /)[1];
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), big);
  const s = JSON.parse(fs.readFileSync(path.join(cfg.root, cfg.stats), 'utf8'));
  assert.equal(s.totals.lens_compactions, 1);
});

test('auto-compaction leaves alone: small results, plain text, images, errors, and results it cannot shrink', () => {
  const cfg = mkcfg();
  assert.equal(call(cfg, 'mcp__crm__x', {}, () => blocks({ a: 1 })).out, null);
  assert.equal(call(cfg, 'mcp__crm__x', {}, () => blocks('word '.repeat(5000))).out, null);
  assert.equal(call(cfg, 'mcp__crm__x', {}, () => [{ type: 'image', data: 'x'.repeat(20000) }, ...blocks({ a: 'y'.repeat(20000) })]).out, null);
  assert.equal(call(cfg, 'mcp__crm__x', {}, () => ({ isError: true, content: blocks({ a: 'y'.repeat(20000) }) })).out, null);
  const dense = { ids: Array.from({ length: 3000 }, (_, i) => i) }; // nothing to drop or pack
  assert.equal(call(cfg, 'mcp__crm__x', {}, () => blocks(dense)).out, null);
});

test('compact: a single document keeps its long text; only lists of records get trimmed', () => {
  const body = 'word '.repeat(400);
  assert.equal(compact({ page: { slug: 'a', body, meta: null } }).page.body, body);
  const list = compact({ items: Array.from({ length: 5 }, (_, i) => ({ id: i, body: `${i}${body}` })) }).items;
  assert.match(list._rows[0][1], /…\[\+\d+ chars\]$/);
});

test('compact: empty fields dropped, unlike records not packed, nested structure kept', () => {
  const out = compact({ a: null, b: '', c: [], d: {}, e: { f: null, g: 1 }, list: [{ x: 1 }, { y: 2 }, { z: 3 }, { w: 4 }] });
  assert.deepEqual(out, { e: { g: 1 }, list: [{ x: 1 }, { y: 2 }, { z: 3 }, { w: 4 }] });
});

test('lens results are counted, not reported as raw traffic that bypassed middleout', () => {
  const cfg = mkcfg();
  call(cfg, 'mcp__crm__list_deals', { _middleout: { select: 'length(deals)', page: false } }, listDeals);
  const s = JSON.parse(fs.readFileSync(path.join(cfg.root, cfg.stats), 'utf8'));
  assert.equal(s.totals.lens_calls, 1);
  assert.equal(s.totals.raw_calls_seen, 0);
  assert.equal(s.tools['crm.list_deals'].lens_calls, 1);
  // lens savings count in the headline numbers
  assert.ok(s.est_tokens_saved > 0 && s.weissman > 1);
});
