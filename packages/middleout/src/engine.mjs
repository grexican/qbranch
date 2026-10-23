// The engine: run declarative, hierarchical fetch plans against downstream MCP servers (and plain JSON HTTP APIs)
// server-side, and hand the model only what it selected. Usable as a library from any agent runtime.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { runtimeProvider, isAuthError, signInMessage, markNoAuth } from './oauth.mjs';
import { scrub } from './config.mjs';
import jmespath from 'jmespath';

export const PLAN_DOC = `A plan is a node, or an array of independent nodes (results come back as an array).
A node is {tool, args?, select?, each?, as?, then?, page?} (or {http: "GET https://...", ...} for a plain JSON API).
- tool: "server.tool" (or just "tool" when there is one server). args may contain {{jmespath}} templates evaluated against the current item.
- select: JMESPath applied to the tool's result. Keep only what you need, e.g. "tasks[?status=='open'].{id: id, name: name}".
- each: child node(s) run once per element of the selected array, in parallel; each child's result is attached to the element under its "as" key.
  Inside a child, {{field}} is the element's field and {{_parent.field}} the parent element's. Nest as deep as needed.
- then: JMESPath applied after children are attached: sort, filter, reshape, aggregate (length(), sum(), max_by(), sort_by(), ...).
- Pagination is automatic: when a result says there is more (next_page, has_more + page, or a cursor field), every page is fetched and the item array merged, in the normal shape. "page": false returns only the first page.`;

const CURSOR_KEYS = ['next_cursor', 'nextCursor', 'next_page_token', 'nextPageToken'];
const PARAM_FOR = { next_cursor: 'cursor', nextCursor: 'cursor', next_page_token: 'page_token', nextPageToken: 'pageToken' };

const hasAuthHeader = (h) => Object.keys(h || {}).some(k => k.toLowerCase() === 'authorization');

/** Connect one HTTP server: Streamable HTTP first, SSE as the fallback for older servers. Auth failures never fall back. */
async function connectHttp(name, spec) {
  const requestInit = { headers: spec.headers || {} };
  const authProvider = hasAuthHeader(spec.headers) ? undefined : runtimeProvider(name, spec) || undefined;
  const authFail = (e) => new Error(hasAuthHeader(spec.headers)
    ? `server "${name}" rejected its configured credentials (401): check the Authorization header in .mcp.json and the env var it reads`
    : `${signInMessage(name)}${authProvider ? ' (the stored sign-in was rejected and could not be refreshed)' : ''}`, { cause: e });
  const attempt = async (Transport) => {
    const c = new Client({ name: 'middleout', version: '0.3.0' });
    const t = new Transport(new URL(spec.url), { requestInit, authProvider });
    // a failed connect must not leave the transport's retry timer behind: it would keep a CLI run from ever exiting
    try { await c.connect(t); } catch (e) { try { await t.close(); } catch { /* already down */ } throw e; }
    return c;
  };
  // remember a server that answers without any auth, so nudges stop suggesting a sign-in it does not need
  const opened = (c) => { if (!authProvider && !hasAuthHeader(spec.headers)) markNoAuth(name, spec, true); return c; };
  const denied = (e) => { markNoAuth(name, spec, false); return authFail(e); };
  if (spec.type === 'sse') { try { return opened(await attempt(SSEClientTransport)); } catch (e) { throw isAuthError(e) ? denied(e) : e; } }
  try { return opened(await attempt(StreamableHTTPClientTransport)); } catch (e) {
    if (isAuthError(e)) throw denied(e);
    try { return opened(await attempt(SSEClientTransport)); } catch (e2) {
      if (isAuthError(e2)) throw denied(e2);
      throw new Error(`server "${name}" (${spec.url}) did not connect: ${e.message}`, { cause: e });
    }
  }
}

