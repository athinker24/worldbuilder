import { app, shell, BrowserWindow, ipcMain, dialog, protocol, net, Menu, session } from 'electron'
import { basename, dirname, join } from 'path'
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { writeFile } from 'fs/promises'
import { execFile } from 'child_process'
import { pathToFileURL } from 'url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import {
  initDb,
  backupIfNeeded,
  hasContent,
  packWorld,
  resetWorld,
  unpackWorld,
  worldStats,
  resolveAssetPath,
  importAsset,
  MUTATES,
  NOT_A_WORLD,
  WORLD_TOO_LARGE,
  WORLD_TOO_NEW,
  api as dbApi
} from './db'
import {
  flushLog,
  initLog,
  Level,
  logError,
  logEvent,
  logFile,
  logPath,
  logSetDebug,
  logTime,
  noteCall
} from './log'
import { MEMORY_SAMPLE_MS, MEMORY_STEP_MB, MEMORY_WARN_MB } from './log/thresholds.ts'

// The product name in ONE place: window title, dialog filter label and the data folder all read
// it, so renaming the app later is a one-line change here plus productName/executableName in
// electron-builder.yml. (Worldbuilder is a placeholder until a real name is chosen.)
const APP_NAME = 'Worldbuilder'
const LEGACY_APP_NAME = 'D\u00fcnya' // pre-rename folder, moved on first launch (see below)
const DOCS = app.getPath('documents')

// All data lives under Documents\<APP_NAME> (to back up, copy that folder); the dev and packaged
// builds deliberately share it, so both see the same world.
const DATA_DIR = join(DOCS, APP_NAME)

// One-time move of the pre-rename folder. Without it the app would quietly start with an empty
// world while years of content sat in the old folder — renaming the app must not orphan data.
// Only ever moves when the new folder does not exist yet, so it can never merge or overwrite.
function adoptLegacyDataDir(): void {
  const legacy = join(DOCS, LEGACY_APP_NAME)
  if (legacy === DATA_DIR || !existsSync(legacy) || existsSync(DATA_DIR)) return
  try {
    renameSync(legacy, DATA_DIR)
  } catch {
    /* different drive / locked file: if the move fails we open with a blank world, data stays put */
  }
}

// world://data/assets/x.png → DATA_DIR/assets/x.png (serves images to the renderer)
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'world',
    // corsEnabled: the WebGL map layers upload these images as textures, and a texture upload
    // from another origin is refused unless the request was a CORS one that succeeded (see the
    // handler, which answers it). Plain <img> tags are unaffected — those never ask for CORS.
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true
    }
  }
])

// exportMapImage needs the window for capturePage; assigned in createWindow
let mainWindow: BrowserWindow | null = null

// --- The document model: the working copy (DATA_DIR) is saved instantly at all times,
// Ctrl+S packs it into a single .world file, Open unpacks a file over the working copy.
// currentFile = the Ctrl+S target, kept in memory here and nowhere else; dirty = changes since
// the last save. (settings.worldFile is a working-copy convenience that nothing reads, and
// packWorld strips it so a shared file never carries the author's path — see db.ts.)
let currentFile: string | null = null
let dirty = false
// Set when the startup sequence failed. Reported once the window exists — the point is that the
// app still opens; a dialog before createWindow() would have nothing to attach to.
let startupWarning: string | null = null
// Name + dirty star in the window title. The renderer never sets document.title.
function updateTitle(): void {
  mainWindow?.setTitle(
    `${APP_NAME} — ${currentFile ? basename(currentFile) : 'unsaved'}${dirty ? ' *' : ''}`
  )
}
// Save: pack + clear the flag. Prompt with a dialog when there is no path ('as' always prompts).
async function saveWorld(as = false): Promise<string | null> {
  let target = as ? null : currentFile
  if (!target) {
    const r = await dialog.showSaveDialog(mainWindow!, {
      defaultPath: currentFile ?? join(DOCS, 'my-world.world'),
      filters: [{ name: APP_NAME, extensions: ['world'] }]
    })
    if (r.canceled || !r.filePath) return null
    target = r.filePath
  }
  // Named for the file, never the path: the log is meant to be pasted into a message, and a
  // directory tree says more about someone than they intended to share.
  const done = logTime('project.save', { file: basename(target), as })
  packWorld(target)
  currentFile = target
  dbApi.setSetting('worldFile', target)
  dirty = false
  addRecent(target)
  updateTitle()
  done()
  return target
}

// .world path from argv (double-click open — the Windows file association passes it as an argument)
// Both extensions: the file the app writes is `.world`, and `.dunya` is what every
// world saved before the rename is still called on disk.
const WORLD_EXT = ['.world', '.dunya']
const worldArg = (argv: string[]): string | null =>
  argv.find((a) => WORLD_EXT.some((e) => a.toLowerCase().endsWith(e)) && existsSync(a)) ?? null

// Recent .world files, shown on the start screen. NOT written into DATA_DIR: the working
// copy is reset on every normal launch, and the list must outlive that → userData/recent.json.
const RECENT = join(app.getPath('userData'), 'recent.json')
const readRecent = (): string[] => {
  try {
    const l: unknown = JSON.parse(readFileSync(RECENT, 'utf8'))
    // The ELEMENTS, not just the array: `recentWorlds` calls basename() and existsSync() on each
    // one, and both throw on a non-string. That is the START SCREEN, so a half-written file (a
    // power cut mid-save is the realistic way) would leave the app with no way back in.
    return Array.isArray(l) ? l.filter((p): p is string => typeof p === 'string') : []
  } catch {
    return [] // first launch / corrupt file: start with an empty list
  }
}
const writeRecent = (l: string[]): void => {
  try {
    writeFileSync(RECENT, JSON.stringify(l.slice(0, 12)))
  } catch {
    /* if the disk cannot be written the list is expendable — never block launch over it */
  }
}
const addRecent = (path: string): void => {
  writeRecent([path, ...readRecent().filter((p) => p !== path)])
  buildMenu() // File > Open Recent is built from this list
}

// Application preferences (language, theme). Deliberately NOT in the settings table: rows there
// live inside world.db, so they travel inside a shared .world (opening someone else's file would
// change your language) and resetWorld() wipes them on any launch that had content (your own
// choice would not survive a restart). Per-machine, next to recent.json.
const PREFS = join(app.getPath('userData'), 'prefs.json')
// Panel widths and the sidebar's open state live here too: they describe how YOU like the app
// laid out, not what the world contains, so they must not ride inside a shared .world.
type Prefs = {
  language?: string
  theme?: string
  sidebarWidth?: number
  mapPanelWidth?: number
  /** Interface scale, as a PERCENT. The app is drawn in CSS pixels, so on a 2560-wide display at
      100% system scaling everything is physically small — the usual complaint about any desktop
      app on a 2K panel. The answer is a zoom the app owns, per machine, because it describes a
      screen rather than a world. */
  uiScale?: number
  // Developer logging. Per machine like everything else here — it describes how YOU want the app
  // to behave, and a shared .world must not be able to turn it on for someone else.
  debugLog?: boolean
}
const readPrefs = (): Prefs => {
  try {
    const p: unknown = JSON.parse(readFileSync(PREFS, 'utf8'))
    return p && typeof p === 'object' ? (p as Prefs) : {}
  } catch {
    return {} // first launch / corrupt file: fall back to the renderer's defaults
  }
}
const writePrefs = (p: Prefs): void => {
  try {
    writeFileSync(PREFS, JSON.stringify(p))
  } catch {
    /* expendable like recent.json — never block launch over it */
  }
}

