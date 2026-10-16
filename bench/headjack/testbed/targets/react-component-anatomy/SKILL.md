---
name: react-component-anatomy
description: "How a React component file is laid out in this codebase: section order, section markers and the naming of its props type. Use when creating, splitting or reviewing a React component."
---

# React component anatomy

A component file has four sections, in this order, each introduced by a marker comment on its own line:

1. `// §props` the props type. It is named `<Component>Knobs` (never `Props`).
2. `// §state` hooks and derived values.
3. `// §handlers` event handlers, each named `on<Thing><Event>`.
4. `// §render` the returned JSX.

One component per file, a named export (no default export).

```tsx
// §props
type OrderListKnobs = { customerId: string };
export function OrderList({ customerId }: OrderListKnobs) {
  // §state
  // §handlers
  // §render
  return <ul />;
}
```
