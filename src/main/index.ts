import { app, shell, BrowserWindow, ipcMain, dialog, protocol, net } from 'electron'
import { join, normalize, sep } from 'path'
import { writeFile } from 'fs/promises'
import { pathToFileURL } from 'url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { initDb, backupIfNeeded, api as dbApi } from './db'

// Veri her zaman Belgeler\Dünya altında (yedek = bu klasörü kopyala); dev ve paketli sürüm aynı dünyayı görür
const DATA_DIR = join(app.getPath('documents'), 'Dünya')

// world://data/assets/x.png → DATA_DIR/assets/x.png (görselleri renderer'a servis eder)
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'world',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
])

// exportMapImage capturePage için pencereye ihtiyaç duyar; createWindow'da atanır
let mainWindow: BrowserWindow | null = null

const mainApi = {
  ...dbApi,
  async pickImage(): Promise<string | null> {
    const r = await dialog.showOpenDialog({
      filters: [{ name: 'Görseller', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      properties: ['openFile']
    })
    if (r.canceled || !r.filePaths[0]) return null
    return dbApi.importAsset(r.filePaths[0])
  },
  // Ekranda görüneni (rect: CSS piksel, .leaflet-host sınırları) PNG olarak dışa aktarır.
  // Wonderdraft'ın "Export" kavramının karşılığı — düzenlenebilir değil, tek yönlü paylaşım çıktısı.
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
    autoHideMenuBar: true,
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

  // Dış linkler yalnız tarayıcıda ve yalnız http(s) — file:// vb. çalıştırılamaz
  const openSafe = (url: string): void => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
  }
  win.webContents.setWindowOpenHandler((details) => {
    openSafe(details.url)
    return { action: 'deny' }
  })
  // Pencerenin kendisi asla uygulama dışına gidemez (notlardaki bir link
  // pencereyi ele geçirip window.api üzerinden veritabanına erişemesin)
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

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.worldbuilding.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  initDb(DATA_DIR)
  backupIfNeeded() // günde bir kez world.db'nin tarihli kopyası — geri yükleme elle (backups/ klasörü)

  protocol.handle('world', (req) => {
    const rel = decodeURIComponent(new URL(req.url).pathname)
    const full = normalize(join(DATA_DIR, rel))
    // prefix + ayraç: "Dünya-baska" gibi kardeş klasörler geçmesin
    if (!full.startsWith(normalize(DATA_DIR) + sep))
      return new Response('forbidden', { status: 403 })
    return net.fetch(pathToFileURL(full).toString())
  })

  ipcMain.handle('api', (_e, method: string, ...args: unknown[]) => {
    // hasOwn: 'constructor' gibi prototype üyeleri metot sayılmasın
    if (!Object.hasOwn(mainApi, method)) throw new Error(`Bilinmeyen api metodu: ${method}`)
    const fn = (mainApi as Record<string, (...a: unknown[]) => unknown>)[method]
    return fn(...args)
  })

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
