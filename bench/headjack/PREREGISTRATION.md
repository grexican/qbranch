# headjack skill benchmark: pre-registration

Written and committed **before any benchmark result exists**. The criteria below may not be changed after the first
scored run. If they turn out to be wrong, a new version is registered and both are reported.

## The question

Does a just-in-time skill library (headjack) get the right skill used more often than the agent's native skill
preloading, at the library sizes real users have (5, 50, 500 skills), without loading skills it shouldn't?
And where does native preloading stop reaching skills at all?

## What is compared (arms)

| Arm | Setup |
|---|---|
| **none** | no skills installed (the floor: what the model does on its own) |
| **native** | every library skill installed the normal way (`.claude/skills`) |
| **native-again** | the native arm run a second time (A/A control: the noise floor) |
| **headjack** | the same skills in a headjack library, with its hook and root skills |

## Library sizes

5, 25, 100, 500, and **beyond the native listing cutoff**. The cutoff is measured by the benchmark itself (the largest
library at which a skill at the end of the listing can still be invoked by name natively), never assumed.

Each library contains the target skills plus filler drawn from public, license-compatible skill repositories at pinned
commits. Filler includes **near-duplicates of targets** (same domain, different conventions) as decoys.

## Target skills and how use is detected

Target skills are written for this benchmark: idiosyncratic conventions no model would produce by default. Each has
**canary rules** whose presence in the output is checked deterministically (a required phrase, format, ordering or
marker). A skill counts as **used** only if its canaries appear in the output, not merely because it was loaded.

## Prompts

Written **blind**: a generator sees only a short situation description, never a skill's name or text. Word overlap with
the target skills' descriptions is measured, and each prompt is tiered:

| Tier | Meaning | Share |
|---|---|---|
| named | asks for a skill by name | minority, at most 20% |
| lexical | shares key terms with an acceptable skill's description | |
| semantic | no shared key terms: the user's own words | the largest tier |
| negative | near-miss: sounds related, but no skill should be loaded | at least 20% |
| beyond-cutoff | names, or clearly needs, a skill positioned past the native listing cutoff | |

Each prompt has an **answer set**: zero (negative), one, or several acceptable skills (e.g. two design skills that both
fit). Prompts are split into a **dev** set (used to tune headjack's thresholds) and a **test** set (scored once,
thresholds frozen). Only test-set results are reported as results.

## Metrics

- **Use rate:** the share of non-negative prompts where an acceptable skill's canaries appear in the output (primary).
- **Load recall:** an acceptable skill was loaded, whether or not it was followed.
- **False-load rate:** the share of negative prompts where any library skill was loaded.
- **Cost:** tokens and wall time per prompt (reported, no pass criterion).
- 95% Wilson intervals on every rate. A difference counts only if it exceeds the native vs native-again difference.

## Hypotheses and pass/fail criteria

| | Hypothesis | Passes if |
|---|---|---|
| **H1** | At 100+ skills, headjack's use rate on **semantic** prompts beats native | headjack − native ≥ 15 points, and the 95% intervals do not overlap |
| **H2** | Past the native cutoff, native cannot reach skills; headjack can | beyond-cutoff use rate: native ≤ 20%, headjack ≥ 80% |
| **H3** | At 5–25 skills, headjack is not meaningfully worse than native | headjack ≥ native − 5 points on use rate |
| **H4** | headjack does not load skills it shouldn't | false-load rate: headjack ≤ native + 5 points |
| **H5** | Loading via headjack leads to the skill being followed as often as native | given an acceptable skill loaded, canary rate: headjack ≥ native − 5 points |

**Expected failures are reported.** If H3 fails (preloading wins on small libraries), the headjack README says so:
use native skills below the size where headjack starts to help. If H1 fails, headjack's claim is limited to H2 (reach).

## Replication

Everything needed to rerun is in the repo: target skills, prompts with answer sets, the filler manifest (repo +
commit + paths, fetched at run time), the runner, and the scoring. Results record the agent and version, the model, the
date, the qbranch commit, and seeds. Anyone with their own model access reproduces with one command.
