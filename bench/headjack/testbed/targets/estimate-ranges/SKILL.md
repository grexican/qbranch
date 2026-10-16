---
name: estimate-ranges
description: "How effort and time estimates are given in this team: the range format, the median and the confidence label. Use when estimating how long work will take, sizing tasks or giving a delivery forecast."
---

# Estimate ranges

1. Never give a single number. Every estimate is three points in working days, best / likely / worst, followed by the median: `2d / 4d / 9d (p50 4d)`.
2. Add a confidence label: `confidence: lo`, `confidence: mid` or `confidence: hi`.
3. If the worst case is more than 3x the best case, say what unknown drives it in one line starting `Spread driver:`.

```
Billing page: 2d / 4d / 9d (p50 4d), confidence: mid
Spread driver: the payment provider's sandbox has been unreliable
```
