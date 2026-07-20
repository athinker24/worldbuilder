// Main process'teki dar API'nin tipli istemci sarmalayıcısı.
const inv = <T>(method: string, ...args: unknown[]): Promise<T> =>
  window.api.invoke(method, ...args) as Promise<T>

export interface EntityRow {
  id: number
  type: string
  name: string
}

export interface OutLink {
  id: number
  relation: string
  notes: string
  to_id: number
  to_name: string
}

export interface InLink {
  id: number
  relation: string
  notes: string
  from_id: number
  from_name: string
}

export interface Entity extends EntityRow {
  content: string
  fields: string // JSON: Record<string, string>
  created_at: string
  updated_at: string
  outLinks: OutLink[]
  inLinks: InLink[]
  mentions: { id: number; name: string }[]
}

export interface MapRow {
  id: number
  name: string
  parent_map_id: number | null
}

export interface Feature {
  id: number
  map_id: number
  entity_id: number | null
  geometry: string // GeoJSON
  style: string // JSON: MapView'daki FeatureStyle (color, fillOpacity, weight, size, font, childMapId, from/to, opacity/dash: yol)
  entity_name: string | null
  entity_type: string | null
}

export interface WorldMap extends MapRow {
  image_path: string | null
  width: number | null
  height: number | null
  layers: string
  features: Feature[]
}

export interface TypeDef {
  name: string
  color: string
  isPerson?: boolean // bu tip kişi maddeleri mi (anne/baba/eş/yönetici formları + harita bağlama bunu kullanır)
}

export interface Hierarchy {
  tags: string[]
  govs: string[] // maddelerde geçen yönetim biçimleri (fields.yönetim)
  entities: {
    id: number
    type: string
    name: string
    fields: string // ham JSON — harita modu değerleri (din/dil…) buradan okunur
    gov: string | null
    tags: string[]
  }[]
}

// Hiyerarşi yapılandırması: yönetim biçimi başına üst→alt kademe merdiveni
export interface HierConfig {
  govs: { name: string; tags: string[] }[] // her yönetim biçiminin kendi sıralı merdiveni
}

// Boşluk vb. içeren dosya adları için her yol parçasını ayrı encode et
export const assetUrl = (relPath: string): string =>
  'world://data/' + relPath.split('/').map(encodeURIComponent).join('/')

