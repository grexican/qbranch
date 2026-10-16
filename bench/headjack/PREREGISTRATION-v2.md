# headjack skill benchmark: pre-registration v2

Registered before any benchmark **result** exists. v1 (`PREREGISTRATION.md`) stays in force and is reported too. v2
changes only the definition of the native cutoff and adds one hypothesis; everything else in v1 is unchanged.

## Why a v2

v1 defined the native cutoff as "the largest library at which a skill late in the listing can still be invoked by
name". Probes on Claude Code 2.1.285 (a measurement, not a result) showed that definition is the wrong limit:

- Claude Code **drops skill descriptions, not names**, once the listing exceeds its budget: roughly 8 skills keep a
  description on Haiku and roughly 105 on Sonnet; past that, skills appear by name only.
- Invoking a skill **by name** keeps working up to the model's context limit (about 15,000 skills still worked on Haiku;
  about 21,800 skills still worked on Sonnet).

So the v1 cutoff is the context limit, which no real library reaches. The limit that matters to a real user is the
**description cutoff**: past it, a natural request can't be matched to a skill, because the skill's description isn't
in context.

## v2 definitions

- **Description cutoff** (per model, measured by the benchmark itself): the number of skills at which a skill positioned
  late in the alphabetical listing no longer has its description in the model's context. Measured by recording the
  listing the model actually receives.
- **Past-cutoff skills:** target skills positioned (alphabetically) beyond the description cutoff.

## v2 hypothesis

| | Hypothesis | Passes if |
|---|---|---|
| **H2b** | Past the description cutoff, native preloading cannot match a **natural** request to the right skill; headjack can | on lexical + semantic prompts whose acceptable skills are all past-cutoff: native use rate ≤ 30%, headjack ≥ 70% |

## v1 H2 stays on the record

v1 H2 (named requests past the v1 cutoff: native ≤ 20%, headjack ≥ 80%) is reported as written. The literal v1 cutoff
is the context limit (thousands of skills) and is not run at full scale. Instead, the named-request reach test is run at
every benchmark size, and v1 H2 is reported against it. Expected verdict, from the probes: **native passes named reach
at every practical size**, so v1 H2 is expected to **fail**. That failure is reported, not redefined away.

## Corrections this triggers regardless of results

headjack's README claim that big listings "lose entries" is wrong for current Claude Code: they lose descriptions. It
is corrected now, before results, because it's a measured fact, not a benchmark outcome.
