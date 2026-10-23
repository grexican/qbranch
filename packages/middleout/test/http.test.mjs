// HTTP MCP servers: config from .mcp.json, Streamable HTTP, static header auth, OAuth (stored tokens, refresh, login).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { createEngine } from '../src/engine.mjs';
import { tokenFile, login } from '../src/oauth.mjs';
import { startHttpFixture } from './fixtures/http-server.mjs';

process.env.MIDDLEOUT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'middleout-home-'));
const open = await startHttpFixture();
const secure = await startHttpFixture({ token: 's3cret' });
const authd = await startHttpFixture({ oauth: true });
after(() => Promise.all([open.close(), secure.close(), authd.close()]));

const project = (mcpServers, extra = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'middleout-proj-'));
  fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers }));
  if (Object.keys(extra).length) fs.writeFileSync(path.join(root, 'middleout.config.json'), JSON.stringify(extra));
  return root;
};

test('config wraps http and sse servers from .mcp.json and expands ${VAR} / ${VAR:-default} in headers', () => {
  process.env.MO_TEST_TOKEN = 'abc';
  const cfg = loadConfig(project({
    web: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${MO_TEST_TOKEN}', 'X-Team': '${MO_MISSING:-ops}' }, oauth: { clientId: 'cid', callbackPort: 8787 } },
    stream: { type: 'sse', url: 'https://example.com/sse' },
    local: { command: 'node', args: ['x.mjs'] },
    sock: { type: 'ws', url: 'wss://example.com' },
  }));
  assert.deepEqual(cfg.servers.web, { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer abc', 'X-Team': 'ops' }, oauth: { clientId: 'cid', callbackPort: 8787 } });
  assert.equal(cfg.servers.stream.type, 'sse');
  assert.ok(cfg.servers.local.command);
  assert.equal(cfg.servers.sock, undefined);
  assert.match(cfg.skipped.sock, /ws/);
});

test('runs plans against a Streamable HTTP server, pagination included', async () => {
  const e = createEngine({ servers: { web: { type: 'http', url: open.url } } });
  try {
    const { result, stats } = await e.run({ tool: 'web.list_items', select: 'items[].id' });
    assert.equal(result.length, 12);
    assert.equal(stats.autoPages, 2);
  } finally { await e.close(); }
});

test('static Authorization header from config reaches the server', async () => {
  const e = createEngine({ servers: { sec: { type: 'http', url: secure.url, headers: { Authorization: 'Bearer s3cret' } } } });
  try { assert.equal((await e.run({ tool: 'sec.list_items', page: false, select: 'length(items)' })).result, 5); } finally { await e.close(); }
});

test('a wrong configured header says the credentials were rejected, not "sign in"', async () => {
  const e = createEngine({ servers: { sec: { type: 'http', url: secure.url, headers: { Authorization: 'Bearer nope' } } } });
  try { await assert.rejects(e.run({ tool: 'sec.list_items' }), /rejected its configured credentials/); } finally { await e.close(); }
});

test('a server that needs sign-in and has no token says how to sign in (and never opens a browser)', async () => {
  const e = createEngine({ servers: { sec: { type: 'http', url: secure.url } } });
  try { await assert.rejects(e.run({ tool: 'sec.list_items' }), /server "sec" needs sign-in: run `[^`]*login sec` once/); } finally { await e.close(); }
});

test('one failing server does not hide the others in tools listings', async () => {
  const e = createEngine({ servers: { web: { type: 'http', url: open.url }, sec: { type: 'http', url: secure.url } } });
  try {
    const r = await e.toolsReport();
    assert.ok(r.tools.some(t => t.ref === 'web.list_items'));
    assert.equal(r.failed.length, 1);
    assert.equal(r.failed[0].server, 'sec');
    assert.match(r.failed[0].error, /needs sign-in/);
  } finally { await e.close(); }
});

test('unknown server errors list the wrapped servers and say why a .mcp.json entry was skipped', async () => {
  const e = createEngine({ servers: { web: { type: 'http', url: open.url } }, skipped: { sock: 'transport "ws" is not supported' } });
  try {
    await assert.rejects(e.run({ tool: 'sock.x' }), /"sock" is in \.mcp\.json but was skipped: transport "ws" is not supported/);
    await assert.rejects(e.run({ tool: 'nowhere.x' }), /wrapped: web.*not in this project's \.mcp\.json/s);
  } finally { await e.close(); }
});

test('OAuth: stored tokens are used, and a rejected access token is refreshed through the SDK and saved', async () => {
  const spec = { type: 'http', url: authd.url };
  const f = tokenFile('acct', spec.url);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ url: spec.url, redirectUrl: 'http://localhost:1/callback', client: { client_id: 'client-1' }, tokens: { access_token: 'stale', token_type: 'Bearer', refresh_token: 'refresh-1' } }));
  const e = createEngine({ servers: { acct: spec } });
  try {
    assert.equal((await e.run({ tool: 'acct.list_items', page: false, select: 'length(items)' })).result, 5);
    assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).tokens.access_token, 'access-2');
  } finally { await e.close(); }
});

test('OAuth: no stored token means a sign-in error, and no client is registered at runtime', async () => {
  const e = createEngine({ servers: { fresh: { type: 'http', url: authd.url } } });
  try { await assert.rejects(e.run({ tool: 'fresh.list_items' }), /needs sign-in: run `[^`]*login fresh`/); } finally { await e.close(); }
  assert.equal(fs.existsSync(tokenFile('fresh', authd.url)), false);
});

test('middleout login: browser flow with dynamic registration and a localhost callback, then the engine just works', async () => {
  const spec = { type: 'http', url: authd.url };
  // stands in for the browser: follow the authorize redirect to the local callback
  const fakeBrowser = async (url) => { const r = await fetch(url, { redirect: 'manual' }); await fetch(r.headers.get('location')); };
  const r = await login('signin', spec, { open: fakeBrowser, log: () => {} });
  assert.equal(r.tools, 1);
  const saved = JSON.parse(fs.readFileSync(tokenFile('signin', spec.url), 'utf8'));
  assert.equal(saved.client.client_id, 'client-1');
  assert.equal(saved.tokens.access_token, 'access-1');
  const e = createEngine({ servers: { signin: spec } });
  try { assert.equal((await e.run({ tool: 'signin.list_items', page: false, select: 'length(items)' })).result, 5); } finally { await e.close(); }
});

test('middleout login on a server that needs no sign-in says so', async () => {
  const r = await login('open', { type: 'http', url: open.url }, { open: () => { throw new Error('must not open'); }, log: () => {} });
  assert.equal(r.needed, false);
});
