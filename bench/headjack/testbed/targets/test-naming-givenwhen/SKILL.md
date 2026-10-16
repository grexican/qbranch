---
name: test-naming-givenwhen
description: "How unit tests are named and structured in this codebase: the test name pattern and the oracle comment. Use when writing, naming or reviewing unit tests in any language."
---

# Test naming: given/when/then

1. Test names follow `given_<state>__when_<action>__then_<outcome>` (snake_case, double underscores between parts), in every language.
2. Each test body has a single comment line stating where the expected value comes from: `// oracle: <source>` (or `# oracle:` in Python), e.g. `// oracle: worked by hand from the pricing table`.
3. One behavior per test; no loops over cases inside a test (use the framework's parameterization).

```js
test('given_empty_cart__when_total__then_zero', () => {
  // oracle: an empty cart costs nothing by definition
  expect(total([])).toBe(0);
});
```
