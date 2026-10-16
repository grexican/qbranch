---
name: sql-house-style
description: "SQL formatting and naming conventions for queries in this codebase: casing, comma placement, common table expressions and aliases. Use when writing, formatting or reviewing a SQL query."
---

# SQL house style

1. Keywords in lowercase (`select`, `from`, `where`), identifiers in snake_case.
2. Leading commas: every column after the first starts its line with `, `.
3. Every common table expression is named `cte_<what>` and the query starts with `with cte_...`. Never nest subqueries in `from`.
4. Table aliases are the table's first three letters, never single letters.
5. End the query with a comment line `-- grain: <one row per what>`.

```sql
with cte_paid as (
  select cus.id
       , sum(inv.total) as paid_total
  from customers cus
  join invoices inv on inv.customer_id = cus.id
  group by cus.id
)
select * from cte_paid
-- grain: one row per customer
```
