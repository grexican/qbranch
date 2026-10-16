# headjack benchmark: handoff (WIP, paused 2026-10-16)

Branch `feat/skill-bench`, worktree `C:/work/qbranch-wt-bench`. Nothing pushed. `npm install` is done in the worktree.
No prompts have been generated and no benchmark runs (pilot or full) have happened. PREREGISTRATION.md is unchanged.

## What is built

- `src/agents/claude.mjs`: isolated `claude -p` adapter (stream-json). Per-run temp `CLAUDE_CONFIG_DIR`,
  `--setting-sources project`, `--strict-mcp-config`, parent `CLAUDE_*` env dropped, replay guard as PreToolUse, and
  `claudeMdExcludes` for every ancestor CLAUDE.md. Auth: `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`, or
  `--auth-from-home` (reads the access token from `~/.claude/.credentials.json` read-only, never refreshes or writes it).
- `src/tap.mjs`: local pass-through proxy (`ANTHROPIC_BASE_URL`) that records request bodies, to read the exact skill
  listing the model receives. Headers are forwarded, never stored.
- `src/synth.mjs`: seeded synthetic filler skills (capacity 21,840; needs a 4th name dimension to go past that).
- `testbed/authoring/targets.mjs`: the 40 original target skills (8 shards x 5, one multi-answer pair per shard) with
  regex canaries and `minHits`. Not yet rendered to `testbed/targets/*/SKILL.md` + `testbed/canaries.json`.

## Measured so far (exploratory probes, CLI 2.1.285; method to be re-run by `src/cutoff.mjs`)

- Isolation: with only `--setting-sources project`, user skills were excluded but `~/.claude/CLAUDE.md` still loaded
  (a sandbox under the home dir sees it as an ancestor's `.claude/CLAUDE.md`). Temp `CLAUDE_CONFIG_DIR` + `claudeMdExcludes`
  fixes it (model answered "no" to the user-memory probe; only built-in skills listed).
- Listing order: user skills alphabetical, then built-ins.
- Claude Code drops **descriptions**, not names. Greedy in listing order: Haiku keeps ~8 descriptions of ~200 chars
  (N=25: 6, N=50: 3, N=100: 0); Sonnet keeps ~105 (N=100: all, N=200: 105, N=400: 76).
- **Names are never dropped**: every name was in the request up to 21,800 skills (~8 tokens per name). A late skill is
  invocable by name natively up to the context limit: Haiku worked at 15,000 and failed at 21,800 ("Prompt is too long",
  ~210k > 200k); Sonnet still worked at 21,800 (larger window). So the pre-registered cutoff (by-name invocation) is the
  context limit: ~21k skills for Haiku, much higher for Sonnet. This needs a decision before the full run (below).

## Decision needed from Eli before running

The pre-registration defines the cutoff as by-name invocability. Measured, that is the context-window limit (~21k skills
for Haiku; Sonnet's 'beyond' would need ~100k+ skills, which means ~1M-token native requests near the limit and a
headjack index of that size). Options: (a) run 'beyond' literally at the measured limit (native fails at session start;
cheap for native, heavy index for headjack); (b) also report the description cutoff as a supplementary, clearly
non-preregistered measurement; (c) register a v2 pre-registration with a description-based cutoff and report both.
The README claim "big listings lose entries" is not true on 2.1.285: they lose descriptions.

## What is left

1. `testbed/authoring/write.mjs`: render targets to SKILL.md + `canaries.json`; write ~24 original decoys (3 per shard).
2. `filler/manifest.json`: public, license-checked repos at pinned commits (anthropics/skills Apache-2.0 skills only,
   excluding the source-available document skills; obra/superpowers MIT; others to verify) + `src/filler.mjs` fetch
   (git fetch by sha into `.cache/`, sha256 per file).
3. `src/library.mjs`: per-shard library of size N (targets + decoys + public filler + synthetic), deterministic.
4. `src/arms.mjs`: none / native / native-again / headjack (in-place source + prebuilt `index.db` copied per sandbox,
   `HEADJACK_HOME` temp, `external: false`, PATH shim for `headjack`).
5. `src/generate.mjs` (`npm run bench:headjack:generate`): situation cards, then blind prompts; `src/overlap.mjs` tiers.
6. `src/score.mjs` (canaries over final text + written files; loads from Skill / `headjack get` / SKILL.md reads),
   `src/stats.mjs` (Wilson), `src/summary.mjs` (SUMMARY.md with H1-H5 verdicts), `src/run.mjs` (`npm run bench:headjack`).
7. `src/cutoff.mjs`: the cutoff measurement + the plain reach test; tune `strong` on dev offline, freeze in
   `frozen-thresholds.json`.
8. Tests in `bench/headjack/test/` and add them to the root `npm test` glob.
9. Pilot (25 and 500, Sonnet, ~30 test prompts, 1 run), then the full run.

## Next commands

```bash
cd C:/work/qbranch-wt-bench
node bench/headjack/testbed/authoring/write.mjs        # after writing it
npm test && npm run sync:check
```
