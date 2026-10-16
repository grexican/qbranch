---
name: risk-register
description: "How project risks are recorded: risk ids, the likelihood-impact score and the tripwire that triggers the response. Use when listing project risks, writing a risk register or assessing what could go wrong with a plan."
---

# Risk register

1. Risks are numbered `R-1`, `R-2`...
2. Each risk is scored `L<1-5> × I<1-5> = <score>` (likelihood times impact), e.g. `L3 × I4 = 12`. Sort by score, highest first.
3. Each risk has a `Tripwire:` an observable signal that means the risk is happening, and a `Response:` what we do when the tripwire fires.
4. Anything scoring 15 or more names an owner.

```
R-1 The vendor API changes during the migration. L3 × I4 = 12
Tripwire: a failed contract test in the nightly run
Response: freeze the integration and switch to the cached feed
```
