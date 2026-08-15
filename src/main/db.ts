import { DatabaseSync } from 'node:sqlite'
import { join, basename, extname, normalize, sep } from 'path'
import {
  mkdirSync,
  copyFileSync,
  existsSync,
  rmSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'fs'
// Only `logEvent` is left of the log surface: the module's own functions record article events
// (see the session-log section in CLAUDE.md). initLog, logTime, noteCall and the rest were the
// harness exercising the logger, and went to tests/db.test.ts with it — as did mkdtempSync,
// utimesSync, homedir, tmpdir, assert and the two log thresholds, which nothing here ever used.
import { logEvent } from './log.ts'
// Pure helpers that used to live in this file. `.ts` extensions for the same reason `./log.ts`
// carries one: `node tests/db.test.ts` runs this under bare node, whose ESM resolver does not
// guess an extension.
//
// RE-EXPORTED, not merely imported. Both are part of what this module has always offered — the
// self-check imports them from here, and packaging, the write gates and the notes on them all
// name db.ts. Keeping the surface identical is what makes "the move changed no behaviour and lost
// no coverage" a thing the harness can demonstrate rather than a claim in a commit message.
import { stripImageMetadata } from './imageMeta.ts'
import { assetName, isArray, isGeometry, isPlainObject, MAX_ASSET_NAME } from './valueGuards.ts'
export { stripImageMetadata } from './imageMeta.ts'
export { assetName } from './valueGuards.ts'

// Kept free of Electron imports so `node tests/db.test.ts` can run the self-check standalone.
let db!: DatabaseSync
// The data folder itself, kept because resolveAssetPath answers questions about paths BELOW it
// (the world:// scheme is handed a path relative to this, not to assets/).
let dataDir: string
let assetsDir: string
let dbFile: string
let backupsDir: string
let notesDir: string
const BACKUP_KEEP_DAYS = 30
/** …and no more than this many, however recent. See backupIfNeeded for why both are needed. */
const BACKUP_KEEP_FILES = 60

/**
 * Pragmas set on EVERY connection, before anything reads the file.
 *
 * A `.world` is someone else's SQLite database opened over yours, which is the situation SQLite's
 * own "defence against dark arts" note is written for.
 *
 * - trusted_schema OFF stops any function call the FILE's schema carries — in a view, a trigger,
 *   a generated column or an index on an expression — from being invoked while we read it. All
 *   three kinds are dropped on open (dropForeignSchema), but the drop itself parses that schema,
 *   so the pragma has to be in place before it, not after.
 * - cell_size_check ON makes SQLite validate a b-tree cell against the page as it reads rather
 *   than trusting the header, which is what turns a deliberately corrupted page into an error.
 * - foreign_keys is not defence, it is the ON DELETE CASCADE the schema below declares: SQLite
 *   defaults it OFF per connection, so without it deleting a map would leave its features behind.
 */
const PRAGMAS = `
PRAGMA trusted_schema = OFF;
PRAGMA cell_size_check = ON;
PRAGMA foreign_keys = ON;
`

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS entities (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  fields TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY,
  from_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  to_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relation TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS maps (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  parent_map_id INTEGER REFERENCES maps(id) ON DELETE SET NULL,
  image_path TEXT,
  width INTEGER,
  height INTEGER,
  layers TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS features (
  id INTEGER PRIMARY KEY,
  map_id INTEGER NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
  entity_id INTEGER REFERENCES entities(id) ON DELETE SET NULL,
  geometry TEXT NOT NULL,
  style TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

/** Open a database with the defensive pragmas already applied. Every open of a file a `.world`
 *  has ever touched goes through here — see PRAGMAS for what they defend against. */
function openDb(file: string, opts?: { readOnly: boolean }): DatabaseSync {
  // Not `new DatabaseSync(file, opts)`: node:sqlite rejects an explicit undefined for its options
  // argument ("The options argument must be an object"), which the self-check caught immediately.
  const d = opts ? new DatabaseSync(file, opts) : new DatabaseSync(file)
  d.exec(PRAGMAS)
  return d
}

export function initDb(dir: string): void {
  dataDir = dir
  assetsDir = join(dir, 'assets')
  mkdirSync(assetsDir, { recursive: true })
  dbFile = join(dataDir, 'world.db')
  backupsDir = join(dataDir, 'backups')
  notesDir = join(dataDir, 'notes')
  rescueLeftover()
  db = openDb(dbFile)
  db.exec(SCHEMA)
  migrateLegacyKeys()
}

/**
 * A `.rescue` still on disk means the last `unpackWorld` never finished — the process died between
 * the copy that put the old world aside and the line that drops it. So world.db is whatever that
 * interrupted open left behind, possibly the new file half-applied, and the `.rescue` beside it is
 * the user's only intact copy of what they had.
 *
 * It used to just sit there under a name nobody would ever open, and the next open would silently
 * write over it. Moved into `backups/`, it lands in the one folder the app tells people to look in
 * when something is wrong, it is dated so a second interruption cannot overwrite the first, and it
 * inherits the retention every other backup gets. Never restored automatically: which of the two
 * files is the one they want is not a decision to make on their behalf at launch.
 */
function rescueLeftover(): void {
  // The image staging folders are the same class of leftover and need none of the care below:
  // `.incoming` holds a copy of pictures still inside the .world, and `.prev` only ever exists
  // between two renames. A run that died mid-open leaves them behind, and unpackWorld clears them
  // on its way in anyway — this is so a crash does not leave the folder sitting there until the
  // next open, taking up the space of a world's images for nothing.
  rmSync(assetsDir + STAGING_SUFFIX, { recursive: true, force: true })
  rmSync(assetsDir + REPLACED_SUFFIX, { recursive: true, force: true })
  const rescue = dbFile + '.rescue'
  if (!existsSync(rescue)) return
  try {
    mkdirSync(backupsDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const to = join(backupsDir, `interrupted-open-${stamp}.db`)
    renameSync(rescue, to)
    logEvent('WARN', 'project.rescued', { file: basename(to) })
  } catch {
    /* the world still opens without this; a rescue we cannot move is not worth refusing to start */
  }
}

// The codebase was Turkish; its data keys were too. Now that the code asks for English keys, a
// world written by an older build would silently lose its parent chains, banners, notes and
// dynasty links — the data would still be there, the code would just be looking elsewhere. This
// renames the keys in place. It runs on every launch and on every .world opened, and is
// idempotent: a key already migrated is simply absent, and an existing English key is never
// overwritten by a stale Turkish one.
const FIELD_RENAMES: Record<string, string> = {
  '\u0073\u0061\u006e\u0063\u0061\u006b': 'banner',
  '\u00fcst': 'parent',
  '\u006e\u006f\u0074\u006c\u0061\u0072': 'notes',
  'hiyerar\u015fi': 'hierarchy',
  'y\u00f6netim': 'government',
  'y\u00f6netici': 'ruler',
  '\u0068\u0061\u006e\u0065': 'house',
  '\u0072\u0065\u006e\u006b': 'color',
  '\u0063\u0069\u006e\u0073\u0069\u0079\u0065\u0074': 'gender',
  'do\u011fum': 'birth',
  '\u00f6l\u00fcm': 'death'
}
// Family links live in links.relation, so they need the same treatment
const RELATION_RENAMES: Record<string, string> = {
  '\u0061\u006e\u006e\u0065': 'mother',
  '\u0062\u0061\u0062\u0061': 'father',
  'e\u015f': 'spouse'
}

/** Rename legacy Turkish data keys to their English equivalents; returns rows touched.
 *  Only the fixed set above is renamed — map-mode dimensions are the
 *  user's own vocabulary and must be left exactly as typed. */
export function migrateLegacyKeys(): number {
  let changed = 0
  const upd = db.prepare(`UPDATE entities SET fields = ? WHERE id = ?`)
  for (const r of db.prepare(`SELECT id, fields FROM entities`).all() as {
    id: number
    fields: string
  }[]) {
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(r.fields || '{}') as Record<string, unknown>
    } catch {
      continue // malformed JSON is repairImportedJson's job, not ours
    }
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) continue
    let touched = false
    for (const [from, to] of Object.entries(FIELD_RENAMES)) {
      if (!(from in obj)) continue
      if (!(to in obj)) obj[to] = obj[from] // never clobber an already-English value
      delete obj[from]
      touched = true
    }
    // Legacy gender values are persisted vocabulary too.
    if (obj['gender'] === '\u0065\u0072\u006b\u0065\u006b' || obj['gender'] === 'kad\u0131n') {
      obj['gender'] = obj['gender'] === '\u0065\u0072\u006b\u0065\u006b' ? 'male' : 'female'
      touched = true
    }
    if (touched) {
      upd.run(JSON.stringify(obj), r.id)
      changed++
    }
  }
  const rel = db.prepare(`UPDATE links SET relation = ? WHERE relation = ?`)
  for (const [from, to] of Object.entries(RELATION_RENAMES))
    changed += Number(rel.run(to, from).changes ?? 0)
  // Silent until now, and it rewrites rows on every launch and every open. A world that keeps
  // reporting migrations is one where something is writing the old keys back.
  if (changed) logEvent('INFO', 'data.migrated', { rows: changed })
  return changed
}

// Once a day (at app launch): take a dated copy of world.db and prune old copies.
// Restore is deliberately manual: with the app closed, copy a file from backups/ over world.db.
export function backupIfNeeded(): void {
  mkdirSync(backupsDir, { recursive: true })
  const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  const target = join(backupsDir, `world-${today}.db`)
  const made = !existsSync(target)
  if (made) copyFileSync(dbFile, target)
  // BOTH limits, cheapest first — the same pair the session log keeps, and for the same reason.
  // Age alone bounds nothing: a backup is taken on every launch and again on every file opened, so
  // three weeks of ordinary use came to 297 files and 8.4 GB without one of them being old enough
  // to prune. Age answers the machine left alone for months; count answers the busy afternoon.
  const cutoff = Date.now() - BACKUP_KEEP_DAYS * 24 * 60 * 60 * 1000
  let dropped = 0
  const drop = (p: string): void => {
    try {
      unlinkSync(p)
      dropped++
    } catch {
      /* a backup that will not delete is not worth failing a launch over */
    }
  }
  // WHEN THE BACKUP WAS TAKEN, which is not its mtime. `copyFileSync` uses CopyFileEx on Windows
  // and that copies the source's timestamps, so a backup of a world.db untouched for a month is
  // born already older than the cutoff — and was deleted on the very next launch, silently, which
  // is the one case a backup exists for. birthtime is the file's own creation; mtime is the
  // fallback for filesystems that do not keep one.
  const takenAt = (p: string): number => {
    const s = statSync(p)
    return s.birthtimeMs > 0 ? s.birthtimeMs : s.mtimeMs
  }
  const left: { p: string; at: number }[] = []
  for (const name of readdirSync(backupsDir)) {
    const p = join(backupsDir, name)
    const at = takenAt(p)
    if (at < cutoff) drop(p)
    else left.push({ p, at })
  }
  // Newest kept: the copy taken seconds before something went wrong is the one worth having.
  left.sort((a, b) => b.at - a.at)
  for (const f of left.slice(BACKUP_KEEP_FILES)) drop(f.p)
  // Restoring is manual, so the only thing between a bad day and lost work is knowing a copy was
  // taken — and that it was taken BEFORE whatever went wrong. Nothing is said on the launches that
  // find today's copy already there.
  if (made || dropped) logEvent('INFO', 'project.backup', { daily: today, dropped })
}

// --- The .world file format: EVERYTHING in one file ---
// Format = a SQLite copy with the same schema + an extra `assets` table (images embedded as BLOBs).
// The working copy (world.db + assets/) is untouched by this — Save packs, Open unpacks.
// settings.worldFile is the Ctrl+S target in the WORKING COPY only — packWorld strips it, so a
// shared file never carries the path it was saved to. See there.

/** Pack the working copy (db + the images in assets/) into a single .world file. */
export function packWorld(targetPath: string): void {
  pruneUnusedAssets() // drop unused images before saving → lean .world and working copy
  // The path does NOT travel — and this has to happen BEFORE the rebuild below, which is the
  // whole lesson. Deleting the row from the OUTPUT afterwards removed it from the table and left
  // its BYTES sitting in the page: SQLite frees a cell by dropping it from the page index, not by
  // erasing it, so `C:\Users\<the author>\…` was still readable in the shared file with a
  // text editor. Measured on a real one. VACUUM INTO REBUILDS the database into the target, so
  // anything removed before it is genuinely absent from the output, and anything written after it
  // can leave residue — which is why the images are inserted (never deleted) and nothing else is.
  //
  // Deleting from the working copy costs nothing: nothing reads this row. main keeps the Ctrl+S
  // target in memory as `currentFile`, `unpackWorld` writes the real source path back on open,
  // and the start screen asks `worldInfo()`.
  db.exec(`DELETE FROM settings WHERE key = 'worldFile'`)
  const tmp = targetPath + '.tmp'
  rmSync(tmp, { force: true })
  db.exec(`VACUUM INTO '${tmp.replaceAll("'", "''")}'`) // clean, atomic snapshot
  // openDb, not a bare DatabaseSync: the claim in PRAGMAS is that EVERY open of a file a `.world`
  // has touched applies them, and this was the one that did not. The tmp is a VACUUM INTO of the
  // working copy, which after an open carries a schema that came from someone else's file — the
  // foreign triggers and views are dropped by then, so nothing is known to be wrong here. An
  // invariant with one exception in it is not an invariant, and this is the cheaper end of proving
  // that.
  const out = openDb(tmp)
  // The output trust boundary. On the SNAPSHOT, inside the same try/finally that already deletes
  // it on any failure — so a sanitise that throws costs the save and nothing else: the working
  // copy is not touched by this function past the two lines above, and the target .world is only
  // replaced by the rename at the very end.
  // Everything from here to the close is inside a try, and the reason is the NEXT save rather than
  // this one. A throw in the loop below — an image deleted between the readdir and the read, a
  // disk that fills partway through — used to leave the temp file open AND on disk, and Windows
  // will not delete a file something still holds. So `rmSync(tmp)` at the top of the next save
  // threw too, and saving stayed broken until the app was restarted: one transient failure turned
  // into a permanent one. Closing the handle and clearing the temp on the way out makes the
  // failure cost exactly the save it happened on.
  let packed = false
  try {
    if (sanitizeExport(out))
      // VACUUM after, and this is gate 27's lesson in a second place: an UPDATE frees the old
      // cell by dropping it from the page index, it does not erase the bytes. Sanitising AFTER
      // the VACUUM INTO therefore left the rejected value plainly readable in the packed file
      // with a text editor — measured, on the first run of the regression that now guards it.
      // Rebuilding the snapshot is what makes the removal real. Skipped entirely when nothing
      // was sanitised, which is every ordinary save.
      out.exec(`VACUUM`)
    out.exec(`CREATE TABLE IF NOT EXISTS assets (name TEXT PRIMARY KEY, data BLOB NOT NULL)`)
    out.exec(`PRAGMA user_version = ${FORMAT_VERSION}`) // header field, not a row — see FORMAT_VERSION
    const ins = out.prepare(`INSERT OR REPLACE INTO assets (name, data) VALUES (?, ?)`)
    for (const name of readdirSync(assetsDir)) {
      const p = join(assetsDir, name)
      // stripImageMetadata: what travels must not carry the author. See there.
      if (statSync(p).isFile()) ins.run(name, stripImageMetadata(readFileSync(p)))
    }
    packed = true
  } finally {
    // `finally`, not a catch: the close has to happen on every path, and a guarantee that reads as
    // unconditional needs no test to be believed. (Which matters here, because the failure this
    // defends against — a read that fails partway through the images — cannot be arranged in the
    // self-check without racing the filesystem.)
    out.close()
    if (!packed) rmSync(tmp, { force: true })
  }
  renameSync(tmp, targetPath) // write to tmp then rename — a half-written file can never remain
}

/** How deep a map or folder tree may be before the entry gate cuts the link. See the tree repair
 *  in repairImportedJson for why a depth limit sits next to the cycle check. */
const MAX_TREE_DEPTH = 64

/**
 * The format this build writes, and the highest it will open.
 *
 * The reason is `dropForeignTables`: anything in a file that is not one of OUR five tables is
 * deleted on open, with its rows, silently — which is right for a smuggled table and catastrophic
 * for a table a LATER version of this app added. Save with a future build, open with this one, and
 * the new data is gone with nothing said. The error screen has always told users a file "may have
 * been created by a newer version"; nothing gave the app any way to know.
 *
 * It lives in `PRAGMA user_version`, a field in the database header rather than a row: no cell to
 * leave residue, and `VACUUM INTO` carries it (verified). Files written before this existed read
 * back as 0, which is below 1, so every world already on disk still opens.
 *
 * BUMP THIS when a change would make an older build destroy data — a new table, a column an older
 * build would drop, a meaning change an older build would misread. Not for ordinary additions:
 * a new settings key or a new field inside `fields` is invisible to the gates and costs nothing.
 */
export const FORMAT_VERSION = 1

/** Thrown when a file was written by a build that knows more than this one does. Refusing rather
 *  than opening, because the failure mode is silent deletion, not a visible error. */
export const WORLD_TOO_NEW = 'WORLD_TOO_NEW'

/** Thrown when the chosen file is not one of our worlds. The renderer shows it as a message
 *  rather than a crash, so the code is a stable string and not prose. */
export const NOT_A_WORLD = 'NOT_A_WORLD'

/** Thrown when a file's embedded images exceed what any real world carries. Separate from
 *  NOT_A_WORLD because the file is well-formed — it is the size that is refused, and the user
 *  deserves to be told which of the two happened. */
export const WORLD_TOO_LARGE = 'WORLD_TOO_LARGE'
const MAX_ASSETS = 10_000
const MAX_ASSET_BYTES = 4 * 1024 * 1024 * 1024

/** Is this file a world we can open? Checked BEFORE anything is overwritten.
 *
 *  Opening used to copy the file straight over world.db and only then try to open it. A file
 *  that was not a database — a renamed .txt, a truncated download, a hostile file — threw at
 *  that point with the working copy ALREADY destroyed and the live handle dead. Worse, the
 *  garbage stayed at world.db, so the next launch threw in initDb before a window existed:
 *  the app could not be started again at all, and ErrorBoundary (a renderer thing) could not
 *  help. Verified in the db self-check.
 *
 *  Read-only so probing can never modify the candidate, and the missing-table case is what
 *  separates one of our worlds from someone's unrelated SQLite file. */
function probeWorldFile(sourcePath: string): void {
  let probe: DatabaseSync | null = null
  // Set inside the try and rethrown after it: the catch below turns EVERY failure into
  // NOT_A_WORLD, and "this is not a world" is the wrong thing to tell someone whose file is
  // simply newer than their app.
  let tooNew = false
  try {
    probe = openDb(sourcePath, { readOnly: true })
    // An empty world is legitimate — these return no row. Only a MISSING table throws.
    probe.prepare(`SELECT 1 FROM entities LIMIT 1`).get()
    probe.prepare(`SELECT 1 FROM maps LIMIT 1`).get()
    probe.prepare(`SELECT 1 FROM features LIMIT 1`).get()
    // …and they must be real TABLES. A file can name a VIEW `entities`, which reads like a table
    // and passes the queries above, then refuses every write later — an open that half-succeeds
    // and leaves the app wedged. packWorld never produces one, so this only rejects files that
    // lie about their shape.
    const real = probe
      .prepare(
        `SELECT COUNT(*) AS n FROM sqlite_master
         WHERE type = 'table' AND name IN ('entities', 'maps', 'features')`
      )
      .get() as { n: number }
    if (real.n !== 3) throw new Error(NOT_A_WORLD)
    const v = probe.prepare(`PRAGMA user_version`).get() as { user_version?: number }
    tooNew = Number(v?.user_version ?? 0) > FORMAT_VERSION
  } catch {
    throw new Error(NOT_A_WORLD)
  } finally {
    probe?.close()
  }
  if (tooNew) throw new Error(WORLD_TOO_NEW)
}

/**
 * Does calling this method CHANGE THE WORLD?
 *
 * The answer drives the dirty flag, which drives the star in the title bar and the Save / Don't
 * Save / Cancel prompt on close — so a method that changes something and is not recognised here
 * lets the user close on unsaved work without being asked. That is the most expensive failure
 * this file can have, and it is silent.
 *
 * It lives in db.ts rather than in the IPC dispatch that uses it because "does this change the
 * world" is a question about the data layer, and because here the self-check can hold it against
 * the actual method names: every one of them must either match this or be listed as a read.
 */
export const MUTATES = /^(create|update|delete|add|set|restore|retype|import|pick)/

/** Our five tables. Anything else a .world carries is not part of the format. */
const OUR_TABLES = new Set(['entities', 'links', 'maps', 'features', 'settings'])

/** Drop everything a .world carries that is not our schema.
 *
 *  A database file holds more than rows. A TRIGGER on entities rides along with the data and
 *  then fires against the USER's own edits from that point on — "after every insert, delete
 *  something else" is sabotage of the world they are building, and it survives every save
 *  because packWorld copies the whole database. Triggers cannot execute code, they are SQL
 *  only, so this is integrity rather than escape; but the file model treats a shared .world as
 *  hostile input, and none of this belongs to the format. packWorld only ever emits our tables
 *  plus `assets`, so nothing legitimate is lost.
 *
 *  sqlite_% is skipped: those are SQLite's own internal objects (autoindexes) and cannot be
 *  dropped. Names are quoted and doubled — a table can be called `"; DROP …`. */
function dropForeignSchema(): void {
  const q = (name: string): string => `"${name.replaceAll('"', '""')}"`
  for (const r of db
    .prepare(
      `SELECT type, name FROM sqlite_master
       WHERE type IN ('trigger', 'view', 'index') AND name NOT LIKE 'sqlite_%'`
    )
    .all() as { type: string; name: string }[])
    db.exec(
      `DROP ${r.type === 'trigger' ? 'TRIGGER' : r.type === 'view' ? 'VIEW' : 'INDEX'} ${q(r.name)}`
    )
}

/** Stray TABLES, dropped after the assets table has been consumed (it is a real part of the
 *  file format while unpacking, and only becomes stray once its images are on disk). */
function dropForeignTables(): void {
  for (const r of db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all() as { name: string }[])
    if (!OUR_TABLES.has(r.name)) db.exec(`DROP TABLE "${r.name.replaceAll('"', '""')}"`)
}

/**
 * Where a `.world`'s images are unpacked BEFORE they are allowed near `assets/`, and where the
 * originals they replace are kept until the open has committed.
 *
 * `world.db` has had a rescue copy since the beginning; `assets/` never did, and the images were
 * written straight into it. So a file that extracted its pictures and then threw — a malformed
 * column, a bad settings value, anything the repairs reject — was rolled back for the database
 * and not for the folder: the user got their world back with someone else's pictures in it,
 * under a message telling them the open had failed. Nothing recovered that, because the backups
 * hold `world.db` alone.
 *
 * Two folders rather than one because the swap has to be reversible in both directions: the
 * incoming images land in `.incoming`, and the only originals that can be lost are the ones a
 * staged name overwrites, so those move to `.prev` first and come back if a later step fails.
 * Siblings of `assets/`, not children — `pruneUnusedAssets` reads that folder, and `world://`
 * confinement is a prefix test against it (see resolveAssetPath), so neither may see these.
 */
const STAGING_SUFFIX = '.incoming'
const REPLACED_SUFFIX = '.prev'

/** Open a .world file OVER the working copy (the current working copy is overwritten —
 *  the caller must confirm/back up first). Embedded images are extracted into assets/. */
export function unpackWorld(sourcePath: string): void {
  probeWorldFile(sourcePath) // throws before anything is touched
  // Even past the probe, the copy + open is the one destructive step in the app. Keep the old
  // working copy one file away and put it back if any part of it fails, so a failed open always
  // ends with a live db and the world the user already had — never a half-replaced one.
  const rescue = dbFile + '.rescue'
  db.close()
  // Taking the rescue copy is itself a step that can fail — it is a full copy of the world, so a
  // disk with no room is the obvious way — and the handle is already CLOSED by the line above. Left
  // unguarded that threw out of here with no database open at all: every later query failed, the
  // renderer answered with a toast per query, and only a restart fixed it. Same rule as everywhere
  // else in this file: a failed operation still ends with a live db.
  try {
    copyFileSync(dbFile, rescue)
  } catch (err) {
    // The reopen is guarded for the same reason putBack's is: this runs when something has already
    // gone wrong, and the likeliest cause — a full disk, a lock on world.db — is the same reason
    // the open would fail. Unguarded, its error REPLACED the copy's and still left the handle
    // closed, which is the state this whole block exists to prevent.
    try {
      db = openDb(dbFile)
      db.exec(SCHEMA)
    } catch {
      /* nothing further to try; the original failure below is the honest answer */
    }
    throw err
  }
  const staging = assetsDir + STAGING_SUFFIX
  const replaced = assetsDir + REPLACED_SUFFIX
  // Names moved out of assets/ (or newly placed into it) by commitAssets, newest last, so a
  // failure part-way through the swap can be walked back exactly.
  const swapped: { name: string; hadPrev: boolean }[] = []
  const clearStaging = (): void => {
    rmSync(staging, { recursive: true, force: true })
    rmSync(replaced, { recursive: true, force: true })
  }
  clearStaging() // a previous run that died mid-open leaves these; they are not ours to keep
  /**
   * Move the staged images into `assets/` — the one destructive step for that folder, and the
   * last thing the open does that a failure would have to undo.
   *
   * Per file rather than swapping the directory, because a name already in `assets/` that the
   * new world REFERENCES but does not carry has always survived an open, and `pruneUnusedAssets`
   * is what decides afterwards whether it stays. Renaming the whole folder would quietly change
   * that; moving file by file leaves both behaviours exactly as they were.
   */
  const commitAssets = (): void => {
    if (!existsSync(staging)) return
    // The folder is listed ONCE rather than asking existsSync per file: at the MAX_ASSETS cap that
    // is ten thousand extra metadata calls against a directory of ten thousand entries, and NTFS
    // charges for both. Measured over the whole swap: 300 images (a large real world) 173 ms.
    const already = new Set(readdirSync(assetsDir))
    for (const name of readdirSync(staging)) {
      const target = join(assetsDir, name)
      const hadPrev = already.has(name)
      if (hadPrev) {
        mkdirSync(replaced, { recursive: true })
        renameSync(target, join(replaced, name))
      }
      renameSync(join(staging, name), target)
      swapped.push({ name, hadPrev })
    }
  }
  /** Undo commitAssets as far as it got. Best effort per file: one that will not move back must
   *  not stop the rest from being restored. */
  const restoreAssets = (): void => {
    for (const s of swapped.reverse()) {
      try {
        if (s.hadPrev) renameSync(join(replaced, s.name), join(assetsDir, s.name))
        else rmSync(join(assetsDir, s.name), { force: true })
      } catch {
        /* this one image stays as the file left it; the others still go back */
      }
    }
    swapped.length = 0
  }
  const putBack = (err: unknown): never => {
    restoreAssets() // BEFORE the database, so a throw below cannot skip the images
    clearStaging()
    try {
      db.close()
    } catch {
      /* already closed, or never opened — the copy below is what matters */
    }
    // Each step separately, because putBack runs when something has ALREADY gone wrong and the
    // most likely reason — no disk space — is the same reason the copy back would fail. Its own
    // failure must not replace the original error, and must not skip the reopen: the app being
    // usable afterwards matters more than which world it is showing.
    let restored = false
    try {
      copyFileSync(rescue, dbFile)
      restored = true
    } catch {
      /* world.db is whatever the failed open left; the rescue stays on disk, and the next launch
         moves it into backups/ under a dated name (see rescueLeftover) */
    }
    try {
      db = openDb(dbFile)
      db.exec(SCHEMA)
      if (restored) rmSync(rescue, { force: true })
    } catch {
      /* nothing further to try; the throw below is the honest answer, and the rescue is kept */
    }
    throw err
  }
  try {
    copyFileSync(sourcePath, dbFile)
    db = openDb(dbFile)
    dropForeignSchema() // BEFORE the schema exec, so a dropped view leaves room for the real table
    db.exec(SCHEMA)
    probeWritable() // CREATE TABLE IF NOT EXISTS proves nothing about a table that already exists
  } catch (err) {
    putBack(err)
  }
  // Everything the FILE can still make throw runs inside the rescue window: its assets table,
  // its foreign tables, its malformed columns. Only past this is the old world unrecoverable.
  try {
    const hasAssets = db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'assets'`)
      .get()
    if (hasAssets) {
      // Bounds on what a file may unpack, checked BEFORE a single byte is written so the rescue
      // path above can still put the old world back. Measured: 20 000 tiny images inside a 2.1 MB
      // file froze the main process for 22 seconds and left 20 000 files behind — a ~10x
      // amplification from a small download, with no privilege gained but the app unusable.
      // Both limits sit far above any real world: a large project runs to a few hundred images.
      const tally = db
        .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(data)), 0) AS b FROM assets`)
        .get() as {
        n: number
        b: number
      }
      if (tally.n > MAX_ASSETS || tally.b > MAX_ASSET_BYTES) throw new Error(WORLD_TOO_LARGE)
      // Once, not per row: `recursive: true` still stats the whole path every call, and this loop
      // runs up to MAX_ASSETS times.
      mkdirSync(staging, { recursive: true })
      let refused = 0
      for (const row of db.prepare(`SELECT name, data FROM assets`).all() as {
        name: unknown
        data: unknown
      }[]) {
        // A .world is a SHARED file: the embedded name is untrusted input, and `assetName` is
        // the whole answer to it — see there for what it refuses and why the answer is refusal
        // rather than repair. It also covers the escape this used to handle with basename
        // (`../../…`, `C:\…`) and the TYPES, which are untrusted too and easy to miss: our schema
        // says `name TEXT, data BLOB`, but SQLite is dynamically typed and the schema being read
        // here is the FILE's. A name stored as an integer made basename() throw and a null data
        // made writeFileSync throw, from a point where the rescue copy had already been dropped.
        //
        // A row that is not a name and some image bytes is simply not one of our images. Skipping
        // it is the whole response — the world still opens, with everything else in it.
        const name = assetName(row.name)
        if (!name || !ArrayBuffer.isView(row.data)) {
          refused++
          continue
        }
        // Into STAGING, never straight into assets/ — see STAGING_SUFFIX. Until the open commits,
        // the pictures the user already had are untouched.
        writeFileSync(join(staging, name), row.data as Uint8Array)
      }
      // WARN and counted: the images are the one part of a world that can go missing without the
      // world looking any different on open, so "three pictures are blank" needs a line saying
      // three were refused rather than lost.
      if (refused) logEvent('WARN', 'assets.refused', { refused })
      db.exec(`DROP TABLE assets`) // the images live on disk now
      // VACUUM, or the drop above frees pages without shrinking the FILE — which is what the line
      // above claimed to do and did not. Measured on a real working copy: 102.4 MB, of which 26 206
      // of 26 217 pages were free; vacuumed, 40 KB. Every backup copied that 102 MB, and three weeks
      // of them came to 8.4 GB of almost pure empty space. It is also cheap exactly when it matters:
      // the space to reclaim is proportional to the images just extracted, and this runs once per
      // open, next to work that already reads and writes all of them.
      db.exec(`VACUUM`)
    }
    dropForeignTables() // assets is consumed by here, so anything left over is not ours
    repairImportedJson() // reset malformed JSON columns to defaults (rationale below)
    migrateLegacyKeys() // so old .world files (with Turkish keys) still open
    api.setSetting('worldFile', sourcePath)
    // The images go in LAST, once nothing else can reject the file, and pruning follows them.
    // Both used to sit after the rescue was dropped, which is the same hole in two places: the
    // upsert needs the settings table to have the primary key our schema declares (a file writes
    // its own schema), and the prune walks a folder the filesystem can refuse. Either one throwing
    // left the user with the new world in place, no rescue, and "could not be opened".
    commitAssets()
    pruneUnusedAssets() // drop images the opened world does not use (leftovers from the previous one)
  } catch (err) {
    putBack(err)
  }
  // Only now is the old world unrecoverable, and that is the point: everything above — the schema
  // exec, the extraction, the foreign tables, the repairs, the settings write, the image swap —
  // is the part where a hostile or simply broken file can still throw. Dropping the rescue after
  // the first three lines meant a failure in any of the rest left the user with the new file in
  // place, unrepaired, and the message "that world file could not be opened".
  clearStaging()
  rmSync(rescue, { force: true })
}

/**
 * Can this database actually be WRITTEN to through our schema?
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op when a table of that name already exists, WHATEVER
 * shape it has. So a file whose `entities` carries an extra NOT NULL column with no default, a
 * `CHECK (0)` that refuses every row, or a WITHOUT ROWID primary key passes the read-only probe
 * (the tables are there and they are real tables), passes the repairs (which only UPDATE existing
 * rows), and opens with no complaint. From then on every single edit the user makes fails, one
 * error at a time, on a world that looked fine — the same half-succeeded open the VIEW check in
 * probeWorldFile exists to prevent, one step further in.
 *
 * One insert per table inside a savepoint, rolled back, is the whole test: it asks the question
 * the app will be asking all session and throws away the answer. It runs inside unpackWorld's
 * rescue window, so a file that fails it leaves the user with the world they already had.
 */
function probeWritable(): void {
  db.exec(`SAVEPOINT probe`)
  try {
    const e = db.prepare(`INSERT INTO entities (name) VALUES ('')`).run()
    const m = db.prepare(`INSERT INTO maps (name) VALUES ('')`).run()
    db.prepare(`INSERT INTO features (map_id, entity_id, geometry) VALUES (?, ?, '{}')`).run(
      m.lastInsertRowid,
      e.lastInsertRowid
    )
    db.prepare(`INSERT INTO links (from_id, to_id) VALUES (?, ?)`).run(
      e.lastInsertRowid,
      e.lastInsertRowid
    )
    db.prepare(`INSERT INTO settings (key, value) VALUES ('probe', '')`).run()
  } catch {
    throw new Error(NOT_A_WORLD)
  } finally {
    // Two statements, not one exec. As one, a failure after the ROLLBACK skipped the RELEASE and
    // left the connection inside a savepoint — and unpackWorld reaches a VACUUM a few lines later,
    // which SQLite refuses inside a transaction. A perfectly good world would have been reported
    // as unopenable. Each is attempted on its own and neither may mask the probe's own verdict.
    try {
      db.exec(`ROLLBACK TO probe`)
    } catch {
      /* nothing was written */
    }
    try {
      db.exec(`RELEASE probe`)
    } catch {
      /* the savepoint is already gone */
    }
  }
}

/**
 * THE ONE DEFINITION OF "this row is not something this app can consume".
 *
 * It takes the database to work on rather than using the module-level one, and that is the whole
 * reason it looks like this. There are now TWO boundaries that need this exact rule and they are
 * not the same boundary:
 *
 *  - the OPEN (`repairImportedJson`), where somebody else's file becomes the working copy and
 *    repairing it is the price of opening it at all;
 *  - the EXPORT (`sanitizeExport`), where the working copy becomes somebody else's file and the
 *    app must not hand on data its own gate would reject.
 *
 * Two copies of a rule this exact would drift on the first change to either. One function, two
 * callers, and the callers keep their own logging and their own transaction — because what they
 * MEAN is different even though what they DO is identical.
 *
 * Rows are NEVER deleted; only the unusable column is reset. The single exception is a settings
 * row, which has no other column to fall back to.
 */
function repairJson(target: DatabaseSync): { fixed: number; byKind: Record<string, number> } {
  const db = target // shadows the module-level handle on purpose: this function must not use it
  let fixed = 0
  // Counted per column, not just totalled: this is the one place in the app that DISCARDS a user's
  // data without asking, and "3 rows repaired" does not tell them what they lost. `geometry=3` says
  // three drawings are now dots at the origin; `fields=9` says nine articles lost their metadata.
  const byKind: Record<string, number> = {}
  const repair = <T extends { id: number; v: string }>(
    kind: string,
    rows: T[],
    ok: (v: string) => boolean,
    sql: string,
    def: string
  ): void => {
    const st = db.prepare(sql)
    for (const r of rows)
      if (!ok(r.v)) {
        st.run(def, r.id)
        fixed++
        byKind[kind] = (byKind[kind] ?? 0) + 1
      }
  }
  repair(
    'fields',
    db.prepare(`SELECT id, fields AS v FROM entities`).all() as { id: number; v: string }[],
    isPlainObject,
    `UPDATE entities SET fields = ? WHERE id = ?`,
    '{}'
  )
  repair(
    'style',
    db.prepare(`SELECT id, style AS v FROM features`).all() as { id: number; v: string }[],
    isPlainObject,
    `UPDATE features SET style = ? WHERE id = ?`,
    '{}'
  )
  repair(
    'layers',
    db.prepare(`SELECT id, layers AS v FROM maps`).all() as { id: number; v: string }[],
    isArray,
    `UPDATE maps SET layers = ? WHERE id = ?`,
    '[]'
  )
  // geometry was missing from this gate while fields/style/layers were covered, and it is
  // parsed unguarded in eight places across MapView and Atlas — so one malformed geometry in a
  // shared world took out the whole map render and the Atlas, which is exactly what this
  // function exists to prevent. Reset to a degenerate Point rather than deleting the row: the
  // rule here is that rows are never dropped, and a stray pin at the origin is visible and
  // fixable, whereas a deleted drawing is silently gone. `isGeometry` (module level, shared with
  // the write path) is what "malformed" means for this column — see there.
  repair(
    'geometry',
    db.prepare(`SELECT id, geometry AS v FROM features`).all() as { id: number; v: string }[],
    isGeometry,
    `UPDATE features SET geometry = ? WHERE id = ?`,
    '{"type":"Point","coordinates":[0,0]}'
  )
  // settings: some values are plain text ('dark', 'tr', a file path) — only JSON-LOOKING ones
  // (starting with { or [) are checked; a bad one is deleted so the code falls back to defaults
  const del = db.prepare(`DELETE FROM settings WHERE key = ?`)
  for (const r of db.prepare(`SELECT key, value FROM settings`).all() as {
    key: string
    value: string
  }[]) {
    if (!/^\s*[[{]/.test(r.value)) continue
    if (isPlainObject(r.value) || isArray(r.value)) continue
    del.run(r.key)
    fixed++
    byKind.settings = (byKind.settings ?? 0) + 1
  }
  // CYCLES AND DEPTH IN THE TWO TREES. A map's parent and a sidebar folder's parent are both plain ids, and
  // a `.world` can carry any pair it likes — nothing has to go through the UI's own guard, which
  // is written where a cycle would be CREATED. Downstream both are walked without one: MapView's
  // breadcrumb is a `while (cur)` that never terminates on a loop, and the map tree and the
  // folder tree are recursive renders. So the file, not the eleven readers, is where this is met.
  //
  // Breaking the link rather than deleting the row: the map and its drawings are the user's work,
  // and a map that comes back at the top level has lost only its place in the tree.
  //
  // DEPTH is the other half of the same hole, and it was missed the first time: a chain 50 000
  // long has no cycle in it at all, so the loop check passes it straight through — and both trees
  // are RECURSIVE renders, so the sidebar meets it as a stack overflow. (Not a brick — the error
  // boundary catches a render throw — but a world that cannot show its own tree.) 64 is chosen
  // against what a person builds: continents inside worlds inside campaigns is four or five, and
  // anyone who reaches sixty-four has stopped organising anything.
  const mapRows = db.prepare(`SELECT id, parent_map_id FROM maps`).all() as {
    id: number
    parent_map_id: number | null
  }[]
  const parentOf = new Map(mapRows.map((m) => [m.id, m.parent_map_id]))
  const clearParent = db.prepare(`UPDATE maps SET parent_map_id = NULL WHERE id = ?`)
  for (const m of mapRows) {
    const seen = new Set<number>([m.id])
    let cur = parentOf.get(m.id) ?? null
    while (cur !== null && cur !== undefined && !seen.has(cur) && seen.size <= MAX_TREE_DEPTH) {
      seen.add(cur)
      cur = parentOf.get(cur) ?? null
    }
    // Landing back on something already walked means this row sits on a loop. Cutting THIS row's
    // link is enough to open it; the rest of the chain keeps its shape. Running past the depth
    // limit ends the same way for a different reason — see MAX_TREE_DEPTH.
    if (cur !== null && cur !== undefined) {
      clearParent.run(m.id)
      parentOf.set(m.id, null)
      fixed++
      byKind.mapParent = (byKind.mapParent ?? 0) + 1
    }
  }

  // The same for the sidebar's folder tree, which lives as one JSON array in settings.
  const rawFolders =
    (
      db.prepare(`SELECT value FROM settings WHERE key = 'entityFolders'`).get() as
        { value: string } | undefined
    )?.value ?? null
  if (rawFolders && isArray(rawFolders)) {
    const folders = JSON.parse(rawFolders) as { id: string; parent: string | null }[]
    const fParent = new Map(folders.map((f) => [f.id, f.parent ?? null]))
    let cut = 0
    for (const f of folders) {
      if (!f || typeof f.id !== 'string') continue
      const seen = new Set<string>([f.id])
      let cur = fParent.get(f.id) ?? null
      while (cur && !seen.has(cur) && seen.size <= MAX_TREE_DEPTH) {
        seen.add(cur)
        cur = fParent.get(cur) ?? null
      }
      if (cur) {
        f.parent = null
        fParent.set(f.id, null)
        cut++
      }
    }
    if (cut) {
      db.prepare(`UPDATE settings SET value = ? WHERE key = 'entityFolders'`).run(
        JSON.stringify(folders)
      )
      fixed += cut
      byKind.folderParent = cut
    }
  }

  return { fixed, byKind }
}

/**
 * The OPEN boundary: someone else's file has just been copied over the working copy.
 *
 * WARN, not INFO: nothing else in the app throws a user's data away, and the only trace it used to
 * leave was the data being gone. A clean file stays silent.
 */
function repairImportedJson(): number {
  const { fixed, byKind } = repairJson(db)
  if (fixed) logEvent('WARN', 'data.repaired', { rows: fixed, ...byKind })
  return fixed
}

/**
 * The EXPORT boundary: the working copy is about to become somebody else's file.
 *
 * E-02. A `.world` that arrives with rows this app cannot consume gets them repaired on the way
 * IN — but only the rows the user then touches are rewritten, so everything they never opened was
 * carried straight back out again by `packWorld`, byte for byte. Measured: seven planted values,
 * seven still present after an ordinary edit and a save. The app was a carrier.
 *
 * Runs on the SNAPSHOT (the VACUUM INTO temp copy), never on the working copy. That is not a
 * detail: repairing at the open is something the user accepts as the cost of opening a file they
 * were given, while silently rewriting their own database on the way to Ctrl+S is data loss they
 * never asked for. The snapshot is discarded on any failure and the working copy is untouched by
 * construction — see packWorld.
 *
 * ONLY what the open would reject. Not "make the data perfect": non-finite coordinates, extra keys
 * inside a geometry and enormous-but-valid style JSON all pass the open, so they pass here too and
 * travel exactly as the user has them. The rule is "never hand on what our own gate refuses",
 * which is a narrower and more defensible promise than "hand on nothing that could ever break a
 * consumer".
 */
function sanitizeExport(out: DatabaseSync): number {
  out.exec(`BEGIN IMMEDIATE`)
  let fixed = 0
  let byKind: Record<string, number> = {}
  try {
    ;({ fixed, byKind } = repairJson(out))
    out.exec(`COMMIT`)
  } catch (err) {
    try {
      out.exec(`ROLLBACK`)
    } catch {
      /* the snapshot is thrown away either way; the caller's error is the honest one */
    }
    throw err
  }
  // Counted per column, like the open. The user is handing this file to somebody, so "nine rows
  // were dropped on the way out" is something they are owed — and never the rows themselves.
  // Guarded: a failure to log must not turn a completed pack into an exception (gate 38's rule).
  if (fixed)
    try {
      logEvent('WARN', 'export.sanitised', { rows: fixed, ...byKind })
    } catch {
      /* the file is already correct; a missing log line is not worth failing the save */
    }
  return fixed
}

/**
 * How big the open world is. For the log, where a duration means nothing without it: 100 ms is slow
 * for four articles and fast for four thousand, and every performance report so far has had to be
 * read without knowing which. Three counts, once per open — not a per-call cost.
 */
export const worldStats = (): Record<string, number> => {
  const n = (t: string): number =>
    Number((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n)
  return { entities: n('entities'), maps: n('maps'), features: n('features') }
}

/**
 * The absolute path a `world://` request may be served from, or null if it points outside
 * `assets/`.
 *
 * It lives HERE, next to the folder it defends, rather than inline in the protocol handler: this
 * is the app's only path check driven entirely by hostile input — a `.world`'s notes can name any
 * url they like and its polygon fills are loaded as WebGL textures with CORS answered — and
 * db.ts is the one main-process file the self-check can run, so the check gets assertions instead
 * of a careful reading.
 *
 * Confined to `assets/` and not to the data folder: DATA_DIR also holds world.db, the logs and
 * every backup, and the scheme exists to serve the images a world refers to. `importAsset` writes
 * `assets/<name>` and `unpackWorld` extracts there, so nothing legitimate lives anywhere else.
 *
 * The `+ sep` is what stops a sibling folder named `assets-other` from passing a plain
 * startsWith, and normalize() is what collapses `..` before the comparison rather than after.
 */
export function resolveAssetPath(rel: string): string | null {
  const full = normalize(join(dataDir, rel))
  return full.startsWith(normalize(assetsDir) + sep) ? full : null
}

/** Does the working copy hold anything worth keeping? (avoids a pointless snapshot on blank launch)
 *  A single map with no image and nothing drawn on it does NOT count. Every blank session (see
 *  index.ts) seeds exactly one so the app can land on it directly instead of an empty start
 *  screen — if that seed alone counted as content, every ordinary launch would re-trigger the
 *  snapshot-and-reset dance for a world nobody touched, which is the shape of bug that once filled
 *  `backups/` with 8.4 GB of empty sessions (see fix/backup-bloat). More than one map (the user
 *  pressed "+ New map" on purpose), or an attached image, or anything actually made, still does. */
export function hasContent(): boolean {
  return (
    !!db.prepare(`SELECT 1 FROM entities LIMIT 1`).get() ||
    !!db.prepare(`SELECT 1 FROM features LIMIT 1`).get() ||
    !!db.prepare(`SELECT 1 FROM maps WHERE image_path IS NOT NULL LIMIT 1`).get() ||
    (db.prepare(`SELECT COUNT(*) AS n FROM maps`).get() as { n: number }).n > 1
  )
}

/** Reset the working copy: empty schema + empty assets/ — a launch always opens a blank document.
 *  The caller must snapshot with packWorld first — no backup is taken here. */
export function resetWorld(): void {
  db.close()
  // The handle is CLOSED for the length of this, which is why the failure has to be caught. On
  // Windows the delete is the step that fails — SQLite opens without share-delete, so anything
  // else holding world.db (an antivirus mid-scan, OneDrive, an indexer) makes rmSync throw EBUSY —
  // and unguarded that left the app with a closed database and no way back: every later query
  // threw, the renderer answered with a toast per query, and only a restart fixed it. The same
  // rule unpackWorld's rescue path already follows: a failed operation must still end with a live
  // db. The caller still sees the throw and reports it.
  try {
    rmSync(dbFile, { force: true })
    db = openDb(dbFile)
    db.exec(SCHEMA)
  } catch (err) {
    try {
      db = openDb(dbFile)
      db.exec(SCHEMA)
    } catch {
      /* the file cannot be opened at all; the throw below is the only honest answer left */
    }
    throw err
  }
  for (const name of readdirSync(assetsDir)) {
    const p = join(assetsDir, name)
    if (statSync(p).isFile()) rmSync(p)
  }
}

// Delete unused images from assets/ and return how many were removed. A file counts as unused
// when its name appears NOWHERE in the database text (fields+content, features.style,
// maps.image_path+layers, settings.value). Matching by name is deliberately CONSERVATIVE — a
// substring collision can only KEEP an extra file, never delete one in use. Called automatically
// inside packWorld (save) and unpackWorld (open) — checkpoint/reload moments where the undo
// stack is irrelevant. Fully automatic — no UI.
function pruneUnusedAssets(): number {
  const files = readdirSync(assetsDir).filter((f) => statSync(join(assetsDir, f)).isFile())
  const texts: string[] = []
  for (const r of db.prepare(`SELECT fields, content FROM entities`).all() as {
    fields: string
    content: string
  }[])
    texts.push(r.fields, r.content)
  for (const r of db.prepare(`SELECT style FROM features`).all() as { style: string }[])
    texts.push(r.style)
  for (const r of db.prepare(`SELECT image_path, layers FROM maps`).all() as {
    image_path: string | null
    layers: string
  }[]) {
    if (r.image_path) texts.push(r.image_path)
    texts.push(r.layers)
  }
  for (const r of db.prepare(`SELECT value FROM settings`).all() as { value: string }[])
    texts.push(r.value)
  const blob = texts.join('\n')
  let removed = 0
  for (const f of files) {
    if (!blob.includes(f)) {
      rmSync(join(assetsDir, f))
      removed++
    }
  }
  // Files deleted with no UI and no undo. Conservative by design, but "my image is gone" deserves
  // a line saying how many went and when — the count against `kept` is the whole diagnosis.
  if (removed) logEvent('INFO', 'assets.pruned', { removed, kept: files.length - removed })
  return removed
}

/**
 * Run several writes as ONE. Either all of them are in the database or none is.
 *
 * Nothing in this file used a transaction before, and the shape that needed one is everywhere: a
 * user action that touches several rows was a loop of independent statements, so a constraint
 * error or a full disk part-way through left half of it applied. A weld writes a border and its
 * neighbour; failing between them leaves the two sides of the same line disagreeing, which is the
 * exact thing the weld exists to prevent. A conquest re-parents five realms and stops at three.
 *
 * BEGIN IMMEDIATE rather than a plain BEGIN: it takes the write lock up front instead of on the
 * first write, so a busy database fails here — before any of the statements have run — rather than
 * half way through.
 *
 * The rollback is guarded and its own failure is swallowed on purpose. It runs when something has
 * already gone wrong, and the caller's error is the one worth reporting; measured behaviour is that
 * the connection is usable afterwards either way. `isTransaction` is the nesting guard — SQLite has
 * no nested BEGIN, and a second one would throw and roll the OUTER work back.
 */
function tx<T>(fn: () => T): T {
  if (db.isTransaction) return fn() // already inside one; the outermost owns the boundary
  db.exec(`BEGIN IMMEDIATE`)
  try {
    const out = fn()
    db.exec(`COMMIT`)
    return out
  } catch (err) {
    try {
      db.exec(`ROLLBACK`)
    } catch {
      /* nothing was committed; the caller's error below is the honest one */
    }
    throw err
  }
}

/**
 * The gate on the WRITE side, and it asks exactly what the open asks.
 *
 * `patchSql` allow-lists the COLUMNS, which is what stops a renderer moving a drawing to another
 * map. It says nothing about the VALUES, and nothing else did either — so `updateFeature` accepted
 * `not json at all`, an empty string, a number, `{"type":"Evil","coordinates":"x"}`. The app could
 * put a row into its own working copy that its own `repairImportedJson` would reset on the next
 * open, and `packWorld` would hand that row to whoever the world was shared with.
 *
 * Deliberately the SAME predicates as the entry gate rather than stricter ones. Undo writes back
 * the string the file arrived with, so anything narrower here would make Ctrl+Z fail on a world
 * that opened cleanly — the guarantee is "never write what the open would reject", not "write only
 * what a fresh drawing would produce".
 *
 * `style` gets `isPlainObject` and no more, because that is the whole contract its consumers have:
 * every one of them does `JSON.parse(f.style || '{}')` and reads fields defensively.
 */
/**
 * The same question for the other three tables, and NO MORE than the open asks.
 *
 * `settings` is the one to be careful with: the open only checks values that LOOK like JSON,
 * because the same table legitimately holds `dark`, `tr`, a file path and `lastMapId` as a bare
 * number. Refusing every non-object here would break the app's own writes. What is refused is
 * exactly the form the open DELETES: something that opens with `{` or `[` and then does not parse.
 */
function assertEntityPatch(patch: Record<string, unknown>): void {
  if ('fields' in patch) {
    const f = patch.fields
    if (typeof f !== 'string' || !isPlainObject(f)) throw new Error('BAD_FIELDS: not a JSON object')
  }
}
function assertSettingValue(value: unknown): void {
  if (typeof value !== 'string') throw new Error('BAD_SETTING: not a string')
  if (!/^\s*[[{]/.test(value)) return // a primitive: the open does not check it, nor do we
  if (!isPlainObject(value) && !isArray(value))
    throw new Error('BAD_SETTING: looks like JSON and is not')
}
/**
 * Would this parent make a cycle, or a chain deeper than the open allows?
 *
 * Mirrors `repairJson`'s walk rather than checking `parent === id`: the open cuts a link when the
 * climb from a row reaches something already seen OR runs past MAX_TREE_DEPTH, and a two-map loop
 * (A under B under A) is neither self-parenthood nor rare. The UI has its own guard where a cycle
 * would be created; this is the same rule at the boundary that guard cannot see.
 */
function assertMapParent(id: number, parent: unknown): void {
  if (parent === null || parent === undefined) return
  if (typeof parent !== 'number') throw new Error('BAD_PARENT: not a map id')
  if (parent === id) throw new Error('BAD_PARENT: a map cannot be its own parent')
  const parentOf = new Map(
    (
      db.prepare(`SELECT id, parent_map_id FROM maps`).all() as {
        id: number
        parent_map_id: number | null
      }[]
    ).map((m) => [m.id, m.parent_map_id])
  )
  const seen = new Set<number>([id])
  let cur: number | null | undefined = parent
  while (cur !== null && cur !== undefined) {
    if (seen.has(cur)) throw new Error('BAD_PARENT: that would make a loop')
    seen.add(cur)
    if (seen.size > MAX_TREE_DEPTH) throw new Error('BAD_PARENT: nested too deep')
    cur = parentOf.get(cur) ?? null
  }
}
function assertFeaturePatch(patch: Record<string, unknown>): void {
  if ('geometry' in patch) {
    const g = patch.geometry
    if (typeof g !== 'string' || !isGeometry(g))
      throw new Error('BAD_GEOMETRY: not a geometry this app can draw')
  }
  if ('style' in patch) {
    const s = patch.style
    if (typeof s !== 'string' || !isPlainObject(s)) throw new Error('BAD_STYLE: not a JSON object')
  }
}

// Builds a dynamic SET clause from allow-listed columns only.
function patchSql(
  table: string,
  allowed: string[],
  patch: Record<string, unknown>
): { sql: string; vals: unknown[] } | null {
  const keys = Object.keys(patch).filter((k) => allowed.includes(k))
  if (!keys.length) return null
  return {
    sql: `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')}`,
    vals: keys.map((k) => patch[k] as never)
  }
}

/**
 * Copy an image from anywhere on disk into `assets/`, returning the world-relative path.
 *
 * DELIBERATELY NOT ON `api`. Every method there is spread onto the IPC surface in index.ts, and
 * this is the only one that takes a filesystem path from its caller — left there, a compromised
 * renderer could copy any image on the machine into assets/, from where the next save embeds it
 * in the `.world` and it travels to whoever the world is shared with. The legitimate route is
 * `pickImage`, where the USER chooses the file in a native dialog and main passes the path on.
 *
 * index.ts used to strip it back off the object with a destructure, which worked and had to be
 * remembered. A function that was never on the object cannot be spread onto the bridge by any
 * future edit to the spread — the same reason `patchSql` allow-lists columns rather than trusting
 * the caller to send the right ones.
 */
export function importAsset(srcPath: string): string {
  let name = assetName(basename(srcPath))
  if (!name) throw new Error('Images only')
  if (existsSync(join(assetsDir, name))) {
    // The stem is CLIPPED so the result still passes assetName. Appending thirteen digits to a
    // name already at the limit produced a name this app writes and then refuses on open: the
    // image was extracted nowhere and the banner came up blank, counted only as assets.refused.
    const ext = extname(name)
    const tag = `-${Date.now()}`
    const stem = basename(name, ext).slice(0, MAX_ASSET_NAME - tag.length - ext.length)
    name = `${stem}${tag}${ext}`
  }
  copyFileSync(srcPath, join(assetsDir, name))
  return `assets/${name}`
}

export const api = {
  // --- maddeler ---
  listEntities(search = ''): unknown[] {
    // folder = the sidebar file-tree membership (fields['folder']); timestamps drive its sort menu
    return db
      .prepare(
        `SELECT id, name, json_extract(fields, '$.folder') AS folder, created_at, updated_at
         FROM entities WHERE name LIKE ? ORDER BY name`
      )
      .all(`%${search}%`)
  },
  // Full-text search: entities whose content, note tabs or free-field values match, with a
  // short context snippet around the hit. Technical fields (banner file path, parent/ruler/house
  // JSON histories, color) are excluded — the snippet is always human-readable text.
  // Filtering happens in JS so Turkish case folds correctly (SQLite LIKE/lower folds ASCII
  // only). Scans all rows at personal scale; switch to FTS5 if it ever gets slow.
  searchContent(q: string): unknown[] {
    const needle = q.trim().toLocaleLowerCase('tr')
    if (needle.length < 2) return []
    const TECH = new Set(['banner', 'parent', 'ruler', 'house', 'notes', 'color', 'folder'])
    const rows = db
      .prepare(
        `SELECT id, name, content, fields, json_extract(fields, '$.folder') AS folder FROM entities`
      )
      .all() as {
      id: number
      folder: string | null
      name: string
      content: string
      fields: string
    }[]
    const hits: { id: number; folder: string | null; name: string; snippet: string }[] = []
    for (const r of rows) {
      if (r.name.toLocaleLowerCase('tr').includes(needle)) continue // name matches are already in the list
      // Searchable text: content, note tabs (title + body), free-field values
      const texts: string[] = [r.content]
      try {
        const f = JSON.parse(r.fields || '{}') as Record<string, string>
        for (const [k, v] of Object.entries(f))
          if (!TECH.has(k) && typeof v === 'string') texts.push(`${k}: ${v}`)
        const notes = JSON.parse(f['notes'] ?? '[]') as { title?: string; content?: string }[]
        if (Array.isArray(notes))
          for (const n of notes) texts.push([n.title, n.content].filter(Boolean).join(': '))
      } catch {
        /* malformed fields → search content only */
      }
      for (const src of texts) {
        const i = src.toLocaleLowerCase('tr').indexOf(needle)
        if (i < 0) continue
        const start = Math.max(0, i - 30)
        const snippet =
          (start > 0 ? '…' : '') +
          src.slice(start, i + needle.length + 40).replace(/\s+/g, ' ') +
          (i + needle.length + 40 < src.length ? '…' : '')
        hits.push({ id: r.id, folder: r.folder, name: r.name, snippet })
        break
      }
      if (hits.length >= 15) break
    }
    return hits
  },
  getEntity(id: number): unknown {
    const entity = db.prepare(`SELECT * FROM entities WHERE id = ?`).get(id)
    if (!entity) return null
    const outLinks = db
      .prepare(
        `SELECT l.id, l.relation, l.notes, l.to_id, e.name AS to_name FROM links l JOIN entities e ON e.id = l.to_id WHERE l.from_id = ?`
      )
      .all(id)
    const inLinks = db
      .prepare(
        `SELECT l.id, l.relation, l.notes, l.from_id, e.name AS from_name FROM links l JOIN entities e ON e.id = l.from_id WHERE l.to_id = ?`
      )
      .all(id)
    // Other entities whose content mentions [[This Entity]] (backlinks)
    const mentions = db
      .prepare(`SELECT id, name FROM entities WHERE id != ? AND content LIKE ?`)
      .all(id, `%[[${(entity as { name: string }).name}]]%`)
    return { ...entity, outLinks, inLinks, mentions }
  },
  findEntityByName(name: string): unknown {
    return (
      db.prepare(`SELECT id, name FROM entities WHERE name = ? COLLATE NOCASE`).get(name) ?? null
    )
  },
  // The legacy `type` column is kept (older .world files still carry it) but no longer used:
  // articles are organised by sidebar folders now.
  // The article events are logged HERE rather than at the buttons that cause them: every route in
  // — the sidebar, an entity page, a [[wiki link]], the dynasty form's find-or-create, undo and
  // redo — comes through these five functions, so this is the one place that cannot be forgotten
  // when a sixth route appears. Names, never content: the log is meant to be pasted into a message,
  // and a name is what makes "my article vanished" answerable at all.
  createEntity(e: { name: string; content?: string; fields?: string }): unknown {
    if (e.fields !== undefined) assertEntityPatch({ fields: e.fields })
    const r = db
      .prepare(`INSERT INTO entities (name, content, fields) VALUES (?, ?, ?)`)
      .run(e.name, e.content ?? '', e.fields ?? '{}')
    const id = Number(r.lastInsertRowid)
    logEvent('INFO', 'entity.created', { entity: id, name: e.name })
    return { id }
  },
  updateEntity(id: number, patch: Record<string, unknown>): void {
    // Only a RENAME is worth a line — an ordinary field save is the most frequent write in the app
    // and would drown everything. The extra read costs nothing because it is skipped for those.
    const was =
      'name' in patch
        ? (db.prepare(`SELECT name FROM entities WHERE id = ?`).get(id) as { name: string })?.name
        : undefined
    assertEntityPatch(patch)
    const p = patchSql('entities', ['name', 'content', 'fields'], patch)
    if (p)
      db.prepare(`${p.sql}, updated_at = datetime('now') WHERE id = ?`).run(
        ...(p.vals as never[]),
        id
      )
    if (was !== undefined && was !== patch.name)
      logEvent('INFO', 'entity.renamed', { entity: id, from: was, to: patch.name })
  },
  /** Several entities in ONE transaction. Conquest is the caller: it re-parents every picked
   *  realm, and stopping half way used to leave some conquered and some not under a single undo
   *  entry that claimed all of them. `fields` is validated the same way the open validates it. */
  updateEntities(list: { id: number; patch: Record<string, unknown> }[]): void {
    for (const u of list) assertEntityPatch(u.patch)
    tx(() => {
      for (const u of list) {
        const p = patchSql('entities', ['name', 'content', 'fields'], u.patch)
        if (p)
          db.prepare(`${p.sql}, updated_at = datetime('now') WHERE id = ?`).run(
            ...(p.vals as never[]),
            u.id
          )
      }
    })
  },
  deleteEntity(id: number): void {
    // Read before the delete or the name is gone with it — and the name is the whole point.
    const row = db.prepare(`SELECT name FROM entities WHERE id = ?`).get(id) as { name: string }
    db.prepare(`DELETE FROM entities WHERE id = ?`).run(id)
    logEvent('INFO', 'entity.deleted', { entity: id, name: row?.name })
  },
  /** Deleting a selection of articles is ONE action (the sidebar's multi-select). A loop left
   *  some deleted and some not when the FK cascade hit something unexpected part-way. */
  deleteEntities(ids: number[]): void {
    tx(() => {
      const read = db.prepare(`SELECT name FROM entities WHERE id = ?`)
      const del = db.prepare(`DELETE FROM entities WHERE id = ?`)
      for (const id of ids) {
        const row = read.get(id) as { name: string } | undefined
        del.run(id)
        logEvent('INFO', 'entity.deleted', { entity: id, name: row?.name })
      }
    })
  },
  // Bring a deleted entity back under the same id, with its links and map-feature bindings (for Ctrl+Z)
  restoreEntity(
    row: {
      id: number
      name: string
      content: string
      fields: string
      created_at: string
    },
    links: { from_id: number; to_id: number; relation: string; notes: string }[],
    featureIds: number[]
  ): void {
    // One transaction: the row, its links and its map bindings are one undo step, so a failure
    // between them must not leave an article back with half its connections.
    tx(() => {
      db.prepare(
        `INSERT INTO entities (id, name, content, fields, created_at) VALUES (?, ?, ?, ?, ?)`
      ).run(row.id, row.name, row.content, row.fields, row.created_at)
      for (const l of links)
        db.prepare(`INSERT INTO links (from_id, to_id, relation, notes) VALUES (?, ?, ?, ?)`).run(
          l.from_id,
          l.to_id,
          l.relation,
          l.notes
        )
      for (const fid of featureIds)
        db.prepare(`UPDATE features SET entity_id = ? WHERE id = ?`).run(row.id, fid)
    })
    // Without this an undone deletion leaves `entity.deleted` as the last word on the article, and
    // a log that says something was destroyed when it was not is worse than one that says nothing.
    logEvent('INFO', 'entity.restored', { entity: row.id, name: row.name })
  },
  // Bulk restore (multi-delete undo): ALL entity rows first, then the (deduplicated) links,
  // then feature bindings — so a link between two deleted entities cannot violate the FK.
  restoreEntities(
    rows: {
      id: number
      name: string
      content: string
      fields: string
      created_at: string
    }[],
    links: { from_id: number; to_id: number; relation: string; notes: string }[],
    features: { entity_id: number; feature_id: number }[]
  ): void {
    tx(() => {
      for (const row of rows)
        db.prepare(
          `INSERT INTO entities (id, name, content, fields, created_at) VALUES (?, ?, ?, ?, ?)`
        ).run(row.id, row.name, row.content, row.fields, row.created_at)
      for (const l of links)
        db.prepare(`INSERT INTO links (from_id, to_id, relation, notes) VALUES (?, ?, ?, ?)`).run(
          l.from_id,
          l.to_id,
          l.relation,
          l.notes
        )
      for (const f of features)
        db.prepare(`UPDATE features SET entity_id = ? WHERE id = ?`).run(f.entity_id, f.feature_id)
    })
    // A count, not one line per article: a multi-delete undo is ONE action by the user.
    logEvent('INFO', 'entity.restored', { count: rows.length })
  },
  featuresByEntity(entityId: number): unknown[] {
    return db
      .prepare(
        `SELECT f.id, f.map_id, f.style, m.name AS map_name
         FROM features f JOIN maps m ON m.id = f.map_id WHERE f.entity_id = ?`
      )
      .all(entityId)
  },
  entityFeatureIds(entityId: number): number[] {
    return (api.featuresByEntity(entityId) as { id: number }[]).map((r) => r.id)
  },
  // Which article is drawn on which map, and on which board inside it. The sidebar groups
  // articles by map from this. The relation is DERIVED from drawings rather than stored on
  // the entity: an article gains a map by being drawn there and loses it when the drawing
  // goes, with no field to keep in sync and nothing added to the schema — the same reasoning
  // that keeps the de-jure chain in fields rather than in columns.
  // Style carries the board id; it is small next to geom, which is why geom is not selected.
  entityPlacements(): { entity_id: number; map_id: number; board: string | null }[] {
    const rows = db
      .prepare(`SELECT entity_id, map_id, style FROM features WHERE entity_id IS NOT NULL`)
      .all() as { entity_id: number; map_id: number; style: string }[]
    return rows.map((r) => {
      let board: string | null = null
      // repairImportedJson resets malformed style at the entry gate; this is belt and braces
      try {
        board = (JSON.parse(r.style || '{}') as { board?: string }).board ?? null
      } catch {
        board = null
      }
      return { entity_id: r.entity_id, map_id: r.map_id, board }
    })
  },
  // Hierarchy tags: the "hierarchy" key in the fields JSON, a comma-separated "#tag" list.
  // gov: "government" in fields (government form — parallel rank ladders).
  // fields is also returned as raw JSON: map modes (religion/language dimensions) and datalist
  // suggestions are derived from it in the renderer. Returns every entity — fine at personal scale.
  hierarchy(): unknown {
    const rows = db
      .prepare(
        `SELECT id, name, fields,
           json_extract(fields, '$.hierarchy') AS h,
           json_extract(fields, '$.government') AS gov
         FROM entities`
      )
      .all() as {
      id: number
      name: string
      fields: string
      h: string | null
      gov: string | null
    }[]
    const entities = rows.map((r) => ({
      id: r.id,
      name: r.name,
      fields: r.fields,
      gov: r.gov,
      tags: (r.h ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
    }))
    const tags = [...new Set(entities.flatMap((e) => e.tags))].sort((a, b) =>
      a.localeCompare(b, 'tr')
    )
    const govs = [...new Set(entities.map((e) => e.gov).filter(Boolean))].sort() as string[]
    return { tags, govs, entities }
  },

  // --- links ---
  addLink(from_id: number, to_id: number, relation: string): unknown {
    const r = db
      .prepare(`INSERT INTO links (from_id, to_id, relation) VALUES (?, ?, ?)`)
      .run(from_id, to_id, relation)
    // The relation by name: the links table is where the whole family tree and half the world's
    // structure lives, and `mother` going in where `spouse` was meant is invisible in the data.
    logEvent('INFO', 'link.created', { from: from_id, to: to_id, relation })
    return { id: Number(r.lastInsertRowid) }
  },
  /**
   * Add a family tie, creating the person on the spot when they are new — as ONE action.
   *
   * Typing a name into the dynasty section is how people get made in this app, so "add a mother
   * called X" is two writes into two tables whenever X is new: the entity, then the link. The
   * renderer did them in sequence, so a link that failed left a person in the Person folder
   * attached to nobody — visible in the sidebar, invisible as a relation, and nothing to undo
   * because the undo record came after both.
   *
   * EITHER endpoint may be a creation, because the direction is not fixed: a mother is
   * `self → person`, a child is `person → self`. Nothing here decides which; the caller says.
   *
   * Returns `created` so the caller can build ONE undo entry that removes the link and the person
   * together — and only the person it actually made, never one that already existed.
   */
  addRelation(
    from: number | { name: string; fields?: string },
    to: number | { name: string; fields?: string },
    relation: string
  ): { linkId: number; from_id: number; to_id: number; created?: number } {
    for (const side of [from, to])
      if (typeof side !== 'number' && side.fields !== undefined && !isPlainObject(side.fields))
        throw new Error('BAD_FIELDS: not a JSON object')
    return tx(() => {
      let created: number | undefined
      const resolve = (side: number | { name: string; fields?: string }): number => {
        if (typeof side === 'number') return side
        const id = Number(
          db
            .prepare(`INSERT INTO entities (name, content, fields) VALUES (?, '', ?)`)
            .run(side.name, side.fields ?? '{}').lastInsertRowid
        )
        logEvent('INFO', 'entity.created', { entity: id, name: side.name })
        created = id
        return id
      }
      const from_id = resolve(from)
      const to_id = resolve(to)
      const linkId = Number(
        db
          .prepare(`INSERT INTO links (from_id, to_id, relation) VALUES (?, ?, ?)`)
          .run(from_id, to_id, relation).lastInsertRowid
      )
      logEvent('INFO', 'link.created', { from: from_id, to: to_id, relation })
      return { linkId, from_id, to_id, created }
    })
  },
  /** The undo of addRelation: drop the link, and the person only if this action invented them. */
  deleteRelation(linkId: number, createdEntityId?: number): void {
    tx(() => {
      const row = db
        .prepare(`SELECT from_id, to_id, relation FROM links WHERE id = ?`)
        .get(linkId) as { from_id: number; to_id: number; relation: string } | undefined
      db.prepare(`DELETE FROM links WHERE id = ?`).run(linkId)
      if (row)
        logEvent('INFO', 'link.deleted', {
          from: row.from_id,
          to: row.to_id,
          relation: row.relation
        })
      if (createdEntityId !== undefined) {
        const ent = db.prepare(`SELECT name FROM entities WHERE id = ?`).get(createdEntityId) as
          { name: string } | undefined
        db.prepare(`DELETE FROM entities WHERE id = ?`).run(createdEntityId)
        logEvent('INFO', 'entity.deleted', { entity: createdEntityId, name: ent?.name })
      }
    })
  },
  deleteLink(id: number): void {
    const row = db.prepare(`SELECT from_id, to_id, relation FROM links WHERE id = ?`).get(id) as {
      from_id: number
      to_id: number
      relation: string
    }
    db.prepare(`DELETE FROM links WHERE id = ?`).run(id)
    logEvent('INFO', 'link.deleted', {
      from: row?.from_id,
      to: row?.to_id,
      relation: row?.relation
    })
  },
  // For whole-graph views like the dynasty tree: every link (fine at personal scale)
  listLinks(): unknown[] {
    return db.prepare(`SELECT id, from_id, to_id, relation FROM links`).all()
  },

  // --- maps ---
  listMaps(): unknown[] {
    // Order = INSERTION order (id), not alphabetical: the user wants maps in the order they
    // built them (the toolbar menu and the "first map" pick both read this list).
    return db.prepare(`SELECT id, name, parent_map_id FROM maps ORDER BY id`).all()
  },
  getMap(id: number): unknown {
    const map = db.prepare(`SELECT * FROM maps WHERE id = ?`).get(id)
    if (!map) return null
    const features = db
      .prepare(
        `SELECT f.*, e.name AS entity_name, json_extract(e.fields, '$.folder') AS entity_folder
         FROM features f LEFT JOIN entities e ON e.id = f.entity_id WHERE f.map_id = ?`
      )
      .all(id)
    return { ...map, features }
  },
  createMap(m: {
    name: string
    image_path?: string
    width?: number
    height?: number
    parent_map_id?: number
  }): unknown {
    // The layers JSON is plumbing for heightmaps etc. — currently written, never read
    const layers = m.image_path ? JSON.stringify([{ type: 'image', path: m.image_path }]) : '[]'
    const r = db
      .prepare(
        `INSERT INTO maps (name, image_path, width, height, parent_map_id, layers) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        m.name,
        m.image_path ?? null,
        m.width ?? null,
        m.height ?? null,
        m.parent_map_id ?? null,
        layers
      )
    return { id: Number(r.lastInsertRowid) }
  },
  updateMap(id: number, patch: Record<string, unknown>): void {
    if ('layers' in patch) {
      const l = patch.layers
      if (typeof l !== 'string' || !isArray(l)) throw new Error('BAD_LAYERS: not a JSON array')
    }
    if ('parent_map_id' in patch) assertMapParent(id, patch.parent_map_id)
    const p = patchSql(
      'maps',
      ['name', 'parent_map_id', 'image_path', 'width', 'height', 'layers'],
      patch
    )
    if (p) db.prepare(`${p.sql} WHERE id = ?`).run(...(p.vals as never[]), id)
  },
  deleteMap(id: number): void {
    db.prepare(`DELETE FROM maps WHERE id = ?`).run(id)
  },
  // Map-delete undo: the row + features come back with their ORIGINAL ids (timeline events and
  // entity map history are keyed by fid — ids must survive), child maps get their parent link back.
  restoreMap(
    map: {
      id: number
      name: string
      parent_map_id: number | null
      image_path: string | null
      width: number | null
      height: number | null
      layers: string
    },
    features: {
      id: number
      map_id: number
      entity_id: number | null
      geometry: string
      style: string
    }[],
    childIds: number[]
  ): void {
    tx(() => {
      db.prepare(
        `INSERT INTO maps (id, name, parent_map_id, image_path, width, height, layers) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(map.id, map.name, map.parent_map_id, map.image_path, map.width, map.height, map.layers)
      for (const f of features)
        db.prepare(
          `INSERT INTO features (id, map_id, entity_id, geometry, style) VALUES (?, ?, ?, ?, ?)`
        ).run(f.id, f.map_id, f.entity_id, f.geometry, f.style)
      for (const cid of childIds)
        db.prepare(`UPDATE maps SET parent_map_id = ? WHERE id = ?`).run(map.id, cid)
    })
  },

  // --- map features ---
  createFeature(f: {
    map_id: number
    entity_id?: number
    geometry: string
    style?: string
  }): unknown {
    assertFeaturePatch({ geometry: f.geometry, ...(f.style !== undefined && { style: f.style }) })
    const r = db
      .prepare(`INSERT INTO features (map_id, entity_id, geometry, style) VALUES (?, ?, ?, ?)`)
      .run(f.map_id, f.entity_id ?? null, f.geometry, f.style ?? '{}')
    return { id: Number(r.lastInsertRowid) }
  },
  updateFeature(id: number, patch: Record<string, unknown>): void {
    assertFeaturePatch(patch) // the values, where patchSql covers only the columns — see there
    const p = patchSql('features', ['entity_id', 'geometry', 'style'], patch)
    if (p) db.prepare(`${p.sql} WHERE id = ?`).run(...(p.vals as never[]), id)
  },
  /**
   * Several features in ONE transaction — a weld, a paste, anything where one user action moves
   * more than one drawing.
   *
   * It replaced a loop of `updateFeature` calls in the renderer, which was not atomic and not
   * even close: a constraint error on the third of five left the first two applied, and the undo
   * entry that had already been pushed claimed all five had moved. So Ctrl+Z rewrote rows that
   * never changed.
   *
   * EVERY patch is validated BEFORE the transaction opens. A rejected batch then costs nothing —
   * no BEGIN, no rollback, no half-second of held write lock — and the caller gets the same error
   * it would have got from a single write.
   */
  updateFeatures(list: { id: number; patch: Record<string, unknown> }[]): void {
    for (const u of list) assertFeaturePatch(u.patch)
    tx(() => {
      for (const u of list) {
        const p = patchSql('features', ['entity_id', 'geometry', 'style'], u.patch)
        if (p) db.prepare(`${p.sql} WHERE id = ?`).run(...(p.vals as never[]), u.id)
      }
    })
  },
  deleteFeature(id: number): void {
    db.prepare(`DELETE FROM features WHERE id = ?`).run(id)
  },
  /** A multi-select delete is ONE action; it must not be able to half-happen. The undo record is
   *  pushed by the caller after this returns, so a failure here leaves nothing to undo — which is
   *  the honest state, and the one the loop it replaced could not produce. */
  deleteFeatures(ids: number[]): void {
    tx(() => {
      const st = db.prepare(`DELETE FROM features WHERE id = ?`)
      for (const id of ids) st.run(id)
    })
  },
  /** The create counterpart, for a paste or a duplicate: several drawings appear at once and that
   *  is one action. Ids come back in the order they were given, which is what the undo record
   *  needs to delete exactly what it made. */
  createFeatures(
    list: { map_id: number; entity_id?: number; geometry: string; style?: string }[]
  ): number[] {
    for (const f of list)
      assertFeaturePatch({ geometry: f.geometry, ...(f.style !== undefined && { style: f.style }) })
    return tx(() => {
      const st = db.prepare(
        `INSERT INTO features (map_id, entity_id, geometry, style) VALUES (?, ?, ?, ?)`
      )
      return list.map((f) =>
        Number(st.run(f.map_id, f.entity_id ?? null, f.geometry, f.style ?? '{}').lastInsertRowid)
      )
    })
  },

  // --- whole user actions that span more than one table ---------------------------------------
  //
  // These exist because the writes cannot be expressed as a batch: the entity's id is an INPUT to
  // the feature, so the second statement depends on the result of the first. A generic
  // "run these in a transaction" call over IPC would be a small RPC engine and would let a
  // compromised renderer compose sequences nobody designed; one method per user action keeps the
  // surface bounded, makes each transaction obviously the right size, and costs one round trip
  // instead of two or three.

  /**
   * A drawing IS an article: every polygon, pin and path is born with its own entity, so drawing
   * one is two inserts into two tables. Failing between them left an entity nobody could reach —
   * it had no drawing, so it appeared in the sidebar as an empty row the user never made.
   *
   * `entityName` absent = the drawing joins an entity that already exists (or none at all, which
   * is what a free label does).
   */
  createDrawing(d: {
    map_id: number
    geometry: string
    style?: string
    entityName?: string
    entity_id?: number
  }): { featureId: number; entityId?: number } {
    assertFeaturePatch({ geometry: d.geometry, ...(d.style !== undefined && { style: d.style }) })
    return tx(() => {
      let entityId = d.entity_id
      if (d.entityName !== undefined) {
        entityId = Number(
          db
            .prepare(`INSERT INTO entities (name, content, fields) VALUES (?, '', '{}')`)
            .run(d.entityName).lastInsertRowid
        )
        logEvent('INFO', 'entity.created', { entity: entityId, name: d.entityName })
      }
      const featureId = Number(
        db
          .prepare(`INSERT INTO features (map_id, entity_id, geometry, style) VALUES (?, ?, ?, ?)`)
          .run(d.map_id, entityId ?? null, d.geometry, d.style ?? '{}').lastInsertRowid
      )
      return { featureId, entityId }
    })
  },
  /** The undo of createDrawing. The entity is passed only when THIS draw created it — a drawing
   *  that joined an existing article must not take that article with it. */
  deleteDrawing(featureId: number, entityId?: number): void {
    tx(() => {
      db.prepare(`DELETE FROM features WHERE id = ?`).run(featureId)
      if (entityId !== undefined) {
        const row = db.prepare(`SELECT name FROM entities WHERE id = ?`).get(entityId) as {
          name: string
        }
        db.prepare(`DELETE FROM entities WHERE id = ?`).run(entityId)
        logEvent('INFO', 'entity.deleted', { entity: entityId, name: row?.name })
      }
    })
  },
  /**
   * Border evolution: copy the drawing forward from this year and close the original at year-1.
   * Two writes that only mean something together — a copy with no closed original is two borders
   * claiming the same land in the same year, which is the state the feature exists to avoid.
   *
   * The source row is read HERE rather than shipped in and back out: it is the geometry, and a
   * ring is thousands of numbers.
   */
  createFeatureFork(id: number, newStyle: string, closedStyle: string): { id: number } {
    assertFeaturePatch({ style: newStyle })
    assertFeaturePatch({ style: closedStyle })
    return tx(() => {
      const src = db
        .prepare(`SELECT map_id, entity_id, geometry FROM features WHERE id = ?`)
        .get(id) as { map_id: number; entity_id: number | null; geometry: string } | undefined
      if (!src) throw new Error('NO_SUCH_FEATURE')
      const copy = Number(
        db
          .prepare(`INSERT INTO features (map_id, entity_id, geometry, style) VALUES (?, ?, ?, ?)`)
          .run(src.map_id, src.entity_id, src.geometry, newStyle).lastInsertRowid
      )
      db.prepare(`UPDATE features SET style = ? WHERE id = ?`).run(closedStyle, id)
      return { id: copy }
    })
  },
  /** The undo of a fork: drop the copy and reopen the original's year range. Two writes that
   *  only mean something together, exactly like the fork itself. */
  deleteFeatureFork(copyId: number, sourceId: number, sourceStyle: string): void {
    assertFeaturePatch({ style: sourceStyle })
    tx(() => {
      db.prepare(`DELETE FROM features WHERE id = ?`).run(copyId)
      db.prepare(`UPDATE features SET style = ? WHERE id = ?`).run(sourceStyle, sourceId)
    })
  },
  /**
   * Bind a drawing to a different article, and clean up the one it left if the app had invented
   * it. Two things the renderer used to do in sequence — and it pushed TWO undo entries, so one
   * Ctrl+Z put the drawing back and left the article deleted.
   *
   * The orphan test moves here with the write for the same reason: it is three reads and a
   * decision, and doing it on this side makes the whole action one round trip and one transaction.
   * "Invented by the app" means exactly what it meant in the renderer — no drawings left anywhere,
   * no body, no links, no fields.
   *
   * Returns the row it deleted (or null), which is what lets the caller build ONE undo entry that
   * puts both halves back.
   */
  updateFeatureLink(
    featureId: number,
    entityId: number | null,
    style: string,
    prevEntityId: number | null
  ): {
    dropped: {
      id: number
      name: string
      content: string
      fields: string
      created_at: string
    } | null
  } {
    assertFeaturePatch({ style })
    return tx(() => {
      db.prepare(`UPDATE features SET entity_id = ?, style = ? WHERE id = ?`).run(
        entityId,
        style,
        featureId
      )
      if (prevEntityId === null || prevEntityId === entityId) return { dropped: null }
      const ent = db.prepare(`SELECT * FROM entities WHERE id = ?`).get(prevEntityId) as
        | { id: number; name: string; content: string; fields: string; created_at: string }
        | undefined
      if (!ent) return { dropped: null }
      const stillDrawn = db
        .prepare(`SELECT 1 FROM features WHERE entity_id = ? LIMIT 1`)
        .get(prevEntityId)
      const linked = db
        .prepare(`SELECT 1 FROM links WHERE from_id = ? OR to_id = ? LIMIT 1`)
        .get(prevEntityId, prevEntityId)
      let written = ent.content.trim() !== '' || !!stillDrawn || !!linked
      if (!written) {
        try {
          written = Object.values(JSON.parse(ent.fields || '{}') as Record<string, unknown>).some(
            (v) => String(v ?? '').trim() !== ''
          )
        } catch {
          written = true // unreadable fields are not ours to throw away
        }
      }
      if (written) return { dropped: null }
      db.prepare(`DELETE FROM entities WHERE id = ?`).run(prevEntityId)
      logEvent('INFO', 'entity.deleted', { entity: prevEntityId, name: ent.name })
      return { dropped: ent }
    })
  },

  // --- settings ---
  getSetting(key: string): string | null {
    const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
      { value: string } | undefined
    return row?.value ?? null
  },
  setSetting(key: string, value: string): void {
    assertSettingValue(value)
    db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(key, value)
  },

  // Manual "back up now" — a timestamped copy independent of the daily automatic one
  backupNow(): string {
    mkdirSync(backupsDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const target = join(backupsDir, `world-${stamp}.db`)
    copyFileSync(dbFile, target)
    return target
  },

  // Dump every entity's note tabs (fields['notes']) into a readable .txt tree:
  //   notes/<map name>/<sidebar folder path…>/<entity name>/<note title>.txt
  // An entity appears under every map it is drawn on; ones on no map go under "(no map)", ones
  // in no folder under "(no folder)". The middle level MIRRORS the sidebar folder tree (nested).
  // One-way export (app → .txt); the tree is rebuilt from scratch every time, so renames and
  // deletions come out clean.
  exportNotes(): { path: string; files: number; skipped: number } {
    const ents = db.prepare(`SELECT id, name, fields FROM entities`).all() as {
      id: number
      name: string
      fields: string
    }[]
    const maps = db.prepare(`SELECT id, name FROM maps`).all() as { id: number; name: string }[]
    const feats = db
      .prepare(`SELECT map_id, entity_id, style FROM features WHERE entity_id IS NOT NULL`)
      .all() as { map_id: number; entity_id: number; style: string }[]

    const mapName = new Map(maps.map((m) => [m.id, m.name]))
    // entity id → map id → the board ids it is drawn on within that map (null = untagged).
    // Mirrors the sidebar's two grouping tiers, so the .txt tree reads like the panel.
    const entMaps = new Map<number, Map<number, Set<string | null>>>()
    for (const f of feats) {
      let byMap = entMaps.get(f.entity_id)
      if (!byMap) entMaps.set(f.entity_id, (byMap = new Map()))
      let boards = byMap.get(f.map_id)
      if (!boards) byMap.set(f.map_id, (boards = new Set()))
      try {
        boards.add((JSON.parse(f.style || '{}') as { board?: string }).board ?? null)
      } catch {
        boards.add(null)
      }
    }
    // Board definitions per map (settings 'mapBoards'), for the level between map and folders.
    const boardsOf = new Map<number, { id: string; name: string }[]>()
    try {
      const parsed = JSON.parse(api.getSetting('mapBoards') || '{}') as Record<
        string,
        { list?: { id: string; name: string }[] }
      >
      for (const [mid, v] of Object.entries(parsed))
        if (Array.isArray(v?.list) && v.list.length) boardsOf.set(Number(mid), v.list)
    } catch {
      /* malformed setting → no board level, the tree just skips it */
    }
    const parseNotes = (fields: string): { title: string; content: string }[] => {
      try {
        const notlar = (JSON.parse(fields || '{}') as Record<string, string>)['notes']
        const arr = JSON.parse(notlar ?? '[]')
        return Array.isArray(arr) ? arr : []
      } catch {
        return []
      }
    }
    // Windows-safe file name: forbidden characters → _, trailing dots/spaces dropped, fallback
    // when empty (control characters are also stripped along with Windows' forbidden symbols)
    const safe = (name: string, fallback: string): string => {
      const s = name
        // eslint-disable-next-line no-control-regex -- control characters are invalid in file names too
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
        .replace(/[. ]+$/, '')
        .trim()
      // Windows device names (CON, NUL, COM1…) cannot be files/folders — writing would error
      const out = (s || fallback).slice(0, 120)
      return /^(CON|PRN|AUX|NUL|COM\d|LPT\d)$/i.test(out) ? `_${out}` : out
    }

    // The sidebar folder tree (settings 'entityFolders') becomes the middle directory levels.
    let folders: { id: string; name: string; parent: string | null }[] = []
    try {
      const parsed = JSON.parse(api.getSetting('entityFolders') || '[]')
      if (Array.isArray(parsed)) folders = parsed
    } catch {
      /* malformed setting → everything lands under (no folder) */
    }
    const folderById = new Map(folders.map((f) => [f.id, f]))
    // A folder id → its nested path segments, root first. Cycle/missing-parent guarded.
    const folderPath = (id: string | null): string[] => {
      const out: string[] = []
      const seen = new Set<string>()
      let cur = id
      while (cur && !seen.has(cur) && seen.size <= MAX_TREE_DEPTH) {
        seen.add(cur)
        const f = folderById.get(cur)
        if (!f) break
        out.unshift(safe(f.name, 'folder'))
        cur = f.parent
      }
      return out.length ? out : ['(no folder)']
    }
    const folderOf = (fieldsJson: string): string | null => {
      try {
        return (JSON.parse(fieldsJson || '{}') as Record<string, string>)['folder'] ?? null
      } catch {
        return null
      }
    }

    rmSync(notesDir, { recursive: true, force: true }) // wipe the old tree → regenerate
    mkdirSync(notesDir, { recursive: true })

    let files = 0
    let skipped = 0
    for (const ent of ents) {
      const notes = parseNotes(ent.fields)
      if (!notes.length) continue
      // The levels above the folder tree: <map>, plus <board> when that map has boards at all.
      // A map without boards gets no board level, exactly as the sidebar shows no board tier
      // for it; an orphan or missing board id falls to the first board (MapView's resolveBoard).
      const byMap = entMaps.get(ent.id)
      const placeDirs: string[][] = []
      for (const [mid, boardIds] of byMap ?? []) {
        const mSeg = safe(mapName.get(mid) ?? '', `map-${mid}`)
        const list = boardsOf.get(mid)
        if (!list) {
          placeDirs.push([mSeg])
          continue
        }
        const done = new Set<string>()
        for (const b of boardIds) {
          const def = list.find((x) => x.id === b) ?? list[0]
          if (done.has(def.id)) continue
          done.add(def.id)
          placeDirs.push([mSeg, safe(def.name, 'board')])
        }
      }
      if (!placeDirs.length) placeDirs.push(['(no map)'])
      const fPath = folderPath(folderOf(ent.fields))
      for (const place of placeDirs) {
        // ONE ENTRY MUST NOT ABORT THE EXPORT. Every segment is clamped to 120 characters, but
        // the PATH is the sum of them: map + board + a folder chain + the entry + the note. Deep
        // enough or named long enough and Windows refuses the whole path, mkdirSync throws — and
        // the tree was emptied before this loop started, so a throw here would leave the user
        // with neither the new export nor the old one. Skipping the entry that cannot be written
        // costs that entry; letting it out costs all of them.
        try {
          // On a name clash in the same folder, disambiguate with the entity id
          let entDir = join(notesDir, ...place, ...fPath, safe(ent.name, `entity-${ent.id}`))
          if (existsSync(entDir)) entDir += ` (#${ent.id})`
          mkdirSync(entDir, { recursive: true })
          const used = new Set<string>()
          notes.forEach((n, i) => {
            const baseName = safe(n.title, `note-${i + 1}`)
            let fname = baseName
            for (let k = 2; used.has(fname.toLowerCase()); k++) fname = `${baseName} (${k})`
            used.add(fname.toLowerCase())
            // \r\n for Windows Notepad compatibility
            writeFileSync(
              join(entDir, `${fname}.txt`),
              (n.content ?? '').replace(/\r?\n/g, '\r\n'),
              'utf8'
            )
            files++
          })
        } catch (err) {
          skipped++
          logEvent('WARN', 'notes.export.skipped', {
            entity: ent.id,
            reason: (err as Error)?.message?.slice(0, 80) ?? 'unknown'
          })
        }
      }
    }
    return { path: notesDir, files, skipped }
  }
}

// The self-check's window into this module, and nothing else's.
//
// It lives in tests/db.test.ts now. That file needs nine things which are deliberately not part of
// the API — the schema text, the table allow-list, four limits, the two staging-folder suffixes,
// the asset prune, and the connection itself — and the alternative to this object was exporting
// all nine, which would put a raw `db` beside `api` for any caller to reach. The write gates
// (assertEntityPatch, assertFeaturePatch, assertSettingValue) are the whole reason `api` is the
// only door; a second, unguarded one is not worth a tidier test.
//
// `db` is a getter because it is a `let`, reassigned by initDb, unpackWorld and resetWorld. A
// plain property would capture whichever connection happened to be open when this object was
// built, i.e. the one from the first initDb, and every assertion after an unpack or a reset would
// be questioning a closed handle. tests/db.test.ts says the same thing at its own top, because
// that is where someone would write `const { db } = __test` and break it.
export const __test = {
  get db(): DatabaseSync {
    return db
  },
  SCHEMA,
  OUR_TABLES,
  MAX_TREE_DEPTH,
  BACKUP_KEEP_DAYS,
  BACKUP_KEEP_FILES,
  STAGING_SUFFIX,
  REPLACED_SUFFIX,
  pruneUnusedAssets
}
