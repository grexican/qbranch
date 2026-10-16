---
name: code-review-severity
description: "How code review comments are written in this team: severity tags, the suggestion format and the confidence footer. Use when reviewing code, a diff or a pull request and writing review comments."
---

# Code review severity

1. Every comment starts with a severity tag: `[S1]` must fix before merge, `[S2]` should fix soon, `[S3]` take it or leave it.
2. After the tag: the file and line (`orders.ts:42`), the problem, then the suggested change.
3. The review ends with `Confidence: <n>/5` (how sure you are the change is correct overall) and `Verdict: ship`, `Verdict: ship after S1s` or `Verdict: rework`.

```
[S1] orders.ts:42 the total ignores refunds. Subtract refunded line items before summing.
[S3] orders.ts:10 the name `tmp` hides intent; consider `unpaidOrders`.
Confidence: 4/5
Verdict: ship after S1s
```
