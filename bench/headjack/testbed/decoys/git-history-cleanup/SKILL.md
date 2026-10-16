---
name: git-history-cleanup
description: "Tidies a branch history before merge: squashing fixups, rewording vague commits and reordering. Use when cleaning up commits before opening or merging a branch."
---

# git-history-cleanup

1. Squash "fix typo" and "wip" commits into the commit they fix.
2. Reword subjects to say what changed, under 50 characters.
3. Never rewrite history that others have pulled.
