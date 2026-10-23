<p align="center"><img src="docs/groundhog-hero.svg" alt="groundhog: stop re-living the same session" width="100%"></p>

**groundhog** finds the mistakes your agents make every session and the procedures they keep doing by hand. It reads past transcripts for three things: **lessons** (a command fails, then a related one works, again and again), **sequences** (the same steps run by hand across many sessions), and **friction** (commands that keep failing). Lessons you accept go into a committed ledger, and hooks enforce them, so the same mistake costs nothing next time.

In *Groundhog Day*, Phil wakes up at 6:00 AM to the same day until he finally learns from it. Your agents wake up every session with no memory of yesterday's dead ends.

<p align="center"><a href="#install">Install</a> · <a href="#how-it-works">How it works</a> · <a href="#commands">Commands</a> · <a href="#is-it-working-groundhog-stats">Stats</a> · <a href="#evidence">Evidence</a></p>

## Why

Longer instructions don't stop repeat mistakes. A rule in `CLAUDE.md` or `AGENTS.md` costs tokens in every session and still gets skipped. A hook costs nothing until the mistake is about to happen, and then it fires every time.

Across one developer's last 30 days (1,187 sessions, 81k shell commands), the same lessons were re-learned over and over:

- `pnpm -s db:seed --env` failed, then `pnpm db:seed --env dev` worked, in **14 separate sessions**.
- `dotnet build` then `dotnet test --no-build` was run by hand in **71 sessions**: a verify script nobody wrote.
- `python` / `python3` failed and `py -3` worked, session after session.

## How it works

| Piece | What it does |
|---|---|
| **Miner** | Reads transcripts and normalizes each shell command to its shape (paths, strings and numbers generalized; `cd` prefixes and wrappers stripped; `npx tsc` and `npx vitest` kept apart). Looking around (grep, cat, ls) is ignored. A lesson needs the fix to be *related* to the failure, to recur in 2+ sessions, and to point one way: A→B and B→A both is flailing, not a fix. |
| **Tool switches** | Some fixes are not another shell command. A failing heredoc-written script that works once it is written with the Write tool and run as a file, or a `sed -i` that becomes an Edit, is a lesson too. These group by the risky construct (heredoc script, inline `-e`/`-c`, `sed -i`, `echo >`), not by command shape, so they add up across sessions. `groundhog report` lists them as `W<n>`. |
| **rtk retries** | When an agent reruns a command as `rtk proxy <cmd>` because the token-saving proxy filtered out what it needed, that command shape is recorded (`K<n>`); accepted, it becomes a reminder, never a block. |
| **Built-in guard** | On Windows, Git Bash turns `\\` into `\` before bash runs, even inside a quoted heredoc or `'...'`. A Bash command whose inline script contains `\\` gets one note per session saying to write the file with the Write tool. Measured on 30 days of real sessions: these scripts failed 39.8% of the time, against 17.8% for inline scripts without a backslash. Fires only on Windows (`escapeGuard: auto`), never blocks. |
| **Ledger** | `groundhog.lessons.json`, committed: each lesson is a command pattern, what to do instead, and which shell it applies to. You accept mined lessons (or write your own); nothing is enforced without review. |
| **Hooks** | `SessionStart` injects the ledger as a short list. `PreToolUse` on shell commands blocks the first matching command per session with the fix, then lets it through with a reminder, so a false positive can never deadlock the agent. |
| **Replay check** | `groundhog accept L3 --verify --budget 1` proves a lesson before it goes in. It replays real past tasks where the failure happened, in a throwaway sandbox, once without the lesson and once with it (the real hooks enforce it in both runs). A held-out sample of unrelated recurring tasks then runs the same way: the **no-regression gate** rejects any lesson whose presence turns a pass into a fail. The evidence goes into the ledger entry. |
| **Runbook drafts** | `groundhog draft S3` turns a repeated sequence into an Agent Skill draft. Adopt it into your skill library; when its steps stop changing, promote it to a script. |
| **Stats** | `.groundhog-stats.json`: injections, guard hits and denies, and whether each accepted lesson's failing command still recurs. |

## Example

```
$ groundhog scan && groundhog report
Lessons: the same error, then the same workaround (accept with: groundhog accept L<n>)
  L1  x14 in 14 sessions  pnpm -s db:seed --env  =>  pnpm db:seed --env dev
Sequences run by hand again and again (draft a runbook with: groundhog draft S<n>)
  S1  71 sessions  dotnet build P -v  >  dotnet test P --no-build

