# Changelog

## v0.3.1 (2026-10-23)

**middleout**
- middleout: sign-in hints name a command that runs (the shim, qbranch middleout, or the plugin's script); installers add headjack/middleout/moneyball/groundhog commands next to qbranch

## v0.3.0 (2026-10-23)

**other**
- qbranch stats: every installed tool's worth-it summary in one view
- marketplace: the Agensi listing source (self-contained install skill) + a cross-platform pack script
- declare the repo's MCP surface: root .mcp.json (both servers), README table of all six tools, mcp keyword on headjack

**moneyball**
- moneyball: judge background subagents by their real reports, measured failure words, parent rework, Wilson lower bound for judgment classes, run duration and minutes saved, why each dispatch was or was not routed, schema upgrade keeps aged-out evidence

**headjack**
- headjack: no suggestions on harness prompts (task notifications), once per session per skill, relevance-gated registry fallback, startup-saving vs injected accounting and a tuning trail

**middleout**
- middleout: wrap HTTP/SSE MCP servers (headers with env expansion, one-time `middleout login` OAuth), per-tool savings, bypass split into addressable/unwrapped/binary/write, nudge conversion, scrubbed error log, a summary that leads with coverage

**core**
- core: background subagent reports (task-notification, plain or queued) are read as late results; older stats files gain newer counters

## v0.2.0 (2026-10-19)

**middleout**
- middleout: wrap every tool by default (readOnlyHint is rarely set, and a POST is often a search); readonly stays as an opt-in

**other**
- readme: move the M8ven badge to the footer
- readme: M8ven score badge

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

