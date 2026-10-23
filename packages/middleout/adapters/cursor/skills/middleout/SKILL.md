---
name: middleout
description: Fetch data from this project's MCP servers or JSON APIs without flooding context. Use before calling an API/MCP tool that returns lists, per-item details, paginated results, or nested data (tasks, deals, issues, comments, records), and whenever you would otherwise call a tool once per item.
---

# middleout

Two ways to fetch less. Both return only the fields you select and fetch every page.

**The lens (no setup, any MCP tool, the tool's own sign-in).** Call the tool you were going to call, and add one extra argument, `"_middleout"`. middleout removes it before the server sees it and shapes the result:

```json
{ "stage": "negotiation", "_middleout": { "select": "deals[].{id: id, name: name}" } }
```

- More pages: the result is a one-line instruction ("call again with ... `"_middleout": {"continue": "..."}`"). Follow it exactly, without answering in between, until the merged result comes back.
- Per item: add `"each": {"tool": "get_contact", "args": {"id": "{{cid}}"}, "select": "email", "as": "email"}`. The result lists the calls to issue (in parallel is fine), and the last one returns everything assembled.
- `"then"` reshapes the final result, `"page": false` keeps only the first page, and `"pages": N` raises the cap of 50.
- A big result without `_middleout` comes back compacted, with the path of the full result. Read that file if you need more.
- The lens works where the agent harness can rewrite a tool result: Claude Code, Cursor, Copilot and Codex. Elsewhere, use `middleout_run`.

**`middleout_run` (the power mode).** It runs a whole fetch plan on the server side: chained calls, one-to-many loops, nesting and pagination, in one step. On real APIs it cuts tokens 2-8x for list work and 7-28x for per-item fan-out, with the same answers. It reaches the servers in the project's `.mcp.json`; a server that signs in with OAuth needs `middleout login <server>` once.

## Workflow

1. `middleout_tools` lists the tools you can reach (every tool the project's servers expose, unless the project narrows it).
2. `middleout_shape` calls a tool once and returns field names and types, not data. Do this before you write a `select`, so you use real field names.
3. `middleout_run` runs the plan. Select only what the answer needs. Keep ids if you will fetch more later.

Use the raw tool directly only for writes, or when you truly need the whole payload.

## Recipes

Filter and project one list. Every page is fetched automatically:

```json
{ "tool": "crm.list_deals", "args": { "stage": "negotiation" },
  "select": "[?amount > `50000`].{id: id, name: name, contact: primary_contact_id}" }
```

Fan out per item (one-to-many). Each child's result is attached under its `as` key:

```json
{ "tool": "crm.list_deals", "args": { "stage": "negotiation" }, "select": "[].{id: id, name: name, cid: primary_contact_id}",
  "each": [
    { "as": "email", "tool": "crm.get_contact", "args": { "id": "{{cid}}" }, "select": "email" },
    { "as": "last",  "tool": "crm.list_activities", "args": { "deal_id": "{{id}}" }, "select": "max_by(@, &occurred_at).occurred_at" }
  ] }
```

Nest as deep as the question goes: accounts, then deals, then a count of calls per deal:

```json
{ "tool": "crm.list_accounts", "args": { "tier": "enterprise" }, "select": "[].{id: id, name: name}",
  "each": { "as": "deals", "tool": "crm.list_deals", "args": { "account_id": "{{id}}" }, "select": "[].{id: id, name: name}",
    "each": { "as": "calls", "tool": "crm.list_activities", "args": { "deal_id": "{{id}}" }, "select": "length([?type=='call'])" } } }
```

Aggregate after the children are attached:

```json
{ "tool": "...", "select": "...", "each": { "...": "..." }, "then": "sort_by(@, &calls) | reverse(@)[:5]" }
```

Several independent fetches in one call: pass an array of nodes.

## Pitfalls

- Check the field names with `middleout_shape` first. Similar fields (`created_at` and `occurred_at`) mean different things.
- Pagination is automatic. Do not page by hand. `"page": false` returns only the first page.
- In a child, `{{field}}` is the current element's field and `{{_parent.field}}` is the parent element's.
- JMESPath string literals use single quotes (`'call'`). Number literals use backticks (`` `50000` ``).
- If a server answers "needs sign-in", ask the user to run `middleout login <server>` once, and use the raw tool until then.
- A status filter has to match every value that means what you mean. "Done" can be `done` or `complete`. Check the values with `middleout_shape` or a `select` of the distinct values.
