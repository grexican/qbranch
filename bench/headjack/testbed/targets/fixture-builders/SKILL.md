---
name: fixture-builders
description: "How test data is created in this codebase: builder functions, their naming and how fields are overridden. Use when writing unit or integration tests that need sample objects, fixtures or test data."
---

# Fixture builders

1. Never write object literals for domain objects in tests. Build them with builder functions named `a<Thing>()` or `an<Thing>()` (`aCart()`, `anOrder()`).
2. Builders return sensible defaults and expose `.with<Field>(value)` methods for overrides, then `.build()`.
3. Builders live together at the top of the test file (or in a builders file), and that block ends with the comment `// builders end`.

```js
const aCart = () => ({ items: [], withItems(items) { this.items = items; return this; }, build() { return { items: this.items }; } });
// builders end

test('...', () => {
  const cart = aCart().withItems([anItem().withPrice(5).build()]).build();
});
```
