---
name: milestone-plan
description: "How project plans are broken into milestones here: milestone ids, exit tests and the cut line. Use when planning a project, a roadmap for the next weeks, or breaking a large piece of work into phases."
---

# Milestone plan

1. Milestones are lettered: `MS-A`, `MS-B`, `MS-C`... never numbered phases or sprints.
2. Each milestone has a one-line goal and an `Exit test:` line: an observable check that says the milestone is done.
3. The plan ends with a `Cut line:` listing what gets dropped, in order, if the plan runs late.
4. At most five milestones; dates are week numbers (`wk 3`), not calendar dates.

```
MS-A (wk 1-2) Read path on the new database
Exit test: the orders page serves from the new database for 10% of traffic
Cut line: 1) admin export 2) audit history
```
