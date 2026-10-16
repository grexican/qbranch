---
name: endpoint-catalog
description: "How HTTP API endpoints are documented in our API reference: the catalog table, its columns and the per-route line format. Use when documenting a REST or HTTP API, listing its routes or writing an API reference."
---

# Endpoint catalog

1. Start with a catalog table with exactly these columns: `Route`, `Purpose`, `Auth`, `Idempotent?`.
2. Then one section per route, whose first line is `VERB /path — one-line summary` (an em dash between path and summary).
3. Each route section lists request fields, response fields, and errors by their kind.

```
| Route | Purpose | Auth | Idempotent? |
|---|---|---|---|
| GET /v1/orders | list orders | token | yes |

GET /v1/orders — list a customer's orders, newest first
```
