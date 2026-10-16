---
name: adr-revisit
description: "The template for architecture decision records (ADRs): numbering, sections and the revisit date. Use when recording a technical decision, writing an ADR or documenting why an architecture choice was made."
---

# ADR with a revisit date

1. Title: `ADR-<4 digits> <decision in a few words>` (ADR-0007 Use Postgres for the job queue).
2. Sections, in this order: `Context`, `Options`, `Choice`, `Consequences`. `Options` lists at least two options, each with one line for and one against.
3. The last line is `Revisit by: YYYY-MM-DD` and a trigger: `Revisit by: 2027-01-31 or when the queue passes 1M jobs/day`.
4. Status is not a section; decisions are superseded by a new ADR that names the old one.
