---
name: toml-config-guide
description: "Conventions for TOML configuration files: tables, arrays of tables and comments. Use when writing a TOML config such as pyproject.toml or Cargo.toml."
---

# toml-config-guide

1. Group settings in [tables] by component.
2. Prefer inline tables only for short values.
3. Comment every non-obvious value on the line above it.