export const api = {
  listEntities: (search = '') => inv<EntityRow[]>('listEntities', search),
  getEntity: (id: number) => inv<Entity | null>('getEntity', id),
  findEntityByName: (name: string) => inv<EntityRow | null>('findEntityByName', name),
  createEntity: (e: { name: string; type?: string; content?: string }) =>
    inv<{ id: number }>('createEntity', e),
  updateEntity: (
    id: number,
    patch: Partial<Pick<Entity, 'type' | 'name' | 'content' | 'fields'>>
  ) => inv<void>('updateEntity', id, patch),
  deleteEntity: (id: number) => inv<void>('deleteEntity', id),
  retypeEntities: (oldType: string, newType: string) =>
    inv<void>('retypeEntities', oldType, newType),
  hierarchy: () => inv<Hierarchy>('hierarchy'),
  // Tam metin arama: içerik/alanlarda geçenler (isim eşleşmeleri hariç), bağlam parçasıyla
  searchContent: (q: string) =>
    inv<{ id: number; type: string; name: string; snippet: string }[]>('searchContent', q),
  restoreEntity: (
    row: Pick<Entity, 'id' | 'type' | 'name' | 'content' | 'fields' | 'created_at'>,
    links: { from_id: number; to_id: number; relation: string; notes: string }[],
    featureIds: number[]
  ) => inv<void>('restoreEntity', row, links, featureIds),
  restoreEntities: (
    rows: Pick<Entity, 'id' | 'type' | 'name' | 'content' | 'fields' | 'created_at'>[],
    links: { from_id: number; to_id: number; relation: string; notes: string }[],
    features: { entity_id: number; feature_id: number }[]
  ) => inv<void>('restoreEntities', rows, links, features),
  entityFeatureIds: (entityId: number) => inv<number[]>('entityFeatureIds', entityId),
  featuresByEntity: (entityId: number) =>
    inv<{ id: number; map_id: number; style: string; map_name: string }[]>(
      'featuresByEntity',
      entityId
    ),

  addLink: (from_id: number, to_id: number, relation: string) =>
    inv<{ id: number }>('addLink', from_id, to_id, relation),
  deleteLink: (id: number) => inv<void>('deleteLink', id),
  listLinks: () =>
    inv<{ id: number; from_id: number; to_id: number; relation: string }[]>('listLinks'),

  listMaps: () => inv<MapRow[]>('listMaps'),
  getMap: (id: number) => inv<WorldMap | null>('getMap', id),
  createMap: (m: {
    name: string
    image_path?: string
    width?: number
    height?: number
    parent_map_id?: number
  }) => inv<{ id: number }>('createMap', m),
  updateMap: (
    id: number,
    patch: Partial<
      Pick<WorldMap, 'name' | 'parent_map_id' | 'image_path' | 'width' | 'height' | 'layers'>
    >
  ) => inv<void>('updateMap', id, patch),
  deleteMap: (id: number) => inv<void>('deleteMap', id),
  restoreMap: (
    map: Pick<
      WorldMap,
      'id' | 'name' | 'parent_map_id' | 'image_path' | 'width' | 'height' | 'layers'
    >,
    features: Pick<Feature, 'id' | 'map_id' | 'entity_id' | 'geometry' | 'style'>[],
    childIds: number[]
  ) => inv<void>('restoreMap', map, features, childIds),

  createFeature: (f: { map_id: number; entity_id?: number; geometry: string; style?: string }) =>
    inv<{ id: number }>('createFeature', f),
  updateFeature: (id: number, patch: Partial<Pick<Feature, 'entity_id' | 'geometry' | 'style'>>) =>
    inv<void>('updateFeature', id, patch),
  deleteFeature: (id: number) => inv<void>('deleteFeature', id),

  getSetting: (key: string) => inv<string | null>('getSetting', key),
  setSetting: (key: string, value: string) => inv<void>('setSetting', key, value),

  pickImage: () => inv<string | null>('pickImage'),
  backupNow: () => inv<string>('backupNow'),
  // Not sekmelerini okunabilir .txt ağacına döker (notes/<harita>/<tip>/<madde>/<not>.txt) + klasörü açar
  exportNotes: () => inv<{ path: string; files: number }>('exportNotes'),
  // .dunya dosya modeli (Wonderdraft tarzı): kaydet/farklı kaydet/aç + kirli durum
  saveWorld: () => inv<string | null>('saveWorld'),
  saveWorldAs: () => inv<string | null>('saveWorldAs'),
  openWorld: () => inv<string | null>('openWorld'),
  worldInfo: () => inv<{ file: string | null; dirty: boolean }>('worldInfo'),
  exportMapImage: (
    rect: { x: number; y: number; width: number; height: number },
    defaultName: string
  ) => inv<string | null>('exportMapImage', rect, defaultName)
}

export async function getTypes(): Promise<TypeDef[]> {
  const raw = await api.getSetting('types')
  return raw ? (JSON.parse(raw) as TypeDef[]) : []
}

export const saveTypes = (types: TypeDef[]): Promise<void> =>
  api.setSetting('types', JSON.stringify(types))

export const typeColor = (types: TypeDef[], type: string | null): string =>
  types.find((t) => t.name === type)?.color ?? '#888888'

export async function getHierConfig(): Promise<HierConfig> {
  const raw = await api.getSetting('hierarchyConfig')
  if (!raw) return { govs: [] }
  const parsed = JSON.parse(raw) as unknown
  // Eski biçim: [{tag, mode}] dizisi → yeni biçime dönüştür
  if (Array.isArray(parsed)) {
    const old = parsed as { tag: string; mode: string }[]
    return {
      govs: [{ name: 'Varsayılan', tags: old.filter((c) => c.mode === 'filtre').map((c) => c.tag) }]
    }
  }
  return { govs: (parsed as HierConfig).govs ?? [] }
}

export const saveHierConfig = (cfg: HierConfig): Promise<void> =>
  api.setSetting('hierarchyConfig', JSON.stringify(cfg))

// Maddelerde keşfedilen yeni yönetim biçimleri için config'e boş merdiven ekle
export function mergeHierConfig(cfg: HierConfig, discoveredGovs: string[]): HierConfig {
  const missing = discoveredGovs.filter((g) => !cfg.govs.some((x) => x.name === g))
  return missing.length
    ? { ...cfg, govs: [...cfg.govs, ...missing.map((name) => ({ name, tags: [] }))] }
    : cfg
}

