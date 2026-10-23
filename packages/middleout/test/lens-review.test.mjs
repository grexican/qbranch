// Lens review fixes: stale sidecars, big integers, failures under fan-out/pagination, permissions, temp safety,
// cleanup, Cursor names, repeated pages, {{_parent}}.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pre, post } from '../src/hook.mjs';
import { loadConfig } from '../src/config.mjs';
import { isWrite } from '../src/stats.mjs';
import { ownedByMe } from '../src/lens.mjs';

function mkcfg(over = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mo-lensr-'));
  return { ...loadConfig(root), lensDir: path.join(root, 'lens'), ...over };
}
const blocks = (v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }];
let n = 0;
function call(cfg, tool, input, api, { platform = 'claude', session = 's1', id = `tu${++n}`, postTool = tool } = {}) {
  const raw = id ? { tool_use_id: id } : {};
  const p = pre(cfg, { platform, event: 'PreToolUse', tool, input, sessionId: session, raw });
  if (p?.deny) return { denied: p.deny, pre: p };
  const sent = p?.updatedInput ?? input;
  const q = post(cfg, { platform, event: 'PostToolUse', tool: postTool, input: sent, response: api(sent), sessionId: session, raw });
  return { sent, out: q?.updatedOutput ?? null, pre: p };
}
const nextArgs = (text) => JSON.parse(text.match(/plus (\{.*\})\. Do not answer/)[1]);
const first = (out) => out.split('\n')[0];
const lensFiles = (dir) => {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(p); } };
  try { walk(dir); } catch { /* nothing yet */ }
  return out;
};
const DEALS = Array.from({ length: 25 }, (_, i) => ({ id: `d${i}`, name: `Deal ${i}` }));
const listDeals = ({ page = 0 }) => blocks({ deals: DEALS.slice(page * 10, page * 10 + 10), page, has_more: (page + 1) * 10 < 25 });
const issuedCalls = (out) => out.split('\n').filter(l => l.startsWith('- ')).map(l => { const m = l.match(/^- (\S+) (\{.*\})$/); return { tool: m[1], args: JSON.parse(m[2]) }; });

test('#1 a sidecar whose call failed is consumed, never applied to a later identical call', () => {
  const cfg = mkcfg();
  assert.equal(call(cfg, 'mcp__crm__get', { q: 'x', _middleout: { select: 'a' } }, () => ({ isError: true, content: blocks('boom') })).out, null);
  assert.equal(call(cfg, 'mcp__crm__get', { q: 'x' }, () => blocks({ a: 1, b: 2 })).out, null);
  assert.equal(lensFiles(cfg.lensDir).filter(f => /side-/.test(f)).length, 0);
});

test('#1 without a tool_use_id the args key pairs pre and post; a record older than 60s is ignored', () => {
  const cfg = mkcfg();
  assert.equal(first(call(cfg, 'mcp__crm__get', { q: 'y', _middleout: { select: 'a' } }, () => blocks({ a: 7, b: 8 }), { id: null }).out), '7');
  pre(cfg, { platform: 'claude', event: 'PreToolUse', tool: 'mcp__crm__get', input: { q: 'z', _middleout: { select: 'a' } }, sessionId: 's1', raw: {} });
  for (const f of lensFiles(cfg.lensDir).filter(f => /side-/.test(f))) {
    const rec = JSON.parse(fs.readFileSync(f, 'utf8')); rec.at -= 61_000; fs.writeFileSync(f, JSON.stringify(rec));
  }
  const q = post(cfg, { platform: 'claude', event: 'PostToolUse', tool: 'mcp__crm__get', input: { q: 'z' }, response: blocks({ a: 1, b: 2 }), sessionId: 's1', raw: {} });
  assert.equal(q?.updatedOutput ?? null, null);
});

