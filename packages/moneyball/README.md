<p align="center"><img src="docs/moneyball-hero.svg" alt="moneyball: pay for the model each job needs" width="100%"></p>

**moneyball** reads your agents' session transcripts and measures every subagent run: which model ran it, what it cost, and whether it worked. When a kind of task keeps succeeding on a cheaper model, moneyball graduates it, and a hook routes the next dispatch there.

In *Moneyball*, the Oakland A's could not afford stars, so they stopped paying for reputation and paid for what the numbers said wins games. Same idea: stop sending every errand to your most expensive model on gut feel.

<p align="center"><a href="#install">Install</a> · <a href="#how-it-works">How it works</a> · <a href="#commands">Commands</a> · <a href="#is-it-working-moneyball-stats">Stats</a> · <a href="#evidence">Evidence</a></p>

## Why

Subagents default to the strongest model, and nobody checks afterwards. In one developer's last 30 days:

- **Subagents were 51% of spend.** 98% of that ran on the two most expensive tiers.
- **192 narrow, checkable runs** (status checks, QA walks, lookups) cost **$927 on frontier models**. At small-model rates they would have cost about $23.
- **Nobody knew which runs could move.** Guessing is risky: a cheaper model that fails and gets re-run is not cheaper.

moneyball replaces the guess with evidence from runs you already made.

## How it works

| Piece | What it does |
|---|---|
| **Scan** | Reads Claude Code transcripts (main sessions and every subagent). Prices each run from its token usage, and judges success: a run **failed** if it was redone (same task, same session, within 30 min), if its report says it could not finish, or if most of its tool calls errored. |
| **Task classes** | Agent type + the leading verb of the description (`general-purpose:research`, `Explore:audit`). Coarse on purpose: real descriptions are nearly unique, and the verb is all a hook can see at dispatch time. |
| **Recommendations** | Per class: **graduate** (the cheaper tier did it ≥10 times at ≥90% success, and is cheaper *per completed task*), **explore** (mechanical work with no evidence yet on the cheaper tier), **try-effort** (unclear work: lower the effort on the same model first; caches are per model), or **keep**. A class failing on its current model gets "fix the brief, or move it up", never a cheaper model. |
| **Hook** | `PreToolUse` on the subagent tool. Looks the dispatch up in the routing table and, by mode, says nothing, adds a note, rewrites the `model`, or (explore) sends a small share one tier down so the cheaper model earns its evidence. A model the caller pinned is never overridden. |
| **Stats** | `.moneyball-stats.json`: dispatches seen, suggestions, rewrites, exploration trials, and the estimated saving. |

Modes (`moneyball.config.json` → `"mode"`): `report` · `suggest` (default) · `enforce` · `explore`.

## Example

```
$ moneyball scan
scanned 265 subagent transcripts (+265 new): 265 runs, 117 classes, $1815.20; 1 graduated, 1 exploring, est. saving $81.16

$ moneyball report
graduate      $78.84  general-purpose:research
                     [mechanical] opus 13/13, sonnet 11/11 -- sonnet passed 11/11 (100%) vs opus 100% (est. $59.99)
explore       $67.34  general-purpose:harvest
                     [mechanical] opus 12/12, sonnet 19/21 -- mechanical, 21 runs on sonnet, 0/10 trials on haiku
keep         $406.35  general-purpose:build
                     [judgment] opus 27/27 -- judgment work: leave it on the strong model
```

With `"mode": "suggest"`, the next research dispatch carries a note: *this task class succeeds on sonnet; prefer it*. With `enforce`, the hook rewrites the dispatch's model itself.

## Install

<!-- generated:install (by scripts/sync.mjs from scripts/platforms.mjs; edit those, not this block) -->
**Claude Code**: one marketplace for every Q Branch gadget; install only the ones you want.

```bash
claude plugin marketplace add grexican/qbranch
claude plugin install moneyball@qbranch        # add -s project to share it with your team
```

**Any other agent**: one command from a clone (Node 22.13+). It copies the skills, merges the hooks and MCP config into the project, and is safe to re-run; `--uninstall` removes exactly what it added.

