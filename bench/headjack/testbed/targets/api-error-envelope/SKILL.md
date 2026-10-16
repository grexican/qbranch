---
name: api-error-envelope
description: "The JSON shape of every error our HTTP APIs return, and how error kinds and trace references are named. Use when designing API error responses, writing an error handler or documenting API errors."
---

# API error envelope

Every error response body is exactly this shape (no top-level `error` or `message` key):

```json
{
  "fault": {
    "kind": "quota.exceeded",
    "hint": "You have used 1000 of 1000 calls this hour. Retry after 14:00 UTC.",
    "trace_ref": "tr_8f3a2c"
  }
}
```

1. `kind` is dot.case, `<area>.<problem>`.
2. `hint` is one sentence a human can act on.
3. `trace_ref` is `tr_` plus 6 hex characters.
4. The HTTP status still carries the class (4xx/5xx); the body never repeats it.