/** The steps the scale moves in, and the list the Preferences dropdown shows. Discrete rather
    than a slider: nobody wants 113%, and a fixed ladder is what makes Zoom In/Out a step rather
    than an arithmetic problem. */
const UI_SCALES = [75, 90, 100, 110, 125, 150, 175, 200]

/** Zoom the whole window.
 *
 * setZoomFactor rather than a CSS scale, because the app is written in px and always has been —
 * a font-size-based scale would reach the type and nothing else. Everything here is drawn in CSS
 * pixels, so the factor moves layout, chrome, the map and its labels together, which is what
 * makes it the answer the other desktop apps landed on too.
 *
 * The map survives it by construction: both WebGL layers are created at resolution 1 (they
 * already ignore devicePixelRatio), the Leaflet host is watched by a ResizeObserver that
 * invalidates the map size, and drawBase re-reads devicePixelRatio on every draw. Nothing caches
 * a scale across the change.
 */
function applyUiScale(percent: number): void {
  mainWindow?.webContents.setZoomFactor(percent / 100)
}

/** Persist and apply in one place, so the menu keys and the Preferences dropdown cannot drift. */
function setUiScaleTo(percent: number): void {
  writePrefs({ ...readPrefs(), uiScale: percent })
  applyUiScale(percent)
}

/** One rung along UI_SCALES, clamped at both ends rather than wrapping. */
function stepUiScale(dir: 1 | -1): void {
  const cur = readPrefs().uiScale ?? 100
  // The nearest rung to whatever is stored, so a hand-edited prefs.json still steps sensibly.
  const i = UI_SCALES.reduce(
    (best, v, n) => (Math.abs(v - cur) < Math.abs(UI_SCALES[best] - cur) ? n : best),
    0
  )
  setUiScaleTo(UI_SCALES[Math.min(UI_SCALES.length - 1, Math.max(0, i + dir))])
}
// One-time adoption of the language/theme the user already picked, which until now lived in the
// settings table. MUST run before resetWorld() empties world.db — see app.whenReady below.
function adoptLegacyPrefs(): void {
  if (existsSync(PREFS)) return
  const p: Prefs = {}
  const lang = dbApi.getSetting('language')
  const theme = dbApi.getSetting('theme')
  if (lang) p.language = lang
  if (theme) p.theme = theme
  writePrefs(p)
}

// Open a .world file over the working copy (safety backup first)
function openWorldFile(path: string): void {
  dbApi.backupNow()
  unpackWorld(path)
  currentFile = path
  dirty = false
  addRecent(path)
  updateTitle()
}

/**
 * Memory across EVERY Electron process, which is the only number worth writing down.
 *
 * `process.memoryUsage()` sees the main process alone, and main is the small one: the growth this
 * app has actually suffered — 4.8 GB of it — was in the renderer. getAppMetrics reports each child
 * separately, so the line says which one is heavy rather than just that something is.
 *
 * FIELDS, not a sentence: written as one string under a key it came out as
 * `total="total=417MB browser=111MB…"` — the key twice, and the whole reading quoted into a single
 * blob because of the `=` signs inside it. Event data is key=value; anything that hands the logger
 * a pre-joined string is opting out of the only grammar the file has.
 */
function memoryFields(): Record<string, string> {
  try {
    const m = app.getAppMetrics()
    const by = (t: string): number =>
      Math.round(
        m.filter((p) => p.type === t).reduce((s, p) => s + (p.memory?.workingSetSize ?? 0), 0) /
          1024
      )
    const total = Math.round(m.reduce((s, p) => s + (p.memory?.workingSetSize ?? 0), 0) / 1024)
    // Zero components are dropped rather than written as 0MB. At startup the renderer and GPU
    // processes do not exist yet, and `renderer=0MB` reads as a measurement rather than as an
    // absence — the header looked wrong the first time it was seen.
    const out: Record<string, string> = { total: `${total}MB` }
    for (const [label, type] of [
      ['browser', 'Browser'],
      ['renderer', 'Tab'],
      ['gpu', 'GPU']
    ] as const) {
      const v = by(type)
      if (v) out[label] = `${v}MB`
    }
    return out
  } catch {
    return {}
  }
}

/** The same reading as one string, for the session header — which is a block, not an event line. */
const memoryLine = (): string =>
  Object.entries(memoryFields())
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')

/**
 * Sample memory on a slow timer and write a line only when it MOVES — a periodic reading that says
 * the same number forever is noise, and the point is to notice growth without being asked.
 *
 * In main, so it cannot touch the renderer's frame budget: the map is the thing whose smoothness
 * was paid for, and nothing added for observability may spend it.
 */
const memoryTotalMb = (): number => {
  try {
    return Math.round(
      app.getAppMetrics().reduce((s, p) => s + (p.memory?.workingSetSize ?? 0), 0) / 1024
    )
  } catch {
    return 0
  }
}

// -1 until the baseline is taken. The first SAMPLE is not a change, and treating it as one made
// every session open with an invented `memory.changed from=0MB to=901MB`.
let memLast = -1
/** Claimed the moment the baseline is SCHEDULED — see logSessionInfo for why that matters. */
let baselineDone = false
/** Called once the renderer has reported in and the real figure has been written. */
const noteMemoryBaseline = (): void => {
  memLast = memoryTotalMb()
}

function startMemoryWatch(): void {
  let warned = false
  setInterval(() => {
    const total = memoryTotalMb()
    if (!total) return
    if (total > MEMORY_WARN_MB && !warned) {
      warned = true
      logEvent('WARN', 'memory.high', { total: `${total}MB`, threshold: `${MEMORY_WARN_MB}MB` })
    } else if (total < MEMORY_WARN_MB * 0.8) warned = false
    if (memLast < 0) {
      memLast = total // no baseline yet (renderer never reported) — take one, silently
      return
    }
    if (Math.abs(total - memLast) >= MEMORY_STEP_MB) {
      logEvent('INFO', 'memory.changed', { from: `${memLast}MB`, to: `${total}MB` })
      memLast = total
    }
  }, MEMORY_SAMPLE_MS).unref?.()
}

/**
 * What the renderer was doing, for the `context` line of an error report.
 *
 * A failure inside a save is a different bug depending on which map was open and which tool was
 * live, and main can see none of it — so an `ipc:*` report, which is the most common kind there is,
 * used to carry a file name and nothing else. But main already RECEIVES every one of these: they
 * cross the bridge as ordinary events anyway, so remembering the last value of each costs one
 * assignment and adds no channel, no call site and nothing for a future event to remember to do.
 */
const UI_KEYS: Record<string, string> = {
  'map.changed': 'map',
  'tool.changed': 'tool',
  'feature.selected': 'feature',
  'map.zoomed': 'zoom'
}
const ui: Record<string, string> = {}
function noteUiState(scope: string, data: Record<string, unknown> | undefined): void {
  const key = UI_KEYS[scope]
  const v = key ? data?.[key] : undefined
  if (v != null) ui[key] = String(v).slice(0, 40)
}

/**
 * Help ▸ the three legal documents. They are `extraFiles`, so they sit BESIDE the exe rather than
 * inside the asar — which is the point: the portable ZIP has no installer to show a terms page, so
 * for that half of the users this menu and the file in the folder are the only copy there is.
 *
 * The name is a literal from the caller and never crosses IPC; nothing here takes a path from the
 * renderer. In development the files are at the repo root, which is what getAppPath returns before
 * packaging — packaged it would be the asar itself, so the two cases differ.
 */
