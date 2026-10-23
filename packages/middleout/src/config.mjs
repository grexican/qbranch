// Project root + config. middleout.config.json at the project root (all keys optional). Without "servers",
// middleout wraps the MCP servers the project's own .mcp.json already declares: stdio, Streamable HTTP and SSE.
import fs from 'node:fs';
import path from 'node:path';
import { projectRoot as coreRoot } from '@qbranch/core';

export const projectRoot = (start) => coreRoot(['middleout.config.json'], start);

export const DEFAULTS = {
  servers: null,      // { name: {command, args, env} | {type: 'http'|'sse', url, headers?, oauth?} }; null = the servers in .mcp.json
  readonly: false,    // true = expose only tools the server itself annotates readOnlyHint (few servers do; see README)
  allow: null,        // optional regex on "server.tool"
  concurrency: 8,     // parallel calls inside an "each"
  mode: 'nudge',      // hook behavior on raw MCP calls to wrapped servers: off | nudge | gate
  nudgeBytes: 8000,   // nudge when a raw result is bigger than this
  stats: '.middleout-stats.json',
};

export function loadConfig(root = projectRoot()) {
  let user = {};
  const f = path.join(root, 'middleout.config.json');
  if (fs.existsSync(f)) user = JSON.parse(fs.readFileSync(f, 'utf8'));
  const cfg = { ...DEFAULTS, ...user, root };
  cfg.skipped = {};   // .mcp.json entries not wrapped, with the reason (shown when a plan names one)
  if (!cfg.servers) {
    cfg.servers = {};
    let m = {};
    try { m = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8')).mcpServers || {}; } catch { /* no .mcp.json */ }
    for (const [name, s] of Object.entries(m)) {
      if (name === 'middleout' || /middleout/.test(String(s.args || ''))) { cfg.skipped[name] = 'it is middleout itself'; continue; }
      const r = toServer(s);
      if (r.server) cfg.servers[name] = r.server; else cfg.skipped[name] = r.why;
    }
  } else {
    for (const [name, s] of Object.entries(cfg.servers)) { const r = toServer(s); if (r.server) cfg.servers[name] = r.server; else { delete cfg.servers[name]; cfg.skipped[name] = r.why; } }
  }
  if (process.env.MIDDLEOUT_STATS === '0') cfg.stats = false;
  return cfg;
}

// ${VAR} and ${VAR:-default}, the .mcp.json convention. An unset variable with no default becomes ''.
export const expandEnv = (v) => (typeof v === 'string' ? v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, k, d) => process.env[k] ?? d ?? '') : v);

// The values ${VAR} expanded to in a URL or header are secrets (API keys, tokens): remembered so scrub() can redact them.
const secretsOf = (...templates) => templates.flatMap(t => (typeof t === 'string' ? [...t.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g)] : []))
  .map(m => process.env[m[1]]).filter(v => v && v.length >= 4);

/** One .mcp.json / config entry -> { server } or { why } it cannot be wrapped. */
export function toServer(s) {
  if (!s || typeof s !== 'object') return { why: 'not an object' };
  if (s.command) return { server: { command: expandEnv(s.command), args: (s.args || []).map(expandEnv), env: s.env && Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, expandEnv(v)])) } };
  if (s.url) {
    const type = s.type || 'http';
    if (!['http', 'streamable-http', 'sse'].includes(type)) return { why: `transport "${type}" is not supported (middleout speaks stdio, http and sse)` };
    const server = { type: type === 'sse' ? 'sse' : 'http', url: expandEnv(s.url) };
    if (s.headers) server.headers = Object.fromEntries(Object.entries(s.headers).map(([k, v]) => [k, expandEnv(v)]));
    if (s.oauth) server.oauth = s.oauth;
    // not enumerable: never serialized, never compared, only read by scrub()
    Object.defineProperty(server, 'secrets', { value: secretsOf(s.url, ...Object.values(s.headers || {})) });
    return { server };
  }
  return { why: 'it has neither "command" nor "url"' };
}

/**
 * Make a message safe to show, log or store: known secret values become ***, and every URL loses its user info and
 * query string (where API keys usually ride). Errors end up in the stats file at the project root.
 */
export function scrub(text, secrets = []) {
  let out = String(text ?? '');
  for (const v of secrets) if (v) out = out.split(v).join('***');
  return out.replace(/(https?:\/\/)(?:[^\s/@"'`<>]+@)?([^\s?#"'`<>]+)(\?[^\s#"'`<>)]*)?/gi, (_, scheme, rest, q) => `${scheme}${rest}${q ? '?…' : ''}`);
}
