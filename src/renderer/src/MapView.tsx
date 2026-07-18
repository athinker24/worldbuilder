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
  getPinImages,
  getTimeline,
  MapRow,
  mergeHierConfig,
  ParentRec,
  parentAt,
  PinImage,
  savePinImages,
  saveTimeline,
  TypeDef,
  typeColor,
  WorldMap
} from './api'
import ColorPicker from './ColorPicker'
import ContextMenu, { MenuItem, MenuState } from './ContextMenu'
import { ImageStrip } from './pinIcons'
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
  MapScale,
  NavLeg,
  NavRoute,
  Tool,
  TravelMode
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
  curviness?: number // eğrilik 0-100 (yalnız çizgi; görsel overlay, vertex'leri değiştirmez)
  img?: string // özel pin görseli (assets/ göreli yolu); varsa glyph ikonun yerine geçer
  imgFree?: boolean // true = rozetsiz serbest görsel (en-boy korunur), false/boş = rozet içinde
  imgAR?: number // görselin en/boy oranı — serbest modda yükseklik buradan (kütüphaneden değil)
  fillImg?: string // poligon dolgu görseli (assets/ göreli yolu) — SVG pattern ile döşenir
  fillImgAR?: number // dolgu görselinin en/boy oranı (desen karosunun yüksekliği için)
  text?: string // serbest metin etiketi (Point geometry + bu alan = etiket, pin değil)
  angle?: number // etiket döndürme açısı (derece)
  curve?: number // etiket eğriliği -100..100 (Wonderdraft curved text; 0 = düz)
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
  // true = bu katman gerçek/düzenlenebilir düz çizgidir ama üstüne eğri overlay'i bindirilmiş,
  // bu yüzden applyYear'da neredeyse görünmez opaklığa (0.03) düşürülür (bkz. curvePoints)
  isCurveControl?: boolean
}

// Pin = renkli yuvarlak rozet + içinde beyaz kartografik ikon (divIcon). Merkez çapa: rozet
// noktanın üstünde ortalı. Taban çap PIN_BASE; zoom'la ölçekleme updateOverlaySizes'ta.
const PIN_BASE = 28
const PIN_DEFAULT_COLOR = '#c0603a'
// Üç görünüm: (1) serbest özel görsel — rozetsiz, en-boy korunur (şeffaf PNG sembolleri);
// (2) rozet içinde özel görsel — daireye kırpılır (arma/portre); (3) gömülü SVG glyph (varsayılan).
const pinDivIcon = (m: {
  size?: number
  color?: string
  img?: string
  imgFree?: boolean
  imgAR?: number
}): L.DivIcon => {
  const s = m.size ?? 1
  const w = PIN_BASE * s
  const color = m.color ?? PIN_DEFAULT_COLOR
  if (m.img && m.imgFree) {
    // Serbest: iconSize/iconAnchor [0,0] + içte translate(-50%,-50%) (etiket deseni) →
    // yükseklik orandan gelir, DOM ölçümü (reflow) gerekmez
    const h = w / (m.imgAR || 1)
    return L.divIcon({
      className: 'pin-marker',
      html: `<img class="pin-img-free" src="${escapeHtml(assetUrl(m.img))}" style="width:${w}px;height:${h}px">`,
      iconSize: [0, 0],
      iconAnchor: [0, 0]
    })
  }
  // Görsel varsa rozet içinde daireye kırpılır; yoksa düz renkli rozet (glyph ikon seti kaldırıldı)
  const inner = m.img ? `<img class="pin-badge-img" src="${escapeHtml(assetUrl(m.img))}">` : ''
  return L.divIcon({
    className: 'pin-marker',
    html: `<div class="pin-badge" style="background:${escapeHtml(color)}">${inner}</div>`,
    iconSize: [w, w],
    iconAnchor: [w / 2, w / 2],
    tooltipAnchor: [0, -w / 2]
  })
}

// Serbest metin etiketi (LegendKeeper "Labels"): poligonsuz/pinsiz harita yazısı — deniz, dağ
// sırası, bölge adı. iconSize/iconAnchor [0,0]: ikonun sol-üstü tam noktada durur, içteki div
// kendini translate(-50%,-50%) ile ortalar → metin uzunluğuna göre genişlik matematiği gerekmez.
// Font boyutu zoom'a göre updateOverlaySizes'ta yazılır (LABEL_BASE = zoom-0 taban, harita birimi).
const LABEL_BASE = 16
// Metin kullanıcı girdisi ve html string'ine gömülüyor → kaçırılmalı (paylaşılan world.db'den XSS
// gelmesin; markdown'da ham HTML'in kapatılmasıyla aynı gerekçe).
const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
// textPath'in href'i belge genelinde çözülür → her etiketin yol id'si benzersiz olmalı
let labelSeq = 0
const labelDivIcon = (s: {
  text?: string
  color?: string
  angle?: number
  curve?: number
}): L.DivIcon => {
  const text = escapeHtml(s.text ?? '')
  const color = escapeHtml(s.color ?? '#ffffff')
  const angle = Number(s.angle) || 0
  const curve = Number(s.curve) || 0
  // Düz metin de SVG textPath ile çizilir (curve=0 → yay düz bir çizgiye çöker; ölçüldü: HTML
  // div ile aynı konum/genişlik). Tek yol olmasının sebebi TIKLAMA: div'de isabet alanı hep
  // kutunun tamamıdır (harflerin dışına basınca da seçilir), SVG'de visiblePainted ile yalnız
  // harfler tıklanır. Tasarım uzayı font-size=100; SVG em cinsinden boyutlanır → _icon'a yazılan
  // fontSize metni ve yayı BİRLİKTE ölçekler, zoom dalı değişmez. Yay bir quadratic Bézier:
  // orta noktası (t=0.5) tam çapada durur (cy = H/2 + sag).
  const F = 100
  const w = Math.max(text.length * F * 0.62, F) // metin genişliği tahmini (harf başına ~0.62em)
  const sag = (curve / 100) * w * 0.3 // yay yüksekliği (sagitta); + yukarı, − aşağı bükülür
  const pad = F
  const W = w + 2 * pad
  const H = 3 * F + 2 * Math.abs(sag)
  const cy = H / 2 + sag
  const id = `lblp${++labelSeq}`
  const html = `<svg class="map-label-svg" viewBox="0 0 ${W} ${H}" style="width:${W / F}em;height:${H / F}em;transform:translate(-50%,-50%) rotate(${angle}deg)"><defs><path id="${id}" fill="none" d="M ${pad},${cy} Q ${W / 2},${cy - 2 * sag} ${W - pad},${cy}"/></defs><text font-size="${F}" fill="${color}" text-anchor="middle" dominant-baseline="central"><textPath href="#${id}" startOffset="50%">${text}</textPath></text></svg>`
  return L.divIcon({ className: 'map-label', html, iconSize: [0, 0], iconAnchor: [0, 0] })
}

