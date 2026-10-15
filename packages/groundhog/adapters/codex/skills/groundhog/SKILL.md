---
name: groundhog
description: Turn repeated agent work into lessons, runbooks and scripts. Use when you hit an error you have seen before, when a groundhog lesson blocks or annotates a command, when asked what the agents keep re-doing by hand, or when writing a runbook or verify script for a repeated procedure.
---

# groundhog

Agents re-learn the same things every session: the flag a command needs, the build that must run before the tests,
the interpreter name on this machine. groundhog mines the session transcripts for three signals:

- **Lessons:** a command fails and a related command then works, again and again. Accepted lessons live in
  `groundhog.lessons.json` (committed). They are injected at session start, and a PreToolUse hook catches matching
  commands: it blocks the first one per session with the fix, then lets the command through with a reminder.
- **Sequences:** the same 2–4 commands run by hand in many sessions. Draft them as a runbook skill, then promote the
  runbook to a script once its steps stop changing.
- **Friction:** commands that are repeated and fail a lot. Some of these are just tests doing their job; check them
  before you script around them.

## When a lesson blocks a command

Follow the lesson and run the fixed command. If the original command really is right this time, run it again
unchanged: the guard blocks only once per session, so a false positive cannot deadlock you.

## Commands

    groundhog scan                     mine recent transcripts (project scope; --all-projects for everything)
    groundhog report                   numbered candidates: L (lessons), S (sequences), F (friction), R (repeats)
    groundhog accept L3                add a mined lesson to the ledger
    groundhog add --when <regex> --instead "<text>"   add a lesson by hand (--remind = never block)
    groundhog draft S2 --name verify-backend          write a runbook skill draft under .groundhog/drafts/
    groundhog stats                    injections, guard hits, and whether accepted lessons stopped recurring

Prefer a lesson plus a hook over another paragraph in CLAUDE.md or AGENTS.md: the hook costs no tokens until the
mistake is about to happen, and it holds every time.
