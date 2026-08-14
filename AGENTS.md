# AGENTS.md

If `HANDOFF.md` is present, read it at the start of a session and update it after material work.
It is not in the repository (`.gitignore`) — a fresh clone has no copy, and nothing depends on one.

**The architecture reference for this repository is [CLAUDE.md](CLAUDE.md). Read it — all of it —
before changing anything. This file is a pointer, not a summary.**

`CLAUDE.md` is short on purpose. Three bodies of guidance load only when they are needed: the
security gates ([`docs/security-gates.md`](docs/security-gates.md)), the map and rendering
internals ([`docs/map-internals.md`](docs/map-internals.md)), and the per-directory
`src/main/CLAUDE.md` and `src/renderer/CLAUDE.md`. Read them directly before touching the areas
they name — the two under `.claude/skills/` with the same names are trigger stubs pointing here,
not second copies.

That indirection is deliberate. This file used to hold its own copy of the project's purpose,
development commands and architecture, and the copy had silently fallen behind: it still described
a rendering layer that had been replaced, and stopped short of half the sections it was duplicating.
Two copies of one document do not stay in agreement, and the one an agent happens to open first
decides what it believes. So there is one document, and everything else points at it.

`CLAUDE.md` is written for whichever agent is reading it; nothing in it is specific to Claude Code.
