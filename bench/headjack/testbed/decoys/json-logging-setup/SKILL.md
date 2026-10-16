---
name: json-logging-setup
description: "Sets up JSON structured logging in an application, with a logger library and request ids. Use when switching an app to JSON logs or adding request tracing to logs."
---

# json-logging-setup

1. Emit one JSON object per line with timestamp, level and message.
2. Attach a request id to every log line in a request.
3. Never log secrets or full request bodies.
