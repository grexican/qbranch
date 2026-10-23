// Test fixture: an MCP server over Streamable HTTP on an ephemeral port. Three flavours:
//   open           no auth
//   { token }      requires "Authorization: Bearer <token>" (a static header, e.g. from an env var)
//   { oauth: true} a minimal OAuth authorization server next to it (metadata, dynamic registration, authorize, token
//                  with refresh); /mcp accepts only tokens it issued
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const items = Array.from({ length: 12 }, (_, i) => ({ id: `item_${i}`, name: `Item ${i}`, notes: 'x'.repeat(200) }));
const out = (v) => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });

function mcp() {
  const s = new McpServer({ name: 'web', version: '1.0.0' });
  s.registerTool('list_items', { description: 'List items (5 per page).', inputSchema: { page: z.number().optional() }, annotations: { readOnlyHint: true } },
    async ({ page = 0 }) => out({ items: items.slice(page * 5, page * 5 + 5), page, has_more: (page + 1) * 5 < items.length }));
  return s;
}

const send = (res, status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => resolve(b)); });

export async function startHttpFixture({ token = null, oauth = false } = {}) {
  const valid = new Set(token ? [token] : []);
  let base = '';
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, base);
    if (oauth && u.pathname === '/.well-known/oauth-authorization-server') {
      return send(res, 200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`,
        response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'] });
    }
    if (oauth && u.pathname === '/register') {
      const meta = JSON.parse(await readBody(req));
      return send(res, 201, { ...meta, client_id: 'client-1', client_id_issued_at: Math.floor(Date.now() / 1000) });
    }
    if (oauth && u.pathname === '/authorize') { // the user "approves" instantly
      const to = new URL(u.searchParams.get('redirect_uri'));
      to.searchParams.set('code', 'code-1'); to.searchParams.set('state', u.searchParams.get('state') || '');
      res.writeHead(302, { Location: to.href }); return res.end();
    }
    if (oauth && u.pathname === '/token') {
      const f = new URLSearchParams(await readBody(req));
      let access = null;
      if (f.get('grant_type') === 'authorization_code' && f.get('code') === 'code-1') access = 'access-1';
      if (f.get('grant_type') === 'refresh_token' && f.get('refresh_token') === 'refresh-1') access = 'access-2';
      if (!access) return send(res, 400, { error: 'invalid_grant' });
      valid.add(access);
      return send(res, 200, { access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: 'refresh-1' });
    }
    if (u.pathname !== '/mcp') return send(res, 404, { error: 'not found' });
    if (token || oauth) {
      const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!valid.has(got)) { res.writeHead(401, { 'WWW-Authenticate': 'Bearer' }); return res.end('unauthorized'); }
    }
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const s = mcp();
    res.on('close', () => { t.close(); s.close(); });
    await s.connect(t);
    await t.handleRequest(req, res);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
  return { url: `${base}/mcp`, base, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }) };
}
