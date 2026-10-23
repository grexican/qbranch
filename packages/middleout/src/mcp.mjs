// MCP server: middleout_tools / middleout_shape / middleout_run over the project's own MCP servers.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig } from './config.mjs';
import { createEngine, PLAN_DOC } from './engine.mjs';
import { recordRun } from './stats.mjs';
import { planTools } from './plan.mjs';

const cfg = loadConfig();
const engine = createEngine(cfg);
const server = new McpServer({ name: 'middleout', version: '0.3.0' });
const text = (t) => ({ content: [{ type: 'text', text: t }] });
const EMPTY = { calls: 0, rawBytes: 0, autoPages: 0, byTool: {}, returnedBytes: 0 };

server.registerTool('middleout_tools', {
  description: 'List the API tools middleout can call for you (from this project\'s MCP servers), with their parameters.',
  inputSchema: {},
  annotations: { title: 'List wrapped API tools', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => {
  const { tools, failed } = await engine.toolsReport();
  const lines = tools.map(t => `- ${t.ref}(${t.params.join(', ')}): ${t.description.slice(0, 200)}`);
  for (const f of failed) lines.push(`- ${f.server}: unavailable (${f.error})`);
  for (const [name, why] of Object.entries(cfg.skipped || {})) if (why !== 'it is middleout itself') lines.push(`- ${name}: not wrapped (${why})`);
  return text(lines.join('\n') || 'no servers configured');
});

server.registerTool('middleout_shape', {
  description: 'Call one API tool and return only the SHAPE of its result (field names, types, one short example each), not the data. Use it to learn field names before writing a middleout_run plan.',
  inputSchema: { tool: z.string().describe('"server.tool"'), args: z.record(z.string(), z.any()).optional() },
  // middleout is a pass-through: it is exactly as safe as the tool the plan names, so it claims nothing stronger
  annotations: { title: 'Sample an API result shape', readOnlyHint: cfg.readonly === true, destructiveHint: cfg.readonly !== true, idempotentHint: false, openWorldHint: true },
}, async ({ tool, args }) => {
  try { const { shape, stats } = await engine.shape(tool, args || {}); const out = JSON.stringify(shape, null, 1); recordRun(cfg, { ...stats, returnedBytes: out.length }); return text(out); }
  catch (e) { recordRun(cfg, EMPTY, { ok: false, error: e.message, tools: [tool] }); return text(`middleout error: ${e.message}`); }
});

server.registerTool('middleout_run', {
  description: 'Fetch exactly the data you need from one or many API calls in ONE step: chained, looped (one-to-many) and nested calls, ' +
    'automatic pagination, and JMESPath projection, so only the fields you select come back. Prefer this over calling API tools one by one, ' +
    'especially for lists, per-item details, and anything paginated.\n' + PLAN_DOC,
  inputSchema: { plan: z.any().describe('A node or an array of nodes (see description)') },
  annotations: { title: 'Run a fetch plan', readOnlyHint: cfg.readonly === true, destructiveHint: cfg.readonly !== true, idempotentHint: false, openWorldHint: true },
}, async ({ plan }) => {
  try {
    const { result, stats } = await engine.run(plan);
    recordRun(cfg, stats);
    const ratio = stats.returnedBytes ? (stats.rawBytes / stats.returnedBytes).toFixed(1) : '-';
    return text(`${JSON.stringify(result)}\n\n(middleout: ${stats.calls} API calls${stats.autoPages ? `, ${stats.autoPages} pages auto-fetched` : ''}, ${stats.rawBytes} raw bytes -> ${stats.returnedBytes} returned, Weissman ${ratio})`);
  } catch (e) {
    recordRun(cfg, EMPTY, { ok: false, error: e.message, tools: planTools(plan) });
    return text(`middleout error ${e.message}\n\n${PLAN_DOC}`);
  }
});

await server.connect(new StdioServerTransport());
