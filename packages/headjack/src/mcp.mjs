// Optional MCP server, for MCP clients other than Claude Code (or harnesses without skills).
// Same engine as the CLI: headjack_find / headjack_get / headjack_acquire.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig } from './config.mjs';
import { reindex, search, isStrong, load, renderSkill, wasSuggested } from './library.mjs';
import { searchRegistry, searchRegistryByGap, acquire } from './registry.mjs';
import { upsert, skillStat } from './stats.mjs';

const cfg = loadConfig();
const server = new McpServer({ name: 'headjack', version: '0.1.0' });
const text = (t) => ({ content: [{ type: 'text', text: t }] });
const noteLoad = (s, acq) => !s.error && upsert(cfg, (st, day) => {
  st.totals.loads++; day.loaded++; if (acq) st.totals.acquires++;
  const k = skillStat(st, s.id); k.loaded++; k.last_loaded = new Date().toISOString();
  if (wasSuggested(cfg, s.id)) st.totals.suggested_then_loaded++;
});

server.registerTool('headjack_find', {
  description: 'Search the skill library for task-specific instructions (workflows, formats, checklists, domain know-how). Skills are not preloaded; ' +
    'search at the start of any non-trivial task and whenever a request names a skill you do not have. Returns ranked ids; load one with headjack_get.',
  inputSchema: { query: z.string().describe('What you are trying to do, in plain words'), external: z.boolean().optional().describe('Search the public registry directly') },
}, async ({ query, external }) => {
  if (external) {
    upsert(cfg, (s) => { s.totals.external_searches++; });
    return text((await searchRegistry(query, 6)).map(s => `- ${s.id}  (${s.installs} installs)`).join('\n') + '\n\nFetch one with headjack_acquire.');
  }
  await reindex(cfg);
  const local = await search(cfg, query, 6); const strong = isStrong(cfg, local, query);
  let out = local.map(s => `- ${s.id}${s.similarity == null ? '' : `  [sim ${s.similarity}]`}\n  ${s.description.slice(0, 280)}`).join('\n') || '(library is empty)';
  if (!strong && cfg.external) {
    let ext = []; try { ext = await searchRegistryByGap(cfg, query); } catch {}
    out += '\n\nNo strong match in the library. Public registry candidates (unvetted):\n' + (ext.length ? ext.map(s => `- ${s.id}  (${s.installs} installs)`).join('\n') : '(none found)');
  }
  upsert(cfg, (s) => { s.totals.searches++; if (!strong) { s.totals.weak_searches++; s.gaps.push({ at: new Date().toISOString(), q: query.slice(0, 140), registry: [] }); } });
  return text(out);
});

server.registerTool('headjack_get', {
  description: 'Load a skill by id (from headjack_find): returns its full instructions plus paths to supporting files. Follow the instructions.',
  inputSchema: { id: z.string() },
}, async ({ id }) => { await reindex(cfg); const s = load(cfg, id); noteLoad(s, false); return text(renderSkill(s)); });

server.registerTool('headjack_acquire', {
  description: 'Fetch a public-registry skill (owner/repo/skill) into the project library, then load it. Unvetted content: prefer reputable, well-installed sources.',
  inputSchema: { id: z.string() },
}, async ({ id }) => { try { const s = await acquire(cfg, id); noteLoad(s, true); return text(renderSkill(s)); } catch (e) { return text(`acquire failed: ${e.message}`); } });

await server.connect(new StdioServerTransport());
