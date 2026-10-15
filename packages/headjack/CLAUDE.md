# CLAUDE.md: headjack

headjack is a just-in-time skill library for LLM agents. It ships as a Claude Code plugin (root skills + a UserPromptSubmit hook), a CLI, an MCP server and a plain library (`src/index.mjs`).

## Map
- `src/library.mjs`: index (SQLite: FTS5 BM25 + MiniLM embeddings, RRF), search, load, gap terms
- `src/suggest.mjs`: the per-prompt retrieval the hook runs (named skill wins; strong local hits; registry fall-through; zero output when nothing fits)
- `src/registry.mjs`: skills.sh search and GitHub fetch
- `src/config.mjs`: shared space (`.headjack/library`) and personal space (`~/.headjack/library`); in-place sources
- `src/stats.mjs`: `.headjack-stats.json` upserts. Stats must never throw into the agent.
- `bin/headjack.mjs`: CLI; `hooks/hooks.json`; `skills/find-skill`, `skills/load-skill`

## Rules
- Tests: `npm test` (offline, lexical mode). Run them before every commit.
- Measured decisions live in the README "Evidence" section. Change hook wording or thresholds only with a rerun, not by feel.
- Keep the hook silent (no output) when nothing is relevant: zero tokens on trivial prompts is a feature.

<!-- portable principles: appended from the second-brain canonical block -->
## 1. Core principles (portable — inject into every project, never replace)

Derived from Andrej Karpathy's observations on LLM coding pitfalls. This block is the canonical copy; keep it in sync with `.claude/skills/karpathy-guidelines/SKILL.md`. When adding to a downstream project, **append** under a clear marker — never overwrite existing instructions.

**1. Think before coding.** Don't assume, don't hide confusion, surface tradeoffs. State assumptions; if uncertain, ask. If multiple interpretations exist, present them — don't pick silently. If a simpler approach exists, say so. If something is unclear, stop and name it. Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one by one. If a question can be answered by exploring the codebase, explore the codebase instead.

**2. Simplicity first.** Minimum code that solves the problem, nothing speculative. No features beyond what was asked, no abstractions for single-use code, no error handling for impossible scenarios. If 200 lines could be 50, rewrite it.

**3. Surgical changes.** Touch only what you must. Don't "improve" adjacent code, don't refactor what isn't broken, match existing style. Remove orphans your change created; leave pre-existing dead code alone (mention it). Every changed line should trace to the request.

**4. Goal-driven execution.** Define success criteria, loop until verified. Turn "add validation" into "write tests for invalid inputs, then make them pass." State a brief plan with a verify step per item.

