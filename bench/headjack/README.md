# headjack skill benchmark

Does a just-in-time skill library ([headjack](../../packages/headjack)) get the right skill used more often than Claude
Code's native preloading, at realistic library sizes, without loading skills it shouldn't? The contract is
[PREREGISTRATION.md](PREREGISTRATION.md) (v1) plus [PREREGISTRATION-v2.md](PREREGISTRATION-v2.md); both are reported.
Results: [`results/`](results/) (one JSON per agent and model, a `*-SUMMARY.md` per run tag).

## Reproduce it

Node 22.13+, the `claude` CLI, and auth for an empty config dir: `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`
(`claude setup-token`). On Windows and Linux, `--auth-from-home` instead reads the current access token from
`~/.claude/.credentials.json` for each run, read-only (never refreshed, copied or printed).

```bash
npm install
npm run bench:headjack:cutoff -- --models sonnet,haiku --auth-from-home              # the listing limits, per model
node bench/headjack/src/verify-isolation.mjs --model haiku --auth-from-home          # isolation check
node bench/headjack/src/tune.mjs --freeze                                            # dev split only, offline
npm run bench:headjack -- --agent claude --models sonnet,haiku --sizes 5,25,100,500 --runs 2 --concurrency 8 --split test --auth-from-home
```

Runs resume: a rerun with the same `--tag` skips finished runs (raw records in `results/raw/`, not committed).
Prompts were generated once and are committed; regenerating them (`npm run bench:headjack:generate`) is a maintainer
step and changes the prompt set's hash recorded in every result.

## What is compared

| Arm | Setup (each run in a throwaway copy of a template project, via `makeSandbox` from `@qbranch/core/replay`) |
|---|---|
| none | no skills |
| native | every library skill in `.claude/skills` |
| native-again | native, run again: the A/A noise floor |
| headjack | root skills `find-skill`/`load-skill` only; the library is an in-place source with a prebuilt index; the `UserPromptSubmit` hook; `external: false` (no registry fall-through); thresholds from `frozen-thresholds.json` |

**Isolation.** Every run gets a fresh temp `CLAUDE_CONFIG_DIR` (no user skills, plugins, settings, hooks, memory or
transcripts), `--setting-sources project`, `--strict-mcp-config`, the replay guard as a PreToolUse hook, and
`claudeMdExcludes` for every ancestor `CLAUDE.md` (without it, a sandbox under the home directory picks up
`~/.claude/CLAUDE.md` as an ancestor's project memory, which we observed). headjack's personal space points at an empty
temp dir. `src/verify-isolation.mjs` checks the request the model actually received.

**Agents.** Only Claude Code is implemented. `src/agents/index.mjs` documents the adapter contract for Codex, Gemini CLI
or Cursor's CLI.

## Test bed

- **40 target skills** (`testbed/targets/`, authored in `testbed/authoring/targets.mjs`), original, with odd house
  conventions across writing, code style, data formats, design, ops, docs, testing, planning, research and code review.
  8 shards of 5; each shard has one pair that legitimately fits the same request (two design-token skills, two React
  skills, two release-writing skills, two test skills, two export skills, two incident skills, two planning skills,
  two docs skills). Canaries (`testbed/canaries.json`) are regexes; a skill counts as used when `minHits` of them match
  the final answer plus every file the agent wrote. Tests check that each skill's own text satisfies its canaries and
  that no description, decoy or synthetic skill does.
- **24 decoys** (`testbed/decoys/`): original near-duplicates in a target's domain with different conventions.
- **Filler**: public skills at pinned commits ([filler/manifest.json](filler/manifest.json): repo, commit, path,
  sha256, license), fetched at run time into `.cache/` and never vendored; built by `src/build-manifest.mjs`. Seeded
  synthetic skills (`src/synth.mjs`) top a library up only when the public pool runs out (not needed up to 500).
- **Libraries** (`src/library.mjs`): for shard s and size N: the shard's targets, then its decoys, then filler in a fixed
  seeded order (a smaller library is a prefix of a larger one). A prompt runs against its own shard's library.
- **Prompts** (`testbed/prompts/`): blind, two steps with `claude -p` (`src/generate.mjs`): a call that sees the skill
  writes a situation card with the skill's key words banned; a fresh call that never sees the skill writes the user's
  message. Tiers come from measured word overlap with the acceptable skills' descriptions (`src/overlap.mjs`): named
  (contains a skill name), lexical (shares a key term), semantic (shares none), negative (empty answer set).
  Split dev/test by a stable hash (~25% dev).

## Scoring

Use rate (canaries), load recall (a library skill loaded via the Skill tool, `headjack get`, or reading its SKILL.md),
false-load rate on negatives, follow rate given a load, cost and wall time. 95% Wilson intervals. Verdict rules are in
`src/summary.mjs`, including the A/A rule.
