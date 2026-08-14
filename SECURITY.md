# Security

## Reporting

Open an issue. If you would rather not do that in public, say so in an issue with no detail and
a way to reach you.

This is a personal project with one maintainer, so there is no response-time promise. What there
is: every fix gets a regression check, and the check is verified by breaking the fix first and
watching it fail — see [gate 21](docs/security-gates.md#gate-21).

## What this app treats as hostile

A `.world` file is designed to be shared, so a file the app did not write is treated as untrusted
input: it is someone else's SQLite database opened over yours, its text is rendered, and its images
are written to disk. The rules that hold that in are written up as
**[41 numbered gates](docs/security-gates.md)**, each one there because something specific was
possible without it.

Two harnesses stand behind them, both run on every pull request:

- `node tests/db.test.ts` — 303 assertions, including the gate regressions.
- `node scripts/check-corrupt.mjs` — 600 deliberately damaged `.world` files. Most are refused,
  which is correct; the bar is that the app survives being asked and the working copy stays
  readable and writable afterwards.

## Known advisory: `extract-zip`

`npm audit` reports two high-severity entries. They are one issue seen twice —
[GHSA-jmr9-qjv8-65gv](https://github.com/advisories/GHSA-jmr9-qjv8-65gv), unvalidated symlink path
traversal in `extract-zip`, reached through `electron`, which is then flagged for depending on it.

**It does not reach anyone running this application.**

| | |
| --- | --- |
| Where it lives | `electron` → `extract-zip@2.0.1`, a **devDependency** |
| When it runs | Inside `electron/install.js`, during `npm install`, on a developer's machine |
| In the shipped app? | **No.** `app.asar` carries 55 runtime packages and `extract-zip` is not among them — verified by listing the built archive, not by reading the config that makes it |
| Touches a `.world`? | No. The app has no zip-extraction path at all |

**Why it is not fixed yet.** The package has never published a patch — the advisory records
`patched_version: null`. Electron's fix was to drop the public package for an internal fork, and
that lands in **Electron 43**. This project is on **Electron 39**, so closing the advisory is a
four-major upgrade that changes the bundled Chromium and Node underneath the app.

That matters more here than the version numbers suggest: most of the 41 gates were verified against
*this* Electron's behaviour, and several of them — the CSP, the fuses, `will-navigate`, the
`world://` protocol's CORS handling, the two permission handlers — were confirmed by breaking them
in a running build rather than by an assertion. The harnesses catch the mechanical half. Nothing
automated answers "does the CSP still block what gate 19 says it blocks under Electron 43."

So the upgrade is scheduled as its own piece of work, with time budgeted to re-walk the gates in a
running app. Low real exposure, high blast radius if it goes wrong quietly.

## What a shared `.world` carries out

Saving is also an outward boundary, and the gates cover that direction too: the author's disk path
is stripped, image metadata (EXIF/XMP — GPS, camera serial, names) is removed on the way out, and
deleted content does not travel because the file is rebuilt rather than copied. See gates
[27](docs/security-gates.md#gate-27), [33](docs/security-gates.md#gate-33),
[34](docs/security-gates.md#gate-34) and [41](docs/security-gates.md#gate-41).

The app makes **no network requests at all** — see [legal/PRIVACY.txt](legal/PRIVACY.txt).