test('#2 integers beyond 2^53 are never altered (compaction and select)', () => {
  const cfg = mkcfg();
  const rows = Array.from({ length: 40 }, (_, i) => `{"id":12345678901234567${String(i).padStart(2, '0')},"name":"T${i}","x":null,"y":"","d":"${'z'.repeat(500)}"}`).join(',');
  const raw = `{"tasks":[${rows}]}`;
  const r = call(cfg, 'mcp__crm__search', {}, () => blocks(raw));
  assert.ok(r.out.includes('1234567890123456700') && r.out.includes('1234567890123456739'), r.out.slice(0, 200));
  assert.match(r.out, /kept as strings/);
  const s = call(cfg, 'mcp__crm__search', { _middleout: { select: 'tasks[0].id', page: false } }, () => blocks(raw));
  assert.equal(first(s.out), '"1234567890123456700"');
});

test('#3 a failed fan-out child is reported, the others still assemble; unknown slots do not count', () => {
  const cfg = mkcfg();
  const accounts = () => blocks({ accounts: [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }] });
  const r = call(cfg, 'mcp__crm__list_accounts', { _middleout: { select: 'accounts', each: { tool: 'get_contact', args: { account_id: '{{id}}' }, as: 'c' } } }, accounts);
  const issued = issuedCalls(r.out);
  const bogus = { ...issued[0].args, _middleout: { ...issued[0].args._middleout, slot: '9.9' } };
  assert.doesNotMatch(call(cfg, issued[0].tool, bogus, () => blocks({ x: 1 })).out || '', /\d\/3 stored/);
  const ok = (a) => blocks({ name: a.account_id });
  call(cfg, issued[0].tool, issued[0].args, ok);
  call(cfg, issued[1].tool, issued[1].args, () => ({ isError: true, content: blocks('404 not found') }));
  const last = call(cfg, issued[2].tool, issued[2].args, ok).out;
  const final = JSON.parse(first(last));
  assert.equal(final[0].c.name, 'a1');
  assert.match(JSON.stringify(final[1].c), /404 not found/);
  assert.equal(final[2].c.name, 'a3');
  assert.match(last, /INCOMPLETE: 1 of 3 per-item calls failed/);
});

test('#3 a page that fails mid-way returns the pages gathered so far, marked INCOMPLETE', () => {
  const cfg = mkcfg();
  let r = call(cfg, 'mcp__crm__list_deals', { _middleout: { select: 'deals[].name' } }, listDeals);
  r = call(cfg, 'mcp__crm__list_deals', nextArgs(r.out), () => ({ isError: true, content: blocks('rate limited') }));
  assert.equal(JSON.parse(first(r.out)).length, 10);
  assert.match(r.out, /INCOMPLETE: page 2 failed: .*rate limited/);
});

test('#4 where a rewrite approves the call, a sidecar is accepted only on read verbs; injection-style names refused', () => {
  const cfg = mkcfg();
  for (const t of ['execute_sql', 'browser_click', 'run_query', 'browser_type', 'evaluate_script']) {
    assert.match(call(cfg, `mcp__db__${t}`, { _middleout: 'x' }, () => blocks({}), { platform: 'cursor' }).denied || '', /call again without _middleout/, t);
    assert.ok(!call(cfg, `mcp__db__${t}`, { _middleout: 'x' }, () => blocks({})).denied, `claude does not approve, so it may strip: ${t}`);
  }
  assert.equal(first(call(cfg, 'mcp__web__browser_get_text', { _middleout: { select: 'a' } }, () => blocks({ a: 1 }), { platform: 'cursor' }).out), '1');
  assert.equal(pre(cfg, { platform: 'cursor', event: 'PreToolUse', tool: 'mcp__crm__list_deals', input: { _middleout: 5 }, sessionId: 's1', raw: {} }), null);
  assert.equal(pre(cfg, { platform: 'claude', event: 'PreToolUse', tool: 'mcp__crm__list_deals', input: { _middleout: 5 }, sessionId: 's1', raw: {} }), null);
  for (const t of ['browser_click', 'execute_sql', 'run_query', 'evaluate_script']) assert.ok(isWrite(t), t);
  for (const t of ['get_type', 'list_posts', 'search_messages', 'tracker_get_task']) assert.ok(!isWrite(t), t);
});

