---
name: pr-description-proof
description: "The template for pull request descriptions in this repo: sections, the proof of testing and the blast radius. Use when writing or improving a pull request (PR) description or a merge request summary."
---

# PR description with proof

Sections, in this order:

```
### Why
### What
### Proof
### Blast radius
```

1. `Why`: the problem in two sentences at most.
2. `What`: the change as a short list.
3. `Proof`: how you know it works: commands run and their result, screenshots, or numbers. "Tested locally" alone is not proof.
4. `Blast radius`: one line, `Blast radius: <who or what breaks if this is wrong>`.
