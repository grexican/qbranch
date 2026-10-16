---
name: sql-query-tuning
description: "Speeds up slow SQL queries: reading the query plan, indexes and rewriting joins. Use when a database query is slow or a query plan looks wrong."
---

# sql-query-tuning

1. Run EXPLAIN ANALYZE and find the most expensive node.
2. Check for missing indexes on join and filter columns.
3. Rewrite correlated subqueries as joins and re-measure.