test('#5 lens files live in a per-user folder, owner-only; a folder owned by someone else is refused', () => {
  const cfg = mkcfg();
  const big = { tasks: Array.from({ length: 60 }, (_, i) => ({ id: `t${i}`, a: null, b: '', d: 'x'.repeat(500) })) };
  const r = call(cfg, 'mcp__crm__search_tasks', {}, () => blocks(big));
  const file = r.out.match(/Full result: (\S+) /)[1];
  assert.match(file, /middleout-lens-[^/]+\//);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(path.dirname(file))).mode & 0o777, 0o700);
    assert.equal(ownedByMe({ uid: process.getuid() + 1 }), false);
    assert.equal(ownedByMe({ uid: process.getuid() }), true);
  } else assert.equal(ownedByMe({ uid: 0 }), true); // no uid ownership on Windows: the temp folder is per-user already
});

test('#6 cleanup only touches the lens folder; raw files per session are capped at 50', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mo-clean-'));
  const keep = path.join(root, 'keep.txt'); fs.writeFileSync(keep, 'mine');
  const old = (Date.now() - 5 * 864e5) / 1000; fs.utimesSync(keep, old, old);
  const cfg = { ...loadConfig(root), lensDir: root };
  const big = { tasks: Array.from({ length: 60 }, (_, i) => ({ id: `t${i}`, a: null, d: 'x'.repeat(500) })) };
  for (let i = 0; i < 55; i++) call(cfg, 'mcp__crm__search_tasks', { i }, () => blocks(big), { session: 'cap' });
  call(cfg, 'mcp__crm__search_tasks', {}, () => blocks(big), { session: 'another' }); // a new session sweeps old ones
  assert.ok(fs.existsSync(keep));
  assert.ok(lensFiles(root).filter(f => /raw-/.test(f)).length <= 51);
  assert.ok(lensFiles(path.join(root)).filter(f => /raw-/.test(f) && f.includes(`${path.sep}cap${path.sep}`)).length <= 50);
});

test('#7 Cursor: pre and post pair up when post lacks the server; instructions use the name the model called', () => {
  const cfg = mkcfg();
  assert.equal(first(call(cfg, 'mcp__crm__get', { q: 1, _middleout: { select: 'a' } }, () => blocks({ a: 3, b: 4 }), { platform: 'cursor', id: null, postTool: 'mcp__mcp__get' }).out), '3');
  const r = call(cfg, 'mcp__mcp__list_deals', { _middleout: { select: 'deals[].name' } }, listDeals, { platform: 'cursor', id: null });
  assert.match(r.out, /Call list_deals again/);
  assert.doesNotMatch(r.out, /mcp\.list_deals|mcp__mcp__/);
  const f = call(cfg, 'mcp__mcp__list_accounts', { _middleout: { select: 'accounts', each: { tool: 'get_contact', args: { id: '{{id}}' } } } }, () => blocks({ accounts: [{ id: 'a1' }] }), { platform: 'cursor', id: null });
  assert.equal(issuedCalls(f.out)[0].tool, 'get_contact');
});

test('#8 a repeated page stops with an INCOMPLETE note', () => {
  const cfg = mkcfg();
  const stuck = () => listDeals({ page: 0 }); // ignores the page argument
  let r = call(cfg, 'mcp__crm__list_deals', { _middleout: { select: 'deals[].name' } }, stuck);
  r = call(cfg, 'mcp__crm__list_deals', nextArgs(r.out), stuck);
  assert.equal(JSON.parse(first(r.out)).length, 10);
  assert.match(r.out, /INCOMPLETE: page 2 repeated/);
});

test('#9 fan-out templates can read {{_parent.x}}: the first call\'s arguments', () => {
  const cfg = mkcfg();
  const r = call(cfg, 'mcp__crm__list_accounts', { region: 'eu', _middleout: { select: 'accounts', each: { tool: 'get_contact', args: { account_id: '{{id}}', region: '{{_parent.region}}' } } } }, () => blocks({ accounts: [{ id: 'a1' }] }));
  assert.equal(issuedCalls(r.out)[0].args.region, 'eu');
});
