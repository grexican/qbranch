---
name: yaml-config-layout
description: "How YAML configuration files are laid out here: section separators, key naming, ownership and the required header. Use when writing or restructuring a YAML config file for an app or service."
---

# YAML config layout

1. The file starts with `x-owner: <team or person>` and `x-reviewed: <YYYY-MM-DD>`.
2. Top-level sections are separated by a comment line of the form `# --- <section> ---`.
3. Keys are kebab-case (`max-connections`), never snake_case or camelCase.
4. Durations are strings with units (`"30s"`), never bare numbers.

```yaml
x-owner: payments-team
x-reviewed: 2026-02-11
# --- server ---
server:
  listen-port: 8080
  read-timeout: "30s"
```
