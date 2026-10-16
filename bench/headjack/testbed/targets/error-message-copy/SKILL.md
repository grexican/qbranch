---
name: error-message-copy
description: "How user-facing error messages are worded in our products: the three parts of a message and the error code. Use when writing or rewriting error messages, validation messages or failure text shown to users."
---

# Error message copy

Every user-facing error message has three parts, then a code:

1. What happened, in plain words, without blame ("We couldn't save your changes.").
2. Why, if known ("The file is larger than 10 MB.").
3. `What to do:` one concrete action ("What to do: compress the file or split it in two.").
4. The error code at the end in square brackets: `[E-1042]` (E- plus four digits).

Never use "Oops", "Error:", "invalid" or exclamation marks.

```
We couldn't upload your photo. The file is larger than 10 MB. What to do: choose a smaller photo. [E-2201]
```
