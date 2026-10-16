---
name: kpi-tile-spec
description: "How metric tiles (KPI cards) on dashboards are specified: label style, the delta indicator, the comparison period and the footnote. Use when designing a dashboard, a stat card or KPI tiles, or writing their spec."
---

# KPI tile spec

Each tile is specified with these lines, in this order:

```
TILE · Active customers
Value: 12,480
Delta: ▲ 4.2% vs prior 28d
Footnote: counts customers with one paid invoice in the window
```

1. The label line starts `TILE · ` and uses sentence case.
2. The delta is always against the prior 28 days, written `vs prior 28d`, with ▲ for up and ▼ for down (no colors named in text; color follows the arrow).
3. Every tile has a `Footnote:` that defines the metric in one line.
