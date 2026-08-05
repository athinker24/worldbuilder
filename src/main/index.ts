import { app, shell, BrowserWindow, ipcMain, dialog, protocol, net, Menu, session } from 'electron'
import { basename, join } from 'path'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
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

// --- Wonderdraft-style file model: the working copy (DATA_DIR) is saved instantly at all times,
// Ctrl+S packs it into a single .dunya file, Open unpacks a file over the working copy.
// currentFile = Ctrl+S target (persisted in settings.worldFile); dirty = changes since last save.
let currentFile: string | null = null
let dirty = false
// Set when the startup sequence failed. Reported once the window exists — the point is that the
// app still opens; a dialog before createWindow() would have nothing to attach to.
let startupWarning: string | null = null
// Name + dirty star in the window title (Photoshop pattern). The renderer never sets document.title.
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
      defaultPath: currentFile ?? join(DOCS, 'my-world.dunya'),
      filters: [{ name: APP_NAME, extensions: ['dunya'] }]
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

// .dunya path from argv (double-click open — the Windows file association passes it as an argument)
const dunyaArg = (argv: string[]): string | null =>
  argv.find((a) => a.toLowerCase().endsWith('.dunya') && existsSync(a)) ?? null

// Recent .dunya files (Photoshop/Krita start screen). NOT written into DATA_DIR: the working
// copy is reset on every normal launch, and the list must outlive that → userData/recent.json.
const RECENT = join(app.getPath('userData'), 'recent.json')
const readRecent = (): string[] => {
  try {
    const l = JSON.parse(readFileSync(RECENT, 'utf8'))
    return Array.isArray(l) ? (l as string[]) : []
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
// live inside world.db, so they travel inside a shared .dunya (opening someone else's file would
// change your language) and resetWorld() wipes them on any launch that had content (your own
// choice would not survive a restart). Per-machine, next to recent.json.
const PREFS = join(app.getPath('userData'), 'prefs.json')
// Panel widths and the sidebar's open state live here too: they describe how YOU like the app
// laid out, not what the world contains, so they must not ride inside a shared .dunya.
type Prefs = {
  language?: string
  theme?: string
  sidebarWidth?: number
  mapPanelWidth?: number
  // Developer logging. Per machine like everything else here — it describes how YOU want the app
  // to behave, and a shared .dunya must not be able to turn it on for someone else.
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

// Open a .dunya file over the working copy (safety backup first)
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
          : ml('That world file could not be opened.'),
      detail: basename(path)
    } as const
    if (mainWindow) dialog.showMessageBoxSync(mainWindow, opts)
    else dialog.showMessageBoxSync(opts)
    return false
  }
}

