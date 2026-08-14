# CLAUDE.md

**Never start editing files straight after a request. First say — in a sentence or two, not a menu
of options — what you understood and how you mean to solve it, then wait for the reply.** Reading,
searching and measuring beforehand is expected; that is what makes those sentences worth reading.
This holds for small changes too: the expensive mistakes here have been confident work on a
misread request, not slow work.

**If `HANDOFF.md` is present, read it at the start of a session and update it after material
work.** It is the running log of what was decided and why — but it is deliberately NOT in the
repository (`.gitignore`), because it is a working document rather than something a reader of this
project needs. A fresh clone has no copy and nothing depends on one.

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## The standing constraint: nothing is final

**The world this app holds is still being invented, so the app must never be the thing that fixes
it in place.** The political structure, the title names, which culture carries which traits are all
still moving, and a decision made today is routinely revised or abandoned months later. That is the
normal shape of the work, not a defect to design around.

So: everything must be renameable, movable to another category, or deletable after the fact.
Hard-coded categories, fixed schemas and "this field cannot change later" constraints are wrong
here even when they are technically correct. A title ladder set up under one set of names today
must be replaceable wholesale tomorrow, **from the UI, not from a code change**. In practice, test
every feature against "how could this be more flexible?" — a feature that works but that a changed
idea three months from now makes unusable was designed wrong.

This is also why the data model is what it is: a free `type` string, a `fields` JSON column, and
relations as rows rather than as schema (see *Data model* below). A new kind of thing is an insert,
never a migration.

---

## Development commands

