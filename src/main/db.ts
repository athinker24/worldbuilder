import { DatabaseSync } from 'node:sqlite'
import { join, basename, extname } from 'path'
import {
  mkdirSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import assert from 'assert'
import { flushLog, initLog, logError, logEvent, logSetDebug, logTime, noteCall } from './log.ts'
import { BATCH_MS, COALESCE_MS } from './log/thresholds.ts'

// Kept free of Electron imports so `node src/main/db.ts` can run the self-check standalone.
let db!: DatabaseSync
let assetsDir: string
let dbFile: string
let backupsDir: string
let notesDir: string
const BACKUP_KEEP_DAYS = 30
/** …and no more than this many, however recent. See backupIfNeeded for why both are needed. */
const BACKUP_KEEP_FILES = 60

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

export function initDb(dataDir: string): void {
  assetsDir = join(dataDir, 'assets')
  mkdirSync(assetsDir, { recursive: true })
  dbFile = join(dataDir, 'world.db')
  backupsDir = join(dataDir, 'backups')
  notesDir = join(dataDir, 'notes')
  db = new DatabaseSync(dbFile)
  db.exec(SCHEMA)
  migrateLegacyKeys()
}

// The codebase was Turkish; its data keys were too. Now that the code asks for English keys, a
// world written by an older build would silently lose its parent chains, banners, notes and
// dynasty links — the data would still be there, the code would just be looking elsewhere. This
// renames the keys in place. It runs on every launch and on every .dunya opened, and is
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

// --- The .dunya file format (like Wonderdraft's own file): EVERYTHING in one file ---
// Format = a SQLite copy with the same schema + an extra `assets` table (images embedded as BLOBs).
// The working copy (world.db + assets/) is untouched by this — Save packs, Open unpacks.
// settings.worldFile carries the file's own path (the Ctrl+S target; updated with the real path on open).

/** Pack the working copy (db + the images in assets/) into a single .dunya file. */
export function packWorld(targetPath: string): void {
  pruneUnusedAssets() // drop unused images before saving → lean .dunya and working copy
  const tmp = targetPath + '.tmp'
  rmSync(tmp, { force: true })
  db.exec(`VACUUM INTO '${tmp.replaceAll("'", "''")}'`) // clean, atomic snapshot
  const out = new DatabaseSync(tmp)
  out.exec(`CREATE TABLE IF NOT EXISTS assets (name TEXT PRIMARY KEY, data BLOB NOT NULL)`)
  const ins = out.prepare(`INSERT OR REPLACE INTO assets (name, data) VALUES (?, ?)`)
  for (const name of readdirSync(assetsDir)) {
    const p = join(assetsDir, name)
    if (statSync(p).isFile()) ins.run(name, readFileSync(p))
  }
  out
    .prepare(
      `INSERT INTO settings (key, value) VALUES ('worldFile', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(targetPath)
  out.close()
  renameSync(tmp, targetPath) // write to tmp then rename — a half-written file can never remain
}

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
  try {
    probe = new DatabaseSync(sourcePath, { readOnly: true })
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
  } catch {
    throw new Error(NOT_A_WORLD)
  } finally {
    probe?.close()
  }
}

/** Our five tables. Anything else a .dunya carries is not part of the format. */
const OUR_TABLES = new Set(['entities', 'links', 'maps', 'features', 'settings'])

/** Drop everything a .dunya carries that is not our schema.
 *
 *  A database file holds more than rows. A TRIGGER on entities rides along with the data and
 *  then fires against the USER's own edits from that point on — "after every insert, delete
 *  something else" is sabotage of the world they are building, and it survives every save
 *  because packWorld copies the whole database. Triggers cannot execute code, they are SQL
 *  only, so this is integrity rather than escape; but the file model treats a shared .dunya as
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

/** Open a .dunya file OVER the working copy (the current working copy is overwritten —
 *  the caller must confirm/back up first). Embedded images are extracted into assets/. */
export function unpackWorld(sourcePath: string): void {
  probeWorldFile(sourcePath) // throws before anything is touched
  // Even past the probe, the copy + open is the one destructive step in the app. Keep the old
  // working copy one file away and put it back if any part of it fails, so a failed open always
  // ends with a live db and the world the user already had — never a half-replaced one.
  const rescue = dbFile + '.rescue'
  db.close()
  copyFileSync(dbFile, rescue)
  try {
    copyFileSync(sourcePath, dbFile)
    db = new DatabaseSync(dbFile)
    dropForeignSchema() // BEFORE the schema exec, so a dropped view leaves room for the real table
    db.exec(SCHEMA)
  } catch (err) {
    copyFileSync(rescue, dbFile)
    db = new DatabaseSync(dbFile)
    db.exec(SCHEMA)
    rmSync(rescue, { force: true })
    throw err
  }
  rmSync(rescue, { force: true })
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
    for (const row of db.prepare(`SELECT name, data FROM assets`).all() as {
      name: string
      data: Uint8Array
    }[]) {
      // A .dunya is a SHARED file: the embedded name is untrusted input. Without basename,
      // a name like `../../…` or `C:\…` would write OUTSIDE assets/ (overwriting files).
      // packWorld only ever writes basenames, so nothing is lost.
      const name = basename(row.name)
      if (name && name !== '.' && name !== '..') writeFileSync(join(assetsDir, name), row.data)
    }
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
  migrateLegacyKeys() // so old .dunya files (with Turkish keys) still open
  api.setSetting('worldFile', sourcePath)
  pruneUnusedAssets() // drop images the opened world does not use (leftovers from the previous one)
}

/** Reset malformed JSON columns in an imported .dunya to defaults; returns rows repaired.
 *  Deliberately in ONE place: the renderer JSON.parses these columns in 20+ spots and a
 *  single bad row would take down that whole view (the map never opens, the entity page
 *  stays blank). Rather than wrapping every call site in try/catch, the data is repaired at
 *  the gate where it enters the app. Rows are NEVER deleted — only the bad column is reset. */
function repairImportedJson(): number {
  let fixed = 0
  // Nesting depth, counted by scanning rather than parsing.
  //
  // Whether a deeply nested value parses at all depends on how much STACK is left, so the gate
  // and the consumer can disagree: `{"a":{"a":…}}` 10000 deep parses fine here in main and then
  // throws RangeError in the renderer, underneath React's own call stack. Measured with a 208 KB
  // file — it opened cleanly and left the map and the entity page unable to render. Parsing to
  // find out is therefore the wrong test; the depth has to be bounded before anyone parses.
  //
  // 64 is far above anything this app writes: notes are an array of flat objects (3), the parent
  // history is an array of pairs (2), a GeoJSON polygon is 4. Quote-aware, because a brace inside
  // a string is not nesting; backslash skips the next character so an escaped quote does not end
  // the string early.
  const MAX_JSON_DEPTH = 64
  const depthOk = (v: string): boolean => {
    let depth = 0
    let inStr = false
    for (let i = 0; i < v.length; i++) {
      const c = v[i]
      if (inStr) {
        if (c === '\\') i++
        else if (c === '"') inStr = false
      } else if (c === '"') inStr = true
      else if (c === '{' || c === '[') {
        if (++depth > MAX_JSON_DEPTH) return false
      } else if (c === '}' || c === ']') depth--
    }
    return true
  }
  const isPlainObject = (v: string): boolean => {
    if (!depthOk(v)) return false
    try {
      const p: unknown = JSON.parse(v)
      return typeof p === 'object' && p !== null && !Array.isArray(p)
    } catch {
      return false
    }
  }
  const isArray = (v: string): boolean => {
    if (!depthOk(v)) return false
    try {
      return Array.isArray(JSON.parse(v))
    } catch {
      return false
    }
  }
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
  // fixable, whereas a deleted drawing is silently gone.
  repair(
    'geometry',
    db.prepare(`SELECT id, geometry AS v FROM features`).all() as { id: number; v: string }[],
    isPlainObject,
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
  // WARN, not INFO: nothing else in the app throws a user's data away, and the only trace it used
  // to leave was the data being gone. A clean file stays silent.
  if (fixed) logEvent('WARN', 'data.repaired', { rows: fixed, ...byKind })
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

/** Does the working copy hold anything worth keeping? (avoids a pointless snapshot on blank launch) */
export function hasContent(): boolean {
  return (
    !!db.prepare(`SELECT 1 FROM entities LIMIT 1`).get() ||
    !!db.prepare(`SELECT 1 FROM maps LIMIT 1`).get()
  )
}

/** Reset the working copy: empty schema + empty assets/ (Photoshop's blank-document launch).
 *  The caller must snapshot with packWorld first — no backup is taken here. */
export function resetWorld(): void {
  db.close()
  rmSync(dbFile, { force: true })
  db = new DatabaseSync(dbFile)
  db.exec(SCHEMA)
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
  // only). ponytail: scans all rows at personal scale; switch to FTS5 if it ever gets slow.
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
  // The legacy `type` column is kept (older .dunya files still carry it) but no longer used:
  // articles are organised by sidebar folders now.
  // The article events are logged HERE rather than at the buttons that cause them: every route in
  // — the sidebar, an entity page, a [[wiki link]], the dynasty form's find-or-create, undo and
  // redo — comes through these five functions, so this is the one place that cannot be forgotten
  // when a sixth route appears. Names, never content: the log is meant to be pasted into a message,
  // and a name is what makes "my article vanished" answerable at all.
  createEntity(e: { name: string; content?: string; fields?: string }): unknown {
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
    const p = patchSql('entities', ['name', 'content', 'fields'], patch)
    if (p)
      db.prepare(`${p.sql}, updated_at = datetime('now') WHERE id = ?`).run(
        ...(p.vals as never[]),
        id
      )
    if (was !== undefined && was !== patch.name)
      logEvent('INFO', 'entity.renamed', { entity: id, from: was, to: patch.name })
  },
  deleteEntity(id: number): void {
    // Read before the delete or the name is gone with it — and the name is the whole point.
    const row = db.prepare(`SELECT name FROM entities WHERE id = ?`).get(id) as { name: string }
    db.prepare(`DELETE FROM entities WHERE id = ?`).run(id)
    logEvent('INFO', 'entity.deleted', { entity: id, name: row?.name })
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
    // ponytail: the layers JSON is plumbing for heightmaps etc. — currently written, never read
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
    db.prepare(
      `INSERT INTO maps (id, name, parent_map_id, image_path, width, height, layers) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(map.id, map.name, map.parent_map_id, map.image_path, map.width, map.height, map.layers)
    for (const f of features)
      db.prepare(
        `INSERT INTO features (id, map_id, entity_id, geometry, style) VALUES (?, ?, ?, ?, ?)`
      ).run(f.id, f.map_id, f.entity_id, f.geometry, f.style)
    for (const cid of childIds)
      db.prepare(`UPDATE maps SET parent_map_id = ? WHERE id = ?`).run(map.id, cid)
  },

  // --- map features ---
  createFeature(f: {
    map_id: number
    entity_id?: number
    geometry: string
    style?: string
  }): unknown {
    const r = db
      .prepare(`INSERT INTO features (map_id, entity_id, geometry, style) VALUES (?, ?, ?, ?)`)
      .run(f.map_id, f.entity_id ?? null, f.geometry, f.style ?? '{}')
    return { id: Number(r.lastInsertRowid) }
  },
  updateFeature(id: number, patch: Record<string, unknown>): void {
    const p = patchSql('features', ['entity_id', 'geometry', 'style'], patch)
    if (p) db.prepare(`${p.sql} WHERE id = ?`).run(...(p.vals as never[]), id)
  },
  deleteFeature(id: number): void {
    db.prepare(`DELETE FROM features WHERE id = ?`).run(id)
  },

  // --- settings ---
  getSetting(key: string): string | null {
    const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
      { value: string } | undefined
    return row?.value ?? null
  },
  setSetting(key: string, value: string): void {
    db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(key, value)
  },

  // --- dosyalar ---
  importAsset(srcPath: string): string {
    if (!/\.(png|jpe?g|webp|gif)$/i.test(srcPath)) throw new Error('Images only')
    let name = basename(srcPath)
    if (existsSync(join(assetsDir, name))) {
      name = `${basename(name, extname(name))}-${Date.now()}${extname(name)}`
    }
    copyFileSync(srcPath, join(assetsDir, name))
    return `assets/${name}`
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
  exportNotes(): { path: string; files: number } {
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
      while (cur && !seen.has(cur)) {
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
      }
    }
    return { path: notesDir, files }
  }
}

// Self-check: `node src/main/db.ts`
if (process.argv[1]?.replace(/\\/g, '/').endsWith('src/main/db.ts')) {
  const dir = mkdtempSync(join(tmpdir(), 'worlddb-'))
  initDb(dir)
  // A session file from the FIRST line, so the article events below actually reach a sink. The log
  // section further down opens its own directory and is unaffected — this one only has to exist.
  initLog(dir, '9.9.9', () => ({}))
  const a = api.createEntity({ name: 'Test State' }) as { id: number }
  const b = api.createEntity({
    name: 'Test Dynasty',
    content: 'See [[Test State]]'
  }) as { id: number }
  api.addLink(b.id, a.id, 'rules')
  const got = api.getEntity(a.id) as { name: string; inLinks: unknown[]; mentions: unknown[] }
  assert.equal(got.name, 'Test State')
  assert.equal(got.inLinks.length, 1)
  assert.equal(got.mentions.length, 1)
  // Full-text search: content hits found; name matches excluded.
  {
    const hits = api.searchContent('test state') as { id: number; snippet: string }[]
    assert.equal(hits.length, 1) // only b (content mentions [[Test State]]); a counts as a name match
    assert.equal(hits[0].id, b.id)
    assert.ok(hits[0].snippet.includes('Test State'))
    assert.equal((api.searchContent('nothinglikethis') as unknown[]).length, 0)
    // Note-tab hits are found; technical fields (banner file path) are not searched
    api.updateEntity(b.id, {
      fields: JSON.stringify({
        banner: 'assets/HIDDEN-PATH-oneword.png',
        notes: JSON.stringify([{ title: 'Wars', content: 'Northern campaign began' }])
      })
    })
    const noteHits = api.searchContent('northern campaign') as { id: number; snippet: string }[]
    assert.equal(noteHits.length, 1)
    assert.ok(noteHits[0].snippet.includes('Northern campaign'))
    assert.equal((api.searchContent('HIDDEN-PATH') as unknown[]).length, 0) // banner path is not searched
  }
  api.updateEntity(a.id, {
    fields: JSON.stringify({
      hierarchy: '#kingdom, #southern-languages',
      government: 'feudal',
      religion: 'Islam'
    })
  })
  const hier = api.hierarchy() as {
    tags: string[]
    govs: string[]
    entities: { id: number; tags: string[]; gov: string | null; fields: string }[]
  }
  assert.deepEqual(hier.tags, ['#kingdom', '#southern-languages'])
  assert.deepEqual(hier.govs, ['feudal'])
  assert.equal(hier.entities.length, 2) // no WHERE: untagged entities are returned too
  const he = hier.entities.find((e) => e.id === a.id)!
  assert.equal(he.tags.length, 2)
  assert.equal(he.gov, 'feudal')
  assert.equal((JSON.parse(he.fields) as { religion: string }).religion, 'Islam')
  const m = api.createMap({ name: 'World' }) as { id: number }
  const feat = api.createFeature({
    map_id: m.id,
    entity_id: a.id,
    geometry: '{"type":"Point","coordinates":[1,2]}'
  }) as { id: number }
  assert.equal((api.getMap(m.id) as { features: unknown[] }).features.length, 1)
  // entityPlacements: the sidebar's map grouping is derived from drawings, not from a field on
  // the entity, so a drawn article must report its map and an undrawn one must not appear at all.
  assert.deepEqual(api.entityPlacements(), [{ entity_id: a.id, map_id: m.id, board: null }])
  api.updateFeature(feat.id, { style: JSON.stringify({ board: 'b1' }) })
  assert.equal(api.entityPlacements()[0].board, 'b1') // board read out of the style JSON
  api.updateFeature(feat.id, { style: 'not json' })
  assert.equal(api.entityPlacements()[0].board, null) // malformed style must not throw
  api.updateFeature(feat.id, { style: '{}' }) // restore: later checks share this fixture
  // exportNotes mirrors the SIDEBAR FOLDER TREE: a sits in the nested folder Realms/States and is
  // on the World map → notes/World/Realms/States/Test State/…; b is in no folder and on no map →
  // notes/(no map)/(no folder)/…
  api.setSetting(
    'entityFolders',
    JSON.stringify([
      { id: 'f1', name: 'Realms', parent: null, order: 1 },
      { id: 'f2', name: 'States', parent: 'f1', order: 1 }
    ])
  )
  api.updateEntity(a.id, {
    fields: JSON.stringify({
      folder: 'f2',
      notes: JSON.stringify([{ title: 'Founding', content: 'line1\nline2' }])
    })
  })
  const exp = api.exportNotes()
  assert.equal(exp.files, 2) // a (on a map) + b (mapless)
  const onMap = join(dir, 'notes', 'World', 'Realms', 'States', 'Test State', 'Founding.txt')
  assert.ok(existsSync(onMap), 'note of an on-map entity must be written')
  assert.equal(readFileSync(onMap, 'utf8'), 'line1\r\nline2') // \n → \r\n (Windows)
  assert.ok(
    existsSync(join(dir, 'notes', '(no map)', '(no folder)', 'Test Dynasty', 'Wars.txt')),
    'a mapless, folderless entity must land under (no map)/(no folder)'
  )
  // Boards become a level between map and folders — but ONLY for maps that have boards, which
  // is why the assertions above (a boardless map) keep passing unchanged.
  {
    api.setSetting(
      'mapBoards',
      JSON.stringify({ [m.id]: { list: [{ id: 'b1', name: 'Borders' }], active: 'b1' } })
    )
    const e2 = api.exportNotes()
    assert.equal(e2.files, 2) // same notes, deeper tree
    assert.ok(
      existsSync(
        join(dir, 'notes', 'World', 'Borders', 'Realms', 'States', 'Test State', 'Founding.txt')
      ),
      'a board must sit between the map and the folder tree'
    )
    // The feature carries no board id, so it resolved to the first board rather than vanishing
    assert.ok(
      !existsSync(join(dir, 'notes', 'World', 'Realms')),
      'the board level must not be skipped'
    )
    api.setSetting('mapBoards', '{}') // restore: later checks share this fixture
  }
  // safe(): the Windows device name CON cannot be a folder → _CON; control chars become _.
  // Without these, exportNotes would blow up on Windows with EPERM or a wrong target.
  {
    const evilEnt = api.createEntity({
      name: 'CON',
      fields: JSON.stringify({ notes: JSON.stringify([{ title: 'x\x07y', content: 'z' }]) })
    }) as { id: number }
    api.exportNotes()
    assert.ok(
      existsSync(join(dir, 'notes', '(no map)', '(no folder)', '_CON', 'x_y.txt')),
      'CON → _CON, control character → _'
    )
    api.deleteEntity(evilEnt.id)
  }
  // pruneUnusedAssets: an image named in the DB text survives, an unnamed one is deleted
  writeFileSync(join(dir, 'assets', 'used.png'), Buffer.from([9]))
  writeFileSync(join(dir, 'assets', 'unused.png'), Buffer.from([9]))
  api.updateEntity(a.id, { fields: JSON.stringify({ banner: 'assets/used.png' }) })
  assert.equal(pruneUnusedAssets(), 1)
  assert.ok(existsSync(join(dir, 'assets', 'used.png')), 'a used image must survive')
  assert.ok(!existsSync(join(dir, 'assets', 'unused.png')), 'an unused image must be deleted')
  rmSync(join(dir, 'assets', 'used.png')) // keep the following packWorld test isolated
  api.updateEntity(a.id, { fields: '{}' }) // clean up for the following tests
  const full = api.getEntity(a.id) as {
    id: number
    type: string
    name: string
    content: string
    fields: string
    created_at: string
  }
  const featIds = api.entityFeatureIds(a.id)
  api.deleteEntity(a.id)
  assert.equal(api.getEntity(a.id) as unknown, null)
  api.restoreEntity(full, [{ from_id: b.id, to_id: a.id, relation: 'rules', notes: '' }], featIds)
  const restored = api.getEntity(a.id) as { name: string; inLinks: unknown[] }
  assert.equal(restored.name, 'Test State')
  assert.equal(restored.inLinks.length, 1)
  assert.equal(
    (api.getMap(m.id) as { features: { entity_id: number }[] }).features[0].entity_id,
    a.id
  )
  // Bulk restore (multi-delete undo): delete linked a+b together, then restore
  const bFull = api.getEntity(b.id) as typeof full
  const aFeat = api.entityFeatureIds(a.id) as number[]
  api.deleteEntity(a.id)
  api.deleteEntity(b.id)
  assert.equal(api.getEntity(b.id) as unknown, null)
  api.restoreEntities(
    [full, bFull],
    [{ from_id: b.id, to_id: a.id, relation: 'rules', notes: '' }], // one record even when captured from both sides
    aFeat.map((fid) => ({ entity_id: a.id, feature_id: fid }))
  )
  const ra = api.getEntity(a.id) as { inLinks: unknown[] }
  assert.equal(ra.inLinks.length, 1) // link restored exactly once (dedup)
  assert.ok(api.getEntity(b.id))
  assert.equal(
    (api.getMap(m.id) as { features: { entity_id: number }[] }).features[0].entity_id,
    a.id
  )
  // Map-delete undo: row + feature return with original ids, the child map keeps its parent link
  const child = api.createMap({ name: 'City', parent_map_id: m.id }) as { id: number }
  // listMaps order is INSERTION order (not alphabetical): 'Island' was added last → last in the list
  const late = api.createMap({ name: 'Island' }) as { id: number }
  assert.equal((api.listMaps() as { id: number }[]).at(-1)?.id, late.id)
  api.deleteMap(late.id)
  const mFull = api.getMap(m.id) as {
    id: number
    name: string
    parent_map_id: number | null
    image_path: string | null
    width: number | null
    height: number | null
    layers: string
    features: {
      id: number
      map_id: number
      entity_id: number | null
      geometry: string
      style: string
    }[]
  }
  const savedFid = mFull.features[0].id
  api.deleteMap(m.id)
  assert.equal(api.getMap(m.id) as unknown, null)
  assert.equal((api.getMap(child.id) as { parent_map_id: number | null }).parent_map_id, null)
  api.restoreMap(
    mFull,
    mFull.features.map((f) => ({
      id: f.id,
      map_id: f.map_id,
      entity_id: f.entity_id,
      geometry: f.geometry,
      style: f.style
    })),
    [child.id]
  )
  const mBack = api.getMap(m.id) as { features: { id: number }[] }
  assert.equal(mBack.features.length, 1)
  assert.equal(mBack.features[0].id, savedFid) // fid preserved (timeline / map-history binding)
  assert.equal((api.getMap(child.id) as { parent_map_id: number | null }).parent_map_id, m.id)
  backupIfNeeded()
  assert.ok(existsSync(join(dir, 'backups')))
  assert.ok(readdirSync(join(dir, 'backups')).length >= 1)
  const manual = api.backupNow()
  assert.ok(existsSync(manual))
  // Retention by COUNT, not only by age. Age alone bounds nothing: a copy is taken on every launch
  // and again on every file opened, and three weeks of that reached 297 files without one being
  // old enough to prune.
  {
    const bdir = join(dir, 'backups')
    for (let i = 0; i < 70; i++) writeFileSync(join(bdir, `world-filler-${i}.db`), 'x')
    // Taken AFTER the filler, so it is genuinely the newest — which is the property being tested.
    const newest = api.backupNow()
    backupIfNeeded()
    const left = readdirSync(bdir)
    assert.ok(
      left.length <= BACKUP_KEEP_FILES,
      `count cap: ${left.length} files left, expected at most ${BACKUP_KEEP_FILES}`
    )
    // The newest survive: the copy taken seconds before something went wrong is the one wanted.
    assert.ok(left.includes(basename(newest)), 'the most recent backup must not be pruned')
    // Age is judged by when the BACKUP was taken, not by the mtime it inherited. copyFileSync
    // copies the source's timestamps on Windows, so a copy of a world untouched for a month was
    // born older than the cutoff and deleted on the next launch — silently, and exactly when it
    // was the only copy that mattered.
    const stale = join(bdir, 'world-stale-source.db')
    writeFileSync(stale, 'x')
    const long = new Date(Date.now() - (BACKUP_KEEP_DAYS + 10) * 86_400_000)
    utimesSync(stale, long, long) // an old mtime on a file created just now, as a copy would have
    backupIfNeeded()
    assert.ok(existsSync(stale), 'a fresh backup of an old world must not be pruned as old')
  }
  // .dunya pack/unpack round trip: the image is embedded; after the working copy is overwritten
  // and reopened, both data and image come back intact, and no assets table remains
  writeFileSync(join(dir, 'assets', 'test.png'), Buffer.from([1, 2, 3]))
  // packWorld now prunes unused images → test.png must be referenced (or it would be deleted)
  api.updateEntity(a.id, { fields: JSON.stringify({ banner: 'assets/test.png' }) })
  const dunya = join(dir, 'test.dunya')
  packWorld(dunya)
  assert.ok(existsSync(dunya))
  api.updateEntity(a.id, { name: 'Changed After Packing' })
  rmSync(join(dir, 'assets', 'test.png'))
  unpackWorld(dunya)
  assert.equal((api.getEntity(a.id) as { name: string }).name, 'Test State') // the state at pack time
  assert.deepEqual([...readFileSync(join(dir, 'assets', 'test.png'))], [1, 2, 3]) // the image came back out
  assert.equal(api.getSetting('worldFile'), dunya)
  assert.ok(
    !db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'assets'`).get()
  )
  // …and the FILE shrank with it. Dropping the table frees pages without shrinking the file, so
  // the working copy kept the full weight of every image it had ever unpacked: 102.4 MB measured
  // on a real one, 26 206 of 26 217 pages free, and every backup copied it. VACUUM leaves none.
  assert.equal(
    Object.values(db.prepare(`PRAGMA freelist_count`).get() as object)[0],
    0,
    'unpackWorld must VACUUM: a dropped assets table leaves the file at its old size'
  )
  // Malicious .dunya: an embedded image name must not write OUTSIDE assets/ (shared file!)
  {
    const evil = join(dir, 'evil.dunya')
    copyFileSync(dunya, evil)
    const ev = new DatabaseSync(evil)
    ev.exec(`CREATE TABLE IF NOT EXISTS assets (name TEXT PRIMARY KEY, data BLOB NOT NULL)`)
    ev.prepare(`INSERT OR REPLACE INTO assets (name, data) VALUES (?, ?)`).run(
      join('..', '..', 'kacti.png'),
      Buffer.from([9])
    )
    // Must be referenced, or pruneUnusedAssets at the end of unpackWorld would delete it and
    // the "stayed inside" claim could not be tested
    ev.prepare(`UPDATE entities SET fields = ? WHERE id = ?`).run(
      JSON.stringify({ banner: 'assets/kacti.png' }),
      a.id
    )
    ev.close()
    unpackWorld(evil)
    // Where the name points: assets/../../kacti.png (above the temp root) — must NOT be there
    assert.ok(
      !existsSync(join(dir, 'assets', '..', '..', 'kacti.png')),
      'embedded name escaped assets/!'
    )
    assert.ok(existsSync(join(dir, 'assets', 'kacti.png'))) // reduced to basename, stayed inside
  }
  // A .dunya with malformed JSON columns must be repaired on open — otherwise one of the 20+
  // JSON.parse sites in the renderer throws and that whole view goes down (the map never opens)
  {
    const broken = join(dir, 'broken.dunya')
    copyFileSync(dunya, broken)
    const bd = new DatabaseSync(broken)
    bd.exec(`UPDATE entities SET fields = 'BOZUK{{'`)
    bd.exec(`UPDATE features SET style = '[1,2]'`) // valid JSON but an ARRAY — an object is expected
    bd.exec(`UPDATE maps SET layers = 'yok'`)
    bd.exec(`UPDATE features SET geometry = '{"type":"Polygon" KESIK'`) // parsed unguarded in 8 places
    bd.exec(`INSERT OR REPLACE INTO settings (key, value) VALUES ('mapModes', '{bozuk')`)
    bd.exec(`INSERT OR REPLACE INTO settings (key, value) VALUES ('theme', 'dark')`)
    bd.close()
    unpackWorld(broken)
    assert.equal(
      (api.getEntity(a.id) as { fields: string }).fields,
      '{}',
      'malformed fields must be repaired'
    )
    const bm = api.getMap(m.id) as {
      layers: string
      features: { style: string; geometry: string }[]
    }
    assert.equal(bm.features[0].style, '{}', 'malformed style must be repaired')
    assert.equal(bm.layers, '[]', 'malformed layers must be repaired')
    assert.equal(api.getSetting('mapModes'), null, 'a malformed JSON setting must be deleted')
    assert.equal(api.getSetting('theme'), 'dark', 'a plain-TEXT setting must survive (not JSON)')
    // geometry was NOT covered by this gate once, and MapView/Atlas parse it without a try —
    // one bad row took down the whole map render. It must come out parseable.
    JSON.parse(bm.features[0].geometry) // throws the assertion for us if the repair regressed
    assert.equal(
      (JSON.parse(bm.features[0].geometry) as { type: string }).type,
      'Point',
      'malformed geometry must be repaired to a degenerate Point, not left as-is'
    )
  }
  // A file that is NOT one of our worlds must be refused BEFORE anything is overwritten.
  // Without the probe this destroyed world.db and the app could not be launched again at all:
  // initDb threw on the garbage before a window existed, so ErrorBoundary could not help.
  {
    const notDb = join(dir, 'not-a-world.dunya')
    writeFileSync(notDb, 'plain text wearing a .dunya extension')
    const before = (api.listEntities() as unknown[]).length
    assert.throws(() => unpackWorld(notDb), /NOT_A_WORLD/, 'a non-database must be refused')
    assert.equal((api.listEntities() as unknown[]).length, before, 'the open world must survive')
    // A real SQLite file that is not OURS is refused the same way (missing tables)
    const stray = join(dir, 'stray.dunya')
    const sd = new DatabaseSync(stray)
    sd.exec(`CREATE TABLE notes (id INTEGER PRIMARY KEY)`)
    sd.close()
    assert.throws(() => unpackWorld(stray), /NOT_A_WORLD/, 'a foreign database must be refused')
    assert.equal((api.listEntities() as unknown[]).length, before, 'the open world must survive')
    // A file that names a VIEW `entities` reads like a world and passes every SELECT, then
    // refuses writes — it must be caught at the gate, not half-opened.
    const viewy = join(dir, 'viewy.dunya')
    copyFileSync(dunya, viewy)
    const vd = new DatabaseSync(viewy)
    vd.exec(`ALTER TABLE entities RENAME TO real_ents`)
    vd.exec(`CREATE VIEW entities AS SELECT * FROM real_ents`)
    vd.close()
    assert.throws(() => unpackWorld(viewy), /NOT_A_WORLD/, 'a view standing in for a table')
  }
  // A .dunya carries more than rows. A TRIGGER rides along and then fires against the USER's own
  // edits from then on — 'after every insert, rename everything' is sabotage that survives every
  // save. None of this is part of the format, so it must not reach the working copy.
  {
    const rigged = join(dir, 'rigged.dunya')
    copyFileSync(dunya, rigged)
    const rg = new DatabaseSync(rigged)
    rg.exec(
      `CREATE TRIGGER sabotage AFTER INSERT ON entities BEGIN UPDATE entities SET name = 'OWNED'; END`
    )
    rg.exec(`CREATE VIEW sneak AS SELECT * FROM entities`)
    rg.exec(`CREATE INDEX foreign_idx ON entities(name)`)
    rg.exec(`CREATE TABLE backdoor (x TEXT)`)
    rg.close()
    unpackWorld(rigged)
    const left = db
      .prepare(`SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'`)
      .all() as { type: string; name: string }[]
    assert.ok(
      left.every((r) => r.type === 'table' && OUR_TABLES.has(r.name)),
      'only our tables may survive an open: ' + JSON.stringify(left)
    )
    api.createEntity({ name: 'After The Trigger' })
    assert.ok(
      !(api.listEntities() as { name: string }[]).some((e) => e.name === 'OWNED'),
      'a planted trigger must not fire on the user later'
    )
  }
  // Depth: whether a deeply nested value parses depends on the stack left, so main can accept
  // what the renderer then cannot read. Measured with a 208 KB file that opened cleanly and left
  // the map unrenderable. The gate bounds depth WITHOUT parsing, so both sides agree.
  {
    const deep = join(dir, 'deep.dunya')
    copyFileSync(dunya, deep)
    const nest = (n: number): string => '{"a":'.repeat(n) + '1' + '}'.repeat(n)
    const dp = new DatabaseSync(deep)
    dp.prepare(`UPDATE entities SET fields = ?`).run(nest(10000))
    dp.prepare(`UPDATE features SET style = ?, geometry = ?`).run(nest(10000), nest(10000))
    dp.close()
    unpackWorld(deep)
    const dm = api.getMap(m.id) as { features: { style: string; geometry: string }[] }
    assert.equal((api.getEntity(a.id) as { fields: string }).fields, '{}', 'deep fields reset')
    assert.equal(dm.features[0].style, '{}', 'deep style reset')
    assert.equal(
      dm.features[0].geometry,
      '{"type":"Point","coordinates":[0,0]}',
      'deep geometry reset'
    )
    // A normally nested world must be untouched — the limit is a ceiling, not a filter
    const okDepth = JSON.stringify({ notes: JSON.stringify([{ title: 't', content: 'c' }]) })
    api.updateEntity(a.id, { fields: okDepth })
    packWorld(join(dir, 'ok.dunya'))
    unpackWorld(join(dir, 'ok.dunya'))
    assert.equal(
      (api.getEntity(a.id) as { fields: string }).fields,
      okDepth,
      'normal depth survives'
    )
  }
  // Count: 20 000 tiny embedded images inside a 2 MB file froze the process for 22 seconds and
  // wrote 20 000 files. Refused before a byte is written, so the open world survives.
  {
    const many = join(dir, 'many.dunya')
    copyFileSync(dunya, many)
    const mn = new DatabaseSync(many)
    mn.exec(`CREATE TABLE IF NOT EXISTS assets (name TEXT PRIMARY KEY, data BLOB NOT NULL)`)
    mn.exec('BEGIN')
    const st = mn.prepare(`INSERT OR REPLACE INTO assets (name, data) VALUES (?, ?)`)
    for (let i = 0; i <= 10_000; i++) st.run(`i${i}.png`, Buffer.from([1]))
    mn.exec('COMMIT')
    mn.close()
    const filesBefore = readdirSync(join(dir, 'assets')).length
    assert.throws(() => unpackWorld(many), /WORLD_TOO_LARGE/, 'too many embedded images')
    assert.equal(readdirSync(join(dir, 'assets')).length, filesBefore, 'nothing written on refusal')
    assert.ok(api.getEntity(a.id), 'the open world must survive the refusal')
  }
  // Blank launch: content is detected; after reset both db and assets are empty
  assert.ok(hasContent())
  resetWorld()
  assert.ok(!hasContent())
  assert.ok(!existsSync(join(dir, 'assets', 'test.png')))
  assert.equal(api.getSetting('worldFile'), null)

  // Migration when an OLD world with Turkish keys is opened: no data may be lost. This was the
  // one real data risk of anglicising the codebase — years of parent chains, banners and
  // dynasty links depend on it. Turkish fixtures below are the point of the test.
  {
    const old = api.createEntity({ name: 'Legacy Record' }) as { id: number }
    const kid = api.createEntity({ name: 'Legacy Child' }) as { id: number }
    db.prepare(`UPDATE entities SET fields = ? WHERE id = ?`).run(
      JSON.stringify({
        '\u00fcst': '[{"from":null,"id":7}]',
        '\u0073\u0061\u006e\u0063\u0061\u006b': 'assets/old.png',
        '\u006e\u006f\u0074\u006c\u0061\u0072': '[{"title":"a","content":"b"}]',
        'hiyerar\u015fi': '#county',
        'y\u00f6netim': 'feudal',
        '\u0072\u0065\u006e\u006b': '#ff0000',
        religion: 'Islam' // user-defined map-mode dimension: never translate it
      }),
      old.id
    )
    db.prepare(
      `INSERT INTO links (from_id, to_id, relation) VALUES (?, ?, '\u0062\u0061\u0062\u0061')`
    ).run(kid.id, old.id)
    assert.ok(migrateLegacyKeys() > 0)
    const f = JSON.parse((api.getEntity(old.id) as { fields: string }).fields) as Record<
      string,
      string
    >
    assert.equal(f['parent'], '[{"from":null,"id":7}]', 'legacy parent must migrate')
    assert.equal(f['banner'], 'assets/old.png')
    assert.equal(f['hierarchy'], '#county')
    assert.equal(f['government'], 'feudal')
    assert.equal(f['color'], '#ff0000')
    assert.equal(f['religion'], 'Islam', 'user-defined fields must be LEFT ALONE')
    // gender VALUE migration
    db.prepare(`UPDATE entities SET fields = ? WHERE id = ?`).run(
      JSON.stringify({ '\u0063\u0069\u006e\u0073\u0069\u0079\u0065\u0074': 'kad\u0131n' }),
      kid.id
    )
    migrateLegacyKeys()
    assert.equal(
      (JSON.parse((api.getEntity(kid.id) as { fields: string }).fields) as { gender: string })
        .gender,
      'female',
      'gender value must migrate too'
    )
    assert.ok(
      !('\u00fcst' in f) && !('\u0073\u0061\u006e\u0063\u0061\u006b' in f),
      'legacy keys must be removed'
    )
    assert.equal(
      (
        db.prepare(`SELECT relation FROM links WHERE from_id = ?`).get(kid.id) as {
          relation: string
        }
      ).relation,
      'father',
      'legacy relation must migrate to father'
    )
    // Running twice must be harmless (it runs on every launch)
    assert.equal(migrateLegacyKeys(), 0, 'migration must be idempotent')
    // A stale Turkish key must NOT overwrite an existing English value
    db.prepare(`UPDATE entities SET fields = ? WHERE id = ?`).run(
      JSON.stringify({ '\u00fcst': 'stale', parent: 'current' }),
      old.id
    )
    migrateLegacyKeys()
    const f2 = JSON.parse((api.getEntity(old.id) as { fields: string }).fields) as Record<
      string,
      string
    >
    assert.equal(f2['parent'], 'current', 'the existing English value must win')
    assert.ok(!('\u00fcst' in f2))
  }

  // The article events. Logged in these functions rather than at the buttons, so every route in is
  // covered by one place; what needs checking is the two that read the database BEFORE writing it.
  {
    const e = api.createEntity({ name: 'Log Test Article' }) as { id: number }
    api.updateEntity(e.id, { name: 'Renamed Article' })
    api.updateEntity(e.id, { content: 'an ordinary field save' })
    api.deleteEntity(e.id)
    flushLog()
    const logs = join(dir, 'logs')
    const txt = readFileSync(join(logs, readdirSync(logs)[0]), 'utf8')
    assert.ok(/entity\.created .*name="Log Test Article"/.test(txt), 'a new article says its name')
    assert.ok(
      /entity\.renamed .*from="Log Test Article" to="Renamed Article"/.test(txt),
      'a rename carries both names — the old one is what a search will be for'
    )
    assert.ok(
      !/entity\.renamed .*from="Renamed Article"/.test(txt),
      'and an ordinary field save is not a rename'
    )
    assert.ok(
      /entity\.deleted .*name="Renamed Article"/.test(txt),
      'a deletion says the name, which means reading it BEFORE the row goes'
    )
  }

  // Three COUNT queries, but they run at open time inside a logTime: a wrong table name here would
  // throw where the app is least able to explain itself.
  {
    const s = worldStats()
    assert.deepEqual(
      Object.keys(s).sort(),
      ['entities', 'features', 'maps'],
      'worldStats reports the three tables an open should describe'
    )
    assert.ok(
      Object.values(s).every((v) => Number.isInteger(v) && v >= 0),
      'and each of them as a number — a wrong table name would throw here, not at open time'
    )
  }

  db.close()
  rmSync(dir, { recursive: true, force: true })
  // Error log. Not a database concern, but this file is the project's only test harness and the
  // logger is the one thing that has to work while everything else is failing.
  {
    const ldir = join(dir, 'logtest')
    mkdirSync(ldir, { recursive: true })
    const logs = join(ldir, 'logs')
    const only = (): string => {
      const n = readdirSync(logs).filter((f) => /_session\.log$/.test(f))
      assert.equal(n.length, 1, 'one file per session')
      return join(logs, n[0])
    }

    initLog(ldir, '9.9.9', () => ({ file: 'w.dunya', dirty: true }))
    // The header is written at INIT, not on the first error: a session log that only sometimes
    // exists cannot be asked for by a user, which is the whole point of having one.
    assert.ok(readFileSync(only(), 'utf8').includes('SESSION START'), 'header at session start')

    logEvent('INFO', 'project.opened', { file: 'w.dunya', entities: 163 })
    logEvent('DEBUG', 'never.written', {})
    logSetDebug(true)
    logEvent('DEBUG', 'now.written', {})
    logTime('map.reload')({ features: 12 })
    // A repeated scope collapses into one line rather than sixty. The first real session log had
    // sixty map.reload lines in three seconds and they buried everything else.
    for (let i = 0; i < 12; i++) logEvent('INFO', 'noisy.scope', { took: `${5 + i}ms` })
    // Only genuinely identical events merge. Coalescing on the scope alone collapsed four tool
    // changes into two lines and threw two of the four values away.
    logEvent('INFO', 'tool.changed', { tool: 'polygon' })
    logEvent('INFO', 'tool.changed', { tool: 'line' })
    logEvent('INFO', 'something.else', {})
    // A run has to say how LONG it lasted: `feature.selected ×6` reads the same whether it was six
    // clicks over four seconds or six fires inside one frame, and only one of those is a bug.
    {
      const t0 = Date.now()
      logEvent('INFO', 'clicky.scope', { feature: 116 }, new Date(t0))
      logEvent('INFO', 'clicky.scope', { feature: 116 }, new Date(t0 + 1500))
    }
    // Lines are written in the order things HAPPENED, not the order they arrived: renderer events
    // carry their own stamp and reach main up to half a second late, and a reader trusts the order
    // of the lines over the clock in them.
    {
      const t0 = Date.now()
      logEvent('INFO', 'arrived.second', {}, new Date(t0 + 40))
      logEvent('INFO', 'happened.first', {}, new Date(t0 - 300))
    }
    noteCall('updateEntity') // only mutations reach the trail — index.ts is where reads are dropped
    noteCall('updateFeature')
    noteCall('logEvents') // reporting is not something the app was DOING — must stay out of it
    logError('ipc:updateFeature', new TypeError('boom: feature write failed'), {
      extra: 'x'.repeat(2000),
      component: 'at MapView (MapView.tsx:365) < at App (App.tsx:33)'
    })
    // The same failure reported twice — main catching an IPC call, then the renderer's unhandled
    // rejection carrying it wrapped — is one fault, and gets one block plus a pointer.
    logError(
      'renderer:unhandledRejection',
      new Error("Error invoking remote method 'api': boom: feature write failed")
    )
    flushLog()

    // The one relationship between two numbers chosen in different files. At 400 against a 500 ms
    // batch, a continuous drag settled once per batch forever and coalescing did nothing.
    assert.ok(
      COALESCE_MS > BATCH_MS,
      'the coalescing window must outlast the renderer batch, or repeats never merge across two'
    )

    const txt = readFileSync(only(), 'utf8')
    assert.ok(txt.includes('App       9.9.9'), 'the header carries the version')
    assert.ok(/INFO {2}.*project\.opened.*entities=163/.test(txt), 'one line per event')
    assert.ok(!txt.includes('never.written'), 'DEBUG is silent while the switch is off')
    assert.ok(txt.includes('now.written'), 'and speaks once it is on')
    assert.ok(/map\.reload.*took=\d+ms/.test(txt), 'a timed operation reports its duration')
    // EVENT lines only — the scope also appears inside the error report's trail, which is correct
    // and must not be counted here.
    const eventLines = txt.split('\n').filter((l) => /^\d{2}:\d{2}:\d{2}\.\d{3} {2}/.test(l))
    assert.equal(
      eventLines.filter((l) => l.includes('noisy.scope')).length,
      1,
      'a repeated scope leaves ONE line, not one per occurrence'
    )
    assert.ok(/noisy\.scope.*count=×12 took=5-16ms/.test(txt), 'and it keeps the count and spread')
    assert.equal(
      eventLines.filter((l) => l.includes('tool.changed')).length,
      2,
      'events that share a scope but differ in data are NOT merged'
    )
    assert.ok(txt.includes('tool=polygon') && txt.includes('tool=line'), 'and neither is lost')
    assert.ok(
      /clicky\.scope.*count=×2 feature=116 over=1500ms/.test(txt),
      'a coalesced run says how long it lasted, not only how many'
    )
    assert.ok(txt.includes('ERROR REPORT'), 'an error gets the full block, not a line')
    assert.equal(
      txt.split('ERROR REPORT').length - 1,
      1,
      'one fault leaves ONE block, however many layers report it'
    )
    assert.ok(
      /error\.echo.*where=renderer:unhandledRejection of=ipc:updateFeature/.test(txt),
      'the echo says where it came from and which block it belongs to'
    )
    assert.ok(!txt.includes('logEvents'), 'the act of logging stays out of the trail')
    assert.ok(txt.includes('TypeError: boom'), 'the error itself')
    assert.ok(txt.includes('file=w.dunya dirty=true'), 'context from the app')
    assert.ok(txt.includes('updateEntity → updateFeature'), 'the call trail — how it got there')
    assert.ok(
      txt.indexOf('happened.first') < txt.indexOf('arrived.second'),
      'lines are ordered by when the event happened, not by when it was written'
    )
    // The component stack names the screen that broke; it is the most valuable field a render crash
    // has and far too long to sit inside the context line.
    assert.ok(/\nscreen {4}at MapView/.test(txt), 'the component stack gets its own row')
    // Without the value the trail reads `tool.changed → tool.changed` and the one thing it is
    // asked — which tool was live — is missing from the summary that exists to save reading.
    assert.ok(
      txt.includes('tool.changed(polygon) → tool.changed(line)'),
      'the trail carries what the event was ABOUT, not only its name'
    )
    assert.ok(txt.includes('chars]'), 'oversized fields are clipped, not written whole')
    // A logger that throws while reporting is worse than none: unwritable directory, no crash.
    initLog(join(dir, 'nope', ' bad'), '1', () => ({}))
    logError('main:uncaught', new Error('during a broken log dir'))
    // One file per RUN: a second run writes its own, and files from the older naming schemes are
    // cleared out rather than left to sit there looking as current as everything else.
    const firstRun = basename(only())
    writeFileSync(join(logs, 'error-2026-01-01_00-00-00-abc.log'), 'from an older version')
    initLog(ldir, '9.9.9', () => ({}))
    logError('main:uncaught', new Error('second run'))
    flushLog()
    const files = readdirSync(logs)
    assert.equal(files.length, 2, 'a file per session, and the legacy name is gone')
    const secondRun = join(
      logs,
      files.find((f) => f !== firstRun)!
    )
    assert.ok(
      readFileSync(secondRun, 'utf8').includes('second run'),
      'the second run wrote its own file, leaving the first intact'
    )
    // A runaway loop stops the file rather than filling the disk, and says that it did.
    writeFileSync(secondRun, 'x'.repeat(1024 * 1024 + 10))
    logError('main:uncaught', new Error('after the cap'))
    logError('main:uncaught', new Error('long after the cap'))
    const capped = readFileSync(secondRun, 'utf8')
    assert.ok(capped.includes('log capped'), 'the cap is announced, not silent')
    assert.ok(!capped.includes('long after the cap'), 'and it holds')

    // Retention: past the age limit a file goes, whatever the count says. Logs must not be a
    // folder that only ever grows on someone's machine.
    const stale = join(logs, '2020-01-01_00-00-00_old_session.log')
    writeFileSync(stale, 'ancient')
    utimesSync(stale, new Date(0), new Date(0))
    initLog(ldir, '9.9.9', () => ({}))
    assert.ok(!existsSync(stale), 'a log past the retention window is removed on launch')
  }

  console.log('db self-check OK')
}
