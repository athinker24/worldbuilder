import { app, shell, BrowserWindow, ipcMain, dialog, protocol, net } from 'electron'
import { basename, join, normalize, sep } from 'path'
import { existsSync } from 'fs'
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

// --- Wonderdraft tarzı dosya modeli: çalışma kopyası (DATA_DIR) anlık kayıtlı kalır,
// Ctrl+S onu tek bir .dunya dosyasına paketler, Open paketi çalışma kopyasının üzerine açar.
// currentFile = Ctrl+S hedefi (settings.worldFile'da kalıcı); dirty = son kayıttan beri değişiklik.
let currentFile: string | null = null
let dirty = false
// Ad + kirli yıldızı pencere başlığında (Photoshop deseni). Renderer document.title kullanmıyor.
function updateTitle(): void {
  mainWindow?.setTitle(
    `Dünya — ${currentFile ? basename(currentFile) : 'kaydedilmemiş'}${dirty ? ' *' : ''}`
  )
}
// Kaydetme: pack + bayrak temizle. Yol yoksa iletişim kutusuyla sor ('as' hep sorar).
async function saveWorld(as = false): Promise<string | null> {
  let target = as ? null : currentFile
  if (!target) {
    const r = await dialog.showSaveDialog(mainWindow!, {
      defaultPath: currentFile ?? join(app.getPath('documents'), 'dünyam.dunya'),
      filters: [{ name: 'Dünya', extensions: ['dunya'] }]
    })
    if (r.canceled || !r.filePath) return null
    target = r.filePath
  }
  packWorld(target)
  currentFile = target
  dbApi.setSetting('worldFile', target)
  dirty = false
  updateTitle()
  return target
}

// Kirliyken dünya değiştirme/kapatma onayı için ikili dil (main'de i18n yok — settings'ten oku)
const isTr = (): boolean => dbApi.getSetting('language') === 'tr'

// argv'den .dunya yolu (çift tıkla açma — Windows dosya ilişkilendirmesi yolu argüman geçer)
const dunyaArg = (argv: string[]): string | null =>
  argv.find((a) => a.toLowerCase().endsWith('.dunya') && existsSync(a)) ?? null

// Bir .dunya dosyasını çalışma kopyasının üzerine aç (önce güvenlik yedeği)
function openWorldFile(path: string): void {
  dbApi.backupNow()
  unpackWorld(path)
  currentFile = path
  dirty = false
  updateTitle()
}

const mainApi = {
  ...dbApi,
  // Notları .txt ağacına döker + gözat için klasörü açar (buton tetikli, tek yönlü)
  exportNotes: async (): Promise<{ path: string; files: number }> => {
    const r = dbApi.exportNotes()
    await shell.openPath(r.path)
    return r
  },
  saveWorld: (): Promise<string | null> => saveWorld(false),
  saveWorldAs: (): Promise<string | null> => saveWorld(true),
  worldInfo: (): { file: string | null; dirty: boolean } => ({ file: currentFile, dirty }),
  // Dosya seç + aç. Kaydedilmemiş-değişiklik onayı RENDERER'da (worldInfo ile sorulur) —
  // burada yalnız seçim + açma. Dönen yol renderer'a "yeniden yükle" işareti.
  async openWorld(): Promise<string | null> {
    const r = await dialog.showOpenDialog(mainWindow!, {
      filters: [{ name: 'Dünya', extensions: ['dunya'] }],
      properties: ['openFile']
    })
    if (r.canceled || !r.filePaths[0]) return null
    openWorldFile(r.filePaths[0])
    // Yenileme MAIN'den: renderer'daki window.location.reload() will-navigate güvenlik
    // engeline takılıp URL'yi dış tarayıcıya gönderiyordu (webContents.reload engele girmez)
    mainWindow?.webContents.reload()
    return r.filePaths[0]
  },
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

  // Kirliyken kapatma koruması (Photoshop deseni): Kaydet / Kaydetme / İptal
  win.on('close', (e) => {
    if (!dirty) return
    const tr = isTr()
    const r = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: tr ? ['Kaydet', 'Kaydetme', 'İptal'] : ['Save', "Don't Save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      message: tr
        ? 'Kaydedilmemiş değişiklikler var. Kapatmadan önce kaydedilsin mi?'
        : 'There are unsaved changes. Save before closing?'
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
            defaultPath: join(app.getPath('documents'), 'dünyam.dunya'),
            filters: [{ name: 'Dünya', extensions: ['dunya'] }]
          }) ?? null
        if (!target) {
          e.preventDefault() // yer seçilmedi → kapatma iptal
          return
        }
      }
      packWorld(target)
    }
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

// Tek kopya: uygulama açıkken .dunya'ya çift tıklanınca ikinci pencere yerine mevcut pencere
// o dünyaya geçer (kirliyse önce onay)
if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', (_e, argv) => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
  const path = dunyaArg(argv)
  if (!path) return
  if (dirty) {
    const tr = isTr()
    const r = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: tr ? ['Aç (değişiklikleri at)', 'İptal'] : ['Open (discard changes)', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: tr
        ? 'Kaydedilmemiş değişiklikler var. Başka dünya açılırsa kaybolur.'
        : 'There are unsaved changes. Opening another world will discard them.'
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

  initDb(DATA_DIR)
  backupIfNeeded() // günde bir kez world.db'nin tarihli kopyası — geri yükleme elle (backups/ klasörü)
  const arg = dunyaArg(process.argv)
  if (arg) {
    openWorldFile(arg) // çift tıkla gelen dosyayla açıl
  } else if (hasContent()) {
    // Photoshop deseni: normal açılış HER ZAMAN boş belge. Önceki oturumun çalışma kopyası
    // (görselleri dahil) tam .dunya paketi olarak backups/'a alınır — kaydedilmemiş olsa bile
    // veri kaybolmaz (30 günlük yedek temizliğine tabi).
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    packWorld(join(DATA_DIR, 'backups', `son-oturum-${stamp}.dunya`))
    resetWorld()
  }

  // .dunya uzantısını her açılışta GÜNCEL exe yoluna kaydet (HKCU — yönetici gerekmez):
  // kurulumsuz/taşınabilir Dünya.exe de nereye taşınırsa taşınsın çift tıkla bulunur.
  // Dev modda kapalı (process.execPath electron.exe olurdu). Hata sessizce yutulur.
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
    // prefix + ayraç: "Dünya-baska" gibi kardeş klasörler geçmesin
    if (!full.startsWith(normalize(DATA_DIR) + sep))
      return new Response('forbidden', { status: 403 })
    return net.fetch(pathToFileURL(full).toString())
  })

  ipcMain.handle('api', (_e, method: string, ...args: unknown[]) => {
    // hasOwn: 'constructor' gibi prototype üyeleri metot sayılmasın
    if (!Object.hasOwn(mainApi, method)) throw new Error(`Bilinmeyen api metodu: ${method}`)
    const fn = (mainApi as Record<string, (...a: unknown[]) => unknown>)[method]
    // Kirli bayrağı: mutasyon metotları son kayıttan beri değişiklik var demektir
    // (ponytail: metot-adı sezgiseli — get/list/search/export eşleşmez, save/open kendini yönetir)
    if (/^(create|update|delete|add|set|restore|retype|import|pick)/.test(method)) {
      dirty = true
      updateTitle()
    }
    return fn(...args)
  })

  createWindow()
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
