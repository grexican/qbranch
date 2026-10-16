---
name: json-schema-stamps
description: "Required metadata on every JSON Schema in this codebase: ownership comment, stability marker and id format. Use when writing or editing a JSON Schema, or defining the shape of a JSON payload or config."
---

# JSON Schema stamps

1. Every schema's root has `"$comment": "owner: <team>"`.
2. Every schema and every object property that is not obvious carries `"x-stability": "experimental"` or `"x-stability": "stable"`.
3. `$id` is `urn:house:<name>:<major>`, e.g. `urn:house:invoice:2`.
4. `additionalProperties` is always stated explicitly.

```json
{
  "$id": "urn:house:invoice:2",
  "$comment": "owner: billing",
  "x-stability": "stable",
  "type": "object",
  "additionalProperties": false
}
```
