---
name: find-skill
description: Search this project's skill library for task-specific instructions (workflows, formats, checklists, domain know-how). Use at the start of any non-trivial task, and whenever a request names a skill you do not have. Only the root skills are installed; every other skill is found here.
---

# find-skill

Run:

```bash
headjack find <what you are trying to do, in plain words>
```

If `headjack` is not on PATH, run `node "<this skill's base directory>/../../bin/headjack.mjs" find ...` instead.

The output is a ranked list of skill ids with descriptions. If one is about this task, load it with the `load-skill` skill and follow it.

When nothing in the library is a strong match, the output also lists public-registry candidates. Fetch one only if it is clearly about this task and comes from a reputable, well-installed source.
