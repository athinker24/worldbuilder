# AGENTS.md

If `HANDOFF.md` is present, read it at the start of a session and update it after material work.
It is not in the repository (`.gitignore`) — a fresh clone has no copy, and nothing depends on one.

**The architecture reference for this repository is [CLAUDE.md](CLAUDE.md). Read it — all of it —
before changing anything. This file is a pointer, not a summary.**

`CLAUDE.md` is short on purpose. Three bodies of guidance load only when they are needed: the
security gates (`.claude/skills/security-gates`), the map and rendering internals
(`.claude/skills/map-internals`), and the per-directory `src/main/CLAUDE.md` and
`src/renderer/CLAUDE.md`. If your harness does not load skills by itself, read those files
directly before touching the areas they name.

That indirection is deliberate. This file used to hold its own copy of the project's purpose,
development commands and architecture, and the copy had silently fallen behind: it still described
a rendering layer that had been replaced, and stopped short of half the sections it was duplicating.
Two copies of one document do not stay in agreement, and the one an agent happens to open first
decides what it believes. So there is one document, and everything else points at it.

`CLAUDE.md` is written for whichever agent is reading it; nothing in it is specific to Claude Code.
