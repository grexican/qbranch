---
name: changelog-ledger
description: "The format of the CHANGELOG file: version headers, dates, codenames and the per-line change markers. Use when adding a version to a changelog or summarizing what changed between versions."
---

# Changelog ledger

1. Newest version first. Each version header is `## [x.y.z] · YYYY-MM-DD · <codename>`; codenames are trees (alder, birch, cedar...).
2. Each change is one line starting with a marker: `+ ` added, `~ ` changed, `- ` removed, `! ` security.
3. No sub-headings inside a version. No links.
4. A line ends with the area in parentheses: `(exports)`.

```
## [2.3.0] · 2026-05-04 · cedar
+ year-long export in one click (exports)
~ CSV dates are now ISO 8601 (exports)
- legacy XML export (exports)
```
