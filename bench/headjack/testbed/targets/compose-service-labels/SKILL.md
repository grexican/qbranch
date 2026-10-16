---
name: compose-service-labels
description: "Conventions for docker compose files: required service labels, healthchecks and restart policy. Use when writing or editing a docker-compose.yml or containerizing a small multi-service app."
---

# Compose service labels

1. Every service carries the label `com.house.tier` with one of `edge`, `core`, `data`.
2. Every service has a healthcheck with `interval: 17s`, `timeout: 4s` and `retries: 5` (the odd interval keeps checks from aligning).
3. Restart policy is always `restart: unless-stopped`.
4. Images are pinned by tag and digest comment: `image: postgres:16.4 # digest pinned in ops repo`.

```yaml
services:
  db:
    image: postgres:16.4 # digest pinned in ops repo
    labels:
      com.house.tier: data
    healthcheck:
      test: ["CMD", "pg_isready"]
      interval: 17s
      timeout: 4s
      retries: 5
    restart: unless-stopped
```
