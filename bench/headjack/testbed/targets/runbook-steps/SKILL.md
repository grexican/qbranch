---
name: runbook-steps
description: "The format for operational runbooks: how steps, expected results and fallbacks are written so anyone on call can follow them. Use when writing or rewriting a runbook, an ops procedure or step-by-step operating instructions."
---

# Runbook steps

1. Title line: `RUNBOOK · <system> · <task>`.
2. A `Before you start:` list of access and preconditions.
3. Steps are numbered `STEP 1 ▸`, `STEP 2 ▸`... Each step is exactly three lines:
   - the action (a command in backticks when there is one),
   - `Expect:` what you should see,
   - `If not:` what to do instead (often "stop and page the owner").
4. End with `Done when:` and a single observable condition.

```
RUNBOOK · queue workers · drain one node
Before you start: shell access to the node, the dashboard open
STEP 1 ▸ `systemctl stop worker`
Expect: the node's in-flight count falls to 0 within 2 minutes
If not: stop and page the queue owner
Done when: the node shows 0 jobs for 5 minutes
```