function openLegal(
  name: 'TERMS.txt' | 'PRIVACY.txt' | 'THIRD-PARTY-NOTICES.txt' | 'ALPHA-README.txt'
): void {
  // These live in a `legal/` folder now (both in the repo and in what ships — see
  // electron-builder.yml's extraFiles), kept separate from `name` itself so the message below
  // still names just the file, not its folder.
  const file = is.dev
    ? join(app.getAppPath(), 'legal', name)
    : join(dirname(app.getPath('exe')), 'legal', name)
  if (!existsSync(file)) {
    // Worth saying rather than doing nothing: an empty click on a legal document reads as the app
    // hiding it, and the realistic cause is a portable copy where only the exe was moved.
    dialog.showMessageBoxSync({
      type: 'warning',
      message: `${name} was not found.`,
      detail:
        'It should be in the "legal" folder next to the application. If this is a portable copy, move the whole folder.'
    })
    return
  }
  void shell.openPath(file)
}

/** Help > Open Error Log, and the same call behind Preferences ▸ Open Log Folder.
 *  Reveals THIS session's file selected rather than opening a folder of 200 sorted by name — the
 *  file a user is being asked for is the run they are in, and picking it out of the list is the
 *  step where the wrong one gets sent. Flush first: the buffered tail is the part that matters.
 *  The folder now always exists (every session writes one), so the fallbacks only speak when the
 *  log itself could not be written. */
function openLogs(): void {
  flushLog()
  const f = logFile()
  if (f && existsSync(f)) {
    shell.showItemInFolder(f)
    return
  }
  if (existsSync(logPath())) {
    void shell.openPath(logPath())
    return
  }
  dialog.showMessageBoxSync(mainWindow!, {
    type: 'info',
    title: ml('Open Error Log'),
    message: ml('No log could be written.'),
    detail: ml('Check that the Worldbuilder folder in Documents can be written to.')
  })
}

/** openWorldFile + the "that file is not a world" dialog. Returns false when nothing was opened.
 *  unpackWorld validates before it touches anything, so a false here means the session the user
 *  already had is still intact and open. */
function openGuarded(path: string): boolean {
  const done = logTime('project.open', { file: basename(path) })
  try {
    openWorldFile(path)
    // Measured AFTER the open, so the counts describe the world that was just loaded rather than
    // the one being replaced.
    done(worldStats())
    return true
  } catch (err) {
    const code = err instanceof Error ? err.message : ''
    const notWorld = code === NOT_A_WORLD
    // No parent at startup — the window does not exist yet when a double-clicked file fails.
    const opts = {
      type: 'error',
      title: ml('Open Project…'),
      message: notWorld
        ? ml('That file is not a world file.')
        : code === WORLD_TOO_LARGE
          ? ml('That world file carries far more images than a world should.')
          : code === WORLD_TOO_NEW
            ? ml('That world was saved by a newer version of this app. Update before opening it.')
            : ml('That world file could not be opened.'),
      detail: basename(path)
    } as const
    if (mainWindow) dialog.showMessageBoxSync(mainWindow, opts)
    else dialog.showMessageBoxSync(opts)
    return false
  }
}

// "New": same path as the blank launch — the current working copy is packed into backups/ as a
// .world, then the schema is emptied. The unsaved-changes confirm lives in the renderer.
// File > Close Project runs this too: in this app there is no third state where a project is
// closed but the working copy still holds it, so "close" and "new" land in the same place.
function newProject(): void {
  const done = logTime('project.new')
  if (hasContent()) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    // A session that was never saved is otherwise a file nobody knows to look for: recoverable in
    // principle, invisible in practice. findPreviousSession() is what makes "closed without
    // saving" a click on the start screen instead of a support request — see HANDOFF/the alpha
    // readiness report, finding B-2. NOT addRecent: this is not a file the user named or chose,
    // it is a system snapshot, and mixing it into Recent (a) reads as clutter next to worlds the
    // user actually saved and (b) would compete with them for Recent's 12-entry cap. It gets its
    // own start-screen section instead, computed live from backups/ rather than persisted.
    packWorld(join(DATA_DIR, 'backups', `last-session-${stamp}.world`))
    logEvent('INFO', 'project.autobacked', { reason: 'previous session had content' })
  }
  resetWorld()
  // A blank world with one map already waiting, so the renderer can land straight on it instead
  // of the start screen. Called directly, never through the 'api' IPC channel, so this does not
  // touch `dirty` — the world must still read as untouched the moment it opens. See hasContent().
  dbApi.createMap({ name: ml('New map') })
  currentFile = null
  dirty = false
  updateTitle()
  done()
  mainWindow?.webContents.reload()
}

// --- Application menu ---------------------------------------------------------------------
// Menu clicks are FORWARDED to the renderer over one 'menu' channel instead of being executed
// here, so every command keeps a single implementation — the function the UI already calls,
// including its unsaved-changes confirm. The mirror image of the single 'api' channel.
const send = (cmd: string): void => mainWindow?.webContents.send('menu', cmd)

// Main cannot import the renderer's i18n.tsx (a React module), so menu labels carry their own
// small dictionary. English text is the key here too, same convention as i18n.tsx.
const MENU_TR: Record<string, string> = {
  File: 'Dosya',
  Edit: 'Düzen',
  View: 'Görünüm',
  Help: 'Yardım',
  'New Project': 'Yeni Proje',
  'Open Project…': 'Proje Aç…',
  'That file is not a world file.': 'Bu dosya bir dünya dosyası değil.',
  'That world file could not be opened.': 'Bu dünya dosyası açılamadı.',
  'That world file carries far more images than a world should.':
    'Bu dünya dosyası bir dünyada olması gerekenden çok daha fazla görsel taşıyor.',
  'Open Recent': 'Son Kullanılanlar',
  '(empty)': '(boş)',
  'Previous session': 'Önceki oturum',
  Save: 'Kaydet',
  'Save As…': 'Farklı Kaydet…',
  Export: 'Dışa Aktar',
  'Current Map as Image…': 'Geçerli Haritayı Görsel Olarak…',
  'Notes…': 'Notlar…',
  'Back Up Now': 'Şimdi Yedekle',
  'Close Project': 'Projeyi Kapat',
  Exit: 'Çıkış',
  Undo: 'Geri Al',
  Redo: 'Yinele',
  Preferences: 'Tercihler',
  Maps: 'Haritalar',
  // Used once, when a blank session's first map is seeded directly by main — see newProject and
  // the launch sequence. Kept in sync with i18n.tsx's own 'New map' entry by hand; the two never
  // read from one another (main cannot import the renderer's i18n module).
  'New map': 'Yeni harita',
  Overview: 'Genel Bakış',
  'Hide Panels': 'Panelleri Gizle',
  'Hide Panels, Keep Tools': 'Panelleri Gizle, Araçlar Kalsın',
  Atlas: 'Atlas',
  Chronology: 'Kronoloji',
  Relations: 'İlişkiler',
  'Project Preferences': 'Proje Tercihleri',
  'Zoom In': 'Yakınlaştır',
  'Zoom Out': 'Uzaklaştır',
  'Reset Zoom': 'Yakınlaştırmayı Sıfırla',
  'Keyboard Shortcuts': 'Klavye Kısayolları',
  'Open Error Log': 'Hata Kaydını Aç',
  'Alpha Notes': 'Alfa Notları',
  'Terms of Use': 'Kullanım Şartları',
  'Privacy Policy': 'Gizlilik Politikası',
  'Third-Party Notices': 'Üçüncü Taraf Bildirimleri',
  'No log could be written.': 'Kayıt dosyası yazılamadı.',
  'Check that the Worldbuilder folder in Documents can be written to.':
    'Belgeler içindeki Worldbuilder klasörünün yazılabilir olduğunu kontrol edin.'
}
const ml = (s: string): string => (readPrefs().language === 'tr' ? (MENU_TR[s] ?? s) : s)

