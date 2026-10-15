---
name: moneyball
description: Right-size subagent models on evidence. Use when choosing which model or effort to give a subagent, when asked what agent runs cost or which jobs could run on a cheaper model, or when a moneyball hook note says a task class has graduated to a cheaper tier. Also use when asked what the startup context costs (CLAUDE.md, skills listing, MCP schemas) or whether to trim it after a model upgrade.
---

# moneyball

moneyball measures every subagent run from the session transcripts: which model ran it, what it cost, and whether it
worked. A run counts as failed when it had to be redone, when its report says it could not finish, or when most of
its tool calls errored. Runs group into task classes (agent type plus the leading verb of the description, such as
`general-purpose:research`). A class **graduates** to a cheaper model only after that model has done the class at
least 10 times with at least 90% success. Savings are counted per *completed* task, so retries are never false savings.

## When dispatching a subagent

- If a `moneyball:` note says this kind of task has graduated, pass that model (for example `model: "sonnet"`) unless
  the task is unusually hard.
- Write the description as `<verb> <object>` ("Research vendor pricing", "QA ticket 123"). The leading verb is the
  class key, so a consistent verb keeps the evidence pooled.
- Judgment work (fix, build, design, review, plan) stays on the strong model. Narrow, checkable, repeated work (check,
  collect, research, QA, summarize) is what graduates.
- Before reaching for a smaller model, try a lower effort on the same model: caches are per model, so switching models
  starts with a cold cache.

## Commands

    moneyball scan        measure new runs, rebuild the routing table (also runs in the background at session start)
    moneyball report      per class: graduate | explore | try-effort | keep, with the evidence behind each
    moneyball stats       dispatches seen, suggestions, rewrites, exploration trials, estimated saving
    moneyball overhead    the startup tax: the fixed prompt each session and subagent pays, apart from the work
                          (add --probe --budget 0.30 to attribute it to instructions, MCP, skills, plugins, hooks)
    moneyball experiments derive trimmed startup-context variants into .moneyball/experiments/ (live files untouched)
    moneyball tune --budget <usd>   replay recurring tasks under each variant; recommend only safe trims

## When asked to trim CLAUDE.md, skills or MCP servers

Measure before you cut. Run `moneyball overhead` to see how big the startup tax is and what share of spend it is.
Then run `moneyball experiments` and `moneyball tune --budget <usd>`. Recommend a variant only when tune recommends it
(it saves tokens, has no regression, and keeps at least 90% of baseline outcomes). Give the human its `patch.diff` to
review. Never edit the live instruction files yourself. Spending commands refuse to run without `--budget`. Ask the
human for the amount.

Savings in `report` are net of the delegation credit: the parent context a subagent kept out.

The mode is set in `moneyball.config.json` (`"mode"`): `report` measures only, `suggest` adds a note to the dispatch,
`enforce` rewrites the model for graduated classes, and `explore` also routes about 10% of mechanical classes one tier
down so the cheaper model can earn its evidence. A model the caller pins explicitly is never overridden.
