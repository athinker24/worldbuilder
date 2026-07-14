import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import '@geoman-io/leaflet-geoman-free'
import 'leaflet/dist/leaflet.css'
import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css'
import iconUrl from 'leaflet/dist/images/marker-icon.png'
import iconRetinaUrl from 'leaflet/dist/images/marker-icon-2x.png'
import shadowUrl from 'leaflet/dist/images/marker-shadow.png'
import {
  api,
  assetUrl,
  autoColor,
  EntityRow,
  Feature,
  getHierConfig,
  getMapModes,
  getParents,
  getTimeline,
  MapRow,
  mergeHierConfig,
  ParentRec,
  parentAt,
  saveTimeline,
  TypeDef,
  typeColor,
  WorldMap
} from './api'
import ColorPicker from './ColorPicker'
import ContextMenu, { MenuItem, MenuState } from './ContextMenu'
import EntityPage from './EntityPage'
import HierarchyPanel, { ActiveMode } from './HierarchyPanel'
import { alertDialog } from './dialog'
import { useT } from './i18n'
import Timeline from './Timeline'
import ToolPanel, {
  ARROW_LABELS,
  DASH_LABELS,
  DEFAULT_DRAW,
  DrawSettings,
  FONTS,
  LINE_ARROWS,
  LINE_DASHES,
  LineArrow,
  LineDash,
  lineDashArray,
  Tool
} from './ToolPanel'
import { pushUndo } from './undo'

L.Icon.Default.mergeOptions({ iconUrl, iconRetinaUrl, shadowUrl })

// Feature.style JSON'unun şekli (hepsi opsiyonel — eski kayıtlar varsayılanlara düşer)
interface FeatureStyle {
  color?: string
  fillOpacity?: number
  weight?: number
  size?: number
  font?: string
  childMapId?: number
  from?: number // çizimin var olduğu yıl aralığı (zaman çizgisi); boş = her zaman
  to?: number
  opacity?: number // çizgi (yol) opaklığı
  dash?: LineDash // çizgi deseni (yol aracı)
  arrow?: LineArrow // yön oku: yok / sonda / akış (göç, sefer, ticaret)
}

interface Props {
  id: number
  focus?: { featureId: number; token: number } | null // kenar çubuğundan "haritada göster" — ilgili çizime uç
  reloadToken: number // undo/redo sonrası çizimleri yerinde tazelet (harita remount edilmez, zoom korunur)
  maps: MapRow[]
  types: TypeDef[]
  onNavigate: (mapId: number) => void
  onOpenEntity: (id: number) => void
  onChanged: () => void
}

interface FeatureLayer extends L.Layer {
  featureId?: number
}

// Gölgesiz: pin zoom ile ölçeklenirken gölgeyle boy uyumsuzluğu olmasın
const scaledIcon = (size: number): L.Icon =>
  L.icon({
    iconUrl,
    iconRetinaUrl,
    iconSize: [25 * size, 41 * size],
    iconAnchor: [12.5 * size, 41 * size],
    tooltipAnchor: [16 * size, -28 * size]
  })

