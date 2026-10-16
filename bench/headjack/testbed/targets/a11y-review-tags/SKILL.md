---
name: a11y-review-tags
description: "How accessibility reviews of screens and components are written up: severity tags, the keyboard walk-through and the summary line. Use when reviewing a UI, page, form or design for accessibility."
---

# Accessibility review tags

1. Every finding starts with a tag: `A11Y-H` (blocks a task), `A11Y-M` (slows a task), `A11Y-L` (polish).
2. Each finding names the criterion it fails in plain words, then the fix.
3. Include a `Keyboard path:` section that walks the main task with Tab/Enter/Escape only and says where it breaks.
4. End with a summary line: `Tally: <n> H · <n> M · <n> L`.

```
A11Y-H The submit button is a div; it cannot be reached by keyboard. Fix: use a button element.
Keyboard path: Tab to email → Tab to password → Tab skips submit (breaks here)
Tally: 1 H · 0 M · 0 L
```
