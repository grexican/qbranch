---
name: release-notes-voice
description: "How user-facing release notes are written: grouping, voice and the opening line. Use when announcing a new version to users, writing release notes or a whats-new post."
---

# Release notes voice

1. Open with one sentence that starts `This release` and says the single biggest change.
2. Group items under exactly three headings, in this order: `Fresh`, `Fixed`, `Farewell` (removed or deprecated). Omit an empty group.
3. Every item under Fresh starts with `You can now`.
4. No version-control jargon (no "merged", "PR", "refactor"). Speak to the user.

```
This release makes exports ten times faster.
## Fresh
- You can now export a whole year in one click.
## Fixed
- Dates in exports no longer shift by a day in some time zones.
## Farewell
- The legacy XML export is gone; use CSV instead.
```