export default function MapView({
  id,
  focus,
  reloadToken,
  maps,
  types,
  onNavigate,
  onOpenEntity,
  onChanged
}: Props): React.JSX.Element {
  const t = useT()
  const divRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const featureGroupRef = useRef<L.FeatureGroup | null>(null)
  const imageLayerRef = useRef<L.ImageOverlay | null>(null)
  // Etiket taban boyutları harita birimi cinsinden (zoom 0 pikseli); her zoom'da piksele çevrilir
  const labelMeta = useRef(new Map<number, { base: number; font: string }>())
  // Pin boyut çarpanları; poligon etiketleri gibi zoom ile ölçeklenir (haritaya yapışık)
  const markerSize = useRef(new Map<number, number>())
  const [worldMap, setWorldMap] = useState<WorldMap | null>(null)
  const [selected, setSelected] = useState<Feature | null>(null)
  const [allEntities, setAllEntities] = useState<EntityRow[]>([])
  // Kişi maddeleri haritaya bağlanamaz (bkz. EntityPage — aile/hanedan alanları içindir)
  const personTypeNames = types.filter((ty) => ty.isPerson).map((ty) => ty.name)
  const [linkName, setLinkName] = useState('')
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [hudZoom, setHudZoom] = useState<number | null>(null)
  const hudTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // Harita modu (CK3 gibi): kademe → taban poligonlar o kademedeki ataya göre; boya → boyuta göre
  const [activeMode, setActiveMode] = useState<ActiveMode>(null)
  const activeModeRef = useRef<ActiveMode>(null)
  const [layersOpen, setLayersOpen] = useState(false)
  // Zaman çizgisi: slider tikinde DB'siz aç/kapa için katman kayıt defteri
  const yearRef = useRef(0)
  // Haritada bir şeyin değiştiği yıllar (çizim başlar/biter/el değiştirir) — ray tikleri
  const [changeYears, setChangeYears] = useState<number[]>([])
  // Haritadan olay eklenince artar → Timeline config'ini yeniden yükler
  const [eventsToken, setEventsToken] = useState(0)
  const layerYears = useRef(new Map<number, { from?: number; to?: number }>())
  const allLayers = useRef(new Map<number, L.Layer[]>())
  // Katman paneli: poligon/yol/pin/etiket aç-kapa (settings'te kalıcı, applyYear DB'siz uygular)
  const [layersOn, setLayersOn] = useState({ polygon: true, line: true, pin: true, label: true })
  const layersRef = useRef(layersOn)
  const featKind = useRef(new Map<number, 'polygon' | 'line' | 'pin'>())
  // Yol yön oku: fid → 'end'|'flow' (SVG marker-mid/end ile, applyYear'da elemana uygulanır)
  const featArrow = useRef(new Map<number, LineArrow>())
  // Her çizimin tekil render stili — applyYear bunlarla DB'siz yeniden boyar
  const renderStyle = useRef(
    new Map<
      number,
      { color: string; fillOpacity: number; weight: number; opacity: number; dashArray: string }
    >()
  )
  // De-jure üst zinciri (kademe görünümü + fetih): madde → üst geçmişi, kademe hedefleri, çizim → madde
  const parentHist = useRef(new Map<number, ParentRec[]>())
  const rungTargets = useRef(new Map<number, string>()) // kademedeki maddeler → renk
  const featEnt = useRef(new Map<number, number>())
  // Varsayılan (kök) görünümü için: taban maddeler, tüm maddelerin renk/adları, çizim alanları
  const baseSet = useRef(new Set<number>())
  const entColors = useRef(new Map<number, string>())
  const entNames = useRef(new Map<number, string>())
  const featArea = useRef(new Map<number, number>())
  // Mozaikle yönetilen maddeler (yıldan bağımsız): haritadaki taban poligonların üst geçmişinde
  // HERHANGİ bir yıl geçenler. Kendi çizimleri varsayılan görünümde asla gösterilmez — tam
  // ilhakta (mozaiği o yıl boşalınca) eski elle çizilmiş poligon geri belirmesin.
  const mosaicManaged = useRef(new Set<number>())
  // Topolojik kaynak Ctrl ile açılır: Ctrl basılıyken köşe sürüklenirse, aynı noktayı paylaşan
  // komşu poligon köşeleri sürükleme SIRASINDA canlı olarak birlikte taşınır (Ctrl'süz tek taraflı)
  const ctrlRef = useRef(false)
  // aktif sürüklemenin partner köşeleri (dragstart'ta bulunur, drag'de taşınır)
  const dragPartners = useRef<{ layer: L.Polygon; fid: number; ring: number; idx: number }[]>([])
  // bu düzenleme oturumunda kaynakla taşınan komşu katmanlar — pm:update'te DB'ye yazılır
  const weldTouched = useRef(new Map<number, L.Polygon>())
  useEffect(() => {
    const down = (e: KeyboardEvent): void => {
      if (e.key === 'Control') ctrlRef.current = true
    }
    const up = (e: KeyboardEvent): void => {
      if (e.key === 'Control') ctrlRef.current = false
    }
    const blur = (): void => {
      ctrlRef.current = false
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [])

  // ⚔ Fetih akışı: adım 1 alıcının komşu poligonuna tıkla (alıcı = onun o yılki doğrudan üstü),
  // adım 2 fethedilen taban poligonları seç, Tamam → seçilenler slider yılından itibaren alıcıya katılır.
  // Katman click handler'ları reload olmadan da güncel durumu görsün diye state + ref birlikte tutulur.
  type Conquest =
    | null
    | { step: 'alıcı' }
    | { step: 'seçim'; receiverId: number; receiverName: string; picked: Set<number> }
  const [conquest, setConquestState] = useState<Conquest>(null)
  const conquestRef = useRef<Conquest>(null)
  const setConquest = (c: Conquest): void => {
    conquestRef.current = c
    setConquestState(c)
  }

  // Araç ve çizim ayarları — event handler'lar ref üzerinden okur (stale closure yok)
  const [tool, setToolState] = useState<Tool | null>(null)
  const toolRef = useRef<Tool | null>(null)
  const [drawSettings, setDrawSettingsState] = useState<DrawSettings>(DEFAULT_DRAW)
  const drawRef = useRef<DrawSettings>(DEFAULT_DRAW)
  const [panelW, setPanelW] = useState(240)
  // Dışa aktarım: yakalama anında haritanın üzerini kaplayan UI (Zaman şeridi, HUD, Hiyerarşi
  // paneli, fetih/olay ipuçları) geçici olarak render'dan çıkar — Wonderdraft'ın "Export" işlevi
  // gibi tek yönlü, düzenlenemeyen bir PNG çıktısıdır (Save = zaten her düzenlemede otomatik).
  const [exporting, setExporting] = useState(false)
  const exportMap = async (): Promise<void> => {
    const host = divRef.current
    if (!host) return
    setExporting(true)
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    const rect = host.getBoundingClientRect()
    const path = await api.exportMapImage(
      {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      },
      worldMap?.name ?? 'harita'
    )
    setExporting(false)
    if (path) alertDialog(t('Exported to {path}', { path }))
  }

  // Zoom HUD'ını göster ve 3 sn etkileşimsizlik sonrası gizle.
  // Kaydırıcı aralığı haritanın o anki min/max zoom'u (görselli haritada minZoom dinamik)
  const [hudRange, setHudRange] = useState<[number, number]>([-4, 4])
  const showHud = (zoom: number): void => {
    const map = mapRef.current
    if (map) setHudRange([map.getMinZoom(), map.getMaxZoom()])
    setHudZoom(zoom)
    clearTimeout(hudTimer.current)
    hudTimer.current = setTimeout(() => setHudZoom(null), 3000)
  }

  // Breadcrumb: parent zincirini yürü
  const crumbs: MapRow[] = []
  let cur = maps.find((m) => m.id === id)
  while (cur) {
    crumbs.unshift(cur)
    cur = maps.find((m) => m.id === cur!.parent_map_id)
  }

  // Tüm geoman modlarını kapatıp istenen aracı aç; aynı araca ikinci basış kapatır
  const activateTool = (t: Tool): void => {
    const map = mapRef.current
    if (!map) return
    map.pm.disableDraw()
    if (map.pm.globalEditModeEnabled()) map.pm.disableGlobalEditMode()
    if (map.pm.globalDragModeEnabled()) map.pm.disableGlobalDragMode()
    if (map.pm.globalRemovalModeEnabled()) map.pm.disableGlobalRemovalMode()
    if (toolRef.current === t) {
      toolRef.current = null
      setToolState(null)
      return
    }
    toolRef.current = t
    setToolState(t)
    const s = drawRef.current
    if (t === 'polygon')
      map.pm.enableDraw('Polygon', {
        pathOptions: {
          color: s.polygon.color,
          fillColor: s.polygon.color,
          fillOpacity: s.polygon.fillOpacity,
          weight: s.polygon.weight
        }
      })
    else if (t === 'line')
      map.pm.enableDraw('Line', {
        pathOptions: {
          color: s.line.color,
          weight: s.line.weight,
          opacity: s.line.opacity,
          dashArray: lineDashArray(s.line.dash, s.line.weight),
          lineCap: 'round',
          fill: false
        }
      })
    else if (t === 'marker')
      map.pm.enableDraw('Marker', { markerStyle: { icon: scaledIcon(s.marker.size) } })
    else if (t === 'edit') map.pm.enableGlobalEditMode()
    else if (t === 'drag') map.pm.enableGlobalDragMode()
    else if (t === 'remove') map.pm.enableGlobalRemovalMode()
  }

  // Ayar değişikliği: kaydet + aktif çizim aracına anında uygula
  const updateDrawSettings = (s: DrawSettings): void => {
    drawRef.current = s
    setDrawSettingsState(s)
    api.setSetting('drawSettings', JSON.stringify(s))
    const map = mapRef.current
    if (!map) return
    if (toolRef.current === 'polygon')
      map.pm.enableDraw('Polygon', {
        pathOptions: {
          color: s.polygon.color,
          fillColor: s.polygon.color,
          fillOpacity: s.polygon.fillOpacity,
          weight: s.polygon.weight
        }
      })
    else if (toolRef.current === 'line')
      map.pm.enableDraw('Line', {
        pathOptions: {
          color: s.line.color,
          weight: s.line.weight,
          opacity: s.line.opacity,
          dashArray: lineDashArray(s.line.dash, s.line.weight),
          lineCap: 'round',
          fill: false
        }
      })
    else if (toolRef.current === 'marker')
      map.pm.enableDraw('Marker', { markerStyle: { icon: scaledIcon(s.marker.size) } })
  }

  // Etiket ve pin'leri haritaya "yapıştır": ekran boyutu = taban (harita birimi) × zoom ölçeği.
  // reposition=true yalnız ayar/içerik değişiminde (harita hareketi olmadan) verilir; zoom hot
  // path'inde FALSE — çünkü Leaflet her tooltip'i 'zoom' olayında zaten yeniden konumlandırıyor
  // (DivOverlay.getEvents → _updatePosition) ve bizim map handler'ımız onlardan önce çalıştığı için
  // font yazımı Leaflet offsetWidth'i okumadan önce uygulanır. tooltip.update()'i her tikte her
  // etiket için çağırmak yüzlerce senkron reflow = ciddi lag demekti.
  const updateOverlaySizes = (reposition = false): void => {
    const map = mapRef.current
    if (!map || !featureGroupRef.current) return
    const scale = 2 ** map.getZoom()
    featureGroupRef.current.eachLayer((l) => {
      const fl = l as FeatureLayer
      if (fl.featureId === undefined) return
      // poligon etiketi
      const meta = labelMeta.current.get(fl.featureId)
      const tooltip = l.getTooltip()
      const el = tooltip?.getElement()
      if (meta && el) {
        el.style.fontSize = `${meta.base * scale}px`
        el.style.fontFamily = `'${meta.font}', serif`
        if (reposition) tooltip!.update()
      }
      // konum pini: ikon img'sinin boyut/çapasını zoom'a göre ölçekle (DOM'u yeniden yaratmadan)
      const ms = markerSize.current.get(fl.featureId)
      const img = (l as unknown as { _icon?: HTMLElement })._icon
      if (ms !== undefined && img) {
        const w = 25 * ms * scale
        const h = 41 * ms * scale
        img.style.width = `${w}px`
        img.style.height = `${h}px`
        img.style.marginLeft = `${-w / 2}px`
        img.style.marginTop = `${-h}px`
      }
    })
  }

  // Sil + geri alma kaydı; hem geoman silme modu hem sağ tık menüsü kullanır
  const removeFeature = async (fid: number): Promise<void> => {
    const row = (await api.getMap(id))?.features.find((f) => f.id === fid)
    await api.deleteFeature(fid)
    if (row) {
      const ref = { id: fid }
      pushUndo({
        undo: async () => {
          ref.id = (
            await api.createFeature({
              map_id: id,
              entity_id: row.entity_id ?? undefined,
              geometry: row.geometry,
              style: row.style
            })
          ).id
        },
        redo: () => api.deleteFeature(ref.id)
      })
    }
    setSelected(null)
    await reloadFeatures()
  }

  // Sınır evrimi: çizimi slider'ın yılından başlayan bir kopyaya çatalla, eskisini yıl-1'de kapat.
  // Kullanıcı sonra yalnız değişen köşeleri düzenleme aracıyla oynatır — sıfırdan çizim yok.
  const forkFeature = async (f: Feature): Promise<void> => {
    const year = yearRef.current
    const oldStyle = JSON.parse(f.style || '{}') as FeatureStyle
    if (year - 1 < (oldStyle.from ?? -Infinity) || year > (oldStyle.to ?? Infinity)) {
      alertDialog(
        t('The slider must be within the year range the drawing exists (after its start).')
      )
      return
    }
    const newStyle = JSON.stringify({ ...oldStyle, from: year })
    const closedStyle = JSON.stringify({ ...oldStyle, to: year - 1 })
    const createCopy = (): Promise<{ id: number }> =>
      api.createFeature({
        map_id: id,
        entity_id: f.entity_id ?? undefined,
        geometry: f.geometry,
        style: newStyle
      })
    const created = await createCopy()
    await api.updateFeature(f.id, { style: closedStyle })
    const ref = { id: created.id }
    pushUndo({
      undo: async () => {
        await api.deleteFeature(ref.id)
        await api.updateFeature(f.id, { style: f.style })
      },
      redo: async () => {
        ref.id = (await createCopy()).id
        await api.updateFeature(f.id, { style: closedStyle })
      }
    })
    await reloadFeatures()
    setSelected((await api.getMap(id))?.features.find((x) => x.id === ref.id) ?? null)
  }

  // Olayı çizime bağlı olarak ekle (yıl = menünün açıldığı andaki slider yılı) — StoryMap deseni.
  // Electron window.prompt desteklemediği için ad, üstte açılan küçük formdan alınır.
  const [eventDraft, setEventDraft] = useState<{ f: Feature; year: number } | null>(null)
  const saveEventDraft = async (name: string): Promise<void> => {
    const d = eventDraft
    setEventDraft(null)
    if (!d || !name.trim()) return
    const t = await getTimeline()
    await saveTimeline({
      ...t,
      events: [...t.events, { name: name.trim(), year: d.year, fid: d.f.id, mid: id }]
    })
    setEventsToken((x) => x + 1)
  }

  // Olaya tıklanınca: çizime uç ve iki kez yanıp söndür (applyYear kanonik stile geri döndürür).
  // Çizim başka haritadaysa önce o haritaya geçilir (tekrar tıklayınca odaklanır).
  const focusFeature = (fid: number, mid?: number): void => {
    if (mid !== undefined && mid !== id) {
      onNavigate(mid)
      return
    }
    const layers = allLayers.current.get(fid)
    const map = mapRef.current
    if (!layers?.length || !map) return
    const l = layers[0]
    const b = (l as L.Polygon).getBounds?.() ?? L.latLngBounds([(l as L.Marker).getLatLng()])
    map.fitBounds(b.pad(0.4), { maxZoom: 2 })
    let n = 0
    const flash = (): void => {
      for (const ly of layers)
        if ((ly as L.Path).setStyle)
          (ly as L.Path).setStyle({ color: n % 2 ? '#ffd700' : '#ffffff' })
      n++
      if (n < 4) setTimeout(flash, 180)
      else applyYear(yearRef.current)
    }
    flash()
  }

  const reloadFeatures = async (): Promise<void> => {
    const wm = await api.getMap(id)
    setWorldMap(wm)
    if (!wm || !featureGroupRef.current) return
    const fg = featureGroupRef.current
    fg.clearLayers()
    labelMeta.current.clear()
    markerSize.current.clear()
    layerYears.current.clear()
    allLayers.current.clear()
    featKind.current.clear()
    featArrow.current.clear()
    renderStyle.current.clear()
    parentHist.current.clear()
    rungTargets.current.clear()
    featEnt.current.clear()
    weldTouched.current.clear()
    dragPartners.current = []
    // Üst geçmişleri, taban küme ve renk/ad kayıtları HER modda dolar: fetih yıl tikleri,
    // kademe çözümlemesi ve varsayılan (kök) görünümü buradan beslenir
    const [h, cfgRaw, modes] = await Promise.all([api.hierarchy(), getHierConfig(), getMapModes()])
    const cfg = mergeHierConfig(cfgRaw, h.govs)
    baseSet.current.clear()
    entColors.current.clear()
    entNames.current.clear()
    featArea.current.clear()
    for (const e of h.entities) {
      const recs = getParents(e.fields)
      if (recs.length) parentHist.current.set(e.id, recs)
      entNames.current.set(e.id, e.name)
      entColors.current.set(
        e.id,
        (JSON.parse(e.fields || '{}') as Record<string, string>)['renk'] ?? autoColor(e.name)
      )
    }
    // En alt kademe gov-bazlıdır: her merdivenin SON etiketi o yönetim biçiminin taban
    // kademesidir. Madde o biçime aitse (ya da yönetim biçimi boşsa) katılır.
    for (const g of cfg.govs) {
      const lowest = g.tags[g.tags.length - 1]
      if (!lowest) continue
      for (const e of h.entities)
        if (e.tags.includes(lowest) && (!e.gov || e.gov === g.name)) baseSet.current.add(e.id)
    }
    // Mozaikle yönetilenler: bu haritada çizimi olan taban maddelerden başlayıp üst geçmişlerinin
    // kapanışını al (zincir: baronluk geçmişi kontlukları, kontluk geçmişi krallıkları verir)
    mosaicManaged.current.clear()
    {
      const queue = wm.features
        .map((f) => f.entity_id)
        .filter((eid): eid is number => eid !== null && baseSet.current.has(eid))
      const seen = new Set(queue)
      while (queue.length) {
        const cur = queue.pop()!
        for (const rec of parentHist.current.get(cur) ?? []) {
          mosaicManaged.current.add(rec.id)
          if (!seen.has(rec.id)) {
            seen.add(rec.id)
            queue.push(rec.id)
          }
        }
      }
    }
    // Kademe modu: taban poligonlar o kademedeki atalarına göre boyanır (renk applyYear'da çözülür).
    // Boya modu: taban poligonlar fields[dim] değerine göre renklenir, değeri boş olan gri.
    let paint: { base: Set<number>; color: Map<number, string> } | null = null
    let kademe: { base: Set<number> } | null = null
    const mode = activeModeRef.current
    if (mode?.kind === 'boya') {
      const color = new Map<number, string>()
      for (const e of h.entities) {
        if (!baseSet.current.has(e.id)) continue
        const value = (JSON.parse(e.fields || '{}') as Record<string, string>)[mode.key]
        color.set(e.id, value ? (modes.colors[mode.key]?.[value] ?? autoColor(value)) : '#666666')
      }
      paint = { base: baseSet.current, color }
    } else if (mode?.kind === 'kademe') {
      kademe = { base: baseSet.current }
      // Kademe hedefleri: görüntülenen etiketi taşıyan maddeler
      for (const e of h.entities)
        if (e.tags.includes(mode.key)) rungTargets.current.set(e.id, entColors.current.get(e.id)!)
    }
    const chYears = new Set<number>()
    const derived = paint ?? kademe // türetilmiş boyama modları: yalnız taban poligonlar, etiket yok
    for (const f of wm.features) {
      const isPolygon = f.geometry.includes('"Polygon"')
      const isLine = f.geometry.includes('"LineString"')
      if (derived && (f.entity_id === null || !derived.base.has(f.entity_id) || !isPolygon))
        continue
      const style = JSON.parse(f.style || '{}') as FeatureStyle
      const color = paint
        ? paint.color.get(f.entity_id!)!
        : kademe
          ? '#666666' // kademe rengi applyYear'da üst zincirinden çözülür
          : (style.color ?? typeColor(types, f.entity_type))
      const lineOpacity = isLine ? (style.opacity ?? 0.9) : 1
      const dashArray = isLine ? lineDashArray(style.dash, style.weight ?? 3) : ''
      const gj = L.geoJSON(JSON.parse(f.geometry), {
        style: {
          color,
          fillColor: color,
          fill: !isLine,
          fillOpacity: derived ? 0.55 : (style.fillOpacity ?? 0.25),
          weight: style.weight ?? (isLine ? 3 : 2),
          opacity: lineOpacity,
          dashArray,
          lineCap: 'round'
        },
        pointToLayer: (_gf, latlng) => L.marker(latlng, { icon: scaledIcon(style.size ?? 1) })
      })
      featKind.current.set(f.id, isPolygon ? 'polygon' : isLine ? 'line' : 'pin')
      // Yön oku (sonda): gerçek çizginin path'ine marker-end (applyYear'da uygulanır)
      if (isLine && style.arrow === 'end') featArrow.current.set(f.id, 'end')
      if (style.from !== undefined || style.to !== undefined)
        layerYears.current.set(f.id, { from: style.from, to: style.to })
      if (f.entity_id !== null) {
        featEnt.current.set(f.id, f.entity_id)
        // fetih yılları rayda tik olsun
        for (const r of parentHist.current.get(f.entity_id) ?? [])
          if (r.from !== null) chYears.add(r.from)
      }
      if (style.from !== undefined) chYears.add(style.from)
      if (style.to !== undefined) chYears.add(style.to + 1) // değişim, bitişin ertesi yılında görünür
      renderStyle.current.set(f.id, {
        color,
        fillOpacity: derived ? 0.55 : (style.fillOpacity ?? 0.25),
        weight: style.weight ?? (isLine ? 3 : 2),
        opacity: lineOpacity,
        dashArray
      })
      gj.eachLayer((layer) => {
        const fl = layer as FeatureLayer
        fl.featureId = f.id
        allLayers.current.set(f.id, [...(allLayers.current.get(f.id) ?? []), layer])
        if (isPolygon) {
          const b = (layer as L.Polygon).getBounds()
          featArea.current.set(f.id, (b.getEast() - b.getWest()) * (b.getNorth() - b.getSouth()))
        }
        if (!isPolygon) markerSize.current.set(f.id, style.size ?? 1)
        if (f.entity_name && !derived) {
          // Poligonda ad sürekli ortada, poligon boyutuna orantılı; marker'da üzerine gelince
          if (isPolygon) {
            layer.bindTooltip(f.entity_name, {
              permanent: true,
              direction: 'center',
              className: 'poly-label'
            })
            const b = (layer as L.Polygon).getBounds()
            const base = Math.min(
              200,
              Math.max(8, (b.getEast() - b.getWest()) / Math.max(4, f.entity_name.length))
            )
            labelMeta.current.set(f.id, { base, font: style.font ?? 'Cinzel' })
          } else {
            layer.bindTooltip(f.entity_name, { sticky: true })
          }
        }
        layer.on('click', () => {
          // Fetih modu: tıklamalar alıcı/fethedilen seçimidir, seçim paneli açılmaz
          const c = conquestRef.current
          if (c) {
            if (!f.entity_id || !isPolygon) return
            if (c.step === 'alıcı') {
              const pid = parentAt(parentHist.current.get(f.entity_id) ?? [], yearRef.current)
              if (pid === null) {
                alertDialog(
                  t('This entity has no parent — first set a "Parent" from the entity page.')
                )
                return
              }
              setConquest({
                step: 'seçim',
                receiverId: pid,
                receiverName: allEntities.find((x) => x.id === pid)?.name ?? `#${pid}`,
                picked: new Set()
              })
              return
            }
            // adım 2: seçimi aç/kapa (alıcının o yılki kendi çocukları atlanır)
            if (
              parentAt(parentHist.current.get(f.entity_id) ?? [], yearRef.current) === c.receiverId
            )
              return
            const picked = new Set(c.picked)
            if (picked.has(f.entity_id)) picked.delete(f.entity_id)
            else picked.add(f.entity_id)
            setConquest({ ...c, picked })
            highlightPicked(picked)
            return
          }
          setSelected(f)
        })
        const saveGeometry = async (e: { layer: L.Layer }, weld: boolean): Promise<void> => {
          const oldGeometry = f.geometry
          const newGeometry = JSON.stringify((e.layer as L.Polygon).toGeoJSON().geometry)
          const updates = [{ id: f.id, old: oldGeometry, next: newGeometry }]
          if (weld) {
            // Ctrl-kaynakla canlı taşınan komşular: katmandaki güncel geometri DB'ye yazılır
            for (const [fid, ly] of weldTouched.current) {
              if (fid === f.id) continue
              const dbOld = wm.features.find((x) => x.id === fid)?.geometry
              if (dbOld)
                updates.push({ id: fid, old: dbOld, next: JSON.stringify(ly.toGeoJSON().geometry) })
            }
            weldTouched.current.clear()
          }
          pushUndo({
            undo: async () => {
              for (const u of updates) await api.updateFeature(u.id, { geometry: u.old })
            },
            redo: async () => {
              for (const u of updates) await api.updateFeature(u.id, { geometry: u.next })
            }
          })
          for (const u of updates) await api.updateFeature(u.id, { geometry: u.next })
          if (updates.length > 1) await reloadFeatures() // kaynaklanan komşular yeniden çizilsin
        }
        // Canlı kaynak: Ctrl basılıyken köşe sürüklemeye başlanınca aynı noktadaki komşu
        // köşeler bulunur, sürükleme boyunca birlikte taşınır (mıknatıs gibi tek nokta hissi).
        // ponytail: aynı oturumda iki komşu birden geoman'la düzenlenirse sonuncunun kaydı kaynağı ezebilir.
        const dragLL = (e: unknown): L.LatLng | undefined =>
          (e as { markerEvent?: { target?: L.Marker } }).markerEvent?.target?.getLatLng?.()
        const partnerRings = (poly: L.Polygon): L.LatLng[][] => {
          const r = poly.getLatLngs()
          return (Array.isArray(r[0]) ? r : [r]) as L.LatLng[][]
        }
        layer.on('pm:markerdragstart', (e) => {
          dragPartners.current = []
          if (!ctrlRef.current || !isPolygon) return
          const ll = dragLL(e)
          if (!ll) return
          const EPS = 0.01 // ponytail: çakışıklık toleransı (harita birimi) — gerekirse tek sayı ayarı
          for (const [fid, lys] of allLayers.current) {
            if (fid === f.id) continue
            for (const ly of lys) {
              const poly = ly as L.Polygon
              if (!poly.getLatLngs) continue
              partnerRings(poly).forEach((ring, ri) =>
                ring.forEach((pt, vi) => {
                  if (Math.abs(pt.lat - ll.lat) < EPS && Math.abs(pt.lng - ll.lng) < EPS)
                    dragPartners.current.push({ layer: poly, fid, ring: ri, idx: vi })
                })
              )
            }
          }
        })
        layer.on('pm:markerdrag', (e) => {
          if (!dragPartners.current.length) return
          const ll = dragLL(e)
          if (!ll) return
          for (const p of dragPartners.current) {
            const rings = partnerRings(p.layer)
            rings[p.ring][p.idx] = ll
            p.layer.setLatLngs(rings)
          }
        })
        layer.on('pm:markerdragend', () => {
          for (const p of dragPartners.current) {
            weldTouched.current.set(p.fid, p.layer)
            // partnerin köşe marker'ları eski yerde kalır — düzenleme modunu tazele
            const pm = (
              p.layer as unknown as {
                pm?: { enabled?: () => boolean; disable: () => void; enable: () => void }
              }
            ).pm
            if (pm?.enabled?.()) {
              pm.disable()
              pm.enable()
            }
          }
          dragPartners.current = []
        })
        // Köşe düzenlemede kaynak var; poligonu bütün olarak taşımada (drag) yok —
        // taşıma "komşudan kopar" demektir, komşuyu peşinden sürüklememeli.
        layer.on('pm:update', (e) => saveGeometry(e, true))
        layer.on('pm:dragend', (e) => saveGeometry(e, false))
        layer.on('contextmenu', (e: L.LeafletMouseEvent) => {
          e.originalEvent.preventDefault()
          const items: MenuItem[] = []
          if (f.entity_id)
            items.push({ label: t('📖 Open entity'), onClick: () => onOpenEntity(f.entity_id!) })
          items.push({
            label: f.entity_id ? t('🔍 Show in panel') : t('🔗 Link to entity…'),
            onClick: () => setSelected(f)
          })
          if (style.childMapId)
            items.push({
              label: t('🗺 Open map →'),
              onClick: () => onNavigate(style.childMapId!)
            })
          items.push({
            label: t('⏳ Change border from this year'),
            onClick: () => forkFeature(f)
          })
          items.push({
            label: t('📅 Add event to this drawing'),
            onClick: () => setEventDraft({ f, year: yearRef.current })
          })
          items.push({ label: t('🗑 Delete'), danger: true, onClick: () => removeFeature(f.id) })
          setMenu({ x: e.originalEvent.clientX, y: e.originalEvent.clientY, items })
        })
        fg.addLayer(layer)
      })
    }
    setChangeYears([...chYears].sort((a, b) => a - b))
    // reposition=true: çizimler yeni kuruldu, tooltip'ler taban font'ta konumlandı; font ölçeklendikten
    // sonra bir kez yeniden ortalanmalı (ayar değişiminde etiket kayması buradan gelirdi). Nadir yol.
    applyYear(yearRef.current, true)
  }

  // Yıl uygulaması: (1) yıl aralığı dışındaki çizimleri gizle/geri getir, (2) kademe modunda
  // taban poligonları o yılki kademe atasının rengine, (3) varsayılan görünümde zincir tepesinin
  // rengine boya + kök etiketlerini yerleştir. Slider'ın her tikinde yalnız bu çalışır — DB yok.
  const applyYear = (year: number, reposition = false): void => {
    yearRef.current = year
    const fg = featureGroupRef.current
    if (!fg) return
    const kademeOn = activeModeRef.current?.kind === 'kademe'
    // Varsayılan (kök) görünümü: taban poligonlar o yılki zincirin TEPESİNDEKİ maddenin rengine
    // boyanır (üstü boş = en üst kabulü); kökün adı en büyük parçasının üzerine tek etiket olur.
    const topOnly = activeModeRef.current === null
    // Üst zincirini yıla göre tırman, görüntülenen kademedeki atayı bul (döngü korumalı)
    const rungColor = (eid: number): string => {
      let cur: number | undefined = eid
      const seen = new Set<number>()
      while (cur !== undefined && !seen.has(cur)) {
        const hit = rungTargets.current.get(cur)
        if (hit) return hit
        seen.add(cur)
        cur = parentAt(parentHist.current.get(cur) ?? [], year) ?? undefined
      }
      return '#666666' // o yıl bu kademede sahibi yok
    }
    // Zincirin tepesi (döngü korumalı, applyYear başına memo'lu)
    const rootMemo = new Map<number, number>()
    const rootOf = (eid: number): number => {
      const hit = rootMemo.get(eid)
      if (hit !== undefined) return hit
      let cur = eid
      const seen = new Set<number>()
      while (!seen.has(cur)) {
        seen.add(cur)
        const p = parentAt(parentHist.current.get(cur) ?? [], year)
        if (p === null) break
        cur = p
      }
      rootMemo.set(eid, cur)
      return cur
    }
    const inYears = (fid: number): boolean => {
      const y = layerYears.current.get(fid)
      return !y || ((y.from ?? -Infinity) <= year && year <= (y.to ?? Infinity))
    }
    // 1. geçiş (yalnız kök görünümü): görünür taban poligonları köke göre grupla,
    // her kökün etiket taşıyıcısını (en büyük parça) seç
    const carrier = new Map<number, number>() // rootId → fid
    if (topOnly) {
      for (const [fid] of allLayers.current) {
        const eid = featEnt.current.get(fid)
        if (eid === undefined || !baseSet.current.has(eid) || !inYears(fid)) continue
        if (!featArea.current.has(fid)) continue // yalnız poligonlar
        const root = rootOf(eid)
        const cur = carrier.get(root)
        if (
          cur === undefined ||
          (featArea.current.get(fid) ?? 0) > (featArea.current.get(cur) ?? 0)
        )
          carrier.set(root, fid)
      }
    }
    for (const [fid, layers] of allLayers.current) {
      let visible = inYears(fid)
      // Katman paneli: türü kapalıysa çizim hiç gösterilmez
      const kind = featKind.current.get(fid)
      if (kind && !layersRef.current[kind]) visible = false
      const eid = featEnt.current.get(fid)
      const isBase = eid !== undefined && baseSet.current.has(eid) && featArea.current.has(fid)
      let st = renderStyle.current.get(fid)
      let labelRoot: number | null = null // taşıyıcıysa kök id'si; -1 = taban etiketi gizle
      if (topOnly && eid !== undefined) {
        if (isBase) {
          // Yalnız renk kökten gelir; opaklık/kalınlık çizimin kendi ayarında kalır
          const root = rootOf(eid)
          if (st) st = { ...st, color: entColors.current.get(root) ?? '#666666' }
          labelRoot = carrier.get(root) === fid ? root : -1
        } else if (featArea.current.has(fid)) {
          // Gizleme kuralları yalnız POLİGON sınırları için: üst maddenin elle çizilmiş sınırı
          // mozaikle temsil ediliyorsa çift görüntü olmasın. Pin ve yollar (maddesi kime bağlı
          // olursa olsun) süslemedir, her zaman kendi görünümüyle kalır.
          if (parentAt(parentHist.current.get(eid) ?? [], year) !== null) {
            visible = false // üstü var → zincirin tepesi değil
          } else if (mosaicManaged.current.has(eid)) {
            visible = false // sınırı mozaikten türetiliyor (herhangi bir yıl); eski çizimi hiç gösterme
          }
        }
      }
      if (kademeOn && st) {
        const c = eid !== undefined ? rungColor(eid) : '#666666'
        st = { ...st, color: c }
      }
      const arrow = featArrow.current.get(fid)
      for (const l of layers) {
        if (visible && !fg.hasLayer(l)) fg.addLayer(l)
        else if (!visible && fg.hasLayer(l)) fg.removeLayer(l)
        if (visible && st && (l as L.Path).setStyle) {
          // dashArray kanonik değere döner — fetih vurgusunun kesikli kenarı kalıcı kalmasın,
          // yol (çizgi) desenleri ise korunur (renderStyle'da saklı)
          ;(l as L.Path).setStyle({
            color: st.color,
            fillColor: st.color,
            fillOpacity: st.fillOpacity,
            weight: st.weight,
            opacity: st.opacity,
            dashArray: st.dashArray
          })
        }
        // 'end' oku: gerçek çizgi path'ine marker-end. Katman eklendikten sonra element var;
        // ok rengi context-stroke ile çizgiyi izler. ('flow' overlay kendi markerlarını 'add'de kurar.)
        if (visible && arrow === 'end') {
          const el = (l as L.Path).getElement?.() as SVGElement | null
          el?.setAttribute('marker-end', 'url(#worldArrow)')
        }
        // Kalıcı etiketler: katman paneli kapalıysa hepsi gizli; kök görünümünde taşıyıcı
        // kökün adını taşır, diğer taban etiketleri gizli
        if (visible) {
          const tt = l.getTooltip?.()
          const el = tt?.getElement()
          if (tt && el && tt.options.permanent) {
            if (!layersRef.current.label || labelRoot === -1) el.style.display = 'none'
            else {
              if (labelRoot !== null) {
                const name = entNames.current.get(labelRoot) ?? ''
                tt.setContent(name)
                const b = (l as L.Polygon).getBounds()
                labelMeta.current.set(fid, {
                  base: Math.min(
                    200,
                    Math.max(8, (b.getEast() - b.getWest()) / Math.max(4, name.length))
                  ),
                  font: labelMeta.current.get(fid)?.font ?? 'Cinzel'
                })
              }
              el.style.display = ''
            }
          }
        }
      }
    }
    updateOverlaySizes(reposition) // geri eklenen etiket/pin boyutları güncel zoom'a otursun
  }

  // Katman panelini settings'ten yükle (kalıcı tercih); toggle anında DB'siz uygular
  useEffect(() => {
    api.getSetting('mapLayers').then((raw) => {
      if (!raw) return
      const v = { ...layersRef.current, ...(JSON.parse(raw) as Partial<typeof layersOn>) }
      setLayersOn(v)
      layersRef.current = v
      applyYear(yearRef.current)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggleLayer = (k: keyof typeof layersOn): void => {
    const v = { ...layersRef.current, [k]: !layersRef.current[k] }
    layersRef.current = v
    setLayersOn(v)
    api.setSetting('mapLayers', JSON.stringify(v))
    applyYear(yearRef.current)
  }

  // Fetih seçim vurguları: önce kanonik stile dön, sonra seçili maddelerin poligonlarını vurgula
  const highlightPicked = (picked: Set<number>): void => {
    applyYear(yearRef.current)
    for (const [fid, eid] of featEnt.current)
      if (picked.has(eid))
        for (const ly of allLayers.current.get(fid) ?? [])
          (ly as L.Path).setStyle?.({ color: '#ffffff', weight: 4, dashArray: '6' })
  }

  // Del/Backspace: seçili çizimi sil (bir girdi alanına yazarken değil)
  useEffect(() => {
    if (!selected) return
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement
      const typing =
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
      if (typing) return
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        removeFeature(selected.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id])

  // Esc: fetih akışını iptal et, seçim vurgularını temizle
  useEffect(() => {
    if (!conquest) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setConquest(null)
        applyYear(yearRef.current)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conquest !== null])

  // Fetih onayı: seçilen her madde, slider yılından itibaren alıcıya bağlanır (tek undo kaydı)
  const commitConquest = async (): Promise<void> => {
    const c = conquestRef.current
    setConquest(null)
    if (!c || c.step !== 'seçim' || c.picked.size === 0) {
      applyYear(yearRef.current)
      return
    }
    const year = yearRef.current
    const updates: { id: number; old: string; next: string }[] = []
    for (const eid of c.picked) {
      const e = await api.getEntity(eid)
      if (!e) continue
      const f = JSON.parse(e.fields || '{}') as Record<string, string>
      const recs = getParents(e.fields).filter((r) => r.from !== year) // aynı yıla ikinci fetih öncekini ezer
      recs.push({ from: year, id: c.receiverId })
      recs.sort((a, b) => (a.from ?? -Infinity) - (b.from ?? -Infinity))
      f['üst'] = JSON.stringify(recs)
      updates.push({ id: eid, old: e.fields, next: JSON.stringify(f) })
    }
    pushUndo({
      undo: async () => {
        for (const u of updates) await api.updateEntity(u.id, { fields: u.old })
      },
      redo: async () => {
        for (const u of updates) await api.updateEntity(u.id, { fields: u.next })
      }
    })
    for (const u of updates) await api.updateEntity(u.id, { fields: u.next })
    onChanged()
    await reloadFeatures()
  }

  // Harita kurulumu (id değişince sıfırdan)
  useEffect(() => {
    if (!divRef.current) return
    // Sol tık sürükleme kapalı (çizim/seçim için serbest); kaydırma orta tuşla; zoom butonları yok (HUD var)
    // scrollWheelZoom kapalı: yerine aşağıda özel sürekli (kesirli, animasyonsuz) tekerlek zoom var
    const map = L.map(divRef.current, {
      crs: L.CRS.Simple,
      minZoom: -4,
      maxZoom: 4,
      zoomSnap: 0,
      dragging: false,
      zoomControl: false,
      scrollWheelZoom: false,
      attributionControl: false
    })
    mapRef.current = map

    const host = divRef.current
    let panning = false
    let last: [number, number] = [0, 0]
    const onDown = (e: MouseEvent): void => {
      if (e.button === 1) {
        e.preventDefault() // otomatik kaydırma imlecini engelle
        panning = true
        last = [e.clientX, e.clientY]
      }
    }
    const onMove = (e: MouseEvent): void => {
      if (!panning) return
      map.panBy([last[0] - e.clientX, last[1] - e.clientY], { animate: false })
      last = [e.clientX, e.clientY]
    }
    const onUp = (): void => {
      panning = false
    }
    // Sürekli tekerlek zoom: her tık imlecin altını sabit tutarak anında kesirli zoom uygular.
    // Animasyonsuz olduğu için zoom akıcı ve etiketler (zoom olayında) her karede senkron ölçeklenir.
    // ponytail: 0.0015 hassasiyet katsayısı — hızlı/yavaş gelirse tek sayı ayarı
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const next = map.getZoom() - e.deltaY * 0.0015
      const clamped = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), next))
      map.setZoomAround(map.mouseEventToContainerPoint(e), clamped, { animate: false })
    }
    host.addEventListener('mousedown', onDown)
    host.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    const fg = new L.FeatureGroup()
    featureGroupRef.current = fg
    map.addLayer(fg)

    map.on('zoom zoomend', () => {
      showHud(map.getZoom())
      updateOverlaySizes()
    })

    // Boş alana sağ tık → araç menüsü (çizim üzerindeyse layer handler'ı devralır)
    map.on('contextmenu', (e: L.LeafletMouseEvent) => {
      if ((e.originalEvent.target as HTMLElement).classList?.contains('leaflet-interactive')) return
      e.originalEvent.preventDefault()
      setMenu({
        x: e.originalEvent.clientX,
        y: e.originalEvent.clientY,
        items: [
          { label: t('⬠ Draw polygon'), onClick: () => activateTool('polygon') },
          { label: t('〰 Draw path'), onClick: () => activateTool('line') },
          { label: t('📍 Add location'), onClick: () => activateTool('marker') },
          { label: t('✏️ Edit mode'), onClick: () => activateTool('edit') },
          { label: t('✋ Move mode'), onClick: () => activateTool('drag') },
          { label: t('🗑 Delete mode'), onClick: () => activateTool('remove') }
        ]
      })
    })

    map.on('pm:create', async (e) => {
      const geometry = JSON.stringify((e.layer as L.Polygon).toGeoJSON().geometry)
      map.removeLayer(e.layer)
      // O anki araç ayarlarının anlık görüntüsü çizimin kalıcı stili olur.
      // from = çizim anındaki slider yılı: çizim, var olmadığı tarihlerde görünmez
      // (seçili çizim panelindeki "Zaman" bloğundan değiştirilebilir/temizlenebilir).
      const s = drawRef.current
      const shape = (e as { shape?: string }).shape
      const from = yearRef.current
      const style = JSON.stringify(
        shape === 'Marker'
          ? { size: s.marker.size, from }
          : shape === 'Line'
            ? {
                color: s.line.color,
                weight: s.line.weight,
                opacity: s.line.opacity,
                dash: s.line.dash,
                arrow: s.line.arrow,
                from
              }
            : {
                color: s.polygon.color,
                fillOpacity: s.polygon.fillOpacity,
                weight: s.polygon.weight,
                font: s.polygon.font,
                from
              }
      )
      const created = await api.createFeature({ map_id: id, geometry, style })
      const ref = { id: created.id }
      pushUndo({
        undo: () => api.deleteFeature(ref.id),
        redo: async () => {
          ref.id = (await api.createFeature({ map_id: id, geometry, style })).id
        }
      })
      toolRef.current = null
      setToolState(null)
      await reloadFeatures()
    })
    map.on('pm:remove', async (e) => {
      const fid = (e.layer as FeatureLayer).featureId
      if (fid) await removeFeature(fid)
    })

    map.setView([500, 500], 0) // varsayılan; zemin görseli ayrı effect'te yüklenir
    reloadFeatures()
    api.listEntities().then(setAllEntities)
    api.getSetting('drawSettings').then((raw) => {
      if (!raw) return
      // Alan bazında birleştir: eski kayıtlarda olmayan yeni ayarlar (ör. font) varsayılandan gelsin
      const p = JSON.parse(raw) as Partial<DrawSettings>
      const s: DrawSettings = {
        marker: { ...DEFAULT_DRAW.marker, ...p.marker },
        polygon: { ...DEFAULT_DRAW.polygon, ...p.polygon },
        line: { ...DEFAULT_DRAW.line, ...p.line }
      }
      drawRef.current = s
      setDrawSettingsState(s)
    })
    setSelected(null)

    return () => {
      clearTimeout(hudTimer.current)
      host.removeEventListener('mousedown', onDown)
      host.removeEventListener('wheel', onWheel)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      map.remove()
      mapRef.current = null
      featureGroupRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // "Haritada göster": çizim yüklenene kadar kısa aralıklarla dene, bulunca üzerine uç
  useEffect(() => {
    if (!focus) return
    let tries = 0
    const t = setInterval(() => {
      let found: L.Layer | undefined
      featureGroupRef.current?.eachLayer((l) => {
        if ((l as FeatureLayer).featureId === focus.featureId) found = l
      })
      if (found || ++tries > 20) {
        clearInterval(t)
        if (found && mapRef.current) {
          const b =
            (found as L.Polygon).getBounds?.() ?? L.latLngBounds([(found as L.Marker).getLatLng()])
          mapRef.current.fitBounds(b.pad(0.4), { maxZoom: 2 })
        }
      }
    }, 100)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.token])

  // Zemin görseli: image_path değişince katmanı ekle/yenile (remount gerekmez → ekleme anında görünür)
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    imageLayerRef.current?.remove()
    imageLayerRef.current = null
    if (worldMap?.image_path && worldMap.width && worldMap.height) {
      const bounds: L.LatLngBoundsExpression = [
        [0, 0],
        [worldMap.height, worldMap.width]
      ]
      imageLayerRef.current = L.imageOverlay(assetUrl(worldMap.image_path), bounds).addTo(map)
      map.fitBounds(bounds)
      // Görselin dışına çirkin gri boşluğa kaçmayı engelle: pan sınırlı, tam sığdırmadan fazla uzaklaşılamaz
      map.options.maxBoundsViscosity = 1
      map.setMaxBounds(L.latLngBounds(bounds).pad(0.5))
      map.setMinZoom(map.getBoundsZoom(bounds) - 1)
    }
  }, [worldMap?.image_path, worldMap?.width, worldMap?.height])

  // Undo/redo sonrası: harita remount edilmeden çizimleri tazele (zoom/konum korunur)
  const firstToken = useRef(true)
  useEffect(() => {
    if (firstToken.current) {
      firstToken.current = false
      return
    }
    reloadFeatures()
    setSelected(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadToken])

  const selStyle = selected ? (JSON.parse(selected.style || '{}') as FeatureStyle) : {}
  const selIsPolygon = selected ? selected.geometry.includes('"Polygon"') : false
  const selIsLine = selected ? selected.geometry.includes('"LineString"') : false

  // Seçili çizimin stilini düzenle — seçim başına TEK undo kaydı (kaydırıcı spam'i yok)
  const styleEditRef = useRef<{ fid: number; orig: string; latest: string } | null>(null)
  const editSelectedStyle = async (patch: Partial<FeatureStyle>): Promise<void> => {
    if (!selected) return
    const nextStr = JSON.stringify({ ...selStyle, ...patch })
    if (styleEditRef.current?.fid !== selected.id) {
      const ref = { fid: selected.id, orig: selected.style || '{}', latest: nextStr }
      styleEditRef.current = ref
      pushUndo({
        undo: () => api.updateFeature(ref.fid, { style: ref.orig }),
        redo: () => api.updateFeature(ref.fid, { style: ref.latest })
      })
    } else {
      styleEditRef.current.latest = nextStr
    }
    await api.updateFeature(selected.id, { style: nextStr })
    setSelected({ ...selected, style: nextStr })
    await reloadFeatures()
  }

  // Hiyerarşi panelinden 📍: çizim bu haritadaysa odaklan, değilse ilgili haritaya git
  const locateEntity = async (eid: number): Promise<void> => {
    const feats = await api.featuresByEntity(eid)
    if (!feats.length) {
      alertDialog(t('This entity has no drawing on the map.'))
      return
    }
    const here = feats.find((f) => f.map_id === id)
    if (!here) {
      onNavigate(feats[0].map_id)
      return
    }
    let found: L.Layer | undefined
    featureGroupRef.current?.eachLayer((l) => {
      if ((l as FeatureLayer).featureId === here.id) found = l
    })
    if (found && mapRef.current) {
      const b =
        (found as L.Polygon).getBounds?.() ?? L.latLngBounds([(found as L.Marker).getLatLng()])
      mapRef.current.fitBounds(b.pad(0.4), { maxZoom: 2 })
    }
  }

  // Araç panelini kenarından sürükleyerek genişlet/daralt
  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const startW = panelW
    const onMove = (ev: MouseEvent): void =>
      setPanelW(Math.min(480, Math.max(180, startW + startX - ev.clientX)))
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const linkEntity = async (entityId: number): Promise<void> => {
    await api.updateFeature(selected!.id, { entity_id: entityId })
    setLinkName('')
    await reloadFeatures()
    setSelected((await api.getMap(id))?.features.find((f) => f.id === selected!.id) ?? null)
  }

  return (
    <div className="map-wrap">
      <div className="map-toolbar">
        {crumbs.map((c, i) => (
          <span key={c.id}>
            {i > 0 && ' › '}
            {c.id === id ? (
              <b>{c.name}</b>
            ) : (
              <a href="#" onClick={(e) => (e.preventDefault(), onNavigate(c.id))}>
                {c.name}
              </a>
            )}
          </span>
        ))}
        {worldMap && !worldMap.image_path && (
          <button
            onClick={async () => {
              const path = await api.pickImage()
              if (!path) return
              // Boyutları öğrenmek için görseli önce yükle; başarısız olursa kullanıcıyı uyar
              const img = new Image()
              img.onload = async () => {
                await api.updateMap(id, {
                  image_path: path,
                  width: img.naturalWidth,
                  height: img.naturalHeight,
                  layers: JSON.stringify([{ type: 'image', path }])
                })
                await reloadFeatures() // worldMap tazelenir → zemin görseli effect'i katmanı ekler
              }
              img.onerror = () =>
                alertDialog(
                  t('Could not load image. The file may be corrupt or in an unsupported format.')
                )
              img.src = assetUrl(path)
            }}
          >
            {t('Add base image')}
          </button>
        )}
        <button className="mini" title={t('Export as image')} onClick={exportMap}>
          📷 {t('Export')}
        </button>
        <div className="layers-menu">
          <button
            className={`layers-btn ${layersOpen ? 'open' : ''}`}
            onClick={() => setLayersOpen((o) => !o)}
          >
            🗂 {t('Layers')}{' '}
            <span className="layers-count">{Object.values(layersOn).filter(Boolean).length}/4</span>
          </button>
          {layersOpen && (
            <>
              <div className="layers-backdrop" onClick={() => setLayersOpen(false)} />
              <div className="layers-panel">
                <div className="layers-panel-head">{t('Show on map')}</div>
                {(
                  [
                    ['polygon', '⬟', t('Polygons'), t('State / region borders')],
                    ['line', '〰', t('Paths'), t('Roads, routes, rivers')],
                    ['pin', '📍', t('Pins'), t('Markers on the map')],
                    ['label', '🏷', t('Labels'), t('Names written on polygons')]
                  ] as const
                ).map(([k, icon, label, desc]) => (
                  <label key={k} className="layers-row">
                    <input type="checkbox" checked={layersOn[k]} onChange={() => toggleLayer(k)} />
                    <span className="layers-icon">{icon}</span>
                    <span className="layers-text">
                      <span className="layers-name">{label}</span>
                      <span className="layers-desc">{desc}</span>
                    </span>
                  </label>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
      <div className="map-body">
        <div className="map-host-wrap">
          {/* Yol yön oku için SVG marker tanımı (belge genelinde url(#worldArrow) ile referanslanır;
              context-stroke ile ok rengi çizginin rengini izler, markerUnits=strokeWidth ile
              kalınlıkla ölçeklenir → zoom'da ekran-sabit, hot-path yok) */}
          <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden>
            <defs>
              <marker
                id="worldArrow"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="4"
                markerHeight="4"
                orient="auto"
                markerUnits="strokeWidth"
              >
                <path d="M0,1 L9,5 L0,9 L3,5 z" fill="context-stroke" />
              </marker>
            </defs>
          </svg>
          <div ref={divRef} className="leaflet-host" />
          {!exporting && (
            <>
              <Timeline
                changeYears={changeYears}
                eventsToken={eventsToken}
                onYear={applyYear}
                onLocate={focusFeature}
              />
              {conquest?.step === 'alıcı' && (
                <div className="link-hint">
                  {t("⚔ Click the conqueror's border polygon (receiver = its parent)…")}{' '}
                  <button className="mini" onClick={() => setConquest(null)}>
                    {t('cancel')}
                  </button>
                </div>
              )}
              {conquest?.step === 'seçim' && (
                <div className="link-hint">
                  {t('⚔ Select polygons to join {name} ({n} selected)', {
                    name: conquest.receiverName,
                    n: conquest.picked.size
                  })}{' '}
                  <button className="mini" onClick={commitConquest}>
                    {t('OK')}
                  </button>{' '}
                  <button
                    className="mini"
                    onClick={() => {
                      setConquest(null)
                      applyYear(yearRef.current)
                    }}
                  >
                    {t('cancel')}
                  </button>
                </div>
              )}
              {eventDraft && (
                <form
                  className="link-hint"
                  onSubmit={(e) => {
                    e.preventDefault()
                    saveEventDraft(new FormData(e.currentTarget).get('name') as string)
                  }}
                >
                  {t('📅 Event name (year {n}):', { n: eventDraft.year })}{' '}
                  <input name="name" autoFocus placeholder={t('event name')} />
                  <button className="mini" type="submit">
                    {t('add')}
                  </button>
                  <button className="mini" type="button" onClick={() => setEventDraft(null)}>
                    {t('cancel')}
                  </button>
                </form>
              )}
              {hudZoom !== null && (
                <div className="zoom-hud" onMouseMove={() => showHud(hudZoom)}>
                  <input
                    type="range"
                    min={hudRange[0]}
                    max={hudRange[1]}
                    step={0.25}
                    value={hudZoom}
                    onChange={(e) => mapRef.current?.setZoom(Number(e.target.value))}
                  />
                  <span className="zoom-pct">%{Math.round(2 ** hudZoom * 100)}</span>
                </div>
              )}
              <HierarchyPanel
                active={activeMode}
                reloadToken={reloadToken}
                onMode={(m) => {
                  activeModeRef.current = m
                  setActiveMode(m)
                  setConquest(null)
                  reloadFeatures()
                }}
                onConquest={() => setConquest({ step: 'alıcı' })}
                onOpenEntity={onOpenEntity}
                onLocate={locateEntity}
              />
            </>
          )}
        </div>
        {selected && (
          <div className="map-panel">
            <div className="map-panel-head">
              <b>{t('Drawing #{id}', { id: selected.id })}</b>
              <button className="mini" onClick={() => setSelected(null)}>
                ×
              </button>
            </div>

            <div className="panel-block">
              <label>{t('View:')}</label>
              {selIsPolygon ? (
                <>
                  <ColorPicker
                    value={selStyle.color ?? typeColor(types, selected.entity_type)}
                    onChange={(color) => editSelectedStyle({ color })}
                  />
                  <label>
                    {t('Fill opacity: {val}', { val: (selStyle.fillOpacity ?? 0.25).toFixed(2) })}
                  </label>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={selStyle.fillOpacity ?? 0.25}
                    onChange={(e) => editSelectedStyle({ fillOpacity: Number(e.target.value) })}
                  />
                  <label>{t('Outline thickness: {val}px', { val: selStyle.weight ?? 2 })}</label>
                  <input
                    type="range"
                    min={1}
                    max={10}
                    step={1}
                    value={selStyle.weight ?? 2}
                    onChange={(e) => editSelectedStyle({ weight: Number(e.target.value) })}
                  />
                  <label>{t('Label font')}</label>
                  <select
                    value={selStyle.font ?? 'Cinzel'}
                    style={{ fontFamily: selStyle.font ?? 'Cinzel' }}
                    onChange={(e) => editSelectedStyle({ font: e.target.value })}
                  >
                    {FONTS.map((fnt) => (
                      <option key={fnt} value={fnt} style={{ fontFamily: fnt }}>
                        {fnt}
                      </option>
                    ))}
                  </select>
                </>
              ) : selIsLine ? (
                <>
                  <ColorPicker
                    value={selStyle.color ?? '#b08968'}
                    onChange={(color) => editSelectedStyle({ color })}
                  />
                  <label>{t('Thickness: {val}px', { val: selStyle.weight ?? 3 })}</label>
                  <input
                    type="range"
                    min={1}
                    max={12}
                    step={1}
                    value={selStyle.weight ?? 3}
                    onChange={(e) => editSelectedStyle({ weight: Number(e.target.value) })}
                  />
                  <label>
                    {t('Opacity: {val}', { val: (selStyle.opacity ?? 0.9).toFixed(2) })}
                  </label>
                  <input
                    type="range"
                    min={0.1}
                    max={1}
                    step={0.05}
                    value={selStyle.opacity ?? 0.9}
                    onChange={(e) => editSelectedStyle({ opacity: Number(e.target.value) })}
                  />
                  <label>{t('Line style')}</label>
                  <select
                    value={selStyle.dash ?? 'solid'}
                    onChange={(e) => editSelectedStyle({ dash: e.target.value as LineDash })}
                  >
                    {LINE_DASHES.map((d) => (
                      <option key={d} value={d}>
                        {t(DASH_LABELS[d])}
                      </option>
                    ))}
                  </select>
                  <label>{t('Direction arrow')}</label>
                  <select
                    value={selStyle.arrow ?? 'none'}
                    onChange={(e) => editSelectedStyle({ arrow: e.target.value as LineArrow })}
                  >
                    {LINE_ARROWS.map((a) => (
                      <option key={a} value={a}>
                        {t(ARROW_LABELS[a])}
                      </option>
                    ))}
                  </select>
                </>
              ) : (
                <>
                  <label>{t('Size: ×{val}', { val: (selStyle.size ?? 1).toFixed(2) })}</label>
                  <input
                    type="range"
                    min={0.5}
                    max={3}
                    step={0.25}
                    value={selStyle.size ?? 1}
                    onChange={(e) => editSelectedStyle({ size: Number(e.target.value) })}
                  />
                </>
              )}
            </div>

            <div className="panel-block">
              <label>{t('Time (blank = always; negative = before epoch):')}</label>
              <div className="field-row">
                <input
                  type="number"
                  placeholder={t('start')}
                  defaultValue={selStyle.from ?? ''}
                  key={`from-${selected.id}`}
                  onBlur={(e) =>
                    editSelectedStyle({
                      from: e.target.value === '' ? undefined : Number(e.target.value)
                    })
                  }
                />
                <input
                  type="number"
                  placeholder={t('end')}
                  defaultValue={selStyle.to ?? ''}
                  key={`to-${selected.id}`}
                  onBlur={(e) =>
                    editSelectedStyle({
                      to: e.target.value === '' ? undefined : Number(e.target.value)
                    })
                  }
                />
              </div>
            </div>

            {selected.entity_id ? (
              <>
                <button
                  className="mini"
                  onClick={async () => (
                    await api.updateFeature(selected.id, { entity_id: null }),
                    reloadFeatures(),
                    setSelected({
                      ...selected,
                      entity_id: null,
                      entity_name: null,
                      entity_type: null
                    })
                  )}
                >
                  {t('Unlink entity')}
                </button>
                <EntityPage
                  id={selected.entity_id}
                  types={types}
                  compact
                  onOpen={onOpenEntity}
                  onChanged={() => (reloadFeatures(), onChanged())}
                  onDeleted={() => (setSelected(null), reloadFeatures())}
                />
              </>
            ) : (
              <div className="panel-block">
                <label>{t('Link to entity:')}</label>
                <input
                  list="entity-list-map"
                  placeholder={t('search entity…')}
                  value={linkName}
                  onChange={(e) => setLinkName(e.target.value)}
                />
                <datalist id="entity-list-map">
                  {allEntities
                    .filter((en) => !personTypeNames.includes(en.type))
                    .map((en) => (
                      <option key={en.id} value={en.name} />
                    ))}
                </datalist>
                <button
                  className="mini"
                  onClick={async () => {
                    if (!linkName.trim()) return
                    const found = allEntities.find(
                      (en) => en.name === linkName && !personTypeNames.includes(en.type)
                    )
                    if (found) return linkEntity(found.id)
                    const { id: newId } = await api.createEntity({ name: linkName.trim() })
                    setAllEntities(await api.listEntities())
                    onChanged()
                    await linkEntity(newId)
                  }}
                >
                  {t('Link / Create')}
                </button>
              </div>
            )}

            <div className="panel-block">
              <label>{t('Child map (door):')}</label>
              <select
                value={selStyle.childMapId ?? ''}
                onChange={async (e) => {
                  const childMapId = e.target.value ? Number(e.target.value) : undefined
                  await api.updateFeature(selected.id, {
                    style: JSON.stringify({ ...selStyle, childMapId })
                  })
                  if (childMapId) await api.updateMap(childMapId, { parent_map_id: id })
                  onChanged()
                  setSelected({ ...selected, style: JSON.stringify({ ...selStyle, childMapId }) })
                }}
              >
                <option value="">{t('— none —')}</option>
                {maps
                  .filter((m) => m.id !== id)
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
              </select>
              {selStyle.childMapId && (
                <button className="mini" onClick={() => onNavigate(selStyle.childMapId!)}>
                  {t('Open map →')}
                </button>
              )}
            </div>
          </div>
        )}
        <div className="panel-resize" onMouseDown={startResize} />
        <div className="tool-panel" style={{ width: panelW, minWidth: panelW }}>
          <ToolPanel
            active={tool}
            settings={drawSettings}
            onTool={activateTool}
            onSettings={updateDrawSettings}
          />
        </div>
      </div>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  )
}
