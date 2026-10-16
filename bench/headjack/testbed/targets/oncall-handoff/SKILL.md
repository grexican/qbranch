---
name: oncall-handoff
description: "The note the outgoing on-call engineer writes at the end of a shift: what carries over, what to watch and the quiet-hours rule. Use when handing over on-call, ending a support shift or summarizing open operational issues for the next person."
---

# On-call handoff

The note has these lines and sections, in this order:

1. `Shift: <start> → <end> (<your name>)`
2. `Carry-over:` open issues the next person now owns, each with its current state.
3. `Watch list:` things that are fine now but might not be, with the signal to watch.
4. `Pages: <n>` the number of pages during the shift.
5. `Quiet-hours rule:` what is allowed to wait until morning.

```
Shift: Mon 09:00 → Tue 09:00 (Sam)
Carry-over: disk on the reports node at 86%, cleanup job scheduled for 10:00
Watch list: login latency, fine now; page if p95 passes 800 ms
Pages: 2
Quiet-hours rule: certificate warnings under 14 days can wait until morning
```
