<p align="center"><img src="docs/middleout-hero.svg" alt="middleout: API calls, compressed" width="100%"></p>

**middleout** sits between an agent and its MCP servers. The agent no longer calls a tool once per item and reads every bloated payload. It writes one small plan, and middleout runs that plan on the server side: chained calls, one-to-many fan-out, nesting and automatic pagination. Only the fields the agent selected come back.

The name comes from *Silicon Valley*, whose fictional compression algorithm worked "middle-out". middleout's stats file reports a **Weissman score**: raw bytes in ÷ bytes handed to the model.

<p align="center"><a href="#install">Install</a> · <a href="#how-it-works">How it works</a> · <a href="#configure">Configure</a> · <a href="#is-it-working-middleout-stats">Stats</a> · <a href="#when-you-do-not-need-it">When not to use it</a></p>

## Why

API payloads are built for apps, not for context windows. A ticket-detail call returns the description twice. A list call drags along avatars, audit metadata and custom fields. Ask "who opened the tickets in this queue?" and an agent makes 37 detail calls and reads every one of them.

Tested against a production ticketing system's MCP server (read-only, ground truth computed separately):

| Question | Opus: raw MCP | Opus: middleout |
|---|---|---|
| Who created each of 37 tickets in a queue? (37 detail fetches) | $1.31 | **$0.17** |
| Total + per-assignee counts over 160 tickets (2 pages) | $0.48 | $0.25 |
| Ticket and resolved counts across 4 queues | $0.84 | $0.40 |

All answers were correct both ways. On a synthetic CRM with three-level nesting, raw MCP cost $2.42 with a 303k-token peak context; middleout cost $0.17 with a 33k peak. Smaller models struggle with raw API mechanics: Haiku went from 0/3 to 3/6 on the live tasks once middleout handled pagination and junk arguments for it.

## How it works

It is a combination, shipped as one Claude Code plugin:

| Piece | Role |
|---|---|
| **Tool** (MCP server) | `middleout_tools`, `middleout_shape`, `middleout_run`. It wraps the stdio MCP servers in your project's `.mcp.json` (no config needed), or the ones you list. |
| **Skill** | How to write plans: recipes for projection, fan-out, nesting and aggregation, plus the pitfalls. |
| **Hook** | Watches every raw MCP call. It measures the payload, and when a big result came from a server middleout wraps, it tells the agent to fetch through middleout next time. In `gate` mode it blocks the first raw call to a wrapped server per session (useful for small models). |
| **Stats** | Upserts `.middleout-stats.json`: calls, bytes in and out, the Weissman score, tokens kept out of context, and the raw traffic that bypassed middleout. |

A plan looks like this:

```json
{ "tool": "crm.list_accounts", "args": { "tier": "enterprise" }, "select": "accounts[].{id: id, name: name}",
  "each": { "as": "deals", "tool": "crm.list_deals", "args": { "account_id": "{{id}}" }, "select": "deals[].{id: id, name: name}",
    "each": { "as": "calls", "tool": "crm.list_activities", "args": { "deal_id": "{{id}}" }, "select": "length([?type=='call'])" } } }
```

