# CLAUDE.md: middleout

middleout is a declarative fetch layer over MCP servers and JSON APIs: hierarchical plans, fan-out, automatic pagination and JMESPath projection. It ships as a Claude Code plugin (MCP server + skill + PostToolUse/PreToolUse hooks), a CLI and a plain library (`src/index.mjs`).

## Map
- `src/engine.mjs`: `createEngine()`: connects downstream servers, read-only filter (server `readOnlyHint`), plan runner, auto-pagination, empty-arg cleanup
- `src/mcp.mjs`: `middleout_tools` / `middleout_shape` / `middleout_run`
- `src/hook.mjs`: post (measure raw MCP traffic split addressable/unwrapped/binary/write, nudge, count nudge conversions) and pre (gate mode)
- `src/config.mjs`: `middleout.config.json`; default servers = the project's `.mcp.json` servers (stdio, http, sse; `${VAR}` expansion; `skipped` says why an entry is not wrapped)
- `src/oauth.mjs`: OAuth client for HTTP servers: `middleout login` (browser, once) and the runtime provider (stored tokens + SDK refresh; never a browser, never registers)
- `src/plan.mjs`: tool refs a plan names (stats, errors, nudge conversion)
- `src/stats.mjs`: `.middleout-stats.json` upserts, per-tool attribution (`recordRun`), the Weissman score and the summary. Stats must never throw into the agent.
- `test/fixtures/crm-server.mjs`: the stdio fixture every engine test runs against
- `test/fixtures/http-server.mjs`: Streamable HTTP fixture (open, bearer, and a minimal OAuth server)

## Rules
- Tests: `npm test`. Run them before every commit.
- Read-only is the default and the safety story. Never loosen it silently.
- Every new API mechanic the engine absorbs (pagination style, arg quirk) gets a fixture test first.

<!-- portable principles: appended from the second-brain canonical block -->
## 1. Core principles (portable — inject into every project, never replace)

Derived from Andrej Karpathy's observations on LLM coding pitfalls. This block is the canonical copy; keep it in sync with `.claude/skills/karpathy-guidelines/SKILL.md`. When adding to a downstream project, **append** under a clear marker — never overwrite existing instructions.

**1. Think before coding.** Don't assume, don't hide confusion, surface tradeoffs. State assumptions; if uncertain, ask. If multiple interpretations exist, present them — don't pick silently. If a simpler approach exists, say so. If something is unclear, stop and name it. Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one by one. If a question can be answered by exploring the codebase, explore the codebase instead.

**2. Simplicity first.** Minimum code that solves the problem, nothing speculative. No features beyond what was asked, no abstractions for single-use code, no error handling for impossible scenarios. If 200 lines could be 50, rewrite it.

**3. Surgical changes.** Touch only what you must. Don't "improve" adjacent code, don't refactor what isn't broken, match existing style. Remove orphans your change created; leave pre-existing dead code alone (mention it). Every changed line should trace to the request.

**4. Goal-driven execution.** Define success criteria, loop until verified. Turn "add validation" into "write tests for invalid inputs, then make them pass." State a brief plan with a verify step per item.

