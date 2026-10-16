---
name: cli-help-text
description: "How command-line tools in our projects present their help text: the usage line, verb list, flags and the exit code footer. Use when writing --help output, a man page or usage documentation for a CLI tool."
---

# CLI help text

The help text has these blocks, in this order:

```
usage: tally <verb> [flags]

VERBS
  add       record an entry
  report    print totals

FLAGS
  -q, --quiet   print nothing on success

Exit codes: 0 ok · 1 usage · 2 runtime
```

1. Block headings are upper case on their own line: `VERBS`, `FLAGS`.
2. Every tool ends its help with the exit code footer, exactly in that form.
3. Descriptions are lowercase, no trailing period, at most 50 characters.