$ groundhog accept L1
L1 added (deny-once): when /pnpm\s+-s\s+db:seed\s+--env/ -> this form fails here; what worked: pnpm db:seed --env dev
```

Next session, the agent starts with the lesson in context. If it reaches for the old command anyway, the hook stops it once with the fix.

## Install

<!-- generated:install (by scripts/sync.mjs from scripts/platforms.mjs; edit those, not this block) -->
**Claude Code**: one marketplace for every Q Branch gadget; install only the ones you want.

```bash
claude plugin marketplace add grexican/qbranch
claude plugin install groundhog@qbranch        # add -s project to share it with your team
```

**Any other agent**: one command from a clone (Node 22.13+). It copies the skills, merges the hooks and MCP config into the project, and is safe to re-run; `--uninstall` removes exactly what it added.

```bash
git clone https://github.com/grexican/qbranch
node qbranch/packages/groundhog/dist/install.mjs --platform cursor --project .   # or: claude, codex, gemini, copilot, windsurf
```

Native packages are in [`adapters/`](adapters/): a Cursor plugin, a Codex plugin and a Gemini CLI extension. Copilot reads the Claude plugin marketplace directly. No Node on the machine? Use the `qbranch` native binary ([how](../../README.md#no-node-native-binary)).

| Platform | What works |
|---|---|
| Claude Code | everything |
| GitHub Copilot (CLI, VS Code) | mining reads VS Code Copilot Chat and Copilot CLI sessions (storage verified on a real install; message details unverified); --verify replays with Claude Code |
| Cursor | mining reads Cursor IDE conversations and agent CLI transcripts (verified on real data); --verify replays with Claude Code |
| OpenAI Codex | mining reads Codex rollouts (format checked against the Codex source, not yet seen on a real install); --verify replays with Claude Code |
| Gemini CLI | mining reads Gemini CLI chats (format checked against the Gemini CLI source, not yet seen on a real install); --verify replays with Claude Code |
| Windsurf / Devin | no session-start context; the guard blocks; no Windsurf transcript reader yet; --verify replays with Claude Code |
<!-- /generated:install -->

## Commands

```bash
groundhog scan [--days 30] [--all-projects]    # mine recent transcripts
groundhog report [--json]                      # numbered candidates: L (lessons), S (sequences), F (friction), R (repeats)
groundhog accept L3                            # add a mined lesson to the ledger
groundhog accept L3 --verify --budget 1        # ...only if replaying past tasks proves it helps and breaks nothing
groundhog verify [L1] --budget 2               # re-check accepted lessons; one that breaks another task is flagged
                                               #   [--model haiku] [--tasks 2] [--held-out 2] [--repeats 1] [--days 30]
groundhog add --when '<regex>' --instead '<what to do>' [--remind]   # write one by hand (--remind never blocks)
groundhog lessons                              # list the ledger
groundhog draft S2 --name verify-backend       # runbook skill draft under .groundhog/drafts/
groundhog stats                                # is it working?
```

**Review every lesson before you accept it**, and verify it when you can. Mined fixes can go stale: on one machine the top mined lesson was "`python` fails, use `python3`", but by then both were broken and only `py -3` worked. The ledger got the corrected lesson instead.

## Proving a lesson: `--verify`

A lesson that reads well can still be wrong. `--verify` checks it against real work before it is enforced:

1. **Find the evidence.** From the transcripts, take the read-only tasks where the lesson's failing command actually ran and failed (cheapest first). A task is a session's first real prompt; sessions whose prompts share most of their words are one recurring task.
2. **Replay without and with.** Each task runs headless (`claude -p`) in a throwaway git worktree, never the live tree: once with the current ledger, once with the lesson added. Both runs install the real groundhog hooks, so the measurement is the lesson as enforced.
3. **Grade deterministically.** The checks come from the original run: it completed, it changed the files the original changed, the commands that worked then work now, and the lesson's own failure did not happen. A command the guard blocked counts as prevented, not failed. An LLM judge is used only for a task with no deterministic check.
4. **Gate regressions.** A held-out sample of unrelated recurring tasks runs both ways too. If the lesson turns any pass into a fail, it is rejected (`accept`) or flagged in the ledger (`verify`).

The verdict is `helps` or `neutral` (accepted), `hurts` or `regressed` (rejected), or `no-evidence` / `inconclusive` when nothing could be replayed within the budget. The evidence is stored with the lesson:

```json
"verified": { "at": "2026-10-15T12:00:00Z", "tasks": 3, "before": { "runs": 1, "passRate": 0, "meanScore": 0.5 },
              "after": { "runs": 1, "passRate": 1, "meanScore": 1 }, "regressions": [], "costUsd": 0.41, "verdict": "helps" }
