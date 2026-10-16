---
name: incident-timeline
description: "How incident timelines are written: relative timestamps, the detection line and what each entry must say. Use when reconstructing what happened during an outage or incident, or writing an incident timeline."
---

# Incident timeline

1. Times are relative to detection: `T+00:00` is the moment someone noticed, `T-00:20` before it, `T+01:15` after.
2. The first line is `Detected by: <person, alert or customer>` and the absolute detection time in UTC.
3. Each entry: `T+hh:mm — <who> <did or saw what>`. One fact per line, no interpretation.
4. The timeline ends with `T+hh:mm — resolved` and the total duration.

```
Detected by: checkout error-rate alert, 2026-06-03 09:12 UTC
T-00:20 — deploy 4411 rolled out to all regions
T+00:00 — alert fired: checkout errors at 8%
T+00:31 — on-call rolled back deploy 4411
T+00:40 — resolved (duration 40 min)
```