// De-jure üst zinciri: maddenin yıl bazlı üst (ebeveyn) geçmişi fields["üst"]'te JSON durur.
// Fetih = yeni {from, id} kaydı eklemek; slider geçmişe çekilince eski üst kendiliğinden döner.
export interface ParentRec {
  from: number | null // null = başlangıçtan beri
  id: number // üst maddenin id'si (ad değişimine dayanıklı)
}

/** fields[key] içindeki yıl bazlı {from, id} listesini oku (üst zinciri, yönetici geçmişi…). */
export function getYearRecs(fieldsJson: string, key: string): ParentRec[] {
  try {
    const f = JSON.parse(fieldsJson || '{}') as Record<string, string>
    const p = JSON.parse(f[key] ?? '[]') as ParentRec[]
    return Array.isArray(p) ? p : []
  } catch {
    return []
  }
}

export const getParents = (fieldsJson: string): ParentRec[] => getYearRecs(fieldsJson, 'üst')

/**
 * Cinsiyet çıkarımı (kişi id → 'M'|'F'). Öncelik:
 *   1. açık `fields.cinsiyet` ('erkek'/'kadın')
 *   2. rol: biri(leri)nin babası → erkek, annesi → kadın
 *   3. eşin tersi: erkeğin eşi → kadın, kadının eşi → erkek (sabit noktaya kadar yayılır)
 * Hem aile ağacı gösterimi hem çocuk-ekleme ilişkisi (anne/baba seçimi) bunu kullanır.
 */
export function inferGenders(
  entities: { id: number; fields: string }[],
  links: { from_id: number; to_id: number; relation: string }[]
): Map<number, 'M' | 'F'> {
  const fatherSet = new Set<number>()
  const motherSet = new Set<number>()
  const spousesOf = new Map<number, number[]>()
  const pushSpouse = (a: number, b: number): void => {
    const arr = spousesOf.get(a) ?? []
    arr.push(b)
    spousesOf.set(a, arr)
  }
  for (const l of links) {
    if (l.relation === 'baba') fatherSet.add(l.to_id)
    else if (l.relation === 'anne') motherSet.add(l.to_id)
    else if (l.relation === 'eş') {
      pushSpouse(l.from_id, l.to_id)
      pushSpouse(l.to_id, l.from_id)
    }
  }
  const g = new Map<number, 'M' | 'F'>()
  for (const e of entities) {
    const c = (JSON.parse(e.fields || '{}') as Record<string, string>)['cinsiyet']
    if (c === 'erkek') g.set(e.id, 'M')
    else if (c === 'kadın') g.set(e.id, 'F')
    else if (fatherSet.has(e.id)) g.set(e.id, 'M')
    else if (motherSet.has(e.id)) g.set(e.id, 'F')
  }
  // Eş tersinden yay: eşi bilinen ama kendisi bilinmeyenlere karşı cinsiyet ata (sabit nokta)
  let changed = true
  while (changed) {
    changed = false
    for (const [pid, sps] of spousesOf) {
      if (g.has(pid)) continue
      for (const s of sps) {
        const sg = g.get(s)
        if (sg) {
          g.set(pid, sg === 'M' ? 'F' : 'M')
          changed = true
          break
        }
      }
    }
  }
  return g
}

/** Yıl Y'deki üst: from <= Y olan en büyük from'lu kayıt (null = -∞). */
export function parentAt(recs: ParentRec[], year: number): number | null {
  let best: ParentRec | null = null
  for (const r of recs) {
    const from = r.from ?? -Infinity
    if (from <= year && (best === null || from > (best.from ?? -Infinity))) best = r
  }
  return best?.id ?? null
}

/** Bir çizim/olay yıl aralığında (from/to; boş = sınırsız) görünür mü. */
export const inYearRange = (
  from: number | undefined,
  to: number | undefined,
  year: number
): boolean => (from ?? -Infinity) <= year && year <= (to ?? Infinity)

/** Taban küme: her yönetim biçiminin merdivenindeki SON etikete sahip maddeler (harita taban
 *  poligonları + Atlas bu kümeyi ortak kullanır — tek kaynak). */
