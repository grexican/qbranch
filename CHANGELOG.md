# Changelog

## v0.1.2 (2026-10-17)

**other**
- license: MIT (root and every gadget folder; all manifests)
- bench(headjack): pilot (Sonnet, 25 and 500, 30 test prompts, 1 run; a pipeline check, not a result); score loads only on successful tool calls; keep transcripts for rescoring
- bench(headjack): blind prompt set (230 test, 78 dev), isolation check with positive control, thresholds frozen on dev
- scenarios: tsconfig comment stripping respects strings ("@/*" is not a comment)
- bench(headjack): test bed (40 targets, 24 decoys, canaries), filler manifest, arms, runner, scoring, summary, cutoff, tuning, isolation check, tests
- scenarios: the interface hint follows tsconfig path aliases (@/...)
- scenarios: kill processes a run left behind in its sandbox (servers holding pipes and ports)
- bench: pre-registration v2 (the description cutoff is the real limit; v1 H2 kept and reported); headjack README: listings lose descriptions, not names
- bench(headjack): WIP: isolated claude adapter, listing tap, synthetic filler, 40 target skills; handoff
- scenarios: tell the agent the interface the hidden tests import (names only, as in SWE-bench Pro); validate --again
- bench: pre-register the headjack skill benchmark (hypotheses and pass/fail criteria fixed before any result)
- scenarios: a workspace package without its own runner config runs under the root's; failure tails kept for audit; QBRANCH_SCENARIOS_CONFIG
- qbranch version is stamped at build; groundhog lesson message has no doubled period

**replay**
- replay/scenarios: a run no longer hangs when the agent orphans a process that holds its pipes (resolve on exit + grace)

**core**
- core: history scenarios (past commits as build tasks graded by their own tests); moneyball scenarios + tune --scenarios; groundhog verify --scenarios

## v0.1.1 (2026-10-16)

**core**
- core: hooks parse BOM-prefixed input (PowerShell pipes add one; hooks silently did nothing); release script runs node directly

## v0.1.0 (2026-10-16)

**other**
- release: the first release may ship the current version
- release: npm run release:patch|minor|major (preflight, lockstep bump incl. plugin versions, regenerate, changelog, tag, push)
- Q Branch: rename from utility-belt; one repo, one marketplace (<gadget>@qbranch); workbench banner; Bond tribute + disclaimer; mirrors removed
- utility belt 0.1.0: headjack, middleout, moneyball, groundhog

**ci**
- ci: build the macOS Intel binary on macos-15-intel (macos-13 is retired and never gets a runner)

**replay**
- replay guard: deleting or moving files is allowed only inside the sandbox, never elsewhere in the shared temp dir (failed on Linux CI, where the sandbox lives in /tmp)
- replay/tune: run a pair's variants in parallel (--concurrency), explicit per-replay cap (--per-run)
- replay: budget-starved or timed-out runs are inconclusive, not failures; refuse plans that can't finish; prompts naming paths outside the project are never replay-safe; skip trivial prompts; tune counts only scored runs
- replay harness + transcript readers for more agents; groundhog proves lessons before accepting them

**tune**
- tune: A/A control (unchanged setup run twice); regressions counted beyond chance; inconclusive when noise exceeds what the bar can resolve
- tune: judge rubric tasks (default Sonnet) so quality loss shows; --timeout; --no-judge

**moneyball**
- moneyball README: restore model names in the ladder section
- moneyball: cross-vendor cost ladder (effort first, then size; Anthropic/OpenAI/Google/xAI/Composer); Cursor runs re-keyed; hook routes Claude only
- moneyball: experiments folder is gitignored in the user's repo
- moneyball: tolerate unpriced (usage: null) runs in overhead and scan
- moneyball: the startup tax (overhead, experiments, tune) + delegation credit

**core**
- core: read editor stores in place (read-only WAL, no 11 GB copies); moneyball counts Cursor runs on outcomes (unpriced, never free); platform notes from verified readers

**headjack**
- headjack: install ledger (what moved, from where, pinned registry commits, portable paths), history, and release (the exit door, back to exact origin)
- headjack: bundles (one trigger loads an ordered set of skills)

**docs**
- docs: replay harness contract (shared by groundhog, moneyball, headjack)

