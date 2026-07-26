import { app, shell, BrowserWindow, ipcMain, dialog, protocol, net, Menu } from 'electron'
import { basename, join, normalize, sep } from 'path'
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
  api as dbApi
} from './db'

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
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
])

// exportMapImage needs the window for capturePage; assigned in createWindow
let mainWindow: BrowserWindow | null = null

// --- Wonderdraft-style file model: the working copy (DATA_DIR) is saved instantly at all times,
// Ctrl+S packs it into a single .dunya file, Open unpacks a file over the working copy.
// currentFile = Ctrl+S target (persisted in settings.worldFile); dirty = changes since last save.
let currentFile: string | null = null
let dirty = false
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
  packWorld(target)
  currentFile = target
  dbApi.setSetting('worldFile', target)
  dirty = false
  addRecent(target)
  updateTitle()
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
type Prefs = { language?: string; theme?: string }
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

// "New": same path as the blank launch — the current working copy is packed into backups/ as a
// .dunya, then the schema is emptied. The unsaved-changes confirm lives in the renderer.
// File > Close Project runs this too: in this app there is no third state where a project is
// closed but the working copy still holds it, so "close" and "new" land in the same place.
function newProject(): void {
  if (hasContent()) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    packWorld(join(DATA_DIR, 'backups', `last-session-${stamp}.dunya`))
  }
  resetWorld()
  currentFile = null
  dirty = false
  updateTitle()
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
  Atlas: 'Atlas',
  Chronology: 'Kronoloji',
  Relations: 'İlişkiler',
  'Project Preferences': 'Proje Tercihleri',
  'Keyboard Shortcuts': 'Klavye Kısayolları'
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
          }
        ]
      }
    ])
  )
}

const mainApi = {
  ...dbApi,
  // Dumps notes into the .txt tree + opens the folder for browsing (button-triggered, one-way)
  exportNotes: async (): Promise<{ path: string; files: number }> => {
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
    openWorldFile(r.filePaths[0])
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
    openWorldFile(path)
    mainWindow?.webContents.reload()
    return true
  },
  newWorld: newProject,
  // Same function on purpose (see newProject) — a separate command because that is where users
  // look for it, not because the behaviour differs.
  closeWorld: newProject,
  // Application preferences, per-machine. The 'save' prefix is deliberate: 'set*' would match the
  // dirty-flag regex in the IPC dispatch below, so switching theme would mark the world unsaved.
  getPrefs: (): Prefs => readPrefs(),
  savePrefs(patch: Prefs): void {
    writePrefs({ ...readPrefs(), ...patch })
    buildMenu() // menu labels follow the language
  },
  async pickImage(): Promise<string | null> {
    const r = await dialog.showOpenDialog({
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      properties: ['openFile']
    })
    if (r.canceled || !r.filePaths[0]) return null
    return dbApi.importAsset(r.filePaths[0])
  },
  // Exports what is on screen (rect: CSS pixels, the .leaflet-host bounds) as a PNG.
  // The equivalent of Wonderdraft's "Export" — not editable, a one-way sharing artifact.
  async exportMapImage(
    rect: { x: number; y: number; width: number; height: number },
    defaultName: string
  ): Promise<string | null> {
    if (!mainWindow) return null
    const r = await dialog.showSaveDialog(mainWindow, {
      defaultPath: `${defaultName}.png`,
      filters: [{ name: 'PNG', extensions: ['png'] }]
    })
    if (r.canceled || !r.filePath) return null
    const image = await mainWindow.webContents.capturePage(rect)
    await writeFile(r.filePath, image.toPNG())
    return r.filePath
  }
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

  // The app uses no browser permissions (camera, location, notifications…) — all denied.
  // Remote content cannot load anyway; this is a cheap safety latch in case something ever slips.
  win.webContents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))

  // External links only in the browser and only http(s) — file:// and friends cannot run
  const openSafe = (url: string): void => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
  }
  win.webContents.setWindowOpenHandler((details) => {
    openSafe(details.url)
    return { action: 'deny' }
  })
  // The window itself can never navigate away from the app (a link in a note must not
  // hijack the window and reach the database through window.api)
  win.webContents.on('will-navigate', (e, url) => {
    e.preventDefault()
    openSafe(url)
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

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
  openWorldFile(path)
  mainWindow.webContents.reload()
})

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.worldbuilding.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  adoptLegacyDataDir() // adopt the old Documents\D\u00fcnya folder (BEFORE initDb)
  initDb(DATA_DIR)
  adoptLegacyPrefs() // language/theme out of the settings table — BEFORE the resetWorld() below
  backupIfNeeded() // daily dated copy of world.db — restore is manual (the backups/ folder)
  const arg = dunyaArg(process.argv)
  if (arg) {
    openWorldFile(arg) // launch with the double-clicked file
  } else if (hasContent()) {
    // Photoshop pattern: a normal launch is ALWAYS a blank document. The previous session's
    // working copy (images included) is packed into backups/ as a full .dunya — nothing is
    // lost even if it was never saved (subject to the 30-day backup pruning).
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    packWorld(join(DATA_DIR, 'backups', `last-session-${stamp}.dunya`))
    resetWorld()
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

  protocol.handle('world', (req) => {
    const rel = decodeURIComponent(new URL(req.url).pathname)
    const full = normalize(join(DATA_DIR, rel))
    // prefix + separator: sibling folders like "Worldbuilder-other" must not pass
    if (!full.startsWith(normalize(DATA_DIR) + sep))
      return new Response('forbidden', { status: 403 })
    return net.fetch(pathToFileURL(full).toString())
  })

  ipcMain.handle('api', (_e, method: string, ...args: unknown[]) => {
    // hasOwn: prototype members like 'constructor' must not count as methods
    if (!Object.hasOwn(mainApi, method)) throw new Error(`Bilinmeyen api metodu: ${method}`)
    const fn = (mainApi as Record<string, (...a: unknown[]) => unknown>)[method]
    // Dirty flag: mutation methods mean changes since the last save (ponytail: a method-name
    // heuristic — get/list/search/export do not match, save/open manage themselves)
    if (/^(create|update|delete|add|set|restore|retype|import|pick)/.test(method)) {
      dirty = true
      updateTitle()
    }
    return fn(...args)
  })

  createWindow()
  buildMenu()
  updateTitle()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
