# Replay harness contract (`@qbranch/core/replay`)

Several gadgets need to **re-run real past work under a controlled change and grade the result**:
- groundhog: does a lesson help, and does it break any other task (no-regression gate)?
- moneyball: can the startup context (CLAUDE.md, rules, skills listing, MCP schemas) be trimmed without losing quality?
- headjack: does a skill or bundle help?

That machinery lives once, in core, behind this interface. Tools depend on the interface, never on internals.

```js
import { harvestTasks, runTask, gradeRun, compareVariants } from '@qbranch/core/replay';

// 1. Recurring, replayable tasks mined from transcripts (any registered platform reader).
const tasks = harvestTasks({ root, days: 30, limit: 20, filter: (t) => t.readOnly });
// task: { id, platform, prompt, cwd, sessionId, startedAt, readOnly, checks: [...], tags: [...] }
//   readOnly: the original run made no writes outside the repo and no outbound side effects (safe to replay)
//   checks:   deterministic graders derived from the original run (e.g. "final answer mentions X",
//             "command Y exits 0", "file Z contains W"), plus an optional rubric for an LLM judge

// 2. Run one task in a sandbox: a throwaway git worktree (or copy) of task.cwd, never the live tree.
const run = await runTask(task, {
  agent: 'claude',                 // CLI adapter; 'claude' first, others pluggable
  model: 'sonnet',                 // optional
  setup: async (dir) => {},        // apply the variant inside the sandbox (write a CLAUDE.md, a lesson ledger, ...)
  budgetUsd: 0.5,                  // hard cap per run; the run is killed past it
  timeoutMs: 300_000,
});
// run: { ok, costUsd, usage, durationMs, transcriptPath, finalText, exitCode, sandboxDir }

// 3. Grade it against the task's checks (deterministic first; LLM judge only when a rubric exists).
const grade = await gradeRun(task, run);   // { pass, score (0..1), reasons: [...] }

// 4. A/B a set of variants over a set of tasks, with a total budget.
const report = await compareVariants({ tasks, variants: { baseline: setupA, trimmed: setupB }, repeats: 2, budgetUsd: 5 });
// report: { perVariant: { name: { passRate, meanScore, costUsd, startupTokens } }, perTask: [...], regressions: [...] }
```

Rules:
- **Never touch the live working tree.** Every run happens in a sandbox that is deleted afterwards.
- **Spending is opt-in.** Anything that calls a model takes an explicit `budgetUsd`, and the CLIs refuse to run without `--budget`.
- **Only read-only tasks replay by default.** A task that wrote outside the repo, pushed, deployed or sent messages is never replayed.
- **Deterministic checks beat judges.** A judge is used only when a task has a rubric and no deterministic check.
