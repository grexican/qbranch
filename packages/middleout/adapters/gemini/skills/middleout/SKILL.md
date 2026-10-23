---
name: middleout
description: Fetch data from this project's MCP servers or JSON APIs without flooding context. Use before calling an API/MCP tool that returns lists, per-item details, paginated results, or nested data (tasks, deals, issues, comments, records), and whenever you would otherwise call a tool once per item.
---

# middleout

`middleout_run` runs a whole fetch plan on the server side: chained calls, one-to-many loops, nesting and pagination. Only the fields you select come back. On real APIs this cuts tokens 2-8x for list work and 7-28x for per-item fan-out, with the same answers.

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