/** Every other Recent entry is a name the USER chose when they saved. `last-session-<stamp>.world`
 *  is the one kind nobody named — it exists so a session closed without saving is not invisible
 *  (see newProject / the blank-launch branch) — and showing its raw ISO filename there reads as a
 *  bug even though the file itself is fine. This gives it a label instead. */
const LAST_SESSION_RE = /^last-session-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.world$/
const pad2 = (n: number): string => String(n).padStart(2, '0')
const recentDisplayName = (path: string): string => {
  const base = basename(path)
  const m = LAST_SESSION_RE.exec(base)
  if (!m) return base
  const d = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`)
  if (isNaN(d.getTime())) return base // a stamp that fails to parse is not worth failing over
  return (
    `${ml('Previous session')} — ${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.` +
    `${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  )
}

/** The most recent unsaved-session snapshot, or null. Computed live from backups/ rather than
 *  persisted anywhere — there is nothing to keep in sync, and the file itself is the only source
 *  of truth. Filenames sort chronologically as text (same property the log's fileStamp relies on),
 *  so the last one alphabetically is the newest; no stat() needed. */
function findPreviousSession(): { path: string; name: string } | null {
  let files: string[]
  try {
    files = readdirSync(join(DATA_DIR, 'backups')).filter((f) => LAST_SESSION_RE.test(f))
  } catch {
    return null // no backups/ folder yet (very first launch) — nothing to show, not an error
  }
  if (!files.length) return null
  const full = join(DATA_DIR, 'backups', files.sort().at(-1)!)
  return { path: full, name: recentDisplayName(full) }
}

function buildMenu(): void {
  const recent = readRecent()
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: ml('File'),
        submenu: [
          { label: ml('New Project'), accelerator: 'CmdOrCtrl+N', click: () => send('file.new') },
          {
            label: ml('Open Project…'),
            accelerator: 'CmdOrCtrl+O',
            click: () => send('file.open')
          },
          {
            label: ml('Open Recent'),
            submenu: recent.length
              ? recent.map((p) => ({ label: basename(p), click: () => send(`file.recent:${p}`) }))
              : [{ label: ml('(empty)'), enabled: false }]
          },
          { type: 'separator' },
          { label: ml('Save'), accelerator: 'CmdOrCtrl+S', click: () => send('file.save') },
          {
            label: ml('Save As…'),
            accelerator: 'CmdOrCtrl+Shift+S',
            click: () => send('file.saveAs')
          },
          { type: 'separator' },
          {
            label: ml('Export'),
            submenu: [
              { label: ml('Current Map as Image…'), click: () => send('file.exportMap') },
              { label: ml('Notes…'), click: () => send('file.exportNotes') }
            ]
          },
          { label: ml('Back Up Now'), click: () => send('file.backup') },
          { type: 'separator' },
          { label: ml('Close Project'), click: () => send('file.close') },
          { role: 'quit', label: ml('Exit') }
        ]
      },
      {
        label: ml('Edit'),
        // registerAccelerator:false — the label advertises the key but the binding stays with the
        // renderer's typing-guarded handler. Registered here, Ctrl+Z inside a note textarea would
        // undo the WORLD instead of the text.
        submenu: [
          {
            label: ml('Undo'),
            accelerator: 'CmdOrCtrl+Z',
            registerAccelerator: false,
            click: () => send('edit.undo')
          },
          {
            label: ml('Redo'),
            accelerator: 'CmdOrCtrl+Shift+Z',
            registerAccelerator: false,
            click: () => send('edit.redo')
          },
          { type: 'separator' },
          { label: ml('Preferences'), click: () => send('edit.prefs') }
        ]
      },
      {
        label: ml('View'),
        submenu: [
          // Tab / Shift+Tab hide the panels. registerAccelerator:false — Tab is the focus key, and
          // registering it natively would kill keyboard navigation in every input on the page.
          // The renderer owns the key and skips it while a form control has focus.
          {
            label: ml('Hide Panels'),
            accelerator: 'Tab',
            registerAccelerator: false,
            click: () => send('view.togglePanels')
          },
          {
            label: ml('Hide Panels, Keep Tools'),
            accelerator: 'Shift+Tab',
            registerAccelerator: false,
            click: () => send('view.togglePanelsKeepTools')
          },
          { type: 'separator' },
          { label: ml('Maps'), click: () => send('view.maps') },
          {
            label: ml('Overview'),
            submenu: [
              { label: ml('Atlas'), click: () => send('view.overview:atlas') },
              { label: ml('Chronology'), click: () => send('view.overview:chronology') },
              { label: ml('Relations'), click: () => send('view.overview:relations') }
            ]
          },
          { type: 'separator' },
          // The keyboard half of the interface scale, because every app that has this setting
          // also has these three keys and people reach for them before they open Preferences.
          // Handled HERE rather than forwarded to the renderer: main owns both the window and
          // prefs.json, so a round trip would only add a way for them to disagree.
          {
            label: ml('Zoom In'),
            accelerator: 'CommandOrControl+=',
            click: () => stepUiScale(1)
          },
          {
            label: ml('Zoom Out'),
            accelerator: 'CommandOrControl+-',
            click: () => stepUiScale(-1)
          },
          {
            label: ml('Reset Zoom'),
            accelerator: 'CommandOrControl+0',
            click: () => setUiScaleTo(100)
          },
          { type: 'separator' },
          { label: ml('Project Preferences'), click: () => send('view.projectPrefs') }
        ]
      },
      {
        label: ml('Help'),
        submenu: [
          {
            label: ml('Keyboard Shortcuts'),
            accelerator: 'F1',
            click: () => send('help.shortcuts')
          },
          { type: 'separator' },
          { label: ml('Alpha Notes'), click: () => openLegal('ALPHA-README.txt') },
          { label: ml('Terms of Use'), click: () => openLegal('TERMS.txt') },
          { label: ml('Privacy Policy'), click: () => openLegal('PRIVACY.txt') },
          { label: ml('Third-Party Notices'), click: () => openLegal('THIRD-PARTY-NOTICES.txt') },
          { type: 'separator' },
          { label: ml('Open Error Log'), click: openLogs }
        ]
      }
    ])
  )
}