// Poligon dolgu görseli (LegendKeeper region fills): SVG <pattern> belge genelinde url(#id) ile
// çözülür (worldArrow marker'ıyla aynı mekanizma). Desen GÖRSEL BAŞINA bir kez tanımlanır,
// poligon başına değil. objectBoundingBox: görsel, REFERANS VEREN poligonun sınır kutusuna
// gerilir → poligona yapışık kalır, zoom'da onunla ölçeklenir (ekran-sabit karo denendi,
// uzaklaşınca desen tekrar edip bozuluyordu — kullanıcı görselin poligonda sabit kalmasını istedi).
// Tek def çok poligona hizmet eder (bbox her referans verende ayrı çözülür). fill-opacity desen
// üstünde doğal çalıştığı için mevcut opaklık kaydırıcısı değişmeden işler.
const fillPatternId = (path: string): string => `fillpat-${path.replace(/[^a-zA-Z0-9]/g, '_')}`

// Harita ölçeği: perUnit = gerçek mesafe / harita birimi (px). İki yöntem: sayısal harita
// genişliği (Wonderdraft) ya da haritada bilinen mesafeyi ölçme. settings 'mapScales' =
// { [mapId]: {perUnit, unit} }. CRS.Simple düzlemsel olduğu için hesap saf Öklid — projeksiyon yok.
const ringLen = (ring: number[][]): number => {
  let s = 0
  for (let i = 1; i < ring.length; i++)
    s += Math.hypot(ring[i][0] - ring[i - 1][0], ring[i][1] - ring[i - 1][1])
  return s
}
const ringArea = (ring: number[][]): number => {
  let s = 0
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i]
    const [x2, y2] = ring[(i + 1) % ring.length]
    s += x1 * y2 - x2 * y1
  }
  return Math.abs(s) / 2
}
const fmtDist = (v: number): string =>
  v >= 100 ? Math.round(v).toLocaleString() : v >= 10 ? v.toFixed(1) : v.toFixed(2)

// Yol/nehir/sınır çizgilerine LegendKeeper tarzı eğrilik: RENDER-ONLY Cardinal spline (Hermite).
// Ham vertex'lere hiç dokunmaz (geoman Edit aracı hâlâ gerçek köşeleri sürükler) — yalnız görsel
// bir overlay üretir (bkz. reloadFeatures/applyYear'daki isCurveControl kullanımı).
// curviness 0-100 → tanjant gücü s (0 = düz çizgiye yakın, 0.5 = klasik Catmull-Rom).
const curvePoints = (coords: number[][], curviness: number): L.LatLng[] => {
  if (coords.length < 3) return coords.map(([x, y]) => L.latLng(y, x))
  const s = (Math.max(0, Math.min(100, curviness)) / 100) * 0.5
  const steps = coords.length > 150 ? 4 : 12 // ponytail: çok uzun yollarda alt bölme azaltılır
  const pt = (i: number): number[] => coords[Math.max(0, Math.min(coords.length - 1, i))]
  const out: L.LatLng[] = []
  for (let i = 0; i < coords.length - 1; i++) {
    const p0 = pt(i - 1)
    const p1 = pt(i)
    const p2 = pt(i + 1)
    const p3 = pt(i + 2)
    const m1 = [(p2[0] - p0[0]) * s, (p2[1] - p0[1]) * s]
    const m2 = [(p3[0] - p1[0]) * s, (p3[1] - p1[1]) * s]
    const n = i === coords.length - 2 ? steps + 1 : steps // eklem noktası yalnız son segmentte dahil edilir
    for (let j = 0; j < n; j++) {
      const t = j / steps
      const t2 = t * t
      const t3 = t2 * t
      const h00 = 2 * t3 - 3 * t2 + 1
      const h10 = t3 - 2 * t2 + t
      const h01 = -2 * t3 + 3 * t2
      const h11 = t3 - t2
      out.push(
        L.latLng(
          h00 * p1[1] + h10 * m1[1] + h01 * p2[1] + h11 * m2[1],
          h00 * p1[0] + h10 * m1[0] + h01 * p2[0] + h11 * m2[0]
        )
      )
    }
  }
  return out
}

// ——— Navigasyon (LegendKeeper "navigation mode"): iki pin arası rota, çizilmiş yol ağı üzerinden.
// Graf yalnız rota istendiğinde kurulur (her karede değil). Koordinatlar ham GeoJSON [x, y] =
// harita pikseli; CRS.Simple düzlemsel olduğu için ağırlıklar saf Öklid (ringLen ile aynı sözleşme).
interface NavEdge {
  to: number
  w: number
  fid: number // kenarın geldiği yol feature'ı; -1 = yol dışı bağlantı
}
type NavLine = { fid: number; coords: number[][] }
type NavPin = { fid: number; xy: number[] }
// Bir pinin yol ağındaki en yakın izdüşümü (li: yol, si: segment, t: segment üzerinde 0-1)
interface NavProj {
  li: number
  si: number
  t: number
  x: number
  y: number
  d: number
}

// Bir noktanın segmente izdüşümü: t = segment üzerindeki 0-1 konumu, d = dik mesafe
const projectOnSeg = (
  p: number[],
  a: number[],
  b: number[]
): { t: number; x: number; y: number; d: number } => {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len2 = dx * dx + dy * dy
  const t =
    len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2))
  const x = a[0] + t * dx
  const y = a[1] + t * dy
  return { t, x, y, d: Math.hypot(p[0] - x, p[1] - y) }
}

// Yol ağından yönsüz graf kur. Kavşaklar `eps` içinde çakışan köşelerin tek düğüme düşmesiyle
// kendiliğinden oluşur (weld kodundaki Chebyshev karşılaştırma konvansiyonu).
// Pinler en yakın segmente izdüşürülür ve o segmentin zincirine düğüm olarak KATILIR — böylece
// aynı yol parçası üzerindeki iki pin arası rota köşeye kadar gidip geri dönmez.
const buildNavGraph = (
  lines: NavLine[],
  pins: NavPin[],
  eps: number
): { nodes: number[][]; adj: NavEdge[][]; pinNode: Map<number, number> } => {
  const nodes: number[][] = []
  const adj: NavEdge[][] = []
  // ponytail: O(n²) lineer tarama — kişisel ölçekte birkaç yüz düğüm, spatial index gereksiz
  const findOrAdd = (x: number, y: number): number => {
    for (let i = 0; i < nodes.length; i++)
      if (Math.abs(nodes[i][0] - x) < eps && Math.abs(nodes[i][1] - y) < eps) return i
    nodes.push([x, y])
    adj.push([])
    return nodes.length - 1
  }
  const addEdge = (a: number, b: number, fid: number): void => {
    if (a === b) return // birleşen köşeler → sıfır uzunluklu self-loop olmasın
    const w = Math.hypot(nodes[a][0] - nodes[b][0], nodes[a][1] - nodes[b][1])
    adj[a].push({ to: b, w, fid })
    adj[b].push({ to: a, w, fid })
  }
  // 1. her pini en yakın segmente izdüşür (tüm yollar taranır; mesafe kapsız)
  const proj: (NavProj | null)[] = pins.map((p): NavProj | null => {
    let best: NavProj | null = null
    lines.forEach((ln, li) => {
      for (let si = 0; si < ln.coords.length - 1; si++) {
        const r = projectOnSeg(p.xy, ln.coords[si], ln.coords[si + 1])
        if (!best || r.d < best.d) best = { li, si, t: r.t, x: r.x, y: r.y, d: r.d }
      }
    })
    return best
  })
  // 2. her yolu zincir olarak kur: v0 → (o segmente düşen pin izdüşümleri, t sırasıyla) → v1 → …
  lines.forEach((ln, li) => {
    const bySeg = new Map<number, { t: number; x: number; y: number }[]>()
    for (const pr of proj) {
      if (!pr || pr.li !== li) continue
      const arr = bySeg.get(pr.si) ?? []
      arr.push({ t: pr.t, x: pr.x, y: pr.y })
      bySeg.set(pr.si, arr)
    }
    let prev = findOrAdd(ln.coords[0][0], ln.coords[0][1])
    for (let si = 0; si < ln.coords.length - 1; si++) {
      for (const m of (bySeg.get(si) ?? []).sort((a, b) => a.t - b.t)) {
        const n = findOrAdd(m.x, m.y)
        addEdge(prev, n, ln.fid)
        prev = n
      }
      const n = findOrAdd(ln.coords[si + 1][0], ln.coords[si + 1][1])
      addEdge(prev, n, ln.fid)
      prev = n
    }
  })
  // 3. pinleri izdüşüm noktalarına bağla (pin zaten yolun üstündeyse aynı düğüme düşer, kenar yok)
  const pinNode = new Map<number, number>()
  pins.forEach((p, i) => {
    const pinIdx = findOrAdd(p.xy[0], p.xy[1])
    pinNode.set(p.fid, pinIdx)
    const pr = proj[i]
    if (pr) addEdge(pinIdx, findOrAdd(pr.x, pr.y), -1)
  })
  return { nodes, adj, pinNode }
}

