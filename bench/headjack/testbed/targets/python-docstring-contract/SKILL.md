---
name: python-docstring-contract
description: "How Python functions are documented in this codebase: the docstring sections and their order. Use when writing or documenting Python functions, methods or modules."
---

# Python docstring contract

Every public function gets a docstring with these sections, in this order, and no others:

```python
def settle(invoice, amount):
    """Apply a payment to an invoice.

    Takes: invoice (Invoice), amount (Decimal, > 0)
    Gives: the updated Invoice
    Breaks when: amount exceeds the open balance (raises OverpaymentError)
    """
```

1. One summary line in the imperative.
2. `Takes:` parameters with types and constraints on one line.
3. `Gives:` the return value.
4. `Breaks when:` the conditions that raise, and what they raise.
Never use Google, NumPy or reST docstring styles.
