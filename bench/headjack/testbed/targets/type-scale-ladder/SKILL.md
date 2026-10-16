---
name: type-scale-ladder
description: "Our typography scale: how font sizes, line heights and the base size are defined as tokens for web projects. Use when setting up fonts, text sizes, headings or a type scale in CSS."
---

# Type scale ladder

1. Font sizes are rungs on a ladder: `--type-rung-0` is the base, `--type-rung-1`, `--type-rung-2`... go up, `--type-rung--1` goes down. Never name sizes sm/md/lg or h1/h2.
2. The base is 17px and the ratio is 1.2. State both in a header comment exactly like this: `/* ladder: ratio 1.2 · base 17px */`.
3. Every rung is paired with a leading token: `--lead-rung-<n>` (unitless).
4. Headings map to rungs in a separate block, never with raw pixel values.

```css
/* ladder: ratio 1.2 · base 17px */
:root {
  --type-rung-0: 1.0625rem; --lead-rung-0: 1.55;
  --type-rung-1: 1.275rem;  --lead-rung-1: 1.4;
}
```
