---
name: weekly-status
description: "The weekly status update format for projects: the sections, the overall weather and how slips are reported. Use when writing a weekly update, progress report or project status summary."
---

# Weekly status

1. First line: `Weather: sunny`, `Weather: cloudy` or `Weather: stormy` (overall health).
2. Three sections, in this order: `Shipped`, `Slipped`, `Next`. `Slipped` is never omitted; write "nothing slipped" if so.
3. Every slipped item says the new date and why, in that order: `<item> → <new date> (<why>)`.
4. At most five bullets per section.

```
Weather: cloudy
## Shipped
- Import from spreadsheets
## Slipped
- SSO login → 2026-04-20 (waiting on the identity provider)
## Next
- Billing page
```
