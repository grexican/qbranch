---
name: react-hook-contracts
description: "The contract every custom React hook in this codebase follows: what it returns, how loading and failure are reported, and the file header. Use when writing or refactoring a custom React hook, data fetching in React, or hook-based state."
---

# React hook contracts

1. The first line of every hook file is `// hook-contract: v1`.
2. A hook returns one object `{ status, data, problem }`. Never return a tuple, never call the field `error` or `loading`.
3. `status` is exactly one of `'idle' | 'busy' | 'done' | 'failed'`.
4. `problem` is `null` or `{ code: string, message: string }`.
5. Hooks never throw; they set `status: 'failed'` and fill `problem`.

```ts
// hook-contract: v1
export function useOrders(customerId: string) {
  const [state, set] = useState({ status: 'idle', data: null, problem: null });
  // ... set({ status: 'busy', data: null, problem: null }) while fetching
  return state;
}
```