export function lowestRungSet(
  cfg: HierConfig,
  entities: { id: number; gov: string | null; tags: string[] }[]
): Set<number> {
  const s = new Set<number>()
  for (const g of cfg.govs) {
    const lowest = g.tags[g.tags.length - 1]
    if (!lowest) continue
    for (const e of entities)
      if (e.tags.includes(lowest) && (!e.gov || e.gov === g.name)) s.add(e.id)
  }
  return s
}

/** O yılki üst zincirinin TEPESİ (döngü korumalı). parentsOf: madde id'sinden o maddenin
 *  yıl bazlı üst kayıtları — çağıran ham fields'tan (Atlas) ya da önden ayrıştırılmış ref'ten
 *  (MapView hot-path) besler. */
export function rootAtYear(
  eid: number,
  year: number,
  parentsOf: (id: number) => ParentRec[]
): number {
  let cur = eid
  const seen = new Set<number>()
  while (!seen.has(cur)) {
    seen.add(cur)
    const p = parentAt(parentsOf(cur), year)
    if (p === null) break
    cur = p
  }
  return cur
}

/** Poligon halkasının alanı (shoelace, işaretsiz). CRS.Simple düz düzlem — projeksiyon yok. */
export function ringArea(ring: number[][]): number {
  let s = 0
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i]
    const [x2, y2] = ring[(i + 1) % ring.length]
    s += x1 * y2 - x2 * y1
  }
  return Math.abs(s) / 2
}

// Harita modları: kullanıcı tanımlı boyutlar (din, dil…) ve boyut+değer başına renkler.
// Değer maddenin fields[dim] alanından okunur; renk atanmamışsa autoColor devreye girer.
export interface MapModes {
  dims: string[]
  colors: Record<string, Record<string, string>> // dim → değer → hex
}

export async function getMapModes(): Promise<MapModes> {
  const raw = await api.getSetting('mapModes')
  if (!raw) return { dims: [], colors: {} }
  const p = JSON.parse(raw) as Partial<MapModes>
  return { dims: p.dims ?? [], colors: p.colors ?? {} }
}

export const saveMapModes = (m: MapModes): Promise<void> =>
  api.setSetting('mapModes', JSON.stringify(m))

// Madde şablonları (settings 'templates'): yeni bir maddeye hazır alan iskeleti uygular.
// DAYATMA DEĞİL başlangıç noktası — uygulandıktan sonra her alan silinip değiştirilebilir,
// şablonun kendisi de. Uygulama saveFields'tan geçtiği için Ctrl+Z ile geri alınır.
export interface EntityTemplate {
  name: string
  type?: string // maddenin tipi boşsa atanır (TypeDef adı; tip silinse/yeniden adlandırılsa bile
  // serbest metin olarak kalır — entities.type zaten serbest bir kolon)
  fields: Record<string, string> // alan → varsayılan değer (boş değer = yalnız iskelet)
}

// Kendi bölümlerinde/mekanizmalarında yaşayan alanlar: şablona girmemeli (serbest metaveri değil).
// db.ts'teki TECH kümesi (arama) ile EntityPage'in render filtresinin BİRLEŞİMİ + kişi alanları.
// Harita modu boyutları (dims) çalışma anında gelir, çağıran ayrıca eler.
export const RESERVED_FIELDS = [
  'sancak',
  'üst',
  'notlar',
  'hiyerarşi',
  'yönetim',
  'yönetici',
  'hane',
  'renk',
  'cinsiyet',
  'doğum',
  'ölüm',
  '_tpl' // uygulanan şablonun adı (salt bilgi, EntityPage'de select'i seçili göstermek için)
]

export const getTemplates = async (): Promise<EntityTemplate[]> =>
  JSON.parse((await api.getSetting('templates')) || '[]')

export const saveTemplates = (list: EntityTemplate[]): Promise<void> =>
  api.setSetting('templates', JSON.stringify(list))

// Özel pin görselleri kütüphanesi (settings 'pinImages', global): kullanıcının pin olarak
// kullanmak üzere yüklediği görseller. path = assets/ göreli yolu, ar = en/boy oranı.
// Yalnız seçici kolaylığı — pinin kendi style'ı img+imgAR'ı ayrıca taşır, bu yüzden buradan
// bir kayıt silinse de o görseli kullanan pinler doğru çizilmeye devam eder.
export interface PinImage {
  path: string
  ar: number
}