// Dijkstra (ponytail: O(V²) düğüm seçimi — rota başına bir kez çalışır, heap gereksiz).
// Rota bulunamazsa null. Ardışık aynı fid'li kenarlar tek NavLeg'e toplanır.
const navRoute = (
  g: { nodes: number[][]; adj: NavEdge[][] },
  from: number,
  to: number,
  nameOf: (fid: number) => string | null
): NavRoute | null => {
  const n = g.nodes.length
  const dist = new Array<number>(n).fill(Infinity)
  const prev = new Array<number>(n).fill(-1)
  const prevFid = new Array<number>(n).fill(-1)
  const done = new Array<boolean>(n).fill(false)
  dist[from] = 0
  for (;;) {
    let u = -1
    for (let i = 0; i < n; i++) if (!done[i] && dist[i] < (u === -1 ? Infinity : dist[u])) u = i
    if (u === -1 || u === to) break
    done[u] = true
    for (const e of g.adj[u])
      if (dist[u] + e.w < dist[e.to]) {
        dist[e.to] = dist[u] + e.w
        prev[e.to] = u
        prevFid[e.to] = e.fid
      }
  }
  if (dist[to] === Infinity) return null
  // rotayı geri kur (to → from), sonra ters çevir
  const chain: { node: number; fid: number }[] = []
  for (let cur = to; cur !== from; cur = prev[cur]) {
    if (prev[cur] === -1) return null
    chain.push({ node: cur, fid: prevFid[cur] })
  }
  chain.push({ node: from, fid: -1 })
  chain.reverse()
  const pts = chain.map((c) => g.nodes[c.node])
  const legs: NavLeg[] = []
  let offRoadPx = 0
  for (let i = 1; i < chain.length; i++) {
    const w = Math.hypot(
      g.nodes[chain[i].node][0] - g.nodes[chain[i - 1].node][0],
      g.nodes[chain[i].node][1] - g.nodes[chain[i - 1].node][1]
    )
    const fid = chain[i].fid
    if (fid === -1) offRoadPx += w
    // fid'e göre birleştir (ada göre DEĞİL: adsız yol ile yol-dışı aynı null'u paylaşır)
    const last = legs[legs.length - 1]
    if (last && last.fid === fid) last.px += w
    else legs.push({ fid, name: fid === -1 ? null : nameOf(fid), px: w })
  }
  return { totalPx: dist[to], offRoadPx, legs, pts }
}

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
  // Serbest metin etiketleri (labelMeta'nın divIcon muadili; font boyutu zoom'la ölçeklenir)
  const labelText = useRef(new Map<number, { base: number; font: string }>())
  // Pin boyut çarpanları; poligon etiketleri gibi zoom ile ölçeklenir (haritaya yapışık).
  // ar yalnız SERBEST özel görselli pinlerde dolu (yükseklik = genişlik / ar; DOM ölçümü yok).
  const markerSize = useRef(new Map<number, { size: number; ar?: number }>())
  const [worldMap, setWorldMap] = useState<WorldMap | null>(null)
  const worldMapRef = useRef<WorldMap | null>(null) // handler'lar (navigasyon) güncel feature'ları görsün
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
  const featKind = useRef(new Map<number, 'polygon' | 'line' | 'pin' | 'label'>())
  // Yol yön oku: fid → 'end'|'flow' (SVG marker-mid/end ile, applyYear'da elemana uygulanır)
  const featArrow = useRef(new Map<number, LineArrow>())
  // Her çizimin tekil render stili — applyYear bunlarla DB'siz yeniden boyar.
  // fillColor ayrı: dolgu görseli olan poligonda 'url(#fillpat-…)' taşır (renkten farklı).
  const renderStyle = useRef(
    new Map<
      number,
      {
        color: string
        fillColor: string
        fillOpacity: number
        weight: number
        opacity: number
        dashArray: string
      }
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

  // 📏 Ölçek aracı (sağ paneldeki 'scale' aracının durumu): kayıtlı ölçek + aktif ölçüm oturumu.
  // Oturum türleri: calib (2 nokta → mesafe formu), dist (kümülatif cetvel), area (geçici poligon).
  // dist/area kalıcı çizim OLUŞTURMAZ — Wonderdraft measure tool karşılığı.
  const [mapScale, setMapScale] = useState<MapScale | null>(null)
  const scaleRef = useRef<MapScale | null>(null)
  const [barZoom, setBarZoom] = useState(0) // ölçek çubuğu için (render'da ref okunmaz)
  type Measure =
    | null
    | { kind: 'calib'; pts: L.LatLng[] }
    | { kind: 'calib-form'; a: L.LatLng; b: L.LatLng }
    | { kind: 'dist'; pts: L.LatLng[] }
    | { kind: 'area'; pts: L.LatLng[] }
  const [measure, setMeasureState] = useState<Measure>(null)
  const measureRef = useRef<Measure>(null)
  const setMeasure = (m: Measure): void => {
    measureRef.current = m
    setMeasureState(m)
  }
  const measureTemp = useRef<L.LayerGroup | null>(null) // geçici nokta/çizgi vurguları
  const measurePoly = useRef<L.Polygon | null>(null) // area oturumunun canlı poligonu
  const endMeasure = (): void => {
    measureTemp.current?.remove()
    measureTemp.current = null
    measurePoly.current = null
    setMeasure(null)
  }
  // Tek yazıcı: ölçeği kaydet/sil (settings 'mapScales' harita başına)
  const persistScale = async (sc: MapScale | null): Promise<void> => {
    const all = JSON.parse((await api.getSetting('mapScales')) || '{}')
    if (sc) all[id] = sc
    else delete all[id]
    await api.setSetting('mapScales', JSON.stringify(all))
    scaleRef.current = sc
    setMapScale(sc)
  }
  const saveCalib = async (val: number, unit: string): Promise<void> => {
    const m = measureRef.current
    if (m?.kind !== 'calib-form' || !(val > 0)) return endMeasure()
    const d = Math.hypot(m.a.lat - m.b.lat, m.a.lng - m.b.lng)
    if (d > 0) await persistScale({ perUnit: val / d, unit: unit.trim() || 'km' })
    endMeasure()
  }
  const startMeasure = (kind: 'calib' | 'dist' | 'area'): void => {
    const same = measureRef.current?.kind === kind
    endMeasure()
    if (!same) setMeasure({ kind, pts: [] })
  }
  // Canlı ölçüm metni için: latlng listesi → birimli uzunluk/alan (ölçek yoksa px)
  const measureUnit = mapScale?.unit ?? 'px'
  const measureK = mapScale?.perUnit ?? 1
  const ptsXY = (pts: L.LatLng[]): number[][] => pts.map((p) => [p.lng, p.lat])

  // 🧭 Navigasyon oturumu (Measure deseninin kopyası): iki pin seç → yol ağı üzerinden rota.
  type Nav =
    | null
    | { step: 'a' }
    | { step: 'b'; aFid: number; aName: string }
    | { step: 'result'; aName: string; bName: string; route: NavRoute | null } // null = rota yok
  const [nav, setNavState] = useState<Nav>(null)
  const navRef = useRef<Nav>(null)
  const setNav = (n: Nav): void => {
    navRef.current = n
    setNavState(n)
  }
  const navTemp = useRef<L.LayerGroup | null>(null) // rota vurgusu (kalıcı çizim değil)
  const endNav = (): void => {
    navTemp.current?.remove()
    navTemp.current = null
    setNav(null)
  }
  const startNav = (): void => {
    endMeasure()
    setConquest(null) // çakışan oturum kalmasın
    endNav()
    setSelected(null)
    setNav({ step: 'a' })
  }
  // Özel pin görselleri kütüphanesi (settings 'pinImages', global — travelModes deseni)
  const [pinImages, setPinImages] = useState<PinImage[]>([])
  const savePinLib = async (list: PinImage[]): Promise<void> => {
    setPinImages(list)
    await savePinImages(list)
  }
  // Görsel yükle: pickImage zaten assets/'e kopyalar + uzantı doğrular ve göreli yol döner.
  // Sonra zemin görselindeki load-probe deseni: oranı öğren + dosyanın çözülebildiğini doğrula.
  const uploadPinImage = async (onPicked: (path: string, ar: number) => void): Promise<void> => {
    const path = await api.pickImage()
    if (!path) return
    const im = new Image()
    im.onload = async () => {
      const ar = im.naturalHeight ? im.naturalWidth / im.naturalHeight : 1
      if (!pinImages.some((p) => p.path === path)) await savePinLib([...pinImages, { path, ar }])
      onPicked(path, ar)
    }
    im.onerror = () =>
      alertDialog(t('Could not load image. The file may be corrupt or in an unsupported format.'))
    im.src = assetUrl(path)
  }

  // Seyahat modları (settings 'travelModes', global — mapScales deseni). Hız = birim/gün.
  const [travelModes, setTravelModesState] = useState<TravelMode[]>([])
  const [travelModeIdx, setTravelModeIdx] = useState(0)
  const saveTravelModes = async (list: TravelMode[]): Promise<void> => {
    setTravelModesState(list)
    if (travelModeIdx >= list.length) setTravelModeIdx(0)
    await api.setSetting('travelModes', JSON.stringify(list))
  }

  // Rota hesabı: o yılki görünür pin ve yollardan graf kur → Dijkstra → haritada vurgula.
  // wm.features'tan okunur (refler'den DEĞİL — türetilmiş modlarda pin/yol refleri boş kalır).
  const computeRoute = (aFid: number, aName: string, bFid: number, bName: string): void => {
    const wm = worldMapRef.current
    const map = mapRef.current
    if (!wm || !map) return
    const year = yearRef.current
    const inYear = (s: FeatureStyle): boolean =>
      (s.from ?? -Infinity) <= year && year <= (s.to ?? Infinity)
    // Katman paneli bilinçli olarak dikkate alınmaz: yolu gizlemek bir görüntü tercihi, ağ yine orada
    const lines: NavLine[] = []
    const pins: NavPin[] = []
    const nameByFid = new Map<number, string | null>()
    for (const f of wm.features) {
      if (!inYear(JSON.parse(f.style || '{}') as FeatureStyle)) continue
      const geo = JSON.parse(f.geometry) as { type: string; coordinates: number[] | number[][] }
      if (geo.type === 'LineString') {
        lines.push({ fid: f.id, coords: geo.coordinates as number[][] })
        nameByFid.set(f.id, f.entity_name)
      } else if (geo.type === 'Point') pins.push({ fid: f.id, xy: geo.coordinates as number[] })
    }
    navTemp.current?.remove()
    navTemp.current = null
    if (!lines.length) return setNav({ step: 'result', aName, bName, route: null })
    // ponytail: kavşak payı = haritanın uzun kenarının 1/500'ü (3000px haritada ~6px). Geoman
    // snapping (varsayılan açık) zaten aynı koordinatı paylaştırır; bu pay float yuvarlamalarını
    // ve ufak ıskaları toparlar. Tek sayı ayarı.
    const span = Math.max(wm.width ?? 0, wm.height ?? 0) || 1000
    const g = buildNavGraph(lines, pins, span / 500)
    const from = g.pinNode.get(aFid)
    const to = g.pinNode.get(bFid)
    const route =
      from === undefined || to === undefined
        ? null
        : navRoute(g, from, to, (fid) => nameByFid.get(fid) ?? null)
    if (route) {
      navTemp.current = new L.LayerGroup().addTo(map)
      navTemp.current.addLayer(
        L.polyline(
          route.pts.map(([x, y]) => L.latLng(y, x)),
          { color: '#ffd700', weight: 5, opacity: 0.95, lineCap: 'round', interactive: false }
        )
      )
    }
    setNav({ step: 'result', aName, bName, route })
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
    endMeasure() // araç değişimi aktif ölçüm/navigasyon oturumunu bitirir
    endNav()
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
          fillColor: s.polygon.fillImg
            ? `url(#${fillPatternId(s.polygon.fillImg)})`
            : s.polygon.color,
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
      map.pm.enableDraw('Marker', { markerStyle: { icon: pinDivIcon(s.marker) } })
    else if (t === 'label')
      // önizleme gerçek metni gösterir (panelden girilen text/renk/açı)
      map.pm.enableDraw('Marker', { markerStyle: { icon: labelDivIcon(s.label) } })
    // 'scale' / 'nav': geoman modu yok — ayar dalı panelde açılır, oturumlar oradan başlatılır
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
          fillColor: s.polygon.fillImg
            ? `url(#${fillPatternId(s.polygon.fillImg)})`
            : s.polygon.color,
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
      map.pm.enableDraw('Marker', { markerStyle: { icon: pinDivIcon(s.marker) } })
    else if (toolRef.current === 'label')
      map.pm.enableDraw('Marker', { markerStyle: { icon: labelDivIcon(s.label) } })
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
      // konum pini: rozet divIcon'unu zoom'a göre ölçekle (merkez çapa; DOM'u yeniden yaratmadan)
      const ms = markerSize.current.get(fl.featureId)
      const pinEl = (l as unknown as { _icon?: HTMLElement })._icon
      if (ms !== undefined && pinEl) {
        const w = PIN_BASE * ms.size * scale
        if (ms.ar) {
          // serbest özel görsel: kutu 0×0, img kendi boyutunu taşır (ortalama CSS transform'la)
          const img = pinEl.firstElementChild as HTMLElement | null
          if (img) {
            img.style.width = `${w}px`
            img.style.height = `${w / ms.ar}px`
          }
        } else {
          pinEl.style.width = `${w}px`
          pinEl.style.height = `${w}px`
          pinEl.style.marginLeft = `${-w / 2}px`
          pinEl.style.marginTop = `${-w / 2}px`
        }
      }
      // serbest metin etiketi: pin gibi ama boyut değil FONT ölçeklenir (içteki div miras alır).
      // tooltip.update() yok → hot path'te tek style yazımı, reflow riski yok.
      const lt = labelText.current.get(fl.featureId)
      if (lt && pinEl) {
        pinEl.style.fontSize = `${lt.base * scale}px`
        pinEl.style.fontFamily = `'${lt.font}', serif`
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

  // Reload nesli: kaydırıcı sürüklemek gibi hızlı ardışık düzenlemeler üst üste reload başlatır;
  // yalnız EN SONUNCUSU haritaya dokunmalı. Eskiden temizlik ilk await'ten ÖNCE yapılıyordu —
  // her çağrı tüm haritayı silip veriyi beklerken bir sonraki çağrı araya giriyor, bitişler
  // sırasız gelince harita "ileri-geri zıplıyor"du (tüm çizimlerde birden, çünkü silinen şey
  // bütün katman grubu). Şimdi: await'lerden sonra bayat nesil erken döner; temizle+kur tek
  // senkron blok — harita hiç boş kare göstermez.
  const reloadGen = useRef(0)
  const reloadFeatures = async (): Promise<void> => {
    const gen = ++reloadGen.current
    const wm = await api.getMap(id)
    // Üst geçmişleri, taban küme ve renk/ad kayıtları HER modda dolar: fetih yıl tikleri,
    // kademe çözümlemesi ve varsayılan (kök) görünümü buradan beslenir
    const [h, cfgRaw, modes] = await Promise.all([api.hierarchy(), getHierConfig(), getMapModes()])
    if (gen !== reloadGen.current) return // daha yeni bir reload başladı — bu bayat
    setWorldMap(wm)
    worldMapRef.current = wm
    if (!wm || !featureGroupRef.current) return
    const fg = featureGroupRef.current
    fg.clearLayers()
    labelMeta.current.clear()
    labelText.current.clear()
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
      // Etiket de pin gibi Point geometry'li — ayırt edici, style'da metin alanının varlığı
      const isLabel = !isPolygon && !isLine && style.text !== undefined
      const color = paint
        ? paint.color.get(f.entity_id!)!
        : kademe
          ? '#666666' // kademe rengi applyYear'da üst zincirinden çözülür
          : (style.color ?? typeColor(types, f.entity_type))
      const lineOpacity = isLine ? (style.opacity ?? 0.9) : 1
      const dashArray = isLine ? lineDashArray(style.dash, style.weight ?? 3) : ''
      // Dolgu görseli yalnız kendi görünümündeki poligonlarda (türetilmiş modlar veriye göre boyar)
      const fillColor =
        !derived && isPolygon && style.fillImg ? `url(#${fillPatternId(style.fillImg)})` : color
      const gj = L.geoJSON(JSON.parse(f.geometry), {
        style: {
          color,
          fillColor,
          fill: !isLine,
          fillOpacity: derived ? 0.55 : (style.fillOpacity ?? 0.25),
          weight: style.weight ?? (isLine ? 3 : 2),
          opacity: lineOpacity,
          dashArray,
          lineCap: 'round',
          // Dolgu görselli poligonda Leaflet'in görünür-alan kırpması KAPALI: kırpılınca path'in
          // bbox'ı küçülür, objectBoundingBox deseni kırpık parçaya gerilir → zoom/pan'de görsel
          // kayar. noClip ile path hep tam poligon, bbox sabit, görsel yapışık. (Kişisel ölçekte
          // kırpmasız render maliyeti önemsiz.)
          noClip: fillColor !== color
        } as L.PolylineOptions,
        pointToLayer: (_gf, latlng) =>
          L.marker(latlng, { icon: isLabel ? labelDivIcon(style) : pinDivIcon(style) })
      })
      featKind.current.set(
        f.id,
        isPolygon ? 'polygon' : isLine ? 'line' : isLabel ? 'label' : 'pin'
      )
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
        fillColor,
        fillOpacity: derived ? 0.55 : (style.fillOpacity ?? 0.25),
        weight: style.weight ?? (isLine ? 3 : 2),
        opacity: lineOpacity,
        dashArray
      })
      gj.eachLayer((layer) => {
        const fl = layer as FeatureLayer
        fl.featureId = f.id
        allLayers.current.set(f.id, [...(allLayers.current.get(f.id) ?? []), layer])
        // Eğrilik: gerçek çizgi (köşe düzenleme için) neredeyse görünmez kalır, üstüne aynı
        // stilde etkileşimsiz bir eğri overlay'i biner (applyYear'da isCurveControl ile eşleşir)
        if (isLine && style.curviness) {
          fl.isCurveControl = true
          const geoCoords = (JSON.parse(f.geometry) as { coordinates: number[][] }).coordinates
          const overlay = L.polyline(curvePoints(geoCoords, style.curviness), {
            interactive: false,
            color,
            weight: style.weight ?? 3,
            opacity: lineOpacity,
            dashArray,
            lineCap: 'round'
          }) as FeatureLayer
          overlay.featureId = f.id
          allLayers.current.set(f.id, [...(allLayers.current.get(f.id) ?? []), overlay])
          fg.addLayer(overlay)
        }
        if (isPolygon) {
          const b = (layer as L.Polygon).getBounds()
          featArea.current.set(f.id, (b.getEast() - b.getWest()) * (b.getNorth() - b.getSouth()))
        }
        // Pin rozet ölçeği YALNIZ pinlere; etiket de Point ama font ölçeklenir (labelText dalı)
        if (!isPolygon && !isLabel)
          markerSize.current.set(f.id, {
            size: style.size ?? 1,
            ar: style.img && style.imgFree ? (style.imgAR ?? 1) : undefined
          })
        if (isLabel)
          labelText.current.set(f.id, {
            base: LABEL_BASE * (style.size ?? 1),
            font: style.font ?? 'Cinzel'
          })
        // Etikete tooltip bağlanmaz — metni zaten görünür
        if (f.entity_name && !derived && !isLabel) {
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
          if (measureRef.current) return // ölçüm oturumu: tıklama harita handler'ına düşer
          // 🧭 Navigasyon: tıklamalar başlangıç/varış pini seçimidir
          const nv = navRef.current
          if (nv && nv.step !== 'result') {
            if (isPolygon || isLine) return // yalnız pinler seçilebilir
            const name = f.entity_name ?? `#${f.id}`
            if (nv.step === 'a') setNav({ step: 'b', aFid: f.id, aName: name })
            else if (f.id !== nv.aFid) computeRoute(nv.aFid, nv.aName, f.id, name)
            return
          }
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
    // Tam yeniden kurulum tüm katmanları yeniden yarattı; edit modundayken köşe marker'ları
    // bu arada sökülüp yeniden doğar (flash). Yeni katmanlar global edit açıkken otomatik marker
    // alır ama tutarlılık için modu bir kez tazeleyip TÜM katmanların köşe yuvarlaklarını garanti et.
    if (toolRef.current === 'edit') mapRef.current?.pm.enableGlobalEditMode()
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
          // (fillColor da düz renge döner — siyasi mozaikte dolgu görseli geçersiz)
          const root = rootOf(eid)
          const c = entColors.current.get(root) ?? '#666666'
          if (st) st = { ...st, color: c, fillColor: c }
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
        st = { ...st, color: c, fillColor: c }
      }
      const arrow = featArrow.current.get(fid)
      for (const l of layers) {
        if (visible && !fg.hasLayer(l)) {
          fg.addLayer(l)
          // Edit modunda aynı katman nesnesini featureGroup'a geri eklemek geoman'ın köşe
          // marker'larını geri GETİRMEZ (ölçüldü) → düzenleme modu açıksa elle tazele, yoksa
          // yıl/katman değişiminde o poligonun köşe yuvarlakları kaybolurdu.
          if (toolRef.current === 'edit')
            (l as unknown as { pm?: { enable: () => void } }).pm?.enable()
        } else if (!visible && fg.hasLayer(l)) fg.removeLayer(l)
        if (visible && st && (l as L.Path).setStyle) {
          // dashArray kanonik değere döner — fetih vurgusunun kesikli kenarı kalıcı kalmasın,
          // yol (çizgi) desenleri ise korunur (renderStyle'da saklı). isCurveControl: üstünde eğri
          // overlay'i olan gerçek/düzenlenebilir çizgi neredeyse görünmez kalır (0 tam saydam SVG'de
          // tıklanamaz olabildiği için değil, düşük ama boyanan bir değer).
          ;(l as L.Path).setStyle({
            color: st.color,
            fillColor: st.fillColor,
            fillOpacity: st.fillOpacity,
            weight: st.weight,
            opacity: (l as FeatureLayer).isCurveControl ? 0.03 : st.opacity,
            dashArray: st.dashArray
          })
        }
        // 'end' oku: yalnız GÖRÜNÜR katmana (eğri varsa overlay'e, yoksa gerçek çizgiye) — kontrol
        // çizgisine de eklenirse context-stroke stroke-opacity'yi yok saydığı için hayalet ikinci ok belirir.
        if (visible && arrow === 'end' && !(l as FeatureLayer).isCurveControl) {
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

  // Esc: aktif ölçüm oturumunu bitir
  useEffect(() => {
    if (!measure) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') endMeasure()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measure !== null])

  // Esc: aktif navigasyon oturumunu bitir (rota vurgusu da temizlenir)
  useEffect(() => {
    if (!nav) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') endNav()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav !== null])

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
    map.pm.setGlobalOptions({ tooltips: false }) // geoman'ın "Click to place marker" ipuçlarını kapat

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
      if (e.shiftKey && wheelAdjustRef.current) {
        wheelAdjustRef.current(e.deltaY) // Shift basılı: zoom yerine seçili çizimi büyüt/küçült
        return
      }
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
      setBarZoom(map.getZoom())
    })

    // Ölçüm oturumu tıklamaları: calib 2 noktada forma geçer; dist/area nokta biriktirir
    map.on('click', (e: L.LeafletMouseEvent) => {
      const m = measureRef.current
      if (!m || m.kind === 'calib-form') return
      if (!measureTemp.current) measureTemp.current = new L.LayerGroup().addTo(map)
      const g = measureTemp.current
      g.addLayer(L.circleMarker(e.latlng, { radius: 5, color: '#ffd700', fillOpacity: 0.8 }))
      if (m.kind === 'calib') {
        if (!m.pts.length) return setMeasure({ kind: 'calib', pts: [e.latlng] })
        g.addLayer(
          L.polyline([m.pts[0], e.latlng], { color: '#ffd700', dashArray: '6', weight: 2 })
        )
        return setMeasure({ kind: 'calib-form', a: m.pts[0], b: e.latlng })
      }
      const pts = [...m.pts, e.latlng]
      if (m.kind === 'dist' && m.pts.length)
        g.addLayer(L.polyline([m.pts[m.pts.length - 1], e.latlng], { color: '#ffd700', weight: 2 }))
      if (m.kind === 'area') {
        if (!measurePoly.current) {
          measurePoly.current = L.polygon(pts, {
            color: '#ffd700',
            dashArray: '6',
            weight: 2,
            fillOpacity: 0.15
          })
          g.addLayer(measurePoly.current)
        } else measurePoly.current.setLatLngs(pts)
      }
      setMeasure({ kind: m.kind, pts })
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
          { label: t('🏷 Add label'), onClick: () => activateTool('label') },
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
      // Etiket ve pin araçlarının ikisi de geoman'da 'Marker' → ayırt etmek için aktif araç okunur
      const isLabelDraw = toolRef.current === 'label'
      const from = yearRef.current
      const style = JSON.stringify(
        shape === 'Marker' && isLabelDraw
          ? {
              text: s.label.text,
              color: s.label.color,
              font: s.label.font,
              size: s.label.size,
              angle: s.label.angle,
              curve: s.label.curve,
              from
            }
          : shape === 'Marker'
            ? {
                size: s.marker.size,
                color: s.marker.color,
                img: s.marker.img,
                imgFree: s.marker.imgFree,
                imgAR: s.marker.imgAR,
                from
              }
            : shape === 'Line'
              ? {
                  color: s.line.color,
                  weight: s.line.weight,
                  opacity: s.line.opacity,
                  dash: s.line.dash,
                  arrow: s.line.arrow,
                  curviness: s.line.curviness,
                  from
                }
              : {
                  color: s.polygon.color,
                  fillOpacity: s.polygon.fillOpacity,
                  weight: s.polygon.weight,
                  font: s.polygon.font,
                  fillImg: s.polygon.fillImg,
                  fillImgAR: s.polygon.fillImgAR,
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
    api.getSetting('mapScales').then((raw) => {
      const sc = (JSON.parse(raw || '{}') as Record<number, MapScale>)[id] ?? null
      scaleRef.current = sc
      setMapScale(sc)
    })
    api.getSetting('travelModes').then((raw) => setTravelModesState(JSON.parse(raw || '[]')))
    getPinImages().then(setPinImages)
    api.getSetting('drawSettings').then((raw) => {
      if (!raw) return
      // Alan bazında birleştir: eski kayıtlarda olmayan yeni ayarlar (ör. font) varsayılandan gelsin
      const p = JSON.parse(raw) as Partial<DrawSettings>
      const s: DrawSettings = {
        marker: { ...DEFAULT_DRAW.marker, ...p.marker },
        polygon: { ...DEFAULT_DRAW.polygon, ...p.polygon },
        line: { ...DEFAULT_DRAW.line, ...p.line },
        label: { ...DEFAULT_DRAW.label, ...p.label }
      }
      drawRef.current = s
      setDrawSettingsState(s)
    })
    setSelected(null)

    return () => {
      clearTimeout(hudTimer.current)
      measureTemp.current = null // map.remove() grubu zaten söker
      measurePoly.current = null
      navTemp.current = null
      setMeasure(null)
      setNav(null)
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
  // Etiket de Point — pin dalından ÖNCE ayrılmalı (ayırt edici: style.text)
  const selIsLabel = selStyle.text !== undefined

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

  // Shift+tekerlek: seçili çizimin boyut/kalınlığını değiştir (Wonderdraft deseni) — zoom yerine.
  // onWheel bir kez kurulan useEffect closure'ında olduğu için taze seçim ref'ten okunur; ref her
  // render'da güncel selStyle/editSelectedStyle ile yeniden atanır. ponytail: her tık editSelectedStyle
  // → reloadFeatures (kaydırıcı sürüklemekle aynı yol, reloadGen titremeyi zaten engelliyor).
  const wheelAdjustRef = useRef<((deltaY: number) => void) | null>(null)
  useEffect(() => {
    // callback ref'i her render taze tut (useLatest deseni); onWheel bir kez kurulur, güncel
    // seçimi buradan okur. Bare-effect ref yazımı bu desende güvenli — kuralı bu satırda kapat.
    // eslint-disable-next-line react-hooks/immutability
    wheelAdjustRef.current = !selected
      ? null
      : (deltaY: number) => {
          const dir = deltaY < 0 ? 1 : -1 // tekerlek yukarı = büyüt
          if (selIsLine || selIsPolygon) {
            const max = selIsLine ? 12 : 10
            const w = Math.max(1, Math.min(max, (selStyle.weight ?? (selIsLine ? 3 : 2)) + dir))
            editSelectedStyle({ weight: w })
          } else {
            const s = Math.max(
              0.5,
              Math.min(10, Number(((selStyle.size ?? 1) + dir * 0.25).toFixed(2)))
            )
            editSelectedStyle({ size: s })
          }
        }
  })

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
                    ['label', '🏷', t('Labels'), t('Names on polygons and free text')]
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
              {/* Poligon dolgu desenleri: haritada kullanılan + çizim varsayılanındaki her benzersiz
                  görsel için bir pattern. objectBoundingBox + preserveAspectRatio=none: görsel,
                  poligonun sınır kutusuna gerilir — poligona yapışık, zoom'da onunla ölçeklenir. */}
              {(() => {
                const pats = new Set<string>()
                for (const f of worldMap?.features ?? []) {
                  if (!f.geometry.includes('"Polygon"')) continue
                  const s = JSON.parse(f.style || '{}') as FeatureStyle
                  if (s.fillImg) pats.add(s.fillImg)
                }
                if (drawSettings.polygon.fillImg) pats.add(drawSettings.polygon.fillImg)
                return [...pats].map((p) => (
                  <pattern
                    key={p}
                    id={fillPatternId(p)}
                    patternContentUnits="objectBoundingBox"
                    width={1}
                    height={1}
                  >
                    <image href={assetUrl(p)} width={1} height={1} preserveAspectRatio="none" />
                  </pattern>
                ))
              })()}
            </defs>
          </svg>
          <div ref={divRef} className="leaflet-host" />
          {/* Ölçek çubuğu: yuvarlak bir mesafe (1/2/5×10ⁿ) seçilir, piksel genişliği zoom'dan gelir.
              Zoom her tikte HUD state'ini değiştirdiği için render güncel kalır. Export'ta da kalır. */}
          {mapScale &&
            (() => {
              const perPx = mapScale.perUnit / 2 ** barZoom
              const pow = 10 ** Math.floor(Math.log10(90 * perPx))
              const d = [1, 2, 5, 10].map((m) => m * pow).find((v) => v / perPx >= 50) ?? 10 * pow
              return (
                <div className="scale-bar" style={{ width: d / perPx }}>
                  <span>
                    {d.toLocaleString()} {mapScale.unit}
                  </span>
                </div>
              )
            })()}
          {!exporting && (
            <>
              <Timeline
                changeYears={changeYears}
                eventsToken={eventsToken}
                // Kullanıcı yılı değiştirince rota bayatlar (o yıl var olmayan yollardan geçiyor
                // olabilir) → düşür. applyYear'ın kendisi sarılmaz: reloadFeatures'ın iç çağrıları
                // rotayı düşürmemeli ve hot path'e dal eklenmemeli.
                onYear={(y) => {
                  if (navRef.current?.step === 'result') endNav()
                  applyYear(y)
                }}
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
              {nav && nav.step !== 'result' && (
                <div className="link-hint">
                  {nav.step === 'a'
                    ? t('🧭 Click the START pin…')
                    : t('🧭 Now click the DESTINATION pin ({from} → …)', { from: nav.aName })}{' '}
                  <button className="mini" onClick={endNav}>
                    {t('cancel')}
                  </button>
                </div>
              )}
              {measure?.kind === 'calib' && (
                <div className="link-hint">
                  {measure.pts.length === 0
                    ? t('📏 Click the FIRST point of a known distance…')
                    : t('📏 Now click the SECOND point…')}{' '}
                  <button className="mini" onClick={endMeasure}>
                    {t('cancel')}
                  </button>
                </div>
              )}
              {measure?.kind === 'calib-form' && (
                <form
                  className="link-hint"
                  onSubmit={(e) => {
                    e.preventDefault()
                    const fd = new FormData(e.currentTarget)
                    saveCalib(Number(fd.get('dist')), String(fd.get('unit') ?? 'km'))
                  }}
                >
                  {t('📏 Real distance between the two points:')}{' '}
                  <input
                    name="dist"
                    type="number"
                    step="any"
                    min={0}
                    autoFocus
                    style={{ width: 80 }}
                  />
                  <input name="unit" defaultValue={mapScale?.unit ?? 'km'} style={{ width: 50 }} />
                  <button className="mini" type="submit">
                    {t('OK')}
                  </button>
                  <button className="mini" type="button" onClick={endMeasure}>
                    {t('cancel')}
                  </button>
                </form>
              )}
              {measure?.kind === 'dist' && (
                <div className="link-hint">
                  📏{' '}
                  {t('Distance: {val} {unit}', {
                    val: fmtDist(ringLen(ptsXY(measure.pts)) * measureK),
                    unit: measureUnit
                  })}{' '}
                  <button className="mini" onClick={endMeasure}>
                    {t('Finish')}
                  </button>
                </div>
              )}
              {measure?.kind === 'area' && (
                <div className="link-hint">
                  📐{' '}
                  {t('Area: {val} {unit}²', {
                    val: fmtDist(ringArea(ptsXY(measure.pts)) * measureK * measureK),
                    unit: measureUnit
                  })}{' '}
                  ·{' '}
                  {t('Perimeter: {val} {unit}', {
                    val: fmtDist(
                      (ringLen(ptsXY(measure.pts)) +
                        (measure.pts.length > 2
                          ? Math.hypot(
                              measure.pts[0].lat - measure.pts[measure.pts.length - 1].lat,
                              measure.pts[0].lng - measure.pts[measure.pts.length - 1].lng
                            )
                          : 0)) *
                        measureK
                    ),
                    unit: measureUnit
                  })}{' '}
                  <button className="mini" onClick={endMeasure}>
                    {t('Finish')}
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
                  <label>{t('Fill image (click again to remove)')}</label>
                  <ImageStrip
                    img={selStyle.fillImg}
                    images={pinImages}
                    onImg={(p, ar) =>
                      editSelectedStyle(
                        selStyle.fillImg === p
                          ? { fillImg: undefined, fillImgAR: undefined }
                          : { fillImg: p, fillImgAR: ar }
                      )
                    }
                    onUpload={() =>
                      uploadPinImage((p, ar) => editSelectedStyle({ fillImg: p, fillImgAR: ar }))
                    }
                    onRemoveImg={(path) => savePinLib(pinImages.filter((p) => p.path !== path))}
                  />
                  {selStyle.fillImg && (
                    <button
                      className="mini"
                      onClick={() =>
                        editSelectedStyle({ fillImg: undefined, fillImgAR: undefined })
                      }
                    >
                      {t('Remove fill image')}
                    </button>
                  )}
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
                  <label>{t('Curviness: {val}', { val: selStyle.curviness ?? 0 })}</label>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={selStyle.curviness ?? 0}
                    onChange={(e) => editSelectedStyle({ curviness: Number(e.target.value) })}
                  />
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
              ) : selIsLabel ? (
                <>
                  <label>{t('Text')}</label>
                  <input
                    value={selStyle.text ?? ''}
                    placeholder={t('sea, mountain range…')}
                    onChange={(e) => editSelectedStyle({ text: e.target.value })}
                  />
                  <label>{t('Color')}</label>
                  <ColorPicker
                    value={selStyle.color ?? '#ffffff'}
                    onChange={(color) => editSelectedStyle({ color })}
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
                  <label>{t('Size: ×{val}', { val: (selStyle.size ?? 1).toFixed(2) })}</label>
                  <input
                    type="range"
                    min={0.5}
                    max={10}
                    step={0.25}
                    value={selStyle.size ?? 1}
                    onChange={(e) => editSelectedStyle({ size: Number(e.target.value) })}
                  />
                  <label>{t('Angle: {val}°', { val: selStyle.angle ?? 0 })}</label>
                  <input
                    type="range"
                    min={-90}
                    max={90}
                    step={5}
                    value={selStyle.angle ?? 0}
                    onChange={(e) => editSelectedStyle({ angle: Number(e.target.value) })}
                  />
                  <label>{t('Curve: {val}', { val: selStyle.curve ?? 0 })}</label>
                  <input
                    type="range"
                    min={-100}
                    max={100}
                    step={5}
                    value={selStyle.curve ?? 0}
                    onChange={(e) => editSelectedStyle({ curve: Number(e.target.value) })}
                  />
                </>
              ) : (
                <>
                  {/* Serbest modda rozet yok → rengin etkisi olmaz, kontrolü gösterme */}
                  {!(selStyle.img && selStyle.imgFree) && (
                    <>
                      <label>{t('Color')}</label>
                      <ColorPicker
                        value={selStyle.color ?? '#c0603a'}
                        onChange={(color) => editSelectedStyle({ color })}
                      />
                    </>
                  )}
                  <label>{t('Pin image (click again to remove)')}</label>
                  <ImageStrip
                    img={selStyle.img}
                    images={pinImages}
                    onImg={(img, imgAR) =>
                      editSelectedStyle(
                        selStyle.img === img ? { img: undefined, imgAR: undefined } : { img, imgAR }
                      )
                    }
                    onUpload={() =>
                      uploadPinImage((img, imgAR) => editSelectedStyle({ img, imgAR }))
                    }
                    onRemoveImg={(path) => savePinLib(pinImages.filter((p) => p.path !== path))}
                  />
                  {selStyle.img && (
                    <>
                      <label>{t('Image style')}</label>
                      <div className="measure-btns">
                        <button
                          className={`mini ${!selStyle.imgFree ? 'active' : ''}`}
                          onClick={() => editSelectedStyle({ imgFree: false })}
                        >
                          {t('Badge')}
                        </button>
                        <button
                          className={`mini ${selStyle.imgFree ? 'active' : ''}`}
                          onClick={() => editSelectedStyle({ imgFree: true })}
                        >
                          {t('Free')}
                        </button>
                      </div>
                    </>
                  )}
                  <label>{t('Size: ×{val}', { val: (selStyle.size ?? 1).toFixed(2) })}</label>
                  <input
                    type="range"
                    min={0.5}
                    max={10}
                    step={0.25}
                    value={selStyle.size ?? 1}
                    onChange={(e) => editSelectedStyle({ size: Number(e.target.value) })}
                  />
                </>
              )}
            </div>

            {mapScale &&
              (selIsPolygon || selIsLine) &&
              (() => {
                const g = JSON.parse(selected.geometry) as { coordinates: unknown }
                const k = mapScale.perUnit
                if (selIsLine)
                  return (
                    <div className="panel-block scale-info">
                      📏{' '}
                      {t('Length: {val} {unit}', {
                        val: fmtDist(ringLen(g.coordinates as number[][]) * k),
                        unit: mapScale.unit
                      })}
                    </div>
                  )
                // ponytail: yalnız dış halka — delikli poligon çizilmiyor
                const ring = (g.coordinates as number[][][])[0]
                return (
                  <div className="panel-block scale-info">
                    <div>
                      📐{' '}
                      {t('Area: {val} {unit}²', {
                        val: fmtDist(ringArea(ring) * k * k),
                        unit: mapScale.unit
                      })}
                    </div>
                    <div>
                      📏{' '}
                      {t('Perimeter: {val} {unit}', {
                        val: fmtDist(ringLen(ring) * k),
                        unit: mapScale.unit
                      })}
                    </div>
                  </div>
                )
              })()}

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
            scale={mapScale}
            mapWidthPx={worldMap?.width ?? null}
            measuring={measure?.kind === 'dist' || measure?.kind === 'area' ? measure.kind : null}
            onCalibrate={() => startMeasure('calib')}
            onMeasure={startMeasure}
            onScaleSave={(perUnit, unit) => persistScale({ perUnit, unit })}
            onScaleClear={() => (persistScale(null), endMeasure())}
            navStep={nav?.step ?? null}
            navResult={nav?.step === 'result' ? nav : null}
            navBlocked={activeMode !== null}
            travelModes={travelModes}
            travelModeIdx={travelModeIdx}
            onNavStart={startNav}
            onNavEnd={endNav}
            onTravelModes={saveTravelModes}
            onTravelModeIdx={setTravelModeIdx}
            pinImages={pinImages}
            onUploadPinImage={uploadPinImage}
            onRemovePinImage={(path) => savePinLib(pinImages.filter((p) => p.path !== path))}
          />
        </div>
      </div>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  )
}
