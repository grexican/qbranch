---
name: structured-log-lines
description: "The format of application log lines in our services: key order, event naming and the service field. Use when adding logging to code, writing log statements or defining a log format."
---

# Structured log lines

Every log line is logfmt with keys in this order:

```
lvl=info evt=order.paid svc=checkout order_id=1001 took_ms=42
```

1. `lvl` first (debug, info, warn, fail; never "error"), then `evt`, then `svc`, then the rest.
2. `evt` is dot.case `<noun>.<past-tense verb>` (`order.paid`, `cache.missed`).
3. Durations are `took_ms`. No free-text message key: the event name is the message.
