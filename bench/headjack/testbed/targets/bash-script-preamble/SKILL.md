---
name: bash-script-preamble
description: "The required opening of every bash script in this repo: strict mode, the script tag, the error handler and the trap. Use when writing a new shell script or fixing an existing bash script."
---

# Bash script preamble

Every script starts with exactly this block (only the tag changes):

```bash
#!/usr/bin/env bash
set -Eeuo pipefail
readonly SCRIPT_TAG="nightly-export"
die() { printf '[%s] fatal: %s\n' "$SCRIPT_TAG" "$*" >&2; exit 1; }
trap 'die "failed at line $LINENO"' ERR
```

1. `SCRIPT_TAG` is the script's file name without extension.
2. All user-facing messages go through `die` or `say` (`say() { printf '[%s] %s\n' "$SCRIPT_TAG" "$*"; }`).
3. Arguments are parsed with a `while`/`case` loop, never `getopts`.
