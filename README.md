# Worldbuilder

A desktop app that keeps a fictional world's map, peoples, states, languages, dynasties and
history in one place, all **linked together**.

- Nested interactive maps (continent → city → building) with borders and pins drawn on top
- Encyclopedia-style articles: free-form fields, templates, `[[links]]` between them
- A layered political hierarchy (empire → kingdom → duchy → county), year-based conquest and
  border changes
- Map modes you **define yourself** — religion, language, culture, anything
- A timeline: drag the year and the map returns to that day
- Dynasty trees, a diplomacy web, atlas statistics

Everything can be renamed, moved or deleted later — no fixed categories.
Design rationale: [CLAUDE.md](CLAUDE.md).

---

## Installing (Windows)

Download the latest release from the [**Releases**](../../releases) page. Two options, both
open the same app:

| File | What it does |
| --- | --- |
| **`Worldbuilder-…-Setup.exe`** | A normal installer. Asks where to install, creates desktop + Start Menu shortcuts, uninstalls like any app. No administrator rights needed. |
| **`Worldbuilder-…-portable.zip`** | No installation. Extract to a folder and run `Worldbuilder.exe` inside. Works from a USB stick too. |

Either way, double-clicking a `.world` file opens that world directly.

### The "Windows protected your PC" warning

Running the `.exe` will likely show a blue warning screen. **This is not a virus warning.** It
appears because the app is not signed with a paid certificate; Windows shows it for any
unrecognised publisher. To continue: **"More info" → "Run anyway"**. Once per file is enough.

If you would rather not run an unsigned `.exe`, that is entirely reasonable — the
[build from source](#building-from-source) steps below let you inspect the code and build it
yourself.

---

## Where your data lives

Everything you create is saved **instantly** to:

```
Documents\Worldbuilder\
├── world.db      → all your content (a SQLite database)
├── assets\       → images you add (banners, map backgrounds)
└── backups\      → automatic daily backups (kept for 30 days)
```

No cloud, no account — everything stays on your own computer. To back up, copy that folder.

A **`.world` file** is the whole world as one document: `Ctrl+S` packs everything (images
included) into a single file you can send to someone or open on another computer.

---

## Shortcuts

| Shortcut | What it does |
| --- | --- |
| `Ctrl+K` | Search everything (palette) |
| `M` | Go to the map (the last one you were on) |
| `Ctrl+S` / `Ctrl+Shift+S` | Save world / Save as |
| `Ctrl+O` | Open world |
| `Ctrl+Z` / `Ctrl+Y` | Undo / Redo |
| `F1` | The full shortcut list |
| `Ctrl`+click | Select multiple drawings on the map |
| `Ctrl+C` / `Ctrl+V` / `Ctrl+D` | Copy / paste / duplicate drawings |
| `Shift`+wheel | Size of the selection (or the active tool's default) |

The complete list lives on the **⌨ Shortcuts** page inside the app.

---

## `.world` files from other people

The files are designed to be shared, so their contents are treated as **untrusted input**:
note content cannot run HTML/JavaScript, embedded images cannot write outside the `assets\`
folder, and corrupt data is repaired instead of locking the app up. Details:
[docs/security-gates.md](docs/security-gates.md).

Still — give a file from a stranger the same suspicion you would give an unknown program.

---

## Building from source

Requires [Node.js](https://nodejs.org) 22 or newer.

```bash
npm install
npm run dev          # dev server with hot reload
npm run build:win    # produces the installer + zip under dist/
```

Other commands:

```bash
npm run typecheck    # type checking
npm run lint         # eslint
node tests/db.test.ts # main-process test harness (schema + CRUD + undo + security asserts)
```

Releasing: `git tag v1.0.1 && git push --tags` → GitHub Actions builds and attaches the
installer and zip to a draft release ([.github/workflows/release.yml](.github/workflows/release.yml)).

---

## Status

A personal hobby project, evolving continuously. If something breaks or looks wrong,
[open an issue](../../issues).

## License

**MIT** — see [LICENSE](LICENSE). Use it, change it, redistribute it, sell what you make from it.
The installer shows the licence as a page you must accept, and it ships as `legal\LICENSE.txt`
beside the executable in the portable zip too.

The world you build with it — your `.world` files, maps and entries — is **entirely yours**. The
licence covers the software and claims nothing over your content; you may publish or sell it
freely. [legal/NOTICE.txt](legal/NOTICE.txt) says that and the other things a licence does not:
back up your work, and treat a `.world` from a stranger like any other downloaded document.

- [legal/PRIVACY.txt](legal/PRIVACY.txt) — the app makes no network requests, has no accounts and
  collects nothing. It also says what the log records, and what is stripped from a `.world` you
  share.
- [legal/THIRD-PARTY-NOTICES.txt](legal/THIRD-PARTY-NOTICES.txt) — the open source components the
  app is built from, each under its own licence, reproduced in full. Generated by
  `node scripts/gen-notices.mjs`; run it after changing dependencies, or the release gate will fail.

These, plus a short alpha-testing note, live in `legal\` beside the executable and are opened from
**Help ▸** inside the app, in both distributions.