// `...dbApi` is the whole renderer surface, and it is safe to spread wholesale because the one
// method that takes a filesystem path from its caller — importAsset — is not on that object at
// all. It is imported separately below, for pickImage, where the USER chooses the file. See its
// note in db.ts for why it is not simply stripped off here.
const mainApi = {
  ...dbApi,
  // Dumps notes into the .txt tree + opens the folder for browsing (button-triggered, one-way)
  exportNotes: async (): Promise<{ path: string; files: number; skipped: number }> => {
    const r = dbApi.exportNotes()
    await shell.openPath(r.path)
    return r
  },
  saveWorld: (): Promise<string | null> => saveWorld(false),
  saveWorldAs: (): Promise<string | null> => saveWorld(true),
  worldInfo: (): { file: string | null; dirty: boolean } => ({ file: currentFile, dirty }),
  // 'appVersion', not 'getVersion' — a `get*` name reads fine but the point is only that it must
  // NOT match MUTATES (create|update|delete|add|set|restore|retype|import|pick); this avoids the
  // question rather than relying on a prefix quirk.
  appVersion: (): string => app.getVersion(),
  // Pick + open a file. The unsaved-changes confirm lives in the RENDERER (asked via worldInfo)
  // — here it is just pick + open. The returned path signals "reload" to the renderer.
  async openWorld(): Promise<string | null> {
    const r = await dialog.showOpenDialog(mainWindow!, {
      filters: [{ name: APP_NAME, extensions: ['world', 'dunya'] }],
      properties: ['openFile']
    })
    if (r.canceled || !r.filePaths[0]) return null
    // A file that is not one of our worlds is a normal thing for a user to pick (the filter is
    // only a hint, and Windows lets any name end in .world). Say so and leave the open world
    // alone — unpackWorld has already guaranteed nothing was touched.
    if (!openGuarded(r.filePaths[0])) return null
    // Reload from MAIN: window.location.reload() in the renderer hit the will-navigate
    // security block and shipped the URL to the external browser (webContents.reload does not)
    mainWindow?.webContents.reload()
    return r.filePaths[0]
  },
  // Start screen: recent worlds. 'missing' = the file was moved/deleted —
  // the row stays listed (the user dismisses it with ×), it is not silently dropped.
  recentWorlds: (): { path: string; name: string; missing: boolean }[] =>
    readRecent().map((p) => ({ path: p, name: recentDisplayName(p), missing: !existsSync(p) })),
  forgetRecent: (path: string): void => writeRecent(readRecent().filter((p) => p !== path)),
  // Open from the list. A missing file stays listed (so the user sees it) and returns false.
  // ONLY paths recorded in recent.json can be opened: a path arriving over IPC is untrusted —
  // a compromised renderer must not be able to open an arbitrary file over the working copy
  // (the dialog-based openWorld is exempt: there the user picks the path, not the renderer).
  openRecent(path: string): boolean {
    if (!readRecent().includes(path) || !existsSync(path)) return false
    if (!openGuarded(path)) return false // a recent entry can go bad on disk after it was listed
    mainWindow?.webContents.reload()
    return true
  },
  // Start screen, its own section above Recent: the most recent session closed without saving —
  // see findPreviousSession(). Deliberately separate from recentWorlds(): this is not a file the
  // user named, and showing it there read as clutter next to worlds they actually chose to save.
  previousSession: (): { path: string; name: string } | null => findPreviousSession(),
  // No path argument, unlike openRecent — main recomputes which file this is rather than trusting
  // one from the renderer, so there is no list for a compromised renderer to have tampered with.
  openPreviousSession(): boolean {
    const p = findPreviousSession()
    if (!p || !openGuarded(p.path)) return false
    mainWindow?.webContents.reload()
    return true
  },
  newWorld: newProject,
  // Same function on purpose (see newProject) — a separate command because that is where users
  // look for it, not because the behaviour differs.
  closeWorld: newProject,
  // Application preferences, per-machine. The 'save' prefix is deliberate: 'set*' would match the
  // dirty-flag regex in the IPC dispatch below, so switching theme would mark the world unsaved.
  // The renderer's channel into the same file. Named 'log*' on purpose: it must not match the
  // dirty-flag regex above — reporting an error is not a change to the world.
  logRendererError(
    where: string,
    message: string,
    stack: string,
    ctx: Record<string, unknown>
  ): void {
    logError(`renderer:${String(where).slice(0, 60)}`, { message, stack }, ctx)
  },
  /**
   * Renderer events, in batches. A batch and not one call per event: the bridge is a round trip
   * and events arrive in bursts, so per-event calls would turn a log into a source of the very
   * stutter it exists to find. The renderer holds them for BATCH_MS (see thresholds.ts).
   *
   * Everything here is untrusted — it crosses from a renderer that may be running a hostile
   * `.world`'s content — so the level is validated against the four known values rather than
   * written through, and every field is clipped downstream in format.ts.
   */
  logEvents(
    batch: { level: string; scope: string; data?: Record<string, unknown>; at?: number }[]
  ): void {
    if (!Array.isArray(batch)) return
    for (const e of batch.slice(0, 200)) {
      const level = (['INFO', 'WARN', 'ERROR', 'DEBUG'] as const).find((l) => l === e?.level)
      if (!level || typeof e.scope !== 'string') continue
      noteUiState(e.scope, e.data)
      // The renderer's own stamp, so a batch does not collapse into one instant. Sanity-checked
      // rather than trusted: it crosses from a renderer that may be running hostile content, and
      // a nonsense date would make the whole file unreadable.
      const at =
        typeof e.at === 'number' && Math.abs(Date.now() - e.at) < 60_000
          ? new Date(e.at)
          : undefined
      logEvent(level as Level, e.scope.slice(0, 40), e.data ?? {}, at)
    }
  },
  /** What only the renderer knows about the session — GPU backend, screen, its own versions. */
  logSessionInfo(info: Record<string, unknown>): void {
    logEvent('INFO', 'renderer.ready', info ?? {})
    // The app's real weight, recorded once, here. The header's figure is the main process alone —
    // at startup the renderer and GPU processes do not exist yet — and the sampler only speaks when
    // memory MOVES, so a short session could open at 63MB, close at 813MB and say nothing in
    // between. This is the line that answers "what does this world cost on this machine".
    // ONCE per session, not per renderer. Opening a project reloads the renderer, so this fires
    // again — and a second line calling itself a baseline is not one. Later movement is the
    // sampler's job, and it does it: the first log to carry this showed 418MB → 866MB correctly.
    //
    // The slot is claimed HERE, not inside the timer. Guarding on the result of the timer was the
    // same bug in a slower disguise: two renderer.ready 1.2s apart both passed the test and both
    // scheduled, because neither had written anything yet when the other looked.
    if (!baselineDone) {
      baselineDone = true
      setTimeout(() => {
        const m = memoryFields()
        if (!m.total) {
          baselineDone = false // nothing measured — let the next renderer try
          return
        }
        logEvent('INFO', 'memory.baseline', m)
        noteMemoryBaseline()
      }, 2000)
    }
  },
  openLogFolder: (): void => openLogs(),
  getPrefs: (): Prefs => readPrefs(),
  savePrefs(patch: Prefs): void {
    // Allow-listed, the same way patchSql treats an UPDATE: everything arriving over the bridge is
    // untrusted, and this one writes a file that is read back and spread into the app on every
    // launch. Without the filter a renderer running a hostile world could put anything of any size
    // in there — including a key a later version starts trusting.
    //
    // THE COST, AND IT IS REAL: a new preference has to be added here as well as to `Prefs`, or it
    // will be dropped on the way to disk and look like a setting that does not stick. That is the
    // trade an allow-list always makes, and it is the right way round — a forgotten line here
    // fails visibly, while the alternative fails silently and only for someone else.
    const keep: Prefs = {}
    if (typeof patch?.language === 'string') keep.language = patch.language.slice(0, 8)
    if (typeof patch?.theme === 'string') keep.theme = patch.theme.slice(0, 32)
    // Widths are clamped rather than merely typed: the panes read them straight back as pixels,
    // and a NaN or a negative would land in a style attribute.
    const px = (v: unknown): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) ? Math.min(2000, Math.max(120, v)) : undefined
    const sw = px(patch?.sidebarWidth)
    const mw = px(patch?.mapPanelWidth)
    if (sw !== undefined) keep.sidebarWidth = sw
    if (mw !== undefined) keep.mapPanelWidth = mw
    if (typeof patch?.debugLog === 'boolean') keep.debugLog = patch.debugLog
    // Clamped for the same reason the widths are, and harder: this one goes to the window itself.
    // Below ~50 the menu bar stops being clickable and above ~250 the map toolbar does not fit,
    // and neither is recoverable from inside an app you can no longer read.
    if (typeof patch?.uiScale === 'number' && Number.isFinite(patch.uiScale))
      keep.uiScale = Math.min(250, Math.max(50, Math.round(patch.uiScale)))
    writePrefs({ ...readPrefs(), ...keep })
    if (keep.debugLog !== undefined) logSetDebug(keep.debugLog === true)
    if (keep.uiScale !== undefined) applyUiScale(keep.uiScale)
    buildMenu() // menu labels follow the language
  },
  async pickImage(): Promise<string | null> {
    const r = await dialog.showOpenDialog({
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      properties: ['openFile']
    })
    if (r.canceled || !r.filePaths[0]) return null
    return importAsset(r.filePaths[0])
  },
  // Exports what is on screen (rect: CSS pixels, the .leaflet-host bounds) as a PNG.
  // Export, as opposed to save: not editable, a one-way sharing artifact.
  async exportMapImage(
    rect: { x: number; y: number; width: number; height: number },
    defaultName: string
  ): Promise<string | null> {
    if (!mainWindow) return null
    // basename: the name comes from the renderer and only ever names a map. A path in it would
    // silently move where the dialog opens — the user still has to accept it, but a save dialog
    // that opens somewhere the user did not choose is exactly the kind of nudge worth removing.
    const r = await dialog.showSaveDialog(mainWindow, {
      defaultPath: `${basename(String(defaultName ?? 'map')).slice(0, 80) || 'map'}.png`,
      filters: [{ name: 'PNG', extensions: ['png'] }]
    })
    if (r.canceled || !r.filePath) return null
    // The rect is CSS pixels from the renderer's own getBoundingClientRect. Sanity-checked
    // because it is handed to the compositor: a NaN takes the capture out, and an enormous one
    // asks the GPU process for a bitmap the size of the number.
    const n = (v: unknown, max: number): number =>
      typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(0, Math.round(v))) : 0
    const [winW, winH] = mainWindow.getContentSize()
    const safeRect = {
      x: n(rect?.x, winW),
      y: n(rect?.y, winH),
      width: n(rect?.width, winW),
      height: n(rect?.height, winH)
    }
    if (!safeRect.width || !safeRect.height) return null
    const image = await mainWindow.webContents.capturePage(safeRect)
    await writeFile(r.filePath, image.toPNG())
    return r.filePath
  }
}

