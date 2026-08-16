# The security contract

**Security contract (a shared `.world` = untrusted input):** the file model was designed for sharing
from the start, so a `.world`'s contents are treated as HOSTILE input. The gates:

The gates are numbered as they were written, and listed below in the order they appear. Gate 21 is
last because it is about all of them: it records how each one was verified.

- [Gate 1 — Markdown escaping, and URLs sanitised at parser level](#gate-1)
- [Gate 2 — Embedded image names are validated, never repaired](#gate-2)
- [Gate 3 — `escapeHtml` on map labels, pin html and Leaflet tooltips](#gate-3)
- [Gate 4 — `openRecent` opens only paths already recorded in `recent.json`](#gate-4)
- [Gate 5 — `exportNotes`' `safe()` neutralises Windows device names](#gate-5)
- [Gate 6 — Malformed JSON columns are reset at the entry gate](#gate-6)
- [Gate 7 — `ErrorBoundary` is the last line of defence](#gate-7)
- [Gate 8 — `world://` is confined to `assets/`, not to the data folder](#gate-8)
- [Gate 9 — Every connection sets `trusted_schema = OFF` and `cell_size_check = ON`](#gate-9)
- [Gate 10 — Cycles are broken at the entry gate](#gate-10)
- [Gate 11 — Settings are coerced, not trusted](#gate-11)
- [Gate 12 — The log cannot be forged or made to identify you](#gate-12)
- [Gate 13 — `savePrefs` allow-lists its keys](#gate-13)
- [Gate 14 — The preload has no non-isolated fallback](#gate-14)
- [Gate 15 — The window's guarantees belong to the APP, not to `createWindow`](#gate-15)
- [Gate 16 — Depth, not just cycles](#gate-16)
- [Gate 17 — Nothing unbounded may reach a per-item renderer](#gate-17)
- [Gate 18 — One entry may not abort an export](#gate-18)
- [Gate 19 — The right table NAMES do not make it our schema](#gate-19)
- [Gate 20 — Settings arrays are bounded, not only typed](#gate-20)
- [Gate 22 — The instance that loses the single-instance lock must `app.exit(0)`, not `app.quit()`](#gate-22)
- [Gate 23 — `escapeHtml` is the WRONG tool inside a `style="…"` attribute](#gate-23)
- [Gate 24 — The family tree is the third tree, and the gate cannot repair it](#gate-24)
- [Gate 25 — The promise that a development tool buys no exception in the shipped app is now asserted](#gate-25)
- [Gate 26 — A `.rescue` on disk is an interrupted open, and it used to be invisible](#gate-26)
- [Gate 27 — What a shared `.world` carries OUT, not only what it can do coming in](#gate-27)
- [Gate 28 — A failed operation must still end with a live database, and `resetWorld` did not](#gate-28)
- [Gate 29 — `packWorld` holds a live handle on its temp copy, and a throw used to leave it open](#gate-29)
- [Gate 30 — The same rule, in the two places `unpackWorld` still broke it](#gate-30)
- [Gate 31 — `spellcheck: false` — the app makes no network requests, and this was the one exception](#gate-31)
- [Gate 32 — The last line of defence could be defeated by its own reporting](#gate-32)
- [Gate 33 — An image carries more than pixels, and all of it travelled](#gate-33)
- [Gate 34 — Deleted content does not travel, and that is now measured rather than assumed](#gate-34)
- [Gate 35 — The depth gate can destroy data by being WRONG, and nothing tested that side](#gate-35)
- [Gate 36 — A failed undo said nothing](#gate-36)
- [Gate 37 — A world from a NEWER build was opened and quietly stripped](#gate-37)
- [Gate 38 — "Fire and forget" has to mean BOTH failure modes](#gate-38)
- [Gate 39 — The WRITE boundary asks what the OPEN asks](#gate-39)
- [Gate 40 — A user action that touches several rows is ONE transaction, and its undo entry is pushed only after it lands](#gate-40)
- [Gate 41 — The OUTPUT boundary, and what it is actually for](#gate-41)
- [Gate 21 — The break-test rule has teeth](#gate-21)

---

<a id="gate-1"></a>

## Gate 1 — Markdown escaping, and URLs sanitised at parser level

in note/content markdown the user's `<` are escaped — raw HTML cannot run — and URLs are sanitised
**at parser level**: via `new Marked({renderer:{link,image}})`, href/src pass the `SAFE_URL`
allow-list BEFORE any HTML exists (`safeMarked` in `markdown.ts`, module-private and reached only
through `renderMarkdown`). marked used to put `[t](javascript:…)`
straight into `<a href>`; clicked, the code ran in the renderer context (i.e. with `window.api`
access). The previous output-regex version was correct today but would silently break if marked's
output format changed — cut at the source, not filter. All attributes including title/alt go through
`escapeAttr` (marked's own escaping is not trusted).

<a id="gate-2"></a>

## Gate 2 — Embedded image names are validated, never repaired

`unpackWorld` VALIDATES every embedded image name against `assetName` (`valueGuards.ts`, re-exported
by `db.ts`) and refuses what fails; it never repairs one. It used to reduce the name to `basename`, which closed the escape
(`../../x.png`, `C:\…`) and nothing else: the extension and the content were free, so a shared world
could drop `setup.exe`, a `.dll` or a `.lnk` into a folder inside the user's Documents — past the
app's own rule for that folder, since `importAsset` has always taken images only. Both writers now
go through the one function, which also refuses an NTFS alternate data stream (`logo.png:ads` —
`basename` leaves the colon intact), a Windows device name (`nul.png`) and a control character.
Refusal rather than repair, because `../../logo.png` reduced to `logo.png` overwrites the image that
IS ours. A refused row is counted and logged (`assets.refused`); the rest of the world still opens.
Asserted in the db self-check — and note the trap that made the OLD assertion vacuous: `unpackWorld`
ends with `pruneUnusedAssets`, so an escaped file that nothing referenced was written and then swept
away before the test looked for it. Every hostile name in that fixture is referenced from the
world's text.

<a id="gate-3"></a>

## Gate 3 — `escapeHtml` on map labels, pin html and Leaflet tooltips

Map labels/pin html go through `escapeHtml` — **including Leaflet string tooltips**
(`bindTooltip`/`setContent` with a string means `innerHTML`, DivOverlay._updateContent; entity names
are therefore escaped at all three tooltip sites).

<a id="gate-4"></a>

## Gate 4 — `openRecent` opens only paths already recorded in `recent.json`

`openRecent` only opens paths recorded in `recent.json` — a path from IPC is untrusted; a
compromised renderer must not open an arbitrary file over the working copy.

<a id="gate-5"></a>

## Gate 5 — `exportNotes`' `safe()` neutralises Windows device names

`exportNotes`' `safe()` neutralises Windows device names (`CON`, `NUL`, `COM1`…) with a `_` prefix
and control characters with `_`.

<a id="gate-6"></a>

## Gate 6 — Malformed JSON columns are reset at the entry gate

`repairImportedJson` (db.ts, at the end of `unpackWorld`) resets malformed `fields`/`style`/`layers`
columns and malformed JSON-looking `settings` values to defaults — the renderer JSON.parses these in
20+ places and one bad row would take down that view; the data is repaired at the entry gate instead
of wrapping every call.

<a id="gate-7"></a>

## Gate 7 — `ErrorBoundary` is the last line of defence

The last line of defense is `ErrorBoundary` (main.tsx): if render still crashes, a "New world /
Open" exit is offered instead of a blank screen — the opened file has overwritten the working copy,
so the app would otherwise be unrecoverable. **Packaging:** the dev notes (`CLAUDE.md`,
`HANDOFF.md`, `AGENTS.md` and `.claude/`) are excluded from the asar (an internals + mitigations
dossier must not ship to users), `!src/**` (a single `*` only excluded direct children). Main side:
the CSP also carries `form-action 'none'; base-uri 'none'` (default-src does NOT cover these — form
submit was a potential exfil channel, `<base>` a relative-URL hijack vector), all browser
permissions are denied via `setPermissionRequestHandler`, the single IPC dispatch is bounded by
`Object.hasOwn`, the `world://` handler normalizes + prefix-checks,
`will-navigate`/`setWindowOpenHandler` hand only http(s) to the external browser, SQL writes go
through the allow-listed `patchSql`.

<a id="gate-8"></a>

## Gate 8 — `world://` is confined to `assets/`, not to the data folder

— that folder also holds `world.db`, the logs and every backup, and none of them are images; the
check is `resolveAssetPath` in db.ts, next to the folder it defends and inside the one main file the
self-check can run (nine assertions: `../`, backslashes, a sibling `assets-other`,
`backups/assets/x.png`). A malformed percent-escape answers 400 and a missing file 404 — a throw
inside a protocol handler is an unhandled rejection, not a failed request.

<a id="gate-9"></a>

## Gate 9 — Every connection sets `trusted_schema = OFF` and `cell_size_check = ON`

(`PRAGMAS`, applied by `openDb`): a `.world` is someone else's SQLite database opened over yours,
and the views/triggers/indexes it carries are dropped by a statement that must not be able to invoke
them while it parses.

<a id="gate-10"></a>

## Gate 10 — Cycles are broken at the entry gate.

A map's parent and a folder's parent are plain ids; the UI's cycle guard sits where a cycle would be
CREATED, which a file bypasses entirely — and downstream the breadcrumb is a `while` that never
terminates and both trees are recursive renders. `repairImportedJson` cuts the LINK, never the row.

<a id="gate-11"></a>

## Gate 11 — Settings are coerced, not trusted:

the gate proves a JSON-looking value parses, not that it has the shape its loader assumes, and a
value that does not look like JSON is not checked at all (the same table holds `dark`, `tr`, a path)
— so `parseSetting` + `asArray`/`asObject`/`asNumber` in api.ts make every loader total. Geometry is
checked for a known type and an array of coordinates, because `L.geoJSON` walks `coordinates` and a
plausible object throws inside the reload.

<a id="gate-12"></a>

## Gate 12 — The log cannot be forged or made to identify you:

a scope and every data KEY go through `tag()` (a newline in either printed a line indistinguishable
from one the app wrote), and the home directory is replaced with `~` in EVERYTHING that reaches the
file. It used to be applied to the stack alone, under a comment saying the stack is the one place a
real path arrives — which is wrong about the most likely failure this app has: Node puts the path in
the MESSAGE of every fs error (`EBUSY … open 'C:\Users\<whoever>\Documents\Worldbuilder\world.db'`,
which is literally the app’s own startup warning), and the message is the report’s headline;
`edit.*` and `map.baseImage` forward an error string into ordinary event lines too. So the scrub
moved to the single `write` door in logger.ts and the five `sink.write` calls now go through it — a
rule applied at four places out of five is a rule that has already failed. It matches THREE
spellings, and the third is one this file makes itself: `kv` quotes any value holding whitespace
with `JSON.stringify`, which doubles every backslash, so a Windows path inside a quoted value sailed
past a scrub that only knew the raw form. The self-check exercises all three; it used to exercise
only the stack, which is exactly why the gap survived.

<a id="gate-13"></a>

## Gate 13 — `savePrefs` allow-lists its keys

and the export path takes `basename()` of the name (`chooseExportPath`) while the capture clamps
the rect (`captureMapImage`). `beginHiResExport` clamps the same way and caps the resulting content
size at 8192 per side — the rect and the window size both end up at the compositor, where a NaN
takes the capture out and a large number is a bitmap request measured in hundreds of megabytes.

<a id="gate-14"></a>

## Gate 14 — The preload has no non-isolated fallback:

it throws instead, because `window.api = api` on a page that renders a shared world's content is the
whole threat model in one line.

<a id="gate-15"></a>

## Gate 15 — The window's guarantees belong to the APP, not to `createWindow`

— navigation, `window.open` and the http(s)-only `openSafe` filter are bound on
`app.on('web-contents-created')`, so a future window cannot come up without them; permissions are
denied through BOTH handlers (`setPermissionRequestHandler` covers only the asking path, a
synchronous permission CHECK goes through `setPermissionCheckHandler`, which defaults permissive)
plus `setDevicePermissionHandler`, and `app.enableSandbox()` makes the sandbox every renderer's
default. Asserted line by line in the self-check, which reads `index.ts` from disk. **`openSafe` has
ONE exception and it cannot exist in a shipped build:** in dev the renderer is served over http by
electron-vite, so the app's own address read as external and Vite's HMR full reload was
preventDefault()ed and posted to the user's DEFAULT BROWSER — a tab per edit, each one the renderer
with no preload behind it, i.e. the exit screen. `will-navigate` now lets the app's own origin
through and `openSafe` refuses to hand it out, with the origin taken from `ELECTRON_RENDERER_URL` —
set by electron-vite in dev, undefined in a packaged build, where the renderer is `file://` and
every http(s) URL really is external. Same shape as the dev-only CSP widening's `apply: 'serve'`:
the allowance does not exist in the shipped app rather than being switched off there. Both halves
are asserted (the env-derived origin, and no hardcoded host anywhere in main), and the older
assertion that pinned `openSafe`'s exact source shape was rewritten to "nothing reaches
`shell.openExternal` before the scheme test" — it broke the moment the body gained a line while
proving nothing the looser form does not.

<a id="gate-16"></a>

## Gate 16 — Depth, not just cycles:

an acyclic 50 000-long parent chain passes the loop check and meets the recursive renders as a stack
overflow, so `MAX_TREE_DEPTH` (64) cuts the link at the same gate.

<a id="gate-17"></a>

## Gate 17 — Nothing unbounded may reach a per-item renderer:

a curved label is one `Text` per glyph, so `setLabels` clips text to `MAX_LABEL_CHARS` (120) — the
same shape as the dash pattern that could be walked in millionths. **That bounded ONE label and not
the sum, which is where the leverage was:** ten thousand label features of a hundred and twenty
characters is 1.2 million display objects built synchronously in `rebuild()`, out of a `.world` of
two or three megabytes, and paid again on every reload rather than once on open — a bigger
amplification than the twenty thousand embedded images the file gate already refuses, from a smaller
file. `MAX_SCENE_GLYPHS` (20 000) is a budget rather than a refusal, because the labels are the
user’s work: past it a name is still drawn, in one `Text` instead of one per letter, and only its
ARC is lost. Total objects then fall back to one per label, which is proportional to the file — the
deal every other feature gets.

<a id="gate-18"></a>

## Gate 18 — One entry may not abort an export:

every name segment is clamped but the PATH is their sum, and the notes tree is emptied before it is
rewritten — a path the filesystem refuses skips that entry, counts it, and says so.

<a id="gate-19"></a>

## Gate 19 — The right table NAMES do not make it our schema.

`CREATE TABLE IF NOT EXISTS` is a no-op against a table that already exists, whatever shape it has —
so a file whose `entities` carries `CHECK (0)` or an extra `NOT NULL` column with no default passes
`probeWorldFile` (they are real tables and they query fine), passes `repairImportedJson` (which only
UPDATEs), and opens without a word, after which every edit the user makes fails for the rest of the
session. `probeWritable` inserts one row per table inside a `SAVEPOINT` and rolls it back — the
question the app will be asking all session, asked once and thrown away. It runs inside
unpackWorld's rescue window, so a file that fails it leaves the user the world they already had.

<a id="gate-20"></a>

## Gate 20 — Settings arrays are bounded, not only typed:

gate 11 proved a value was an array and stopped, but every one of these lists is rendered item by
item (a tab per template, a chip per map-mode dimension on EVERY entry page, a band per era), and a
settings value is just a JSON string in a table — a million-entry `templates` costs the file ten
megabytes and costs whoever opens it the app. `asArray` clips to `MAX_LIST_ITEMS` (5000) and drops
nullish ELEMENTS, because almost every consumer reads a field off each item and one `null` is a
throw during render. `getYearRecs` gets the same treatment and is the sharpest case: `parentAt`
reads `r.from` in a loop that runs per base polygon on every year tick, so one null in a shared
world's `fields.parent` throws inside `applyYear` — and `repairImportedJson` cannot see it, since
that gate proves `fields` is an object while this list lives as a JSON string INSIDE one of its
values. **Every settings read is total, including the ones that are not loaders:** `getHierConfig`
was bypassing the helpers, and six sites in MapView/Atlas did a bare `JSON.parse(raw || '{}')` — the
gate deletes a value that LOOKS like JSON and is not, but a value that does not start with `{`/`[`
is never checked (the same table holds `dark`, `tr`, a path), so `mapScales` set to `hello` threw
inside a `.then()` and the scale bar, the layer toggles or the drawing defaults simply never
arrived, with an unhandled rejection as the only trace. They go through the exported
`settingObject`/`settingArray` now. This is gate 17's rule applied to the other places it was
needed. Two more of the same shape: **`packWorld` opened its temporary copy with a bare
`DatabaseSync`** — the one open in the app that skipped `PRAGMAS`, and an invariant with an
exception in it is not one — and **`readRecent` checked the array but not its elements**, where
`basename()`/`existsSync()` on a non-string would have taken out the start screen after a
half-written `recent.json`.

<a id="gate-22"></a>

## Gate 22 — The instance that loses the single-instance lock must `app.exit(0)`, not `app.quit()`

— quit() asks politely and RETURNS, so the module kept running, `whenReady` still fired, and the
losing copy walked the whole startup sequence against the winner's live data: schema exec and
`migrateLegacyKeys`' UPDATEs into a database another process has open, `packWorld` snapshotting it,
then `resetWorld()` deleting world.db and emptying `assets/`. It usually died on EBUSY at the last
step and became a `startupWarning` — which is the comment inside `whenReady` that gave it away.
Asserted against `index.ts` on disk.

<a id="gate-23"></a>

## Gate 23 — `escapeHtml` is the WRONG tool inside a `style="…"` attribute

— the HTML parser decodes `&#39;` back to `'` before CSS reads it, so `x'; background:url(…`
reassembles itself after escaping, and a pin's colour and a label's font come out of a shared world
as free strings. `cssColor`/`cssFont` (MapView) check instead of escape: a hex colour and a font
name, anything else dropped for the default. The same two values also go STRAIGHT INTO PIXI, which
throws on a colour string it cannot parse — `hexNum` accepted `#zzzzzz` because it only measured the
length — so one bad value in a `.world` took down the label layer and with it the map.

<a id="gate-24"></a>

## Gate 24 — The family tree is the third tree, and the gate cannot repair it.

Gate 16 bounds the DEPTH of the map tree and the folder tree, which are parent pointers a repair can
cut. A family tree is built from the `links` table as a general graph — there is no single link to
break — and `FamilyTree.renderNode` is a recursive render. Cycles were already handled (`seen`), but
an ACYCLIC line 20 000 long has no cycle in it and arrives as a stack overflow, so the limit lives
in the VIEW: `MAX_GENERATIONS` (200). The other recursive walkers were checked and are covered —
`shiftCoords`/`eachPoint` recurse over GeoJSON `coordinates`, which `MAX_JSON_DEPTH` already bounds
at 64, and every parent-chain climb (`rootAtYear`, `rungOwnerAt`) is iterative with a `seen` set.

<a id="gate-25"></a>

## Gate 25 — The promise that a development tool buys no exception in the shipped app is now asserted.

The dev CSP widening for the annotation toolbar is kept out of the build by ONE line, `apply:
'serve'`, whose absence is invisible: the build still succeeds, the app still runs, and the packaged
policy quietly permits `http://localhost:4747`. The self-check reads `electron.vite.config.ts` and
checks both that line and that the string the plugin searches for is still the string the CSP
contains — a replace that stopped matching would insert nothing and say nothing.

<a id="gate-26"></a>

## Gate 26 — A `.rescue` on disk is an interrupted open, and it used to be invisible.

`unpackWorld` puts the old working copy one file away and drops it at the end; a process that dies
in between leaves world.db holding whatever the half-applied open produced, with the only intact
copy of the user's world sitting beside it under a name nobody would open — and the next open
writing straight over it. A launch now moves it into `backups/` as `interrupted-open-<stamp>.db`:
the one folder the app tells people to look in, dated so a second interruption cannot overwrite the
first, and covered by the same retention. Never restored automatically — which of the two files they
want is not a decision to make for them at launch.

<a id="gate-27"></a>

## Gate 27 — What a shared `.world` carries OUT, not only what it can do coming in.

Every pass before this one asked what someone else’s file could do to you. `packWorld` wrote the
save target into `settings.worldFile`, and `VACUUM INTO` had already copied the working copy’s own
row before that — so a world handed to somebody carried `C:\Users\<the author>\Documents\…` inside
it, permanently, to everyone it was ever shared with. Gate 12 exists to keep that name out of a log
file; this was the same leak in the one artifact the app exists to hand to other people. Nothing
reads the row — main keeps the Ctrl+S target in memory, `unpackWorld` overwrites it on open, the
start screen asks `worldInfo()` — so `packWorld` deletes it — **from the WORKING COPY, before the
`VACUUM INTO`, and that ordering is the whole gate.** The first version deleted it from the OUTPUT
afterwards, which removed the ROW and left its BYTES: SQLite frees a cell by dropping it from the
page index, not by erasing it, so the path was still plainly readable in the shared file with a text
editor. Found on one of the real worlds on this machine, hours after the "fix". `VACUUM INTO`
REBUILDS the database into the target, so anything removed before it is genuinely absent and
anything written after it can leave residue — which is why the images are inserted and never
deleted, and why nothing else is written post-vacuum. The assertion had to be rewritten too, twice:
it checked that the ROW was gone (a proxy that passed while the bytes were there), and then it
checked the FILE but against a working copy that had never had the row set, so there was nothing to
leave behind. It now writes the row exactly as `saveWorld` does, packs, and searches the bytes — and
putting the old ordering back makes it fail. The other settings were checked for the same shape and
hold no paths; `pinImages` and `maps.image_path` are `assets/`-relative by construction.

<a id="gate-28"></a>

## Gate 28 — A failed operation must still end with a live database, and `resetWorld` did not.

It closes the handle before deleting world.db, and on Windows the delete is the step that fails:
SQLite opens without share-delete, so anything else holding the file (an antivirus mid-scan,
OneDrive, the search indexer) throws EBUSY — leaving a CLOSED db and no way back, every later query
throwing and the renderer answering with a toast per query until a restart. It now reopens before
rethrowing, the same rule `unpackWorld`'s rescue path already followed. Asserted by holding a second
connection open, which reproduces the lock exactly. The sibling paths were checked and are already
right by construction: `newProject` packs before it resets, so a failed pack never reaches the
reset, and the launch path is the same shape.

<a id="gate-29"></a>

## Gate 29 — `packWorld` holds a live handle on its temp copy, and a throw used to leave it open.

Windows will not delete a file something still holds, so `rmSync(tmp)` at the top of the NEXT save
threw as well and saving stayed broken until a restart — one transient failure (an image deleted
between the readdir and the read, a disk filling partway through) becoming a permanent one. It is a
`finally` rather than a catch, deliberately: the close must happen on every path, and this is one of
the few guarantees with NO test behind it — the in-try failure cannot be arranged in the self-check
without racing the filesystem, and the first attempt at one passed with the fix removed, so it was
deleted rather than kept as a green light that meant nothing.

<a id="gate-30"></a>

## Gate 30 — The same rule, in the two places `unpackWorld` still broke it.

Taking the rescue copy is itself a step that can fail — it is a full copy of the world, so a disk
with no room is the obvious way — and the handle is already CLOSED by then, so an unguarded throw
left no database open at all. `putBack` had the mirror problem: it runs when something has already
gone wrong, and the likeliest reason is the same reason the copy BACK would fail, at which point the
reopen was skipped and the original error was replaced by the copy's. Each step is separate now, the
reopen always happens, and the rescue file is kept when the restore failed so gate 26 moves it to
`backups/` next launch. Asserted with a directory sitting where the rescue file wants to be, which
reproduces the failure without needing a full disk; broken, it reports `database is not open`, which
is the bug in four words. Together with gates 28 and 29 the rule is now uniform: **every destructive
multi-step operation in this file ends with a live database and no leaked handle.**

<a id="gate-31"></a>

## Gate 31 — `spellcheck: false` — the app makes no network requests, and this was the one exception.

Electron's spellchecker is hunspell with dictionaries FETCHED from Google's CDN the first time a
language is used: a call the CSP does not govern, because it happens below the page, in an app whose
whole pitch is that it is local. It also had nothing to offer here — this world runs on two invented
languages and hundreds of invented names, so it would have underlined nearly every proper noun. If
it is ever wanted it belongs behind a preference that says what it downloads. Asserted with the
other window guarantees.

<a id="gate-32"></a>

## Gate 32 — The last line of defence could be defeated by its own reporting.

`ErrorBoundary.componentDidCatch` called `logCrash` and `getLanguage` unguarded, and React treats a
throw inside `componentDidCatch` as unrecoverable — it unmounts the tree, which is the blank screen
the boundary exists to prevent. Not hypothetical: both calls go through `window.api`, and gate 14
makes the preload THROW on purpose when context isolation is lost, so in that failure the bridge is
undefined, App's first api call throws during render, this catches it, and `window.api.invoke` then
throws SYNCHRONOUSLY here — not a rejected promise, so the `.catch()` never sees it. The scenario
where the exit screen matters most was the one that removed it. The body is wrapped now: reporting
the crash is worth less than showing the way out. The same thread runs one level up: `main.tsx`
called `api.logSessionInfo` at MODULE SCOPE, above `createRoot`, so in that same failure the module
never finished evaluating and React never mounted at all — a blank window with no boundary in it.
Guarded, because a session-info line is the least important thing in that file and mounting is the
most. Same pass moved `resolveAssetPath` inside the `world://` handler's guard — it is not known to
throw, but being safe by inspection is not the same as being safe by construction, in a handler
whose documented hazard is that a throw is an unhandled rejection rather than a failed request.

<a id="gate-33"></a>

## Gate 33 — An image carries more than pixels, and all of it travelled.

EXIF holds GPS coordinates to a few metres, the camera's serial number and the second the shutter
opened; XMP holds the author's name and an editing history; IPTC holds a creator line. `importAsset`
copies a file byte for byte and `packWorld` embeds it byte for byte, so every one of those rode
inside every `.world` handed to anybody — the same shape as gate 27's disk path, and the same
answer. `stripImageMetadata` (`imageMeta.ts`, re-exported by `db.ts`) covers ALL FOUR formats
`importAsset` accepts, which is the point — the one most likely to carry GPS today is a phone photo saved as `.webp`, and that was the
format with no stripper. JPEG loses APP1/APP13/COM, PNG `tEXt`/`zTXt`/`iTXt`/`eXIf`/`tIME`, WebP the
`EXIF` and `XMP ` RIFF chunks (the container size is rewritten — the only byte any stripper edits
rather than omits), GIF its comment extensions and an XMP application extension, but NOT
`NETSCAPE2.0`, which is what makes an animation loop. Every stripper returns the ORIGINAL buffer
when it removed nothing, because the common case is a picture with no metadata and a `Buffer.concat`
on a hundred-megabyte base map would double peak memory on every save. Three rules came out of
writing it. **On the way OUT, not the way in:** the user's own copy in `assets/` keeps whatever it
came with, which is theirs, and stripping at pack time also covers every image imported before this
existed, for free, because packWorld already reads them all. **ICC (APP2) and Adobe (APP14) are
KEPT** — those describe the COLOUR, and dropping them changes how the picture looks. **Anything
unparseable comes back byte-identical**, because a cleaner that can corrupt an image is worse than
the metadata it removes; the first version of the test proved this by accident, with a malformed
fixture that the stripper correctly refused to rewrite. Asserted with hand-built fixtures rather
than a checked-in photo, since a real photo in the repo would be somebody's actual metadata — AND
FUZZED, because it is the only byte-level parser in the app and two fixtures prove nothing about a
parser. Four thousand mutated JPEGs and PNGs from a seeded generator, against the two properties
that matter: it never throws, and it either returns the input unchanged or something strictly
shorter that still begins with the same signature. That found a real defect on the first run: when
the chunk walk stopped early on a damaged PNG, the bytes after the last complete chunk were silently
DROPPED — a stripper truncating a file it had not understood. Three conservative exits came out of
it (no SOS in a JPEG, no IEND in a PNG, bytes appended after IEND — which are carried over verbatim
rather than made a reason to give up on the whole file), and each one is reverted individually by
the break test, because a guard no test reaches is not a guard. Two of the three were unreachable by
the fuzz and needed directed fixtures; that is the point of checking.

<a id="gate-34"></a>

## Gate 34 — Deleted content does not travel, and that is now measured rather than assumed.

A SQLite delete frees the page; it does not erase the bytes — so a plain copy of `world.db` would
hand whoever you shared it with every entry you ever wrote and removed, readable in a text editor.
`packWorld` uses `VACUUM INTO`, which REBUILDS the database into the target instead of copying it,
and free pages are not rebuilt. The self-check writes something distinctive, deletes it, packs, and
searches the packed FILE for it — with a negative control, so it cannot pass on an empty file.
Replacing `VACUUM INTO` with a plain copy makes it fail, which is the proof. NOTE the counterpart:
`backups/` are raw `copyFileSync` copies by design (a backup should be faithful for recovery), so a
backup CAN still contain deleted content. Backups are local, restore is manual, and the shareable
artifact is the `.world` — but they are not the thing to send anybody.

<a id="gate-35"></a>

## Gate 35 — The depth gate can destroy data by being WRONG, and nothing tested that side.

`depthOk` scans rather than parses, so it has to know that a brace inside a string value is text —
and getting that wrong does not throw, it silently resets the entry's `fields` to `{}` at the entry
gate. Silent data loss on a perfectly good world, which is the worst failure that function can have.
The existing tests covered only the reject side (10 000-deep gets reset) and a trivially shallow
accept. There is now a fixture whose strings hold a hundred braces, an escaped quote and a trailing
backslash — not contrived, since anyone writing about a constructed language keeps grammar notation
and quoted samples in their notes. Making the scanner blind to strings makes it fail.

<a id="gate-36"></a>

## Gate 36 — A failed undo said nothing.

`run` catches a throwing step, pushes the entry back and returns — the stacks stay intact, which was
the whole point of that catch — but both callers received the same `false` they get from an EMPTY
stack, so Ctrl+Z on a failure did nothing visible at all and the only trace was a WARN in a log
nobody had a reason to open. That is a quiet half-success, which the comment above that function
already calls impossible to reconstruct later. `StepResult` ('ok' | 'empty' | 'failed') separates
the two falsy cases: an empty stack stays silent because it is not a fault, a failure raises the
toast that points at the log. The History panel does the same for a partial jump — `goTo` returns
how far it actually got, and the panel used to just look like it had ignored the click. Same rule as
App's global error listener: **a fault must SAY so.**

<a id="gate-37"></a>

## Gate 37 — A world from a NEWER build was opened and quietly stripped.

`dropForeignTables` deletes everything a file carries that is not one of our five tables, with its
rows and without a word — exactly right for a smuggled table, catastrophic for one a later version
of this app added. Save with a future build, open with an older one, and the new data is gone. The
error screen has always told users a file "may have been created by a newer version"; nothing gave
the app any way to know. `FORMAT_VERSION` now lives in `PRAGMA user_version` — a header FIELD, not a
row, so there is no cell to leave residue and `VACUUM INTO` carries it (verified before relying on
it) — and `probeWorldFile` refuses anything higher, before a byte is touched, with a message of its
own rather than "not a world file". Files written before the gate read back as 0 and still open,
which is asserted alongside the refusal. **Bump it when a change would make an older build destroy
data**, not for ordinary additions: a new settings key or a new key inside `fields` is invisible to
the gates. This one matters most BEFORE the alpha testers exist — once files are in the wild the
marker cannot be added retroactively.

<a id="gate-38"></a>

## Gate 38 — "Fire and forget" has to mean BOTH failure modes.

The three logging methods on `api` carried that promise in a comment and `.catch(() => {})` in the
code, which covers a rejected promise and nothing else — `inv` reaches into `window.api.invoke`, and
when the bridge is missing that throws SYNCHRONOUSLY, straight past the catch. The bridge is missing
exactly when the preload threw, which gate 14 makes it do on purpose. Seen LIVE, by loading the
renderer in a browser where there is no preload: every error the app reported produced a second
error from the REPORTER, and the global handler that caught that one called the reporter again,
bounded only by the five-second dedup in main.tsx. They go through `quiet()` now. Gate 32 had fixed
the boundary's own reporter and missed the global one; **reporting a fault must never be able to
become one**, on every path. The same browser load is what proves gates 32 and the `main.tsx` guard
work: with no bridge at all the app still mounts and still shows the exit screen, which is exactly
what both were written for and neither could be tested any other way.

<a id="gate-39"></a>

## Gate 39 — The WRITE boundary asks what the OPEN asks.

`patchSql` allow-lists the COLUMNS and always did — that is what stops a renderer moving a drawing
to another map — but nothing checked the VALUES, so `updateFeature` accepted `not json at all`, an
empty string, a number, `{"type":"Evil","coordinates":"x"}`. The app could therefore put a row into
its own working copy that its own `repairImportedJson` would reset on the next open, and `packWorld`
would hand that row to whoever the world was shared with. The four predicates (`depthOk`,
`isPlainObject`, `isArray`, `isGeometry`) were closures inside `repairImportedJson`; they are pure,
so they moved to module scope and `assertFeaturePatch` uses THE SAME ones — a rule this exact would
drift on the first change if it existed twice. They now live in `valueGuards.ts` with `assetName`,
which is the same move one step further: pure, so they belong where nothing around them can write
anything. Both gates are still exercised through `db.ts`'s own surface, which did not change. Deliberately NOT stricter than the open: undo writes
back the string the file arrived with, so a narrower rule here would make Ctrl+Z fail on a world
that opened cleanly (non-finite coordinates are the concrete case — `1e999` passes both gates, on
purpose). `style` gets `isPlainObject` and no more, because that is the entire contract its
consumers have.

<a id="gate-40"></a>

## Gate 40 — A user action that touches several rows is ONE transaction, and its undo entry is pushed only after it lands.

Nothing in `db.ts` used a transaction before. A weld writes a border and its neighbour; failing
between them left the two sides of the same line disagreeing, which is the one thing the weld exists
to prevent. A conquest re-parented five realms and stopped at three. Worse, `pushUndo` ran BEFORE
the writes, so a failure left a step in the history that had not happened and Ctrl+Z then rewrote
rows nothing had touched. `tx()` (BEGIN IMMEDIATE, rollback on throw, `isTransaction` as the nesting
guard) plus three narrow batch methods — `updateFeatures`, `updateEntities`, `deleteFeatures` — and
`restoreEntity`/`restoreEntities`/`restoreMap` wrapped internally. Validation runs BEFORE `BEGIN` so
a refused batch never opens one; that ordering is a preference, not a testable property (breaking it
produces the same observable outcome, checked). **A user action that spans two TABLES cannot be a
batch** — the entity's id is an INPUT to the feature, so the second statement depends on the first —
so those are one method per action: `createDrawing`/`deleteDrawing` (a drawing IS an article, two
inserts; failing between them left an entity with no drawing, an empty sidebar row the user never
made), `createFeatureFork`/`deleteFeatureFork` (a copy with no closed original is two borders
claiming the same land in the same year), and `updateFeatureLink` (rebind + drop the article the
drawing left if the app invented it — the orphan test moved into main WITH the write, because in the
renderer it was two writes and TWO `pushUndo` calls, so one Ctrl+Z put the drawing back and left the
article deleted). A generic "run these in a transaction" call over IPC was rejected: it is a small
RPC engine and would let a compromised renderer compose sequences nobody designed. **A relation is
the fourth of these**: typing a name into the dynasty section is how people get made here, so "add a
mother called X" is an entity and a link whenever X is new — `addRelation`/`deleteRelation`, with
EITHER endpoint allowed to be the creation because a mother is self→person and a child is
person→self. It also gained an undo entry, which adding a relation never had (removing one always
did). Its redo passes the DESCRIPTION again rather than the id it got the first time: the person was
deleted with the link, so they come back under a new row id, and the ref has to carry what the NEXT
undo must delete — the identity-drift rule, and the regression caught it failing. **Method names are
self-classifying on purpose** — `forkFeature`/`relinkFeature` were renamed because they missed
`MUTATES` and the self-check refused them, which is that invariant working. Not every composite
transaction is testable: `createDrawing`'s second statement has a real foreign key so a
mid-transaction failure is arrangeable and asserted, while `createFeatureFork` has no reachable
failure between its two statements — that one is insurance, written down rather than asserted
(removing its `tx` leaves the suite green, checked).

<a id="gate-41"></a>

## Gate 41 — The OUTPUT boundary, and what it is actually for.

`repairImportedJson` runs at the OPEN; `packWorld` re-exported whatever the working copy held, so a
row the app's own gate rejects could travel on to whoever the world was shared with.
`sanitizeExport` now runs the SAME rule (`repairJson`, one function, two callers) on the VACUUM INTO
snapshot — never on the working copy, because repairing a file you were GIVEN is a cost the user
accepts while rewriting their own database on the way to Ctrl+S is data loss they never asked for.
**Only what the open would reject**: non-finite coordinates, extra keys inside a geometry and
enormous-but-valid style JSON all pass the open, so they pass here and travel exactly as the user
has them. **The scope is narrower than it first looks and that is written down deliberately** — all
seven values the E-02 audit found surviving an A→B→C cycle are things the open ACCEPTS, so the
sanitiser does not stop them and should not. What it closes is a working copy holding rejected rows
that never came through `unpackWorld`: one written by a build older than the write gates, or
`world.db` corrupted out of band. **Sanitising after `VACUUM INTO` needs a second `VACUUM`** — an
UPDATE frees the old cell without erasing the bytes, so the rejected value was still plainly
readable in the packed file. Gate 27's lesson, in a second place, found by the regression on its
first run. The write gates were completed in the same pass (`assertEntityPatch`, `assertMapParent`,
`assertSettingValue` on `createEntity`/`updateEntity`/`updateMap`/`setSetting`); `settings` is
checked ONLY in the form the open deletes, because the same table legitimately holds `dark`, `tr`, a
path and a bare number — refusing every non-object there breaks `unpackWorld`'s own
`setSetting('worldFile', path)`, measured.

<a id="gate-21"></a>

## Gate 21 — The break-test rule has teeth:

every assertion added for these gates was verified by first breaking the fix and watching the
self-check fail. THREE of them passed against the broken code on the first try. Twice
`pruneUnusedAssets` had deleted the evidence before the assertion looked for it; once the assertion
was matching the COMMENT that explained the line it was meant to be guarding, so deleting the line
changed nothing. A green run over a vacuous assertion is worse than no assertion, because it is read
as coverage. Strip comments before asserting against source, and make sure the fixture cannot be
swept up before the check.
