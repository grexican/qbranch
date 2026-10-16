---
name: http-status-picker
description: "Chooses the right HTTP status code for an API response. Use when deciding which status code an endpoint should return."
---

# http-status-picker

1. 400 for malformed input, 422 for valid-but-rejected input.
2. 401 when unauthenticated, 403 when authenticated but not allowed.
3. 409 for conflicts, 429 for rate limits with a Retry-After header.
