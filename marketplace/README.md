# marketplace

Listings of Q Branch on third-party skill marketplaces. Each folder holds the exact source of one listing, so a
listing can be rebuilt or corrected without reverse-engineering what was published.

## agensi

Listed free at [agensi.io](https://www.agensi.io) as **Q Branch**, submitted 2026-10-19.

`agensi/qbranch/SKILL.md` is the skill itself: it installs the gadgets a user picks, then explains how to drive them.
It has to be self-contained, because a marketplace buyer has none of this installed yet; the per-gadget skills inside
`packages/*/skills/` are companions to an installed gadget and do not work on their own.

Rebuild the upload (`SKILL.md` must sit at the ZIP root, with forward slashes — Windows PowerShell's
`Compress-Archive` writes backslash paths, which the uploader cannot read):

```bash
node scripts/pack-marketplace.mjs
```

The listing copy itself (summary, description, demo) lives on Agensi. Two rules it follows: the demo is real output
from a real run, never generated prose, and the description keeps an "Honest limits" section.