/**
 * The guarantees that must hold for EVERY web contents, not for the one window we happen to make.
 *
 * These three rules used to be attached inside createWindow, which made them a property of that
 * call rather than of the app: a second window, a devtools-hosted page, anything created later
 * would have come up without them, and nothing would have said so. Bound at the app level they
 * are structural — a new window inherits them by existing.
 *
 * - Navigation: the window can never leave the app. A link in a note that hijacked the window
 *   would be running with `window.api` in reach, which is the whole database.
 * - Opening: `window.open` is denied outright; http(s) is handed to the real browser and
 *   everything else (file:, javascript:, world:) is dropped — `shell.openExternal` will happily
 *   launch what it is given, so the filter has to be here, not in the browser.
 * - Permissions: the app uses none of them. Both handlers are set, and that is the point of this
 *   pass: `setPermissionRequestHandler` only covers the asking path, while a synchronous
 *   `permission check` (what `navigator.permissions.query` and several Blink call sites use) goes
 *   through the OTHER handler, which defaults to permissive. Device permissions (USB/HID/serial)
 *   are a third door and are shut here too.
 */
function hardenWebContents(): void {
  // In DEV the renderer is served over http by electron-vite, which makes the app's OWN address
  // look to this guard exactly like a link leading out of it. So Vite's full reload — what its HMR
  // client falls back to for any edit it cannot apply hot, which is most edits to a module that
  // does not export a component — was preventDefault()ed and handed to the real browser: a tab in
  // the user's default browser per edit, each one the renderer with no preload behind it, i.e. the
  // "This world could not be opened" screen. The comment on `openWorldFile`'s reload records half
  // of this (a renderer-side `location.reload()` going out the same door, worked around there by
  // reloading from main) without noticing that HMR knocks on it too.
  //
  // `ELECTRON_RENDERER_URL` is set by electron-vite in dev and is UNDEFINED in a packaged build,
  // where the renderer is `file://` and every http(s) URL really is external. So the allowance
  // does not exist in the shipped app rather than being switched off there — the rule the dev-only
  // CSP widening follows with `apply: 'serve'`, and the reason this is written as an origin taken
  // from the environment instead of a `localhost` pattern.
  const devOrigin = ((): string | null => {
    const raw = process.env['ELECTRON_RENDERER_URL']
    if (!raw) return null
    try {
      return new URL(raw).origin
    } catch {
      return null
    }
  })()
  const isOwnDevOrigin = (url: string): boolean => {
    if (!devOrigin) return false
    try {
      return new URL(url).origin === devOrigin
    } catch {
      return false
    }
  }
  const openSafe = (url: string): void => {
    if (isOwnDevOrigin(url)) return // never hand our own dev server to the browser
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
  }
  app.on('web-contents-created', (_e, wc) => {
    // window.open stays denied for the dev origin too: a reload is a navigation, not a new window.
    wc.setWindowOpenHandler((details) => {
      openSafe(details.url)
      return { action: 'deny' }
    })
    wc.on('will-navigate', (e, url) => {
      // Reloading ourselves is not leaving the app, so it is allowed to proceed. Everything else
      // is stopped exactly as before — the window still can never navigate away.
      if (isOwnDevOrigin(url)) return
      e.preventDefault()
      openSafe(url)
    })
  })
  const s = session.defaultSession
  s.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  s.setPermissionCheckHandler(() => false)
  s.setDevicePermissionHandler(() => false)
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    // The map's chrome does not reflow, and below roughly this it stops being a map. The floats
    // are absolutely positioned inside the map host and cost a fixed 480px (the timeline strip's
    // own min-width) + 260 (the hierarchy panel) + 252 (the tool popover) + 46 (the toolbar)
    // against a 280px inspector and a 180px sidebar. The entity page is the one screen that DOES
    // reflow — it drops to a single column at 1100 — so this floor is set by the map, which is
    // where the work happens. 640 tall keeps the timeline strip and the zoom HUD off each other.
    minWidth: 1024,
    minHeight: 640,
    show: false,
    autoHideMenuBar: false, // the File/Edit/View/Help menu is the app's command surface
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      // OFF, and it is the only outbound request this app would ever make. Electron's spellchecker
      // is hunspell with dictionaries FETCHED from Google's CDN the first time a language is used
      // — a network call the CSP does not govern (it happens below the page), that nobody asked
      // for, in an app whose whole pitch is that it is local. An alpha tester watching their
      // firewall would be right to ask.
      //
      // It also has nothing to offer here. This world runs on two invented languages and a few
      // hundred invented names; a spellchecker would underline nearly every proper noun in the
      // app. If it is ever wanted, it belongs behind a preference that says what it downloads.
      spellcheck: false
    }
  })
  mainWindow = win

  win.on('ready-to-show', () => {
    win.show()
  })

  // On EVERY load, not once at startup: Chromium resets the zoom factor on navigation, and this
  // app reloads the renderer whenever a world is opened, created or closed (webContents.reload).
  // Set once and the user's scale would silently go back to 100% the first time they opened a
  // file — which reads as the preference not sticking.
  win.webContents.on('did-finish-load', () => {
    const s = readPrefs().uiScale
    if (s) applyUiScale(s)
  })

  // Close guard while dirty: Save / Don't Save / Cancel
  win.on('close', (e) => {
    if (!dirty) return
    const r = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Save', "Don't Save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      message: 'There are unsaved changes. Save before closing?'
    })
    if (r === 2) {
      e.preventDefault()
      return
    }
    if (r === 0) {
      let target = currentFile
      if (!target) {
        target =
          dialog.showSaveDialogSync(win, {
            defaultPath: join(DOCS, 'my-world.world'),
            filters: [{ name: APP_NAME, extensions: ['world'] }]
          }) ?? null
        if (!target) {
          e.preventDefault() // no location picked → cancel the close
          return
        }
      }
      // GUARDED, because this is the last moment the work exists as the user left it. A throw here
      // never called preventDefault, so the exception went out through the close listener and the
      // window shut anyway: they clicked Save, saw nothing, and the file on disk was the old one.
      // Every realistic cause is ordinary — a full disk, a target on a USB stick that has been
      // pulled, a folder OneDrive or an antivirus has locked. (The file itself is never half
      // written: packWorld renames a finished temp copy into place.)
      //
      // Refusing to close is what every document app does when a save fails, and it is the only
      // answer that keeps the work reachable: the session is still open, so Save As to somewhere
      // else is one keystroke away.
      try {
        packWorld(target)
        currentFile = target
        dirty = false
        // The save path does this and the close path did not, so a world saved on the way out
        // never appeared on the start screen next launch.
        addRecent(target)
        updateTitle()
      } catch (err) {
        logError('main:closeSave', err)
        e.preventDefault()
        dialog.showMessageBoxSync(win, {
          type: 'error',
          title: APP_NAME,
          message: 'Could not save, so the app has not closed.',
          detail:
            `${err instanceof Error ? err.message : String(err)}

` + 'Nothing is lost — the world is still open. Try Save As to a different folder.'
        })
        return
      }
    }
  })

  // A renderer that DIES writes nothing on its way out: the file simply stops mid-session, which
  // is the one case where a log is needed most and present least. `oom` is why this is here at all
  // — a world heavy enough to exhaust the renderer is this app's most likely real crash, and it
  // leaves the user with a white window and us with a file that just ends. clean-exit is the
  // ordinary quit and must stay silent, or every close would file an error report.
  win.webContents.on('render-process-gone', (_e, d) => {
    if (d.reason === 'clean-exit') return
    logError('main:render-process-gone', `renderer ${d.reason}`, { exit: d.exitCode })
  })
  // Not a crash — a freeze. The user sees the same thing, so the log should be able to tell them
  // apart afterwards.
  win.webContents.on('unresponsive', () => logEvent('WARN', 'window.unresponsive'))
  win.webContents.on('responsive', () => logEvent('INFO', 'window.responsive'))
  // Without this a broken preload is an app with no window.api: every screen empty, nothing thrown
  // anywhere the app can see, and no line anywhere saying why.
  win.webContents.on('preload-error', (_e, p, err) =>
    logError('main:preload', err, { preload: basename(p) })
  )

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// The window asks for `sandbox: true` itself; this makes it the DEFAULT for every renderer the
// app will ever create, so a future window that forgets the flag is still sandboxed. Must run
// before ready, which is why it sits at module level rather than in the whenReady block.
app.enableSandbox()