- `npm run dev` — Electron dev server (with HMR)
- `npm run typecheck` — type checking (main + renderer; runs `typecheck:node` then `typecheck:web`)
- `npm run lint` — eslint (cached)
- `npm run build:unpack` — packages the desktop app to `dist/win-unpacked/Worldbuilder.exe`; the only way to update the desktop build after code changes
- `npm run build:win` — full release build: installer (`Worldbuilder-…-Setup.exe`) + portable zip
- `node src/main/db.ts` — database self-check: runs and asserts schema setup + CRUD + undo + the security scenarios. There is no test framework; this file stands in for one on the MAIN side and must be run after any data-model change.
- `node scripts/check-corrupt.mjs` — bit rot and bytes damaged on purpose. db.ts's own scenarios build files that are ODD but structurally valid SQLite; this one takes a real packed world and damages it six hundred ways (scattered flips, the header, a zeroed page, truncation) from a seeded generator. The bar is not "it opens" — most of these are not worlds any anymore and a refusal is the right answer. The bar is that the APP survives being asked: the working copy still readable AND writable afterwards, nothing written outside the image rules. Current run: 222 opened, 323 refused, 55 raw SQLite errors (all inside the rescue window, all restored), 0 left the app unusable, 0 wrote outside the image rules. (Measured against `master` and against the staging change below — identical both ways; the 225/52 written here before was from an older run.) It also checks the SHAPE of its own run, so a fixture that stopped being a world could not make it pass by refusing everything.
- `node scripts/gen-notices.mjs` — regenerates `legal/THIRD-PARTY-NOTICES.txt` from the installed dependency tree. Run it after adding, removing or upgrading a dependency. The release gate runs it and fails if the file changes, because a stale notice file breaks nothing and ships anyway.
- `node scripts/check-api.mjs` — the same idea for the renderer's `api.ts`, which db.ts cannot reach (different process, and it imports `window`). Stubs the IPC bridge and runs every settings loader against a list of hostile values, then the pure helpers. A loader must never throw and must never return a shape its caller will trip over. Run it after touching a loader or a coercion helper; it found `getHierConfig` throwing on the literal value `null` the first time it ran. **It also checks that every `var(--x)` in `main.css` is defined in `:root`**, which nothing else can: an undefined CSS variable is not an error to the parser, to tsc, to eslint or to the bundler — it is SILENCE, and the rule falls back to nothing. Retiring the last compatibility aliases took `--tint-1` and `--tint-2` out with them and five surfaces lost their background in the dark theme with every other check still green. Tokens set per element (`--w`, `--mz`, `--lz`, `--guide`, `--canvas-grid`) are listed as local and exempt.
- `node scripts/check-pack.mjs` — run after `build:unpack`/`build:win`, checks what actually SHIPS rather than what the config says should. Lists the built `app.asar` and fails on any top-level entry outside `out/`, `node_modules/`, `resources/` or `package.json`. Written after `graphify-out/` (2.9 MB of this codebase's own architecture and security notes, extracted from CLAUDE.md/HANDOFF.md) was found shipping inside the asar — gitignored, so a git-based review never caught it, and `.gitignore` has nothing to do with what electron-builder packs. `electron-builder.yml`'s `files:` excludes are a list of things to remember; this is the thing that notices when one was forgotten.

On Windows, `dist/` files are locked while the packaged `Worldbuilder.exe` is running — close it before `build:unpack`.

**`graphify-out/graph.json` — a knowledge graph of this repository, and the first place to look before grepping WHEN IT EXISTS.** It is a derived artifact and is NOT in the repository (`.gitignore`): a fresh clone has none, and `graphify query` will simply fail there until someone builds one. Where it exists it holds the AST symbols of `src/` (deterministic, no LLM) plus the named concepts of the hand-written docs — and the concepts that matter sit ON the code node they describe, so `packWorld` and "Gate 27: what a shared `.world` carries OUT" are one node, not two. That is the whole point: a graph where the prose and the code sat in separate components would be worth nothing. Answer an architectural question with `graphify query "<question>"` before opening files; it knows things no single file states, e.g. that `migrateLegacyKeys` is the bridge between the data model and three separate gate clusters. Refresh with `/graphify . --update` after code changes — the AST half is free, so the only costly refresh is a substantial edit to the prose. **The scope is chosen, not defaulted, and re-running it wider is a mistake already made once:** `src/` plus the hand-written docs, NOT `.agents/` (an unrelated skill library whose hundreds of files would drown the graph) and not the generated licence dumps. Two known limits, written down so they are not rediscovered: dangling edges where prose names a symbol that is not exported, and the report's "Corpus Check" header quoting the pre-filter file count rather than the files actually built.

## Architecture

**Where the rest of this file went.** Three bodies of guidance moved out of the always-loaded
file so a session pays for them only when it needs them. Nothing was deleted.

- **`.claude/skills/security-gates`** — the 41 numbered gates. A shared `.world` is HOSTILE input:
  it is someone else's SQLite database opened over yours, its text is rendered, its images are
  written to disk, and what you save is handed to other people. **Load that skill before editing
  `src/main/db.ts`, `src/main/index.ts`, the CSP, the IPC write boundary or anything that parses a
  file the user did not write** — and never weaken a gate to make a feature work.
- **`.claude/skills/map-internals`** — the map screen: Leaflet/CRS.Simple, the WebGL split, the
  base-image texture, timeline, rank and paint modes, and the measured dead ends.
- **`src/main/CLAUDE.md`** and **`src/renderer/CLAUDE.md`** — loaded automatically when working
  under those directories.

**Process split:** `src/main` (Electron main process — node:sqlite, file system, window management), `src/preload` (the single bridge exposed to the renderer: `window.api.invoke(method, ...args)`), `src/renderer/src` (React UI). Every renderer access to main goes through that one IPC channel; the `mainApi` object in `src/main/index.ts` defines the entire surface exposed to the renderer — adding a main-process capability means adding a method there, never opening a separate IPC channel. **One channel runs the other way:** `menu` (preload `onMenu`), carrying application-menu clicks as opaque command-id strings. Main only forwards the click; the renderer maps the id onto the function its own UI already calls, so a command never grows a second implementation. Extend that channel by adding a command id, not a second channel.

**Data model (flexibility, in code):** four tables in `src/main/db.ts`:
- `entities` — free `type` string (no category enforcement) + a `fields` JSON column (free key/value metadata)
- `links` — free `relation` string (relations between articles)
- `maps` — nested maps via `parent_map_id` (continent → city → building)
- `features` — drawings on a map; the `style` JSON column carries appearance (color, opacity, size, font)

This is the code counterpart of "openness to change" above: a new entity type or relation kind is a row insert, not a schema change.

**Information architecture — commands vs places (a standing distinction):** things you DO live in the native application menu (`Menu.buildFromTemplate` in `index.ts`, `autoHideMenuBar:false`); places you GO live in the sidebar. File = New/Open/Open Recent/Save/Save As/Export ▸ (Current Map as Image, Notes)/Back Up Now/Close Project; Edit = Undo/Redo/Preferences; View = Maps/Overview ▸/Project Preferences; Help = Keyboard Shortcuts. The sidebar's nav is only `Maps`, `Overview`, `Project Preferences`. **Accelerators are split on purpose:** Ctrl+N/O/S/Shift+S and F1 are REGISTERED by the menu and were deleted from App's keydown handler (handling them in both places fires every command twice); Undo/Redo use `registerAccelerator:false`, so the menu advertises Ctrl+Z while the binding stays with App's typing-guarded branch — registered natively, Ctrl+Z inside a note textarea would undo the WORLD instead of the text. Ctrl+K, `M` (go to the map — the same `openMaps` the sidebar row calls) and Alt+←/→ are
renderer-only. A bare letter cannot be a menu accelerator without stealing the key from every
input, so `M` is guarded by the typing check plus "no modifier held". `File > Close Project` and `New Project` run the SAME function (`newProject`): there is no third state where a project is closed but the working copy still holds it. **`Overview.tsx`** is a fragment, not a wrapper `.page` — each tab child renders its own `.page`, and nesting them would double the padding and hand the scroll to the wrong element. Menu labels carry their own small `MENU_TR` map in main, which cannot import the renderer's `i18n.tsx`; main's save/close DIALOGS are still English-only.

**Two preference screens (the split that mirrors the data):** `Preferences.tsx` (Edit ▸ Preferences) = language + theme, stored in **`userData/prefs.json`** via `getPrefs`/`savePrefs` — per machine, NOT inside the `.world`. They used to sit in the `settings` table, which meant opening a shared world changed your language and `resetWorld()` wiped your choice on the next launch; `adoptLegacyPrefs()` migrates the old rows once and **must run before the startup `resetWorld()`**. The `save` prefix on `savePrefs` is load-bearing: `set*` would match the dirty-flag regex and switching theme would mark the world unsaved. `ProjectPreferences.tsx` (sidebar) = Hierarchy Ranks + Map Modes + Entity Templates — these define the open world's structure, live in the `settings` table and travel inside the `.world`. New settings go to whichever side matches where they are stored.

**Development-only tooling (`electron.vite.config.ts`):** the Agentation annotation toolbar is mounted in dev — click something in the running app, leave a note, the agent reads it over MCP. It needs `connect-src` to `localhost:4747`, which the CSP forbids, so the widening is a Vite plugin with **`apply: 'serve'`** rather than an edit to `index.html`; the toolbar itself is a dynamic `import()` inside `import.meta.env.DEV` in its own React root, and the package is a devDependency. All three were verified against a real `npm run build`: the packaged HTML keeps the original policy and `out/renderer` holds no trace of the package. **A development tool never buys itself an exception in the shipped app** — if that becomes hard to guarantee, drop the tool.

**UI language (`i18n.tsx`):** English by default; switchable to Turkish in Settings (the `language` key in `settings`, `getLanguage`/`saveLanguage` in `api.ts`). The translation scheme is not a separate key dictionary — the English text in JSX IS the key: `t('Some Text')`; missing keys in the `TR` dictionary fall back to English. Parameterised texts use `t('Delete "{name}"?', {name})`. `App.tsx` loads the language via `getLanguage()` into `LangContext.Provider`; components read via `useT()`. Non-React helpers (`entityOps.ts`) use `getLanguage()` + `translate(lang, …)` directly. Database field keys (`fields['parent']`, `fields['hierarchy']`, …) and internal state labels (`'receiver'`/`'picking'`) are English schema/state constants, not display text. The TR dictionary in `i18n.tsx` is the translation layer and stays Turkish by design. **The user-facing word for a row of `entities` is `Entry`** — it was "entity" in two thirds of the UI and "article" in the other third, and "Article" was rejected on meaning (these rows carry a polygon, a rank chain and a ruler history, not a piece of writing; `madde` has always been the Turkish). Types, columns, IPC methods and state keys stay `entity`; do not rename them and do not reintroduce "article" in display text. **Interface prose has a rule of its own:** nothing is written that the control already says, a line that DIAGNOSES stays and a line that narrates goes, no em dashes (they read as written prose), no trailing full stop on a placeholder, no colon on a caption that sits above its control. Code comments are exempt — they are not on screen.

