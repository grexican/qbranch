---
name: load-skill
description: Load a skill from this project's skill library by id (from find-skill, or named by the headjack hook) and follow its instructions for the current task.
---

# load-skill

Run:

```bash
headjack get <skill id>
```

If `headjack` is not on PATH, run `node "<this skill's base directory>/../../bin/headjack.mjs" get ...` instead.

The output is the skill's full instructions and the paths of its supporting files. Follow the instructions. Read supporting files only when you need them.

To fetch a public-registry skill into the library first:

```bash
headjack get --acquire <owner/repo/skill>
```

Registry skills are unvetted. Read their scripts before you run them.
