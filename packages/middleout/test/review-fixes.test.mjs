// Hardening: re-login redirects, secrets kept out of stats, refresh races, nudge accounting, callback safety, write
// classification, and "no sign-in needed" memory.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, scrub } from '../src/config.mjs';
import { createEngine } from '../src/engine.mjs';
import { tokenFile, login, maybeNeedsLogin, provider } from '../src/oauth.mjs';
import { post } from '../src/hook.mjs';
import { recordRun, summarize, isWrite } from '../src/stats.mjs';
import { startHttpFixture } from './fixtures/http-server.mjs';

process.env.MIDDLEOUT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'middleout-home-'));
const open = await startHttpFixture();
const authd = await startHttpFixture({ oauth: true });
after(() => Promise.all([open.close(), authd.close()]));

const tmp = () => ({ root: fs.mkdtempSync(path.join(os.tmpdir(), 'middleout-rf-')), stats: '.middleout-stats.json', mode: 'nudge', nudgeBytes: 1000,
  servers: { crm: { command: 'node', args: ['x'] } } });
const readStats = (cfg) => JSON.parse(fs.readFileSync(path.join(cfg.root, cfg.stats), 'utf8'));
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
// stands in for the browser: follow the authorize redirect to the local callback
const fakeBrowser = async (url) => { const r = await fetch(url, { redirect: 'manual' }); await fetch(r.headers.get('location')); };

test('login uses a 127.0.0.1 redirect and reuses the port a stored dynamic client was registered with', async () => {
  const spec = { type: 'http', url: authd.url };
  const port = await freePort();
  const f = tokenFile('reuse', spec.url);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const redirect = `http://127.0.0.1:${port}/callback`;
  fs.writeFileSync(f, JSON.stringify({ url: spec.url, redirectUrl: redirect, client: { client_id: 'client-1', redirect_uris: [redirect] } }));
  await login('reuse', spec, { open: fakeBrowser, log: () => {} });
  const saved = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(saved.redirectUrl, redirect);
  assert.ok(saved.tokens.access_token);
});

test('login drops a stored client whose registered port is taken, and registers again for the new redirect', async () => {
  const spec = { type: 'http', url: authd.url };
  const busy = net.createServer(); await new Promise((r) => busy.listen(0, '127.0.0.1', r));
  const old = `http://127.0.0.1:${busy.address().port}/callback`;
  const f = tokenFile('moved', spec.url);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ url: spec.url, redirectUrl: old, client: { client_id: 'stale', redirect_uris: [old] }, tokens: { access_token: 'dead', token_type: 'Bearer' } }));
  try { await login('moved', spec, { open: fakeBrowser, log: () => {} }); } finally { busy.close(); }
  const saved = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.notEqual(saved.redirectUrl, old);
  assert.match(saved.redirectUrl, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.equal(saved.client.client_id, 'client-1');
  assert.deepEqual(saved.client.redirect_uris, [saved.redirectUrl]);
});

test('a callback with the wrong state (or before the flow is ready) answers 400 and login keeps waiting', async () => {
  const spec = { type: 'http', url: authd.url };
  const browser = async (url) => {
    const r = await fetch(url, { redirect: 'manual' });
    const cb = new URL(r.headers.get('location'));
    const forged = new URL(cb); forged.searchParams.set('state', 'forged');
    assert.equal((await fetch(forged)).status, 400);
    await fetch(cb);
  };
  const r = await login('statecheck', spec, { open: browser, log: () => {} });
  assert.equal(r.needed, true);
});

test('the callback page escapes an error value from the authorization server', async () => {
  const spec = { type: 'http', url: authd.url };
  let body = '';
  const browser = async (url) => {
    const r = await fetch(url, { redirect: 'manual' });
    const cb = new URL(r.headers.get('location'));
    cb.searchParams.delete('code'); cb.searchParams.set('error', '<script>alert(1)</script>');
    body = await (await fetch(cb)).text();
  };
  await assert.rejects(login('escaped', spec, { open: browser, log: () => {} }), /sign-in failed/);
  assert.doesNotMatch(body, /<script>/);
  assert.match(body, /&lt;script&gt;/);
});

test('scrub strips query strings, userinfo and known secret values from messages', () => {
  const msg = scrub('GET https://bob:pw@api.example.com/v1/items?key=sk-123&x=1 failed; header Bearer sk-123 rejected', ['sk-123']);
  assert.doesNotMatch(msg, /sk-123|bob|pw@/);
  assert.match(msg, /https:\/\/api\.example\.com\/v1\/items\?…/);
});