// "New": same path as the blank launch — the current working copy is packed into backups/ as a
// .dunya, then the schema is emptied. The unsaved-changes confirm lives in the renderer.
// File > Close Project runs this too: in this app there is no third state where a project is
// closed but the working copy still holds it, so "close" and "new" land in the same place.
function newProject(): void {
  const done = logTime('project.new')
  if (hasContent()) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    packWorld(join(DATA_DIR, 'backups', `last-session-${stamp}.dunya`))
    logEvent('INFO', 'project.autobacked', { reason: 'previous session had content' })
  }
  resetWorld()
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
  Overview: 'Genel Bakış',
  'Hide Panels': 'Panelleri Gizle',
  'Hide Panels, Keep Tools': 'Panelleri Gizle, Araçlar Kalsın',
  Atlas: 'Atlas',
  Chronology: 'Kronoloji',
  Relations: 'İlişkiler',
  'Project Preferences': 'Proje Tercihleri',
  'Keyboard Shortcuts': 'Klavye Kısayolları',
  'Open Error Log': 'Hata Kaydını Aç',
  'No log could be written.': 'Kayıt dosyası yazılamadı.',
  'Check that the Worldbuilder folder in Documents can be written to.':
    'Belgeler içindeki Worldbuilder klasörünün yazılabilir olduğunu kontrol edin.'
}
const ml = (s: string): string => (readPrefs().language === 'tr' ? (MENU_TR[s] ?? s) : s)

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
          // Photoshop's Tab / Shift+Tab. registerAccelerator:false — Tab is the focus key, and
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
  // Pick + open a file. The unsaved-changes confirm lives in the RENDERER (asked via worldInfo)
  // — here it is just pick + open. The returned path signals "reload" to the renderer.
  async openWorld(): Promise<string | null> {
    const r = await dialog.showOpenDialog(mainWindow!, {
      filters: [{ name: APP_NAME, extensions: ['dunya'] }],
      properties: ['openFile']
    })
    if (r.canceled || !r.filePaths[0]) return null
    // A file that is not one of our worlds is a normal thing for a user to pick (the filter is
    // only a hint, and Windows lets any name end in .dunya). Say so and leave the open world
    // alone — unpackWorld has already guaranteed nothing was touched.
    if (!openGuarded(r.filePaths[0])) return null
    // Reload from MAIN: window.location.reload() in the renderer hit the will-navigate
    // security block and shipped the URL to the external browser (webContents.reload does not)
    mainWindow?.webContents.reload()
    return r.filePaths[0]
  },
  // Start screen (Photoshop/Krita): recent worlds. 'missing' = the file was moved/deleted —
  // the row stays listed (the user dismisses it with ×), it is not silently dropped.
  recentWorlds: (): { path: string; name: string; missing: boolean }[] =>
    readRecent().map((p) => ({ path: p, name: basename(p), missing: !existsSync(p) })),
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
   * `.dunya`'s content — so the level is validated against the four known values rather than
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
    writePrefs({ ...readPrefs(), ...keep })
    if (keep.debugLog !== undefined) logSetDebug(keep.debugLog === true)
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
  // The equivalent of Wonderdraft's "Export" — not editable, a one-way sharing artifact.
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
  const openSafe = (url: string): void => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
  }
  app.on('web-contents-created', (_e, wc) => {
    wc.setWindowOpenHandler((details) => {
      openSafe(details.url)
      return { action: 'deny' }
    })
    wc.on('will-navigate', (e, url) => {
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
    show: false,
    autoHideMenuBar: false, // the File/Edit/View/Help menu is the app's command surface
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true
    }
  })
  mainWindow = win

  win.on('ready-to-show', () => {
    win.show()
  })

  // Close guard while dirty (Photoshop pattern): Save / Don't Save / Cancel
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
            defaultPath: join(DOCS, 'my-world.dunya'),
            filters: [{ name: APP_NAME, extensions: ['dunya'] }]
          }) ?? null
        if (!target) {
          e.preventDefault() // no location picked → cancel the close
          return
        }
      }
      packWorld(target)
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

// Single instance: double-clicking a .dunya while the app is open switches the existing
// window to that world instead of spawning a second one (confirm first when dirty)
if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', (_e, argv) => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
  const path = dunyaArg(argv)
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
  initDb(DATA_DIR)
  adoptLegacyPrefs() // language/theme out of the settings table — BEFORE the resetWorld() below
  // Everything from here to createWindow() is best-effort. A throw used to escape into the
  // unhandled-rejection void BEFORE any window existed, so Electron saw zero windows and quit
  // with code 0 — the app simply never appeared, with nothing on screen to explain why.
  // Two real ways in: world.db locked by a second instance (EBUSY inside resetWorld), and a
  // corrupt .dunya passed on the command line, which is untrusted input by the security
  // contract. The renderer has ErrorBoundary for this class of failure; this is main's.
  try {
    backupIfNeeded() // daily dated copy of world.db — restore is manual (the backups/ folder)
    const arg = dunyaArg(process.argv)
    if (arg) {
      openGuarded(arg) // launch with the double-clicked file; a bad one just starts blank
    } else if (hasContent()) {
      // Photoshop pattern: a normal launch is ALWAYS a blank document. The previous session's
      // working copy (images included) is packed into backups/ as a full .dunya — nothing is
      // lost even if it was never saved (subject to the 30-day backup pruning).
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      packWorld(join(DATA_DIR, 'backups', `last-session-${stamp}.dunya`))
      resetWorld()
    }
  } catch (err) {
    startupWarning = err instanceof Error ? err.message : String(err)
  }

  // Register the .dunya extension to the CURRENT exe path on every launch (HKCU — no admin
  // needed): even the portable exe stays double-clickable wherever it is moved or renamed.
  // Disabled in dev (process.execPath would be electron.exe). Errors are swallowed.
  if (process.platform === 'win32' && !is.dev) {
    const reg = (args: string[]): void => {
      execFile('reg.exe', args, () => {})
    }
    reg(['add', 'HKCU\\Software\\Classes\\.dunya', '/ve', '/d', 'Dunya.World', '/f'])
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
    const full = resolveAssetPath(rel)
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
    // Dirty flag: mutation methods mean changes since the last save (ponytail: a method-name
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
          'file. The app has started with whatever was already there — save to a .dunya before ' +
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