```

**Safety.** Only tasks whose original run made no writes outside the repo and no outbound side effects (push, deploy, publish, messages, MCP writes) are replayed. The same rules run again as a PreToolUse guard during the replay. Git hooks are disabled in the sandbox and a pre-push hook refuses every push; MCP servers and user-level hooks are off; each run has a hard dollar cap (`--max-budget-usd`) and a kill timer. The guard reads commands, not what a script does on its own, so treat it as a strong filter, not an OS sandbox. Nothing spends money without `--budget`.

One replay per variant is a single sample: a model can pass or fail the same task by chance. Use `--repeats 2` or more when the verdict matters more than the cost.

## How groundhog compares to SkillOpt

Microsoft's [SkillOpt-Sleep](https://github.com/microsoft/SkillOpt) mines agent transcripts, replays recurring tasks, and keeps an edit to CLAUDE.md or a skill only if it scores better on held-out tasks (`gate_no_regression` rejects any edit that lowers a held-out task). groundhog borrows its task mining, held-out gating and transcript locations, and differs on purpose:

| | SkillOpt-Sleep | groundhog |
|---|---|---|
| What it changes | rewrites instruction text (CLAUDE.md, skills) | a ledger of narrow lessons, each enforced by a hook at the moment it applies |
| How a task is replayed | single-shot text: the model answers the prompt without tools | a real headless agent run with tools, in a throwaway worktree |
| How a replay is graded | rubric or rule judges over the answer text | deterministic checks from the original run (files changed, commands that worked, the failure gone) before any judge |
| Safety | replays are tool-less | read-only filter on what may replay, a runtime guard, pushes blocked, a dollar cap per run |

In short: **they write down the lesson; we stop the mistake, and now we prove it first.** SkillOpt is the broader tool: it optimizes whole skills, reads more agents (Devin, OpenClaw and VS Code Copilot Chat too), and ships an evaluation kit. groundhog does one narrow thing.

## Is it working? `groundhog stats`

```
groundhog stats since 2026-10-14 (updated 2026-10-14 12:51)
lessons accepted 1 | session injections 1 | guard hits 2 (denied 1) | drafts 0
last scan: 248 sessions, 23164 shell calls; 68 repeated shapes, 2 lesson candidates, 50 sequences
no accepted lesson has recurred since it was accepted
```

The number that matters is the last line: an accepted lesson whose failing command keeps running means the wording or the pattern needs work.

## Configure

`groundhog.config.json` at the repo root. All keys are optional:

```json
{ "days": 30, "minSessions": 5, "minRecoveries": 3, "minSequence": 3, "guard": "deny-once", "lessons": "groundhog.lessons.json" }
```

`guard`: `off` · `remind` (context only) · `deny-once` (default). `escapeGuard`: `auto` (default: Windows only) · `on` · `off`. `GROUNDHOG_STATS=0` turns the stats file off.

## Evidence

- **Verified live in Claude Code:** the lesson was injected at session start, the matching command was denied once and allowed on the forced retry, and the agent named the lesson in its answer.
- **Replay verification, run live** (Windows, `--model haiku`, 1 target task and 1 held-out task, about $0.40 per verification). The ledger's hand-written lesson "`python` is broken here, use `py -3`" was checked with `groundhog verify L1 --repeats 3`: without it the task's `python` call failed in 3 of 3 runs, and with it 2 of 3 runs avoided the failure (pass 0 → 0.67). The held-out task passed 3 of 3 both ways, so the verdict was `helps`. A mined duplicate of the same lesson came out `neutral` (1/3 → 1/3), since the ledger already covered it. Its first single-sample run read `regressed`, which was noise. That is why the CLI now asks you to confirm any non-neutral one-sample verdict with `--repeats 3`.
- **The miner was tuned on real data, not by feel.** The first scan proposed "`tsc` fails → `vitest` works" (two steps of a verify run, not a fix) and missed the real Python lessons. Runner-aware program names, kept inline scripts and the one-way rule fixed both.

## Requirements

Node 22.13+. Transcripts (readers in `@qbranch/core/transcripts`):

- **Verified on real data:** Claude Code, and Cursor (IDE conversations and agent CLI transcripts). On one machine the Cursor history gave 614 sessions and 13,316 shell calls with results, which mined into 28 lesson candidates. Cursor's store can be several GB; it is read from a snapshot copy, never in place, and the copy is reused until Cursor writes again.
- **Checked against the writer's source, not yet seen on a real install:** Codex (rollouts, including compressed `.jsonl.zst`, which needs Node 22.15+) and Gemini CLI (JSONL chat logs).
- **Storage verified, message details not:** VS Code Copilot Chat and Copilot CLI. OpenCode and Pi follow SkillOpt's readers.

`--verify` needs the `claude` CLI.

## From Q Branch

<!-- generated:family -->
groundhog is a gadget from [Q Branch](../../README.md), the workshop where tools for AI agents get built and proven. The gadgets share a core and a release train, and each one installs and works on its own.

| Tool | |
|---|---|
| [**headjack**](../headjack) | Skills, loaded the moment you need them: an indexed skill library and a per-prompt retrieval hook instead of a preloaded listing. |
| [**middleout**](../middleout) | API calls, compressed: agents write one small plan, and only the fields they selected reach the model. |
| [**moneyball**](../moneyball) | Pay for the model each job needs: measure every subagent run, graduate repeat work to cheaper models on evidence. |
| **groundhog** (you are here) | Stop re-living the same session: re-learned lessons become a committed ledger that hooks enforce, and repeated procedures become runbooks. |
<!-- /generated:family -->

---

*groundhog is an original project. It is not affiliated with Columbia Pictures or Groundhog Day, and the illustration is original artwork.*
