---
name: qbranch
description: Install and run the Q Branch gadgets for coding agents - just-in-time skills (headjack), compressed API calls (middleout), evidence-based model routing (moneyball) and a lessons ledger that hooks enforce (groundhog). Use when asked to set up Q Branch, to make an agent cheaper or more reliable, to stop repeating the same mistakes across sessions, to load skills on demand instead of preloading them, or to find out what agent runs cost and which could run on a smaller model.
license: MIT
---

# Q Branch

Four open-source gadgets for coding agents. Each one installs on its own, works across Claude Code, Cursor, Codex,
Gemini CLI, Copilot and Windsurf, and writes a stats file so you can see whether it is earning its place.

They share one idea: **guarantee steps with hooks instead of longer prompts.** A hook costs nothing until the moment
it applies, and then it fires every time.

Source (MIT): https://github.com/grexican/qbranch

| Gadget | What it does |
|---|---|
| **headjack** | Skills arrive when a task needs them. The library is indexed and searched per prompt instead of preloaded, so a large library stops crowding the context. |
| **middleout** | One plan over your MCP servers: chained calls, one-to-many fan-out, automatic pagination, and only the fields you select come back. |
| **moneyball** | Measures every subagent run from the transcripts (model, cost, whether it worked) and graduates repeated work to a cheaper model once the evidence supports it. |
| **groundhog** | Mines transcripts for the lessons agents keep re-learning, keeps the accepted ones in a committed ledger, and enforces them with a hook. |

## Install

Ask the user which gadgets they want, then install those. Everything below is safe to re-run.

**Claude Code** (one marketplace, install only what you want):

```bash
claude plugin marketplace add grexican/qbranch
claude plugin install groundhog@qbranch     # and/or headjack, middleout, moneyball
```

**Any other agent** (Cursor, Codex, Gemini CLI, Copilot, Windsurf). Requires Node 22.13+:

```bash
git clone https://github.com/grexican/qbranch
node qbranch/scripts/install.mjs all --platform cursor --project .
```

It copies the skills, merges the hooks and MCP config into that platform's project files, and `--uninstall` removes
exactly what it added. No Node on the machine? Install the native binary instead:

```bash
curl -fsSL https://raw.githubusercontent.com/grexican/qbranch/main/scripts/install.sh | sh   # macOS, Linux
irm https://raw.githubusercontent.com/grexican/qbranch/main/scripts/install.ps1 | iex        # Windows PowerShell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/grexican/qbranch/main/scripts/install.ps1 | iex"   # Windows Command Prompt
qbranch install all --platform claude
```

Later, `qbranch update` refreshes the binary (plugin updates do not); the plugins say when it has fallen behind.

After installing, restart the agent session so the hooks load.

## Use it

Each gadget ships its own skill, so once installed the agent gets detailed instructions in context when they apply.
The commands worth knowing:

```bash
groundhog scan && groundhog report     # what your agents keep re-doing and re-learning
groundhog accept L1                    # add a mined lesson to the committed ledger
moneyball scan && moneyball report     # per task class: graduate | explore | try-effort | keep
moneyball overhead                     # what the fixed startup prompt costs you per session
headjack adopt && headjack find <task> # move preloaded skills into the library, then search it
```

## What to expect

- **groundhog** starts finding lessons once there is session history to mine. A fresh machine has nothing to learn from
  yet; it learns from the sessions you run after installing.
- **moneyball** needs at least 10 runs of a task class before it will recommend anything. It judges cost per
  *completed* task, so a cheaper model that needs retries is not counted as cheaper.
- **headjack** helps most with a large library. With only a handful of skills, your agent's built-in preloading is
  fine, and the honest answer is to keep using it.
- **middleout** earns its place on per-item fan-out over chatty APIs, and with smaller models that get pagination
  wrong. For a one-off call, a raw tool call is simpler.
