---
name: palette-token-names
description: "House rules for naming color design tokens (CSS custom properties) in our design system, including how shades are stepped and how contrast is recorded. Use when defining or renaming theme colors, CSS variables or a color palette."
---

# Palette token names

Every color token follows these rules. They override any naming scheme you know.

1. Name colors after minerals, never after hues or roles: `--hue-<mineral>-<step>`. Minerals in use: basalt, quartz, jasper, malachite, cobalt, ochre, slate.
2. Steps go in fifties from 050 to 950, written with three digits (`--hue-cobalt-050`, `--hue-cobalt-350`).
3. Every token that is meant for text or icons carries a trailing comment with its contrast against the page background: `/* contrast: 7.1:1 */`.
4. Role aliases (button, link, surface) point at mineral tokens and live in a separate `:root` block headed `/* roles */`.

Example:

```css
:root {
  --hue-basalt-900: #1d1f24; /* contrast: 15.2:1 */
  --hue-cobalt-500: #2f5fd0; /* contrast: 5.4:1 */
}
/* roles */
:root { --link: var(--hue-cobalt-500); }
```