`select` and `then` are [JMESPath](https://jmespath.org). `{{field}}` templates read the current item. `{{_parent.field}}` reads its parent.

## What middleout does for the agent

It handles the API mechanics that small models get wrong:

- **Pagination is automatic.** `next_page`, `has_more` + `page`, and cursor fields are followed, and the pages are merged into the normal shape. (Haiku used 1-based pages on a 0-based API, and forgot to paginate.)
- **Empty-string arguments are dropped.** Models send `""` for optional params, and APIs reject them.
- **Fan-out runs in parallel** with a concurrency cap.
- **Errors name the node that failed** (`at plan[0].deals[3].calls: ...`), so the agent can fix the plan.

## What it will call, and what that means

middleout wraps **every** tool your servers expose. It is a pass-through: a plan can call anything a raw MCP call could, including a POST that is really a search, which is common and which a read-only filter would wrongly exclude.

Two consequences worth knowing:

- **A plan runs under one approval.** Your agent is prompted once for `middleout_run`, and the plan may then make many calls. A fan-out over 100 items is 100 calls. That is the point of the tool, and it is why middleout's own annotations do not claim to be read-only: it is exactly as safe as the tools the plan names.
- **Narrow it when you want to.** `allow` (a regex on `server.tool`) limits middleout to the tools you list. `"readonly": true` restricts it to tools their own server annotates `readOnlyHint` — accurate when servers set that hint, but most do not, so it is off by default.

## Install

<!-- generated:install (by scripts/sync.mjs from scripts/platforms.mjs; edit those, not this block) -->
**Claude Code**: one marketplace for every Q Branch gadget; install only the ones you want.

```bash
claude plugin marketplace add grexican/qbranch
claude plugin install middleout@qbranch        # add -s project to share it with your team
```

**Any other agent**: one command from a clone (Node 22.13+). It copies the skills, merges the hooks and MCP config into the project, and is safe to re-run; `--uninstall` removes exactly what it added.

```bash
git clone https://github.com/grexican/qbranch
node qbranch/packages/middleout/dist/install.mjs --platform cursor --project .   # or: claude, codex, gemini, copilot, windsurf
```

Native packages are in [`adapters/`](adapters/): a Cursor plugin, a Codex plugin and a Gemini CLI extension. Copilot reads the Claude plugin marketplace directly. No Node on the machine? Use the `qbranch` native binary ([how](../../README.md#no-node-native-binary)).

| Platform | What works |
|---|---|
| Claude Code | everything |
| GitHub Copilot (CLI, VS Code) | everything |
| Cursor | everything |
| OpenAI Codex | everything |
| Gemini CLI | everything |
| Windsurf / Devin | no post-call measurement and nudges; MCP server goes in your user-level mcp_config.json |
<!-- /generated:install -->

## Configure

In a project with a `.mcp.json`, that is all: middleout wraps its stdio servers. To customize, run `middleout init` and edit `middleout.config.json`:

```json
{
  "servers": { "tickets": { "command": "node", "args": ["./mcp/tickets-server.mjs"] } },
  "readonly": false,
  "allow": null,
  "mode": "nudge",
  "nudgeBytes": 8000,
  "concurrency": 8,
  "stats": ".middleout-stats.json"
}
```

`mode`: `off` (measure only), `nudge` (default), or `gate`. HTTP MCP servers whose OAuth Claude Code holds are not wrapped yet; wrap a stdio bridge to them instead.

## Is it working? `middleout stats`

```
middleout stats since 2026-10-14 (updated 2026-10-14 07:47)
runs 3 | API calls through middleout 15 | auto-fetched pages 6 | errors 0
raw 67 KB -> returned 1 KB | Weissman score 55.1 | ~19235 tokens kept out of context
raw MCP calls that bypassed middleout: 0 (0 KB) | nudges 0 | gated 0
```

"Bypassed" is the honest number. If it stays high, agents are reading raw payloads anyway: switch to `gate`, or check the skill. The biggest raw callers are listed as candidates. Commit the file to track a team, or `.gitignore` it. `"stats": false` (or `MIDDLEOUT_STATS=0`) turns it off.

## When you do not need it

Inside Claude Code with a strong model, writing a quick script against the API ("code mode") was about as cheap in our tests, and Claude Code already spills huge single results to disk. middleout earns its place with **per-item fan-out over chatty APIs**, with **smaller models**, and in **deployed agents** that have no code sandbox. There, a declarative plan is safer than running model-written code.

## Other agent runtimes

```js
import { createEngine } from 'middleout';
const engine = createEngine({ servers: { crm: { command: 'node', args: ['crm-server.mjs'] } } });
const { result, stats } = await engine.run(plan);   // expose engine.run as one tool in your agent framework
```

Requires Node 20.11+.

## From Q Branch

<!-- generated:family -->
middleout is a gadget from [Q Branch](../../README.md), the workshop where tools for AI agents get built and proven. The gadgets share a core and a release train, and each one installs and works on its own.

| Tool | |
|---|---|
| [**headjack**](../headjack) | Skills, loaded the moment you need them: an indexed skill library and a per-prompt retrieval hook instead of a preloaded listing. |
| **middleout** (you are here) | API calls, compressed: agents write one small plan, and only the fields they selected reach the model. |
| [**moneyball**](../moneyball) | Pay for the model each job needs: measure every subagent run, graduate repeat work to cheaper models on evidence. |
| [**groundhog**](../groundhog) | Stop re-living the same session: re-learned lessons become a committed ledger that hooks enforce, and repeated procedures become runbooks. |
<!-- /generated:family -->

---

*middleout is an original project. It is not affiliated with HBO or Silicon Valley, and the illustration is original artwork.*
