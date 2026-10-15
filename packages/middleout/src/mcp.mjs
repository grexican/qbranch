// MCP server: middleout_tools / middleout_shape / middleout_run over the project's own MCP servers.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig } from './config.mjs';
import { createEngine, PLAN_DOC } from './engine.mjs';
import { upsert, toolStat } from './stats.mjs';

const cfg = loadConfig();
const engine = createEngine(cfg);
const server = new McpServer({ name: 'middleout', version: '0.1.0' });
const text = (t) => ({ content: [{ type: 'text', text: t }] });
const record = (st, ok) => upsert(cfg, (s, day) => {
  s.totals.runs++; day.runs++; if (!ok) s.totals.errors++;
  s.totals.api_calls += st.calls; s.totals.auto_pages += st.autoPages;
  s.totals.raw_bytes += st.rawBytes; day.raw_bytes += st.rawBytes;
  s.totals.returned_bytes += st.returnedBytes || 0; day.returned_bytes += st.returnedBytes || 0;
  for (const [ref, n] of Object.entries(st.byTool)) toolStat(s, ref).via_middleout += n;
});

server.registerTool('middleout_tools', {
  description: 'List the API tools middleout can call for you (from this project\'s MCP servers), with their parameters.',
  inputSchema: {},
}, async () => text((await engine.tools()).map(t => `- ${t.ref}(${t.params.join(', ')}): ${t.description.slice(0, 200)}`).join('\n') || 'no servers configured'));

server.registerTool('middleout_shape', {
  description: 'Call one API tool and return only the SHAPE of its result (field names, types, one short example each), not the data. Use it to learn field names before writing a middleout_run plan.',
  inputSchema: { tool: z.string().describe('"server.tool"'), args: z.record(z.string(), z.any()).optional() },
}, async ({ tool, args }) => {
  try { const { shape, stats } = await engine.shape(tool, args || {}); const out = JSON.stringify(shape, null, 1); record({ ...stats, returnedBytes: out.length }, true); return text(out); }
  catch (e) { return text(`middleout error: ${e.message}`); }
});

server.registerTool('middleout_run', {
  description: 'Fetch exactly the data you need from one or many API calls in ONE step: chained, looped (one-to-many) and nested calls, ' +
    'automatic pagination, and JMESPath projection, so only the fields you select come back. Prefer this over calling API tools one by one, ' +
    'especially for lists, per-item details, and anything paginated.\n' + PLAN_DOC,
  inputSchema: { plan: z.any().describe('A node or an array of nodes (see description)') },
}, async ({ plan }) => {
  try {
    const { result, stats } = await engine.run(plan);
    record(stats, true);
    const ratio = stats.returnedBytes ? (stats.rawBytes / stats.returnedBytes).toFixed(1) : '-';
    return text(`${JSON.stringify(result)}\n\n(middleout: ${stats.calls} API calls${stats.autoPages ? `, ${stats.autoPages} pages auto-fetched` : ''}, ${stats.rawBytes} raw bytes -> ${stats.returnedBytes} returned, Weissman ${ratio})`);
  } catch (e) {
    record({ calls: 0, rawBytes: 0, autoPages: 0, byTool: {}, returnedBytes: 0 }, false);
    return text(`middleout error ${e.message}\n\n${PLAN_DOC}`);
  }
});

await server.connect(new StdioServerTransport());