// Single instance: double-clicking a .world while the app is open switches the existing
// window to that world instead of spawning a second one (confirm first when dirty).
//
// `app.exit(0)`, NOT `app.quit()`. quit() asks politely and returns: the module keeps running,
// `whenReady` below still fires, and the losing instance walks the whole startup sequence against
// the WINNER's live data — `initDb` runs the schema and `migrateLegacyKeys`' UPDATEs into a
// database another process has open, `packWorld` snapshots it, and then `resetWorld` DELETES
// world.db and empties assets/. Today that last step usually fails with EBUSY (node:sqlite holds
// the file without share-delete) and becomes a startupWarning — which is how it was found, in
// the comment that names it inside whenReady. Landing on EBUSY is luck, not a design, and two
// processes writing one SQLite file is the kind of corruption that is discovered much later.
//
// exit() terminates now: no ready event, no handlers, nothing touched. There is nothing to flush
// either — initLog has not run yet. Electron has already handed our argv to the first instance by
// the time the lock comes back false, so the double-clicked file still opens, over there.
if (!app.requestSingleInstanceLock()) app.exit(0)
app.on('second-instance', (_e, argv) => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
  const path = worldArg(argv)
  if (!path) return
  if (dirty) {
    const r = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Open (discard changes)', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'There are unsaved changes. Opening another world will discard them.'
    })
    if (r !== 0) return
  }
  if (!openGuarded(path)) return
  mainWindow.webContents.reload()
})

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.worldbuilding.app')
  hardenWebContents() // before any window exists, so the first one is covered by the same rules

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  adoptLegacyDataDir() // adopt the old Documents\D\u00fcnya folder (BEFORE initDb)
  // Before initDb, so a failure inside it is already reportable. The context callback is what an
  // error report fills its `context` line from: main answers for the file, the renderer sends the
  // rest (map, tool, selection, zoom) with each report.
  initLog(
    DATA_DIR,
    app.getVersion(),
    () => ({ file: currentFile ? basename(currentFile) : null, dirty, ...ui }),
    { memory: memoryLine() }
  )
  // app.started FIRST: setDebug writes a line of its own, and having it above the line that says
  // the app started reads as though the log began mid-sentence.
  logEvent('INFO', 'app.started', { packaged: app.isPackaged, locale: app.getLocale() })
  logSetDebug(readPrefs().debugLog === true)
  startMemoryWatch()
  // Last resort: anything that escapes every handler still reaches the file rather than a
  // console nobody is watching in a packaged app.
  process.on('uncaughtException', (err) => logError('main:uncaught', err))
  process.on('unhandledRejection', (err) => logError('main:unhandledRejection', err))
  // The GPU process, most of all: it dying is exactly what a report of "the map went blank" is,
  // and it takes no JS with it, so nothing else in the app would ever notice.
  app.on('child-process-gone', (_e, d) =>
    logError('main:child-process-gone', `${d.type} ${d.reason}`, {
      name: d.name,
      exit: d.exitCode
    })
  )
  // The one startup step with no best-effort fallback: without a database there is no app. It sat
  // OUTSIDE the try below, which is the same silent death that block was written to end — a throw
  // here escaped into the unhandled-rejection void before any window existed, Electron saw zero
  // windows and quit with code 0, and the app simply never appeared. Nothing on screen, and the
  // log line nobody knows to look for.
  //
  // Every realistic cause is outside our control: Documents held open by OneDrive or an antivirus,
  // a disk with nothing left, a world.db truncated by a power cut mid-write. In all of them the
  // user's work is still sitting in backups/ — which they will never think to look in if the app
  // just fails to launch. So the app still cannot start, but it says why, and where the copies are.
  try {
    initDb(DATA_DIR)
  } catch (err) {
    logError('main:initDb', err)
    flushLog()
    dialog.showMessageBoxSync({
      type: 'error',
      title: APP_NAME,
      message: 'The world could not be opened, so the app cannot start.',
      detail:
        `${err instanceof Error ? err.message : String(err)}\n\n` +
        `Dated copies of your world are kept in:\n${join(DATA_DIR, 'backups')}\n\n` +
        'If world.db itself is damaged: close the app, move it out of the folder above its ' +
        'backups folder, and copy one of those copies in its place under the name world.db.'
    })
    app.exit(1)
    return
  }
  adoptLegacyPrefs() // language/theme out of the settings table — BEFORE the resetWorld() below
  // Everything from here to createWindow() is best-effort. A throw used to escape into the
  // unhandled-rejection void BEFORE any window existed, so Electron saw zero windows and quit
  // with code 0 — the app simply never appeared, with nothing on screen to explain why.
  // Two real ways in: world.db locked by a second instance (EBUSY inside resetWorld), and a
  // corrupt .world passed on the command line, which is untrusted input by the security
  // contract. The renderer has ErrorBoundary for this class of failure; this is main's.
  try {
    backupIfNeeded() // daily dated copy of world.db — restore is manual (the backups/ folder)
    const arg = worldArg(process.argv)
    if (arg) {
      openGuarded(arg) // launch with the double-clicked file; a bad one just starts blank
    } else if (hasContent()) {
      // A normal launch is ALWAYS a blank document. The previous session's
      // working copy (images included) is packed into backups/ as a full .world — nothing is
      // lost even if it was never saved (subject to the 30-day backup pruning).
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      // NOT addRecent — see newProject() for why: findPreviousSession() surfaces this on its own,
      // separate from the worlds the user actually chose to save.
      packWorld(join(DATA_DIR, 'backups', `last-session-${stamp}.world`))
      resetWorld()
      dbApi.createMap({ name: ml('New map') }) // see newProject() — same reasoning
    } else if (!(dbApi.listMaps() as unknown[]).length) {
      // Not a reset, but still blank: the very first launch this app has ever had (a fresh
      // world.db, schema only, nothing seeded yet), or a blank session continuing from last time
      // that somehow lost its map. Either way the guarantee is unconditional — a blank session
      // always has exactly one map to land on.
      dbApi.createMap({ name: ml('New map') })
    }
  } catch (err) {
    startupWarning = err instanceof Error ? err.message : String(err)
  }

  // Register the .world extension to the CURRENT exe path on every launch (HKCU — no admin
  // needed): even the portable exe stays double-clickable wherever it is moved or renamed.
  // Disabled in dev (process.execPath would be electron.exe). Errors are swallowed.
  if (process.platform === 'win32' && !is.dev) {
    const reg = (args: string[]): void => {
      execFile('reg.exe', args, () => {})
    }
    // Both extensions point at the SAME ProgID, and that ProgID keeps its old name on purpose:
    // renaming it would leave every already-registered .dunya pointing at an entry that no longer
    // exists, and those files would stop opening on a double click.
    for (const ext of WORLD_EXT)
      reg(['add', `HKCU\\Software\\Classes\\${ext}`, '/ve', '/d', 'Dunya.World', '/f'])
    reg([
      'add',
      'HKCU\\Software\\Classes\\Dunya.World\\shell\\open\\command',
      '/ve',
      '/d',
      `"${process.execPath}" "%1"`,
      '/f'
    ])
    reg([
      'add',
      'HKCU\\Software\\Classes\\Dunya.World\\DefaultIcon',
      '/ve',
      '/d',
      `"${process.execPath}",0`,
      '/f'
    ])
  }

  protocol.handle('world', async (req) => {
    // A malformed percent-escape throws here, and a throw inside the handler is an unhandled
    // rejection rather than a failed request. `![](world://data/%)` in a note is enough to reach it.
    let rel: string
    try {
      rel = decodeURIComponent(new URL(req.url).pathname)
    } catch {
      return new Response('bad request', { status: 400 })
    }
    // The url is `world://data/assets/x.png`, so the path arrives with the `assets/` segment on
    // it and resolveAssetPath is given it relative to the data folder. Confinement, and the
    // reasoning for confining to assets/ rather than to DATA_DIR, live with the folder in db.ts —
    // where the self-check can assert them.
    // resolveAssetPath is pure path arithmetic and is not known to throw — but it sat outside every
    // guard in a handler whose whole documented hazard is that a throw here is an unhandled
    // REJECTION rather than a failed request. Being safe by inspection is not the same as being
    // safe by construction, and this is one line to make it the second.
    let full: string | null
    try {
      full = resolveAssetPath(rel)
    } catch {
      return new Response('bad request', { status: 400 })
    }
    if (!full) return new Response('forbidden', { status: 403 })
    // A world can outlive the image it names — pruneUnusedAssets removes what nothing referred to
    // at save time, and a world opened on another machine refers to files that were never here.
    // net.fetch REJECTS on a missing file, and a rejection inside a protocol handler is an
    // unhandled one; the request itself deserves an answer instead.
    let res: Response
    try {
      res = await net.fetch(pathToFileURL(full).toString())
    } catch {
      return new Response('not found', { status: 404 })
    }
    // A texture upload from an image of another origin is a security error in WebGL, and this
    // scheme IS another origin — that is what made a polygon's fill image render black instead of
    // showing. Answering the CORS request is what lets the upload through. It widens nothing: the
    // scheme is reachable only from this app's own renderer, and the path above is already
    // confined to the assets folder.
    const headers = new Headers(res.headers)
    headers.set('Access-Control-Allow-Origin', '*')
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
  })

  ipcMain.handle('api', (_e, method: string, ...args: unknown[]) => {
    // hasOwn: prototype members like 'constructor' must not count as methods
    if (!Object.hasOwn(mainApi, method)) throw new Error(`Bilinmeyen api metodu: ${method}`)
    const fn = (mainApi as Record<string, (...a: unknown[]) => unknown>)[method]
    // Dirty flag: mutation methods mean changes since the last save (a method-name
    // heuristic — get/list/search/export do not match, save/open manage themselves)
    if (MUTATES.test(method)) {
      dirty = true
      updateTitle()
      // The trail records the same set, and for the same reason the flag does: these are the calls
      // that CHANGED something. Recording every call instead filled forty of the fifty slots with
      // `getPrefs → listEntities → getSetting ×7` — the app polling itself on boot and every
      // render — and pushed the user's actual actions off the end. Reads lose nothing by being
      // absent: when one of them is what failed, the report's `where` line names it.
      noteCall(method)
    }
    // Logged AND rethrown: the renderer still gets its rejection and decides what to show,
    // the file gets the detail the user cannot be expected to relay.
    try {
      const out = fn(...args)
      return out instanceof Promise
        ? (out as Promise<unknown>).catch((err: unknown) => {
            logError(`ipc:${method}`, err)
            throw err
          })
        : out
    } catch (err) {
      logError(`ipc:${method}`, err)
      throw err
    }
  })

  createWindow()
  buildMenu()
  updateTitle()

  if (startupWarning && mainWindow) {
    // Non-blocking on purpose: the world may be the previous session's rather than a fresh one,
    // which is worth knowing but not worth refusing to start over.
    mainWindow.once('ready-to-show', () =>
      dialog.showMessageBox(mainWindow!, {
        type: 'warning',
        message: 'The world could not be prepared for this session.',
        detail:
          `${startupWarning}\n\n` +
          'This usually means another copy of the app is already open and holding the world ' +
          'file. The app has started with whatever was already there — save to a .world before ' +
          'making changes you care about.'
      })
    )
  }

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// The last line of the session, and the only place the buffered queue is guaranteed to reach the
// disk. Writes here are synchronous on purpose — 'before-quit' is the last moment there is.
app.on('before-quit', () => {
  logEvent('INFO', 'app.closed', memoryFields())
  flushLog()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
