// Project root + config. middleout.config.json at the project root (all keys optional). Without "servers",
// middleout wraps the stdio MCP servers the project's own .mcp.json already declares.
import fs from 'node:fs';
import path from 'node:path';
import { projectRoot as coreRoot } from '@qbranch/core';

export const projectRoot = (start) => coreRoot(['middleout.config.json'], start);

export const DEFAULTS = {
  servers: null,      // { name: {command, args, env} }; null = the stdio servers in .mcp.json
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
  if (!cfg.servers) {
    cfg.servers = {};
    try {
      const m = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8')).mcpServers || {};
      for (const [name, s] of Object.entries(m)) if (s.command && name !== 'middleout') cfg.servers[name] = { command: s.command, args: s.args || [], env: s.env };
    } catch { /* no .mcp.json */ }
  }
  if (process.env.MIDDLEOUT_STATS === '0') cfg.stats = false;
  return cfg;
}