/** createEngine({servers, skipped, readonly, allow, concurrency}) -> { tools(), toolsReport(), shape(tool,args), run(plan), close() } */
export function createEngine({ servers = {}, skipped = {}, readonly = false, allow = null, concurrency = 8 } = {}) {
  const clients = {}; const readOnly = {};
  // every message that leaves the engine is scrubbed: errors are shown to the model and kept in the stats file
  const secrets = Object.values(servers).flatMap(s => s?.secrets || []);
  const safe = (e) => new Error(scrub(e?.message ?? e, secrets), { cause: e });
  const allowRe = allow ? new RegExp(allow) : null;
  const allowed = (srv, tool) => (!allowRe || allowRe.test(`${srv}.${tool}`)) && (!readonly || readOnly[`${srv}.${tool}`] === true);

  async function client(name) {
    if (!servers[name]) {
      const have = Object.keys(servers).join(', ') || 'none';
      throw new Error(`unknown server "${name}" (wrapped: ${have}). ` + (skipped[name]
        ? `"${name}" is in .mcp.json but was skipped: ${skipped[name]}.`
        : `"${name}" is not in this project's .mcp.json (plugin and user-scope servers are not wrapped; add it under "servers" in middleout.config.json), so call its tools directly.`));
    }
    clients[name] ??= (async () => {
      const spec = servers[name];
      let c;
      if (spec.url) c = await connectHttp(name, spec);
      else {
        c = new Client({ name: 'middleout', version: '0.3.0' });
        await c.connect(new StdioClientTransport({ ...spec, env: { ...process.env, ...(spec.env || {}) }, stderr: 'ignore' }));
      }
      for (const t of (await c.listTools()).tools) readOnly[`${name}.${t.name}`] = t.annotations?.readOnlyHint === true;
      return c;
    })();
    clients[name].catch(() => { delete clients[name]; }); // a failed connect is retried next time, not cached
    return clients[name];
  }

  function newStats() { return { calls: 0, rawBytes: 0, autoPages: 0, byTool: {} }; }

  async function callTool(st, ref, args) {
    const [srv, tool] = ref.includes('.') ? ref.split(/\.(.*)/s) : [Object.keys(servers)[0], ref];
    const c = await client(srv); // connect first: read-only annotations are loaded on connect
    if (!allowed(srv, tool)) throw new Error(`${srv}.${tool} is not available through middleout${readonly ? ' (read-only mode)' : ''}`);
    const r = await c.callTool({ name: tool, arguments: args });
    const text = r.content?.map(x => x.text || '').join('') || '';
    st.calls++; st.rawBytes += text.length;
    const bt = (st.byTool[`${srv}.${tool}`] ??= { calls: 0, rawBytes: 0 }); bt.calls++; bt.rawBytes += text.length;
    if (r.isError) throw new Error(`${srv}.${tool}: ${text.slice(0, 300)}`);
    try { return JSON.parse(text); } catch { return text; }
  }

  async function callHttp(st, spec) {
    const [method, url] = spec.includes(' ') ? spec.split(/\s+/, 2) : ['GET', spec];
    const r = await fetch(url, { method, headers: { 'User-Agent': 'middleout', Accept: 'application/json' } });
    const text = await r.text(); st.calls++; st.rawBytes += text.length;
    const bt = (st.byTool[`http.${new URL(url).host}`] ??= { calls: 0, rawBytes: 0 }); bt.calls++; bt.rawBytes += text.length;
    if (!r.ok) throw new Error(`${method} ${url} -> ${r.status} ${text.slice(0, 200)}`);
    return JSON.parse(text);
  }

  // Small models forget pagination or start at page 1; doing it here removes the whole failure class.
  async function callAuto(st, tool, args) {
    const first = await callTool(st, tool, args);
    if (!first || typeof first !== 'object' || Array.isArray(first)) return first;
    const arrKeys = Object.keys(first).filter(k => Array.isArray(first[k]));
    if (arrKeys.length !== 1) return first;
    const key = arrKeys[0]; const items = [...first[key]]; let r = first;
    for (let i = 0; i < 50; i++) {
      const ck = CURSOR_KEYS.find(k => r[k]);
      let next;
      if (ck) next = { ...args, [PARAM_FOR[ck]]: r[ck] };
      else if (r.next_page != null) next = { ...args, page: r.next_page };
      else if (r.has_more === true && typeof r.page === 'number') next = { ...args, page: r.page + 1 };
      else break;
      r = await callTool(st, tool, next); st.autoPages++;
      items.push(...(r?.[key] || []));
    }
    return r === first ? first : { ...first, [key]: items, has_more: false, next_page: null };
  }

  // {{expr}} templates; a whole-string template keeps its type. LLMs often send "" for optional params: drop them.
  function fill(v, scope) {
    if (typeof v === 'string') {
      const whole = v.match(/^\{\{\s*(.+?)\s*\}\}$/);
      if (whole) return jmespath.search(scope, whole[1]);
      return v.replace(/\{\{\s*(.+?)\s*\}\}/g, (_, e) => String(jmespath.search(scope, e) ?? ''));
    }
    if (Array.isArray(v)) return v.map(x => fill(x, scope));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, scope)]).filter(([, x]) => x !== ''));
    return v;
  }

  async function pool(items, fn) {
    const out = new Array(items.length); let i = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
    return out;
  }

  async function runNode(st, node, scope, at) {
    try {
      let v = node.http ? await callHttp(st, fill(node.http, scope))
        : node.page === false ? await callTool(st, node.tool, fill(node.args || {}, scope))
        : await callAuto(st, node.tool, fill(node.args || {}, scope));
      if (node.select) v = jmespath.search(v, node.select);
      const kids = node.each ? [].concat(node.each) : [];
      if (kids.length) {
        if (!Array.isArray(v)) throw new Error(`"each" needs the selected value to be an array, got ${v === null ? 'null' : typeof v}`);
        v = await pool(v, async (el, i) => {
          const obj = el && typeof el === 'object' ? { ...el } : { value: el };
          for (const k of kids) obj[k.as || 'children'] = await runNode(st, k, { ...obj, _parent: scope }, `${at}[${i}].${k.as || 'children'}`);
          return obj;
        });
      }
      if (node.then) v = jmespath.search(v, node.then);
      return v;
    } catch (e) { throw new Error(e.message.startsWith('at ') ? e.message : `at ${at}: ${e.message}`); }
  }

  function shapeOf(v, depth = 0) {
    if (Array.isArray(v)) return v.length ? [`array(${v.length}) of`, shapeOf(v[0], depth + 1)] : 'array(0)';
    if (v && typeof v === 'object') return depth > 3 ? 'object' : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shapeOf(x, depth + 1)]));
    if (typeof v === 'string') return `string e.g. ${JSON.stringify(v.slice(0, 28))}`;
    return v === null ? 'null' : `${typeof v} e.g. ${v}`;
  }

  return {
    /** Every tool from every server that connects, plus the servers that did not and why. */
    async toolsReport() {
      const tools = [], failed = [];
      await Promise.all(Object.keys(servers).map(async (name) => {
        try {
          for (const t of (await (await client(name)).listTools()).tools)
            if (allowed(name, t.name)) tools.push({ ref: `${name}.${t.name}`, params: Object.keys(t.inputSchema?.properties || {}), description: t.description || '' });
        } catch (e) { failed.push({ server: name, error: safe(e).message }); }
      }));
      const order = Object.keys(servers);
      tools.sort((a, b) => order.indexOf(a.ref.split('.')[0]) - order.indexOf(b.ref.split('.')[0]));
      return { tools, failed };
    },
    async tools() { return (await this.toolsReport()).tools; },
    /** Shape (field names, types, one example) of a tool's result: learn field names before writing a plan. */
    async shape(tool, args = {}) {
      const st = newStats();
      try { return { shape: shapeOf(await callAuto(st, tool, args)), stats: st }; } catch (e) { throw safe(e); }
    },
    /** Run a plan. Returns { result, stats: {calls, rawBytes, autoPages, byTool, returnedBytes} }. */
    async run(plan) {
      const st = newStats();
      let result;
      try {
        const p = typeof plan === 'string' ? JSON.parse(plan) : plan;
        result = Array.isArray(p) ? await Promise.all(p.map((n, i) => runNode(st, n, {}, `plan[${i}]`))) : await runNode(st, p, {}, 'plan');
      } catch (e) { throw safe(e); }
      st.returnedBytes = JSON.stringify(result ?? null).length;
      return { result, stats: st };
    },
    async close() { for (const c of Object.values(clients)) { try { await (await c).close(); } catch { /* never connected */ } } },
  };
}
