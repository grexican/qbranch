#!/usr/bin/env node
// middleout CLI: run the MCP server, run plans from the shell, read stats, and serve the hooks.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { createEngine } from '../src/engine.mjs';
import { summarize } from '../src/stats.mjs';
import { login } from '../src/oauth.mjs';
import { post, pre } from '../src/hook.mjs';
import { runHook } from '@qbranch/core/hooks';
import { withBinaryNote, refreshLatest } from '@qbranch/core/binary';

const [cmd, ...rest] = process.argv.slice(2);
const cfg = loadConfig();

const HELP = `middleout: API calls, compressed. Only the fields you asked for reach the model.

  middleout init                 write middleout.config.json (wrapping this project's .mcp.json servers: stdio, http, sse)
  middleout servers              list the wrapped servers and the tools exposed through middleout (and any that failed)
  middleout login <server>       sign in to an OAuth HTTP server once (opens a browser; tokens in ~/.qbranch/middleout)
  middleout run '<plan json>'    run a plan from the shell and print the result + compression
  middleout stats [--json]       usage + savings (Weissman score) from .middleout-stats.json
  middleout mcp                  run the MCP server (middleout_tools / middleout_shape / middleout_run)
  middleout hook post|pre        PostToolUse / PreToolUse hooks (hook JSON on stdin; --platform claude|codex|cursor|copilot|gemini|windsurf)`;

async function main() {
  if (!['hook', 'mcp'].includes(cmd) && (rest.includes('--help') || rest.includes('-h'))) return console.log(HELP);
  switch (cmd) {
    case 'refresh-latest': return void (await refreshLatest()); // spawned in the background by the session hook
    case 'init': {
      const f = path.join(cfg.root, 'middleout.config.json');
      if (fs.existsSync(f)) return console.log(`${f} already exists`);
      fs.writeFileSync(f, JSON.stringify({ readonly: true, mode: 'nudge', nudgeBytes: 8000 }, null, 2) + '\n');
      return console.log(`wrote ${f}\nwrapping (from .mcp.json): ${Object.keys(cfg.servers).join(', ') || 'none yet: add "servers" or a .mcp.json'}`);
    }
    case 'servers': {
      const e = createEngine(cfg);
      try {
        const { tools, failed } = await e.toolsReport();
        for (const t of tools) console.log(`- ${t.ref}(${t.params.join(', ')})`);
        for (const f of failed) console.log(`! ${f.server}: ${f.error}`);
        for (const [n, why] of Object.entries(cfg.skipped)) console.log(`  ${n}: not wrapped (${why})`);
      } finally { await e.close(); }
      return;
    }
    case 'login': {
      const name = rest[0];
      if (!name || !cfg.servers[name]) {
        const http = Object.keys(cfg.servers).filter(n => cfg.servers[n].url);
        throw new Error(`usage: middleout login <server>${http.length ? ` (HTTP servers here: ${http.join(', ')})` : ' (no HTTP servers in this project)'}`);
      }
      const r = await login(name, cfg.servers[name]);
      if (!r.needed) console.log(`"${name}" answered without sign-in: nothing to do`);
      return;
    }
    case 'run': {
      const e = createEngine(cfg);
      try {
        const { result, stats } = await e.run(rest.join(' '));
        console.log(JSON.stringify(result, null, 2));
        console.error(`(${stats.calls} calls, ${stats.rawBytes} raw bytes -> ${stats.returnedBytes} returned)`);
      } finally { await e.close(); }
      return;
    }
    case 'stats': {
      let s; try { s = JSON.parse(fs.readFileSync(path.join(cfg.root, cfg.stats || '.middleout-stats.json'), 'utf8')); } catch { return console.log('no stats yet'); }
      return console.log(rest.includes('--json') ? JSON.stringify(s, null, 2) : summarize(s, cfg));
    }
    case 'hook': return runHook((h) => (rest[0] === 'session' ? withBinaryNote(h, null, { tool: 'middleout' }) : rest[0] === 'pre' ? pre(cfg, h) : post(cfg, h)), rest.slice(1));
    case 'mcp': return import('../src/mcp.mjs');
    default: console.log(HELP);
  }
}

main().catch((e) => { console.error(`middleout: ${e.message}`); process.exitCode = cmd === 'hook' ? 0 : 1; });
