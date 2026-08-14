---
name: security-gates
description: The 41 numbered security gates of the .world file format — what a shared world can do coming in and what it must not carry out. Read before editing src/main/db.ts, src/main/index.ts, unpackWorld, packWorld, the CSP, the IPC write boundary, asset handling, or anything that parses a file the user did not write.
---

# Security contract

**Read [`docs/security-gates.md`](../../../docs/security-gates.md) — all 41 gates, in full.**

The gates live in `docs/` rather than here because they are not agent configuration: they are this
project's security contract, the README sends users to them, and a contributor looking for how a
shared `.world` is treated will not think to open a `.claude/` directory. This file is the trigger
that tells you to go and read them; that file is the document.

Never weaken a gate to make a feature work. Each one exists because something specific was possible
without it, and gate 21 records how every one of them was verified: by breaking the fix first and
watching the check fail.
