# AGENTS.md: Q Branch

Q Branch: the monorepo of agent gadgets (headjack, middleout, moneyball, groundhog) plus `@qbranch/core`. See README.md.

## Rules
- `packages/<tool>` is canonical, in Claude Code plugin layout. **Never edit `adapters/`, `packages/*/dist/` or the marketplace files by hand.** Change the package, then run `npm run sync`. CI fails on drift (`npm run sync:check`).
- Platform translation (event names, hook shapes, MCP config) lives in one place: `scripts/platforms.mjs`. Hook handlers take normalized input from `@qbranch/core/hooks` and return `{ context, deny, updatedInput }`. Never write a platform's raw output shape inside a tool.
- Hooks must never throw or block the agent by accident. Exit 0 with no output when nothing applies. Stats writes never throw.
- Test before every commit: `npm test` (offline). Everything must run on Windows, macOS and Linux: use `path`, not string paths; no shell-specific commands in tools.
- Skills must pass the agentskills.io spec (sync checks it): lowercase-hyphen names that match the folder; descriptions of 1024 characters or fewer.
- Thresholds and hook wording come from measurements. Change them with a rerun, not by feel.
- IP hygiene: nothing in this repo may name or identify a client, employer, their people, their tools or their data. Use generic examples ("a ticketing system").

## Core principles
1. **Think before coding.** State assumptions, surface tradeoffs, ask when unclear.
2. **Simplicity first.** Write the minimum code that solves the problem, with no speculative features.
3. **Surgical changes.** Touch only what the task needs, and match the existing style.
4. **Goal-driven execution.** Define success criteria and verify them, with tests first.
