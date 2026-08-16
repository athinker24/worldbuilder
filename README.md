# Worldbuilder

A desktop app for keeping a made up world in one place. Maps, entries, states, dynasties, a
timeline.

The parts are linked. Draw a border on the map and it gets an entry. Give that entry a parent and
the map starts drawing it as part of a realm. Move the year and the borders follow.

## What it does

- Maps inside maps. A continent opens a city, a city opens a building.
- Entries with free fields, and `[[links]]` between them.
- A hierarchy you name yourself (empire, kingdom, duchy, or whatever you call them), plus conquests
  that change borders by year.
- A timeline. Drag the year and the map goes back to it.
- Map modes for anything you track: religion, language, culture.

Nothing is locked in. Every type, name and category can be renamed, moved or deleted later, from
inside the app.

## Install (Windows)

Grab one of these two from the [Releases](../../releases) page. They run the same app, pick
whichever suits you.

**Installer, `Worldbuilder-…-Setup.exe`**

1. Download it and run it.
2. Choose a folder or leave the default.
3. You get a desktop and Start Menu shortcut. No admin rights needed.

**Portable, `Worldbuilder-…-portable.zip`**

1. Download it and extract it anywhere.
2. Run `Worldbuilder.exe` inside the folder.
3. Nothing gets installed. A USB stick works fine.

Either way, double clicking a `.world` file opens that world.

### If Windows shows a blue warning

It says "Windows protected your PC". That is not a virus warning. It shows for any app without a
paid signing certificate, and this one does not have one. Click **More info**, then **Run anyway**.
Once per file is enough.

If you would rather not run an unsigned exe, that is fair. Build it yourself, steps are at the
bottom.

### Other platforms

Only Windows is tested. There is no macOS or Linux build.

## Where your files go

Everything saves as you work, into:

```
Documents\Worldbuilder\
├── world.db      all your content, a SQLite database
├── assets\       images you add
└── backups\      daily backups, kept 30 days
```

No cloud and no account. To back up, copy that folder.

`Ctrl+S` packs the whole thing, images included, into a single `.world` file. That is the one you
send to someone or carry to another computer.

## Shortcuts

| Key | What it does |
| --- | --- |
| `Ctrl+K` | Search everything |
| `M` | Go to the map |
| `Ctrl+S` / `Ctrl+Shift+S` | Save / Save as |
| `Ctrl+Z` / `Ctrl+Y` | Undo / Redo |
| `Ctrl`+click | Select more than one drawing |
| `F1` | The full list |

## Opening a `.world` from someone else

These files are meant to be shared, so the app treats their contents as untrusted. Note text cannot
run HTML or JavaScript, embedded images cannot write outside `assets\`, and broken data gets
repaired instead of hanging the app. The full list is in
[docs/security-gates.md](docs/security-gates.md).

Even so, treat a file from a stranger the way you would treat any program you did not write.

## Build from source

Needs [Node.js](https://nodejs.org) 22 or newer.

```bash
npm install
npm run dev          # dev server, hot reload
npm run build:win    # installer + zip, into dist/
```

Checks:

```bash
npm run typecheck
npm run lint
node tests/db.test.ts   # schema, CRUD, undo, security asserts
```

To release: `git tag v1.0.1 && git push --tags`. GitHub Actions builds it and attaches the files to
a draft release ([.github/workflows/release.yml](.github/workflows/release.yml)).

Design notes and the reasoning behind the data model are in [CLAUDE.md](CLAUDE.md).

## Status

A hobby project, still changing. If something breaks or looks wrong,
[open an issue](../../issues).

## License

MIT, see [LICENSE](LICENSE). Use it, change it, sell what you make with it.

What you build with it stays yours. The licence covers the software and claims nothing over your
worlds, maps or entries.

- [legal/PRIVACY.txt](legal/PRIVACY.txt): no network requests, no accounts, nothing collected. Also
  says what the log keeps and what gets stripped out of a `.world` you share.
- [legal/NOTICE.txt](legal/NOTICE.txt): the things a licence does not say. Back up your work, and be
  careful with files from strangers.
- [legal/THIRD-PARTY-NOTICES.txt](legal/THIRD-PARTY-NOTICES.txt): the open source parts this is
  built on, each under its own licence.

All three ship next to the executable and open from the **Help** menu.