test('a server URL with ${VAR} that fails to connect never puts the secret in errors or the stats file', async () => {
  process.env.MO_RF_SECRET = 'very-secret-value';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'middleout-rf-'));
  fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { leaky: { type: 'http', url: 'http://127.0.0.1:1/mcp?key=${MO_RF_SECRET}' } } }));
  const cfg = loadConfig(root);
  const e = createEngine(cfg);
  let message = '';
  try { await e.run({ tool: 'leaky.anything' }); } catch (err) { message = err.message; } finally { await e.close(); }
  assert.ok(message);
  assert.doesNotMatch(message, /very-secret-value/);
  recordRun(cfg, { calls: 0, rawBytes: 0, autoPages: 0, byTool: {}, returnedBytes: 0 }, { ok: false, error: `${message} (also https://h.example/x?key=very-secret-value)`, tools: ['leaky.anything'] });
  assert.doesNotMatch(fs.readFileSync(path.join(root, cfg.stats), 'utf8'), /very-secret-value/);
});

test('a refresh that lost the race does not delete the tokens another process just saved', () => {
  const spec = { type: 'http', url: 'https://race.example/mcp' };
  const f = tokenFile('race', spec.url);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ url: spec.url, client: { client_id: 'c' }, tokens: { access_token: 'a1', token_type: 'Bearer', refresh_token: 'r1' } }));
  const loser = provider('race', spec, { interactive: false });
  assert.equal(loser.tokens().refresh_token, 'r1'); // this process starts its refresh with r1...
  // ...meanwhile another process refreshed and rotated the refresh token
  fs.writeFileSync(f, JSON.stringify({ url: spec.url, client: { client_id: 'c' }, tokens: { access_token: 'a2', token_type: 'Bearer', refresh_token: 'r2' } }));
  loser.invalidateCredentials('tokens'); // the SDK's reaction to invalid_grant on r1
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).tokens.refresh_token, 'r2');
  assert.equal(loser.tokens().access_token, 'a2');
  // with no newer tokens on disk, invalidation does delete
  const solo = provider('race', spec, { interactive: false });
  solo.tokens();
  solo.invalidateCredentials('tokens');
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).tokens, undefined);
});

test('per-tool "saved" never goes negative', () => {
  const cfg = tmp();
  recordRun(cfg, { calls: 1, rawBytes: 100, autoPages: 0, returnedBytes: 4000, byTool: { 'crm.tiny': { calls: 1, rawBytes: 100 } } });
  assert.doesNotMatch(summarize(readStats(cfg), cfg), /saved -/);
});

test('repeated nudges for one server in one session track once; a failed middleout call does not convert', () => {
  const cfg = tmp(); const sessionId = `rf${Date.now()}`;
  for (let i = 0; i < 3; i++) post(cfg, { tool: 'mcp__crm__list_deals', sessionId, response: 'x'.repeat(5000) });
  const run = { tool: 'mcp__plugin_middleout_middleout__middleout_run', sessionId, input: { plan: { tool: 'crm.list_deals' } } };
  post(cfg, { ...run, response: [{ type: 'text', text: 'middleout error at plan: boom' }] });
  let s = readStats(cfg);
  assert.equal(s.totals.nudges, 3);
  assert.equal(s.totals.nudges_tracked, 1);
  assert.equal(s.totals.nudges_converted, 0);
  post(cfg, { ...run, response: [{ type: 'text', text: '[{"id":1}]' }] });
  s = readStats(cfg);
  assert.equal(s.totals.nudges_converted, 1);
});

test('a tool once seen returning binary stays binary', () => {
  const cfg = tmp();
  post(cfg, { tool: 'mcp__crm__render', response: [{ type: 'image', data: 'x'.repeat(2000) }] });
  post(cfg, { tool: 'mcp__crm__render', response: 'small text' });
  assert.equal(readStats(cfg).tools['crm.render'].class, 'binary');
});

test('write classification: a leading verb (after one optional prefix) is a write; read verbs on write-ish nouns are not', () => {
  for (const t of ['create_task', 'tracker_create_task', 'createTask', 'navigate', 'tabs_close_mcp', 'post_message', 'send_chat_message'])
    assert.ok(isWrite(t), t);
  for (const t of ['get_post', 'list_posts', 'search_messages', 'get_task', 'tracker_get_task', 'brain_search', 'filter_tasks'])
    assert.ok(!isWrite(t), t);
});

test('an HTTP server that connects without auth is remembered, so nudges stop asking for sign-in', async () => {
  const spec = { type: 'http', url: open.url };
  assert.equal(maybeNeedsLogin('openweb', spec), true);
  const e = createEngine({ servers: { openweb: spec } });
  try { await e.run({ tool: 'openweb.list_items', page: false }); } finally { await e.close(); }
  assert.equal(maybeNeedsLogin('openweb', spec), false);
});
