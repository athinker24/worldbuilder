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

/** Yıl Y'deki üst: from <= Y olan en büyük from'lu kayıt (null = -∞). */
export function parentAt(recs: ParentRec[], year: number): number | null {
  let best: ParentRec | null = null
  for (const r of recs) {
    const from = r.from ?? -Infinity
    if (from <= year && (best === null || from > (best.from ?? -Infinity))) best = r
  }
  return best?.id ?? null
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