```bash
git clone https://github.com/grexican/qbranch
node qbranch/packages/moneyball/dist/install.mjs --platform cursor --project .   # or: claude, codex, gemini, copilot, windsurf
```

Native packages are in [`adapters/`](adapters/): a Cursor plugin, a Codex plugin and a Gemini CLI extension. Copilot reads the Claude plugin marketplace directly. No Node on the machine? Use the `qbranch` native binary ([how](../../README.md#no-node-native-binary)).

| Platform | What works |
|---|---|
| Claude Code | everything |
| GitHub Copilot (CLI, VS Code) | measures and reports; model routing applies where the subagent tool takes a model argument |
| Cursor | measures and reports (transcripts: Claude Code today); model routing needs a subagent tool with a model argument |
| OpenAI Codex | measures and reports (transcripts: Claude Code today); model routing needs a subagent tool with a model argument |
| Gemini CLI | measures and reports (transcripts: Claude Code today); no subagent model routing |
| Windsurf / Devin | no pre-call guard, no session-start context; CLI reports only |
<!-- /generated:install -->

## Commands

```bash
moneyball scan [--days 30] [--all-projects]   # measure new runs, rebuild the routing table (also runs in the background at session start)
moneyball report [--all] [--json]             # every class: graduate | explore | try-effort | keep, with the evidence
moneyball stats                               # is routing being applied, and what is it worth?
```

## Is it working? `moneyball stats`

```
moneyball stats since 2026-10-14 (updated 2026-10-14 11:26)
subagent dispatches seen 1 | caller pinned a model 0 | matched a measured class 1
suggestions 0 | rewrites (enforce) 1 | exploration trials 0
last scan: 265 runs in 117 classes, $1815.20 measured; 1 graduated, 1 exploring; est. saving $81.16 over the window
```

| Signal | What it tells you |
|---|---|
| **matched a measured class** | How much of your dispatch traffic moneyball has evidence for |
| **rewrites / suggestions** | Whether routing is actually applied |
| **exploration trials** | Evidence being bought on purpose, at a bounded share |
| **estimated saving** | Per completed task, so retries count against the cheap model |

## Configure

`moneyball.config.json` at the repo root. All keys are optional:

```json
{ "mode": "suggest", "minRuns": 10, "bar": 0.9, "margin": 0.05, "exploreRate": 0.1, "respectExplicit": true, "days": 30 }
```

`MONEYBALL_MODE` overrides the mode; `MONEYBALL_STATS=0` turns the stats file off. The run index lives in `.moneyball/` (gitignored automatically).

## Evidence

- **The bar is UD's 18-of-20 rule:** a smaller model takes a job only once it matches the outcome on 90% of real runs. Retries and redos count as failures, so "cheap per call" can't hide "expensive per finished task".
- **Effort before model:** lowering effort on the same model keeps its prompt cache; switching models starts cold. moneyball recommends `try-effort` for unclear work before it ever proposes a smaller model.
- **Verified live:** in `enforce` mode, the hook rewrote a real Claude Code dispatch and the subagent ran on Haiku, confirmed from its transcript.

## Requirements

Node 22.13+ (built-in `node:sqlite`). Transcripts: Claude Code today; the reader is pluggable (`registerReader`) for other agents.

## From Q Branch

<!-- generated:family -->
moneyball is a gadget from [Q Branch](../../README.md), the workshop where tools for AI agents get built and proven. The gadgets share a core and a release train, and each one installs and works on its own.

| Tool | |
|---|---|
| [**headjack**](../headjack) | Skills, loaded the moment you need them: an indexed skill library and a per-prompt retrieval hook instead of a preloaded listing. |
| [**middleout**](../middleout) | API calls, compressed: agents write one small plan, and only the fields they selected reach the model. |
| **moneyball** (you are here) | Pay for the model each job needs: measure every subagent run, graduate repeat work to cheaper models on evidence. |
| [**groundhog**](../groundhog) | Stop re-living the same session: re-learned lessons become a committed ledger that hooks enforce, and repeated procedures become runbooks. |
<!-- /generated:family -->

---

*moneyball is an original project. It is not affiliated with Sony Pictures, Michael Lewis or the Oakland Athletics, and the illustration is original artwork.*
