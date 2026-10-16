---
name: meeting-notes-ledger
description: "The format for meeting notes in this team: how decisions, open questions and action items are recorded so they can be found later. Use when writing up, summarizing or cleaning up notes from a meeting or call."
---

# Meeting notes ledger

1. First line: `<YYYY-MM-DD> · <meeting name> · <who attended, first names>`.
2. Sections, in this order: `Decisions`, `Open questions`, `Actions`. Nothing else (no summary, no discussion log).
3. Decisions are numbered `D-1`, `D-2`... Open questions are `Q-1`, `Q-2`...
4. Every action is one line: `→ @owner by YYYY-MM-DD: <what>`. An action without an owner or date is not written down; it becomes an open question.

```
2026-03-02 · pricing sync · Ana, Joe, Mei
Decisions
D-1 Annual plans get two months free.
Open questions
Q-1 Do we grandfather existing monthly customers?
Actions
→ @ana by 2026-03-09: draft the pricing page copy
```
