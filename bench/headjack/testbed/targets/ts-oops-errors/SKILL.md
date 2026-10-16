---
name: ts-oops-errors
description: "How TypeScript code in this codebase handles expected failures: the result type, its helper functions and error codes. Use when writing TypeScript functions that can fail, error handling, or parsing and validation code."
---

# TypeScript: oops errors

1. Expected failures are returned, never thrown. A function that can fail returns `Fine<T> | Oops<Code>`.
2. Build them with the helpers `fine(value)` and `oops('code', 'message')`. Codes are kebab-case string literals.
3. Callers branch on `r.ok`.
4. Only programmer errors (impossible states) throw.

```ts
type Fine<T> = { ok: true; value: T };
type Oops<C extends string> = { ok: false; code: C; message: string };
const fine = <T>(value: T): Fine<T> => ({ ok: true, value });
const oops = <C extends string>(code: C, message: string): Oops<C> => ({ ok: false, code, message });

function parseAge(s: string): Fine<number> | Oops<'not-a-number' | 'out-of-range'> {
  const n = Number(s);
  if (Number.isNaN(n)) return oops('not-a-number', `"${s}" is not a number`);
  return n < 0 || n > 150 ? oops('out-of-range', 'age must be 0-150') : fine(n);
}
```
