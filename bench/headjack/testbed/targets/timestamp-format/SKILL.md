---
name: timestamp-format
description: "How dates and times are written in data files, exports, logs and reports here: the timestamp shape and the naming of time fields. Use when a file, export, schema or log includes dates or times."
---

# Timestamp format

1. Every timestamp is UTC, written `YYYY-MM-DD@HH:MM:SSZ` with an at-sign between date and time: `2026-10-16@14:05:09Z`.
2. Every time field or column name ends in `_at_utc` (`created_at_utc`, or `CREATED_AT_UTC` where headers are upper case).
3. Dates without times are `YYYY-MM-DD` and their fields end in `_on` (`shipped_on`).
4. Never write local times or offsets in stored data; convert when displaying.
