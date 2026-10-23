// OAuth for HTTP MCP servers. middleout is its own OAuth client: `middleout login <server>` runs the browser flow once
// (PKCE, dynamic client registration unless .mcp.json gives oauth.clientId, a 127.0.0.1 callback on the port the client was registered with) and stores the tokens
// under ~/.qbranch/middleout/oauth/. At runtime the stored tokens are used and refreshed through the SDK; the runtime
// never opens a browser and never registers a client: when sign-in is needed it says so and stops.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';

export const home = () => process.env.MIDDLEOUT_HOME || path.join(os.homedir(), '.qbranch', 'middleout');
export const tokenFile = (name, url) =>
  path.join(home(), 'oauth', `${name.replace(/[^\w.-]/g, '_')}-${crypto.createHash('sha256').update(url).digest('hex').slice(0, 8)}.json`);

const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

// Every Claude session runs its own middleout process, and the CLI is another: token-file read-modify-writes are
// serialized across processes with a lock file (stale after 5s, so a crashed writer never wedges sign-in).
function locked(f, fn) {
  const l = `${f}.lock`;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  let got = false;
  for (let i = 0; i < 200 && !got; i++) {
    try { fs.writeFileSync(l, String(process.pid), { flag: 'wx' }); got = true; }
    catch {
      try { if (Date.now() - fs.statSync(l).mtimeMs > 5000) fs.rmSync(l, { force: true }); } catch { /* gone already */ }
      const until = Date.now() + 25; while (Date.now() < until) { /* writers hold the lock for microseconds */ }
    }
  }
  try { return fn(); } finally { if (got) fs.rmSync(l, { force: true }); }
}
function write(f, v) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2) + '\n', { mode: 0o600 }); // tokens: owner-only
  fs.renameSync(tmp, f);
}

export class SignInNeeded extends Error {}
export const signInMessage = (name) => `server "${name}" needs sign-in: run \`middleout login ${name}\` once (opens a browser)`;

/** OAuthClientProvider over the token file. interactive=false is the runtime: refresh only, no browser, no registration. */
export function provider(name, spec, { interactive, redirectUrl, onRedirect } = {}) {
  const f = tokenFile(name, spec.url);
  const load = () => read(f) || { url: spec.url };
  const save = (patch) => locked(f, () => write(f, { ...load(), ...patch }));
  let used = null; // the refresh token this process last read: what a refresh it starts will spend
  const fixed = spec.oauth?.clientId ? { client_id: spec.oauth.clientId, ...(spec.oauth.clientSecret ? { client_secret: spec.oauth.clientSecret } : {}) } : null;
  let state;
  return {
    get redirectUrl() { return redirectUrl || load().redirectUrl; },
    get clientMetadata() {
      return { client_name: 'middleout', redirect_uris: [this.redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
        token_endpoint_auth_method: fixed?.client_secret ? 'client_secret_post' : 'none' };
    },
    state() { state = crypto.randomBytes(16).toString('hex'); return state; },
    expectedState: () => state,
    clientInformation: () => fixed || load().client,
    saveClientInformation(client) { if (!interactive) throw new SignInNeeded(signInMessage(name)); save({ client }); },
    tokens() { const t = load().tokens; used = t?.refresh_token ?? null; return t; },
    saveTokens: (tokens) => save({ tokens }),
    redirectToAuthorization(url) { if (!interactive) throw new SignInNeeded(signInMessage(name)); return onRedirect(url); },
    saveCodeVerifier: (verifier) => save({ verifier }),
    codeVerifier: () => load().verifier,
    invalidateCredentials(scope) {
      locked(f, () => {
        const cur = load();
        // a refresh that lost a race to another process (rotating refresh tokens) gets invalid_grant: the tokens on disk
        // are then NEWER than the ones it spent, so keep them; tokens() reads them on the SDK's next attempt
        const newer = cur.tokens && used != null && cur.tokens.refresh_token !== used;
        if (scope === 'all' || scope === 'client') delete cur.client;
        if ((scope === 'all' || scope === 'tokens') && !newer) delete cur.tokens;
        if (scope === 'all' || scope === 'verifier') delete cur.verifier;
        write(f, cur);
      });
    },
  };
}

/** An HTTP server middleout may need to sign in to first: no Authorization header, no stored tokens, and never seen to answer without auth. */
export const maybeNeedsLogin = (name, spec) => {
  if (!spec?.url || Object.keys(spec.headers || {}).some(k => k.toLowerCase() === 'authorization')) return false;
  const r = read(tokenFile(name, spec.url));
  return !r?.tokens && !r?.no_auth;
};

/** Remember (or forget) that a server answers without auth. Best-effort: a hint for nudges and summaries only. */
export function markNoAuth(name, spec, on) {
  try {
    const f = tokenFile(name, spec.url);
    if (!!read(f)?.no_auth === on) return;
    locked(f, () => { const cur = read(f) || { url: spec.url }; if (on) cur.no_auth = true; else delete cur.no_auth; write(f, cur); });
  } catch { /* hint only */ }
}

const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The runtime provider, or null when this server was never signed in (then a 401 is reported, nothing registered). */
export const runtimeProvider = (name, spec) => (read(tokenFile(name, spec.url))?.tokens ? provider(name, spec, { interactive: false }) : null);

export const isAuthError = (e) => e instanceof UnauthorizedError || e instanceof SignInNeeded || e?.code === 401 || /\b401\b|unauthori[sz]ed/i.test(e?.message || '');

export function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref(); } catch { /* the URL is printed too */ }
}

