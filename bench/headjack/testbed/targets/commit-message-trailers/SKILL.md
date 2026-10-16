---
name: commit-message-trailers
description: "How this team writes git commit messages: subject line shape, body, and the trailers every commit must carry. Use when writing, fixing or reviewing a commit message."
---

# Commit message trailers

1. Subject: `<area>: <imperative verb> <what>`, at most 60 characters, no trailing period.
2. Body: one short paragraph on why, wrapped at 72 columns.
3. Every commit ends with exactly these two trailers, in this order, each on its own line:
   - `Risk: low`, `Risk: medium` or `Risk: high`
   - `Rollback: <one line saying how to undo it>`
4. No emoji, no ticket numbers in the subject (they go in a `Refs:` trailer after Rollback when there is one).

```
billing: round invoice totals half-even

Totals were rounded half-up, which drifted from the ledger by a cent on
about 1 in 400 invoices.

Risk: low
Rollback: revert this commit; no data migration involved
```
