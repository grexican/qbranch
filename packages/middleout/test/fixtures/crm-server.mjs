#!/usr/bin/env node
// Test fixture: a small CRM MCP server with bloated payloads, page-number pagination, read-only annotations, and one write tool.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const bloat = () => ({ custom_fields: Array.from({ length: 10 }, (_, i) => ({ id: `cf_${i}`, value: 'x'.repeat(40) })), audit: { by: { id: 'u1', name: 'Someone', avatar: 'https://cdn/a.png' } } });
const accounts = [1, 2, 3].map(i => ({ id: `acc_${i}`, name: `Account ${i}`, tier: i === 3 ? 'smb' : 'enterprise', ...bloat() }));
const deals = Array.from({ length: 25 }, (_, i) => ({ id: `deal_${i}`, name: `Deal ${i}`, account_id: `acc_${(i % 3) + 1}`, stage: i % 2 ? 'negotiation' : 'won', amount: (i + 1) * 5000, contact_id: `c_${i % 4}`, ...bloat() }));
const contacts = Object.fromEntries([0, 1, 2, 3].map(i => [`c_${i}`, { id: `c_${i}`, email: `person${i}@example.com`, ...bloat() }]));
const activities = (dealId) => { const n = Number(dealId.split('_')[1]); return Array.from({ length: (n % 4) + 1 }, (_, j) => ({ id: `${dealId}_a${j}`, type: j % 2 ? 'email' : 'call', occurred_at: `2026-10-0${j + 1}`, ...bloat() })); };

const s = new McpServer({ name: 'crm', version: '1.0.0' });
const out = (v) => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });
const RO = { readOnlyHint: true };
s.registerTool('list_accounts', { description: 'List accounts.', inputSchema: { tier: z.string().optional() }, annotations: RO },
  async ({ tier }) => out({ accounts: accounts.filter(a => !tier || a.tier === tier) }));
// paginated: 10 per page, 0-based page numbers, like many ticketing APIs
s.registerTool('list_deals', { description: 'List deals (10 per page).', inputSchema: { stage: z.string().optional(), account_id: z.string().optional(), page: z.number().optional() }, annotations: RO },
  async ({ stage, account_id, page = 0 }) => {
    const all = deals.filter(d => (!stage || d.stage === stage) && (!account_id || d.account_id === account_id));
    const slice = all.slice(page * 10, page * 10 + 10);
    return out({ deals: slice, page, has_more: (page + 1) * 10 < all.length });
  });
s.registerTool('get_contact', { description: 'Get a contact.', inputSchema: { id: z.string() }, annotations: RO }, async ({ id }) => out(contacts[id]));
s.registerTool('list_activities', { description: 'Activities on a deal.', inputSchema: { deal_id: z.string() }, annotations: RO }, async ({ deal_id }) => out(activities(deal_id)));
s.registerTool('delete_deal', { description: 'Delete a deal.', inputSchema: { id: z.string() }, annotations: { destructiveHint: true } }, async () => out({ deleted: true }));
// a chat-style API: the cursor comes back nested and the request parameter has a different name than the response key
const notes = Array.from({ length: 12 }, (_, i) => ({ id: `note_${i}`, text: `Note ${i}` }));
s.registerTool('list_notes', { description: 'List notes (5 per page).', inputSchema: { since_cursor: z.string().optional() }, annotations: RO },
  async ({ since_cursor }) => { const f = since_cursor ? Number(since_cursor) : 0; return out({ ok: true, notes: notes.slice(f, f + 5), response_metadata: { next_cursor: f + 5 < notes.length ? String(f + 5) : '' } }); });
// an API that always claims there is more (to test the page cap)
s.registerTool('list_events', { description: 'Endless events.', inputSchema: { page: z.number().optional() }, annotations: RO },
  async ({ page = 0 }) => out({ events: [{ id: `ev_${page}` }], page, has_more: true }));
await s.connect(new StdioServerTransport());