/**
 * Sign in to an HTTP server: returns { needed: false } when it answers without auth, else { needed: true, tools, file }.
 * open(url) is the browser (injectable for tests); the callback listens on oauth.callbackPort, else the port a stored dynamic client registered, else an ephemeral one (then it registers again).
 */
export async function login(name, spec, { open = openBrowser, log = console.log, timeoutMs = 5 * 60_000 } = {}) {
  if (!spec?.url) throw new Error(`server "${name}" is not an HTTP server: nothing to sign in to`);
  let resolveCode, rejectCode;
  const code = new Promise((res, rej) => { resolveCode = res; rejectCode = rej; });
  code.catch(() => {}); // the callback can fail before the flow awaits it: handled where it is awaited, never unhandled
  let p;
  const page = (res, status, html) => { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(`<p>${html}</p>`); };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname !== '/callback') { res.writeHead(404); return res.end(); }
    const err = u.searchParams.get('error');
    const ours = p && u.searchParams.get('state') === p.expectedState();
    // the authorization server said no (the user denied, a bad request): a real answer to our flow, so the login ends
    if (err && ours) { page(res, 400, `Sign-in failed: ${escapeHtml(err)}.`); return rejectCode(new Error(`sign-in failed: ${err}`)); }
    // anything else that is not our flow's answer (too early, forged or stale state) is refused, and we keep waiting
    if (err || !ours || !u.searchParams.get('code')) return page(res, 400, 'This sign-in link is not valid for the current request.');
    page(res, 200, 'middleout is signed in. You can close this tab.');
    resolveCode(u.searchParams.get('code'));
  });
  const file = tokenFile(name, spec.url);
  const stored = read(file);
  // a dynamically registered client is bound to the redirect it registered: come back on the same port when we can
  const storedPort = !spec.oauth?.clientId && stored?.client && stored.redirectUrl ? Number(new URL(stored.redirectUrl).port) || 0 : 0;
  const listen = (port) => new Promise((res, rej) => { srv.once('error', rej); srv.listen(port, '127.0.0.1', () => { srv.off('error', rej); res(); }); });
  if (spec.oauth?.callbackPort) await listen(spec.oauth.callbackPort);
  else { try { await listen(storedPort); } catch { await listen(0); } }
  const redirectUrl = `http://127.0.0.1:${srv.address().port}/callback`;
  if (stored?.client && !spec.oauth?.clientId && !(stored.client.redirect_uris || []).includes(redirectUrl)) {
    // registered for another redirect, which the server would refuse: register again (its tokens go with it)
    locked(file, () => { const cur = read(file) || {}; delete cur.client; delete cur.tokens; delete cur.verifier; write(file, cur); });
  }
  const timer = setTimeout(() => rejectCode(new Error('sign-in timed out')), timeoutMs);
  try {
    p = provider(name, spec, { interactive: true, redirectUrl, onRedirect: async (url) => { log(`Opening the browser to sign in to "${name}":\n  ${url.href}`); await open(url.href); } });
    locked(file, () => write(file, { ...(read(file) || {}), url: spec.url, redirectUrl }));
    const headers = spec.headers || {};
    const first = new StreamableHTTPClientTransport(new URL(spec.url), { authProvider: p, requestInit: { headers } });
    const probe = new Client({ name: 'middleout', version: '0.3.0' });
    try {
      await probe.connect(first);
      await probe.close();
      if (!read(file)?.tokens) { locked(file, () => write(file, { url: spec.url, no_auth: true })); return { needed: false }; }
    } catch (e) {
      if (!isAuthError(e)) throw e;
      await first.finishAuth(await code);
    }
    const c = new Client({ name: 'middleout', version: '0.3.0' });
    await c.connect(new StreamableHTTPClientTransport(new URL(spec.url), { authProvider: p, requestInit: { headers } }));
    const tools = (await c.listTools()).tools.length;
    await c.close();
    log(`signed in to "${name}": ${tools} tools available through middleout`);
    return { needed: true, tools, file: tokenFile(name, spec.url) };
  } finally { clearTimeout(timer); srv.closeAllConnections?.(); srv.close(); }
}