export const getPinImages = async (): Promise<PinImage[]> =>
  JSON.parse((await api.getSetting('pinImages')) || '[]')

export const savePinImages = (list: PinImage[]): Promise<void> =>
  api.setSetting('pinImages', JSON.stringify(list))

// Zeminler (settings 'mapBoards', harita başına): aynı harita üzerinde birden çok çizim katmanı
// (Photoshop mantığı). Her çizim, yapıldığı zemine (id) `style.board` ile bağlanır; zemin değişince
// diğerlerininki gizlenir. Dış görsel YOK — yalnız aynı zemin görselinin üstündeki çizimleri gruplar.
// Etiketlenmemiş/artık-olmayan zemin id'li çizimler ilk zemine düşer (silme/rename bozmaz — bkz. MapView).
export interface BoardDef {
  id: string
  name: string
}
export interface MapBoards {
  list: BoardDef[]
  active: string
}

export const getMapBoards = async (mapId: number): Promise<MapBoards> => {
  const all = JSON.parse((await api.getSetting('mapBoards')) || '{}') as Record<number, MapBoards>
  return all[mapId] ?? { list: [], active: '' }
}

export const saveMapBoards = async (mapId: number, data: MapBoards): Promise<void> => {
  const all = JSON.parse((await api.getSetting('mapBoards')) || '{}') as Record<number, MapBoards>
  if (data.list.length) all[mapId] = data
  else delete all[mapId]
  await api.setSetting('mapBoards', JSON.stringify(all))
}

// Zaman çizgisi: dönüm noktası tamamen kullanıcı tanımlı (MÖ/MS dayatması yok).
// Yıllar işaretli tamsayı: negatif = dönümden önce. year = slider'ın son konumu (kalıcı).
export interface TimelineConfig {
  before: string // dönümden önceki çağ kısaltması (örn. "MÖ", "KÖ")
  after: string // dönümden sonraki çağ kısaltması
  min: number
  max: number
  year: number
  periods: { name: string; from: number; to: number }[] // isimli dönemler (İlk Çağ…)
  events: { name: string; year: number; fid?: number; mid?: number }[] // olaylar; fid/mid = bağlı çizim ve haritası
}

const TIMELINE_DEFAULT: TimelineConfig = {
  before: 'MÖ',
  after: 'MS',
  min: -500,
  max: 1500,
  year: 0,
  periods: [],
  events: []
}

export async function getTimeline(): Promise<TimelineConfig> {
  const raw = await api.getSetting('timeline')
  return raw
    ? { ...TIMELINE_DEFAULT, ...(JSON.parse(raw) as Partial<TimelineConfig>) }
    : TIMELINE_DEFAULT
}

export const saveTimeline = (t: TimelineConfig): Promise<void> =>
  api.setSetting('timeline', JSON.stringify(t))

export const formatYear = (y: number, cfg: TimelineConfig): string =>
  y < 0 ? `${-y} ${cfg.before}` : `${y} ${cfg.after}`

// Interface language — default English; changeable from Settings.
export type Lang = 'en' | 'tr'

export async function getLanguage(): Promise<Lang> {
  const raw = await api.getSetting('language')
  return raw === 'tr' ? 'tr' : 'en'
}

export const saveLanguage = (lang: Lang): Promise<void> => api.setSetting('language', lang)

// Tema — koyu (teal) varsayılan; App.tsx <html data-theme> yazar, tüm renkler CSS token'larından.
export type Theme = 'dark' | 'light'

export async function getTheme(): Promise<Theme> {
  const raw = await api.getSetting('theme')
  return raw === 'light' ? 'light' : 'dark'
}

export const saveTheme = (theme: Theme): Promise<void> => api.setSetting('theme', theme)

// Renk atanmamış değerler için string'den deterministik renk (hex — ColorPicker ile uyumlu)
export function autoColor(seed: string): string {
  let hash = 0
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0
  const h = ((hash % 360) + 360) % 360
  const s = 0.55
  const l = 0.55
  const f = (n: number): number => {
    const k = (n + h / 30) % 12
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))
  }
  return (
    '#' +
    [f(0), f(8), f(4)]
      .map((v) =>
        Math.round(v * 255)
          .toString(16)
          .padStart(2, '0')
      )
      .join('')
  )
}
