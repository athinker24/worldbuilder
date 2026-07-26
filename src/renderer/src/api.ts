// Typed client wrapper around the narrow main-process API.
const inv = <T>(method: string, ...args: unknown[]): Promise<T> =>
  window.api.invoke(method, ...args) as Promise<T>

export interface EntityRow {
  id: number
  name: string
  folder?: string | null // sidebar folder id (fields['folder']); null/absent = root
  created_at?: string
  updated_at?: string
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
  entity_folder: string | null // the bound article's sidebar folder id — drives the default color
}

export interface WorldMap extends MapRow {
  image_path: string | null
  width: number | null
  height: number | null
  layers: string
  features: Feature[]
}

export interface Hierarchy {
  tags: string[]
  govs: string[] // government forms seen on entities (fields.government)
  entities: {
    id: number
    name: string
    fields: string // raw JSON — map-mode values (religion/language…) are read from it
    gov: string | null
    tags: string[]
  }[]
}

// Hierarchy configuration: a top→bottom rank ladder per government form
export interface HierConfig {
  govs: { name: string; tags: string[] }[] // each government form's own ordered ladder
}

// Encode each path segment separately, for file names containing spaces etc.
export const assetUrl = (relPath: string): string =>
  'world://data/' + relPath.split('/').map(encodeURIComponent).join('/')

export const api = {
  listEntities: (search = '') => inv<EntityRow[]>('listEntities', search),
  getEntity: (id: number) => inv<Entity | null>('getEntity', id),
  findEntityByName: (name: string) => inv<EntityRow | null>('findEntityByName', name),
  createEntity: (e: { name: string; content?: string }) => inv<{ id: number }>('createEntity', e),
  updateEntity: (id: number, patch: Partial<Pick<Entity, 'name' | 'content' | 'fields'>>) =>
    inv<void>('updateEntity', id, patch),
  deleteEntity: (id: number) => inv<void>('deleteEntity', id),
  hierarchy: () => inv<Hierarchy>('hierarchy'),
  // Full-text search: content/field hits (name matches excluded), with a context snippet
  searchContent: (q: string) =>
    inv<{ id: number; folder: string | null; name: string; snippet: string }[]>('searchContent', q),
  restoreEntity: (
    row: Pick<Entity, 'id' | 'name' | 'content' | 'fields' | 'created_at'>,
    links: { from_id: number; to_id: number; relation: string; notes: string }[],
    featureIds: number[]
  ) => inv<void>('restoreEntity', row, links, featureIds),
  restoreEntities: (
    rows: Pick<Entity, 'id' | 'name' | 'content' | 'fields' | 'created_at'>[],
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
  // Dumps note tabs into a readable .txt tree (notes/<map>/<type>/<entity>/<note>.txt) + opens the folder
  exportNotes: () => inv<{ path: string; files: number }>('exportNotes'),
  // The .dunya file model (Wonderdraft-style): save / save as / open + dirty state
  saveWorld: () => inv<string | null>('saveWorld'),
  saveWorldAs: () => inv<string | null>('saveWorldAs'),
  openWorld: () => inv<string | null>('openWorld'),
  worldInfo: () => inv<{ file: string | null; dirty: boolean }>('worldInfo'),
  // Start screen: recent worlds (userData/recent.json — independent of the working copy)
  recentWorlds: () => inv<{ path: string; name: string; missing: boolean }[]>('recentWorlds'),
  openRecent: (path: string) => inv<boolean>('openRecent', path),
  forgetRecent: (path: string) => inv<void>('forgetRecent', path),
  newWorld: () => inv<void>('newWorld'),
  // Same behaviour as newWorld in this app — a separate command because that is where users
  // look for it (see newProject in main/index.ts).
  closeWorld: () => inv<void>('closeWorld'),
  // Application preferences (userData/prefs.json) — per machine, NOT part of the .dunya
  getPrefs: () => inv<{ language?: string; theme?: string }>('getPrefs'),
  savePrefs: (patch: { language?: string; theme?: string }) => inv<void>('savePrefs', patch),
  exportMapImage: (
    rect: { x: number; y: number; width: number; height: number },
    defaultName: string
  ) => inv<string | null>('exportMapImage', rect, defaultName)
}

export async function getHierConfig(): Promise<HierConfig> {
  const raw = await api.getSetting('hierarchyConfig')
  if (!raw) return { govs: [] }
  const parsed = JSON.parse(raw) as unknown
  // Legacy shape: a [{tag, mode}] array → convert to the new shape
  if (Array.isArray(parsed)) {
    const old = parsed as { tag: string; mode: string }[]
    return {
      govs: [{ name: 'Default', tags: old.filter((c) => c.mode === 'filtre').map((c) => c.tag) }]
    }
  }
  return { govs: (parsed as HierConfig).govs ?? [] }
}

export const saveHierConfig = (cfg: HierConfig): Promise<void> =>
  api.setSetting('hierarchyConfig', JSON.stringify(cfg))

// Built-in starter presets for the rank ladders. Merged, never forced (the "everything
// renameable" rule): a first-time user loads one to see how the ladder system works, then renames
// or reorders freely. The tags are only example ranks.
export const HIER_PRESETS: { name: string; govs: HierConfig['govs'] }[] = [
  {
    name: 'Medieval',
    govs: [
      { name: 'feudal', tags: ['#empire', '#kingdom', '#duchy', '#county', '#barony'] },
      { name: 'tribal', tags: ['#confederation', '#tribe', '#clan'] }
    ]
  },
  {
    name: 'Modern',
    govs: [
      { name: 'unitary', tags: ['#state', '#province', '#district'] },
      { name: 'federal', tags: ['#federation', '#state', '#county'] }
    ]
  }
]

// Add an empty ladder to the config for government forms newly discovered on entities
export function mergeHierConfig(cfg: HierConfig, discoveredGovs: string[]): HierConfig {
  const missing = discoveredGovs.filter((g) => !cfg.govs.some((x) => x.name === g))
  return missing.length
    ? { ...cfg, govs: [...cfg.govs, ...missing.map((name) => ({ name, tags: [] }))] }
    : cfg
}

// De-jure parent chain: the entity's year-based parent history lives as JSON in fields["parent"].
// Conquest = appending a {from, id} record; drag the slider back and the old parent returns by itself.
export interface ParentRec {
  from: number | null // null = since the beginning
  id: number // the parent entity's id (survives renames)
}

/** Read the year-based {from, id} list in fields[key] (parent chain, ruler history…). */
export function getYearRecs(fieldsJson: string, key: string): ParentRec[] {
  try {
    const f = JSON.parse(fieldsJson || '{}') as Record<string, string>
    const p = JSON.parse(f[key] ?? '[]') as ParentRec[]
    return Array.isArray(p) ? p : []
  } catch {
    return []
  }
}

export const getParents = (fieldsJson: string): ParentRec[] => getYearRecs(fieldsJson, 'parent')

/**
 * Gender inference (person id → 'M'|'F'). Priority:
 *   1. explicit `fields.gender` ('male'/'female')
 *   2. role: someone's father → male, mother → female
 *   3. spouse's opposite: a man's spouse → female and vice versa (propagated to a fixed point)
 * Used by both the family-tree display and the add-child relation (mother/father pick).
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
    if (l.relation === 'father') fatherSet.add(l.to_id)
    else if (l.relation === 'mother') motherSet.add(l.to_id)
    else if (l.relation === 'spouse') {
      pushSpouse(l.from_id, l.to_id)
      pushSpouse(l.to_id, l.from_id)
    }
  }
  const g = new Map<number, 'M' | 'F'>()
  for (const e of entities) {
    const c = (JSON.parse(e.fields || '{}') as Record<string, string>)['gender']
    if (c === 'male') g.set(e.id, 'M')
    else if (c === 'female') g.set(e.id, 'F')
    else if (fatherSet.has(e.id)) g.set(e.id, 'M')
    else if (motherSet.has(e.id)) g.set(e.id, 'F')
  }
  // Propagate from spouses: assign the opposite gender where the spouse is known (fixed point)
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

/** Parent in year Y: the record with the largest from <= Y (null = -∞). */
export function parentAt(recs: ParentRec[], year: number): number | null {
  let best: ParentRec | null = null
  for (const r of recs) {
    const from = r.from ?? -Infinity
    if (from <= year && (best === null || from > (best.from ?? -Infinity))) best = r
  }
  return best?.id ?? null
}

/** Is a feature/event visible in its year range (from/to; empty = unbounded). */
export const inYearRange = (
  from: number | undefined,
  to: number | undefined,
  year: number
): boolean => (from ?? -Infinity) <= year && year <= (to ?? Infinity)

/** Base set: entities carrying the LAST tag of each government form's ladder (map base
 *  polygons + Atlas share this set — single source). */
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

/** The TOP of the parent chain in that year (cycle-guarded). parentsOf: entity id to its
 *  year-based parent records — the caller feeds it from raw fields (Atlas) or a pre-parsed ref
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

/** Area of a polygon ring (shoelace, unsigned). CRS.Simple is a flat plane — no projection. */
export function ringArea(ring: number[][]): number {
  let s = 0
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i]
    const [x2, y2] = ring[(i + 1) % ring.length]
    s += x1 * y2 - x2 * y1
  }
  return Math.abs(s) / 2
}

// Map modes: user-defined dimensions (religion, language…) and colors per dimension+value.
// The value is read from the entity's fields[dim]; autoColor kicks in when no color is assigned.
export interface MapModes {
  dims: string[]
  colors: Record<string, Record<string, string>> // dim → value → hex
}

export async function getMapModes(): Promise<MapModes> {
  const raw = await api.getSetting('mapModes')
  if (!raw) return { dims: [], colors: {} }
  const p = JSON.parse(raw) as Partial<MapModes>
  return { dims: p.dims ?? [], colors: p.colors ?? {} }
}

export const saveMapModes = (m: MapModes): Promise<void> =>
  api.setSetting('mapModes', JSON.stringify(m))

// Entity templates (settings 'templates'): apply a ready field skeleton to a new entity.
// A starting point, NOT a constraint — every field stays editable and deletable afterwards,
// as does the template itself. Application goes through saveFields, so Ctrl+Z undoes it.
export interface EntityTemplate {
  name: string
  fields: Record<string, string> // field → default value (empty value = skeleton only)
}

// Fields that live in their own sections/mechanisms: they must not enter templates (not free
// metadata). The UNION of db.ts's TECH set (search) and EntityPage's render filter + person
// fields. Map-mode dimensions (dims) arrive at runtime; the caller filters them separately.
export const RESERVED_FIELDS = [
  'banner',
  'parent',
  'notes',
  'hierarchy',
  'government',
  'ruler',
  'house',
  'color',
  'gender',
  'birth',
  'death',
  'folder', // sidebar file-tree folder id (organisation only, not article metadata)
  '_tpl' // name of the applied template (informational; keeps EntityPage's select in sync)
]

// Sidebar file tree (settings 'entityFolders', global): user-made folders that group articles like
// Obsidian. An article's membership is fields['folder'] = a folder id (absent = root). Folders nest
// via `parent` (a folder id, null = root); `order` is the manual creation order.
export interface FolderDef {
  id: string
  name: string
  parent: string | null
  order: number
  color?: string // shown as the row dot; also the default color of drawings bound to its articles
  isPerson?: boolean // people live here (family/dynasty pickers; they cannot be bound to the map)
}

export const getEntityFolders = async (): Promise<FolderDef[]> =>
  JSON.parse((await api.getSetting('entityFolders')) || '[]')

export const saveEntityFolders = (list: FolderDef[]): Promise<void> =>
  api.setSetting('entityFolders', JSON.stringify(list))

// The old typeColor, re-homed: a drawing's default color is its article's folder color.
export const folderColor = (folders: FolderDef[], folderId: string | null): string =>
  folders.find((f) => f.id === folderId)?.color ?? '#888888'

// Ids of folders flagged as "people" (replaces the old TypeDef.isPerson)
export const personFolderIds = (folders: FolderDef[]): Set<string> =>
  new Set(folders.filter((f) => f.isPerson).map((f) => f.id))

export const getTemplates = async (): Promise<EntityTemplate[]> =>
  JSON.parse((await api.getSetting('templates')) || '[]')

export const saveTemplates = (list: EntityTemplate[]): Promise<void> =>
  api.setSetting('templates', JSON.stringify(list))

// Custom pin image library (settings 'pinImages', global): images the user uploaded to use
// as pins. path = assets/-relative path, ar = aspect ratio. Purely picker convenience — a
// pin's own style carries img+imgAR itself, so pins keep rendering correctly even after a
// record is removed from here.
export interface PinImage {
  path: string
  ar: number
}

export const getPinImages = async (): Promise<PinImage[]> =>
  JSON.parse((await api.getSetting('pinImages')) || '[]')

export const savePinImages = (list: PinImage[]): Promise<void> =>
  api.setSetting('pinImages', JSON.stringify(list))

// Boards (settings 'mapBoards', per map): multiple drawing layers on the same map (Photoshop
// mental model). Each feature is tied to the board (id) it was drawn on via `style.board`;
// switching boards hides the others'. NO external images — this only groups drawings over the
// same base image. Features with a missing/stale board id fall to the first board (deletion/
// rename cannot break them — see MapView).
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

// Timeline: the epoch is entirely user-defined (no BC/AD imposed).
// Years are signed integers: negative = before the epoch. year = the slider's last position (persisted).
export interface TimelineConfig {
  before: string // era abbreviation before the epoch (e.g. "BC", or an invented one)
  after: string // era abbreviation after the epoch
  min: number
  max: number
  year: number
  periods: { name: string; from: number; to: number }[] // named eras (Early Age…)
  events: { name: string; year: number; fid?: number; mid?: number }[] // events; fid/mid = linked feature and its map
}

const TIMELINE_DEFAULT: TimelineConfig = {
  before: 'BC', // defaults only — the user renames these freely in the timeline settings
  after: 'AD',
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

// Language and theme are APPLICATION preferences, so they live in userData/prefs.json rather than
// the settings table: a row there would ride inside a shared .dunya (opening someone else's world
// would change your language) and resetWorld() would wipe it on the next launch.
// Interface language — default English; changeable from Preferences.
export type Lang = 'en' | 'tr'

export async function getLanguage(): Promise<Lang> {
  const { language } = await api.getPrefs()
  return language === 'tr' ? 'tr' : 'en'
}

export const saveLanguage = (lang: Lang): Promise<void> => api.savePrefs({ language: lang })

// Theme — dark (teal) is the default; App.tsx writes <html data-theme>, all colors come from CSS tokens.
export type Theme = 'dark' | 'light'

export async function getTheme(): Promise<Theme> {
  const { theme } = await api.getPrefs()
  return theme === 'light' ? 'light' : 'dark'
}

export const saveTheme = (theme: Theme): Promise<void> => api.savePrefs({ theme })

// The color picker's "recent" strip (settings 'recentColors'; newest first, 12 entries).
// Cached in memory — no DB round trip per open; a page can hold many pickers.
const RECENT_COLORS = 12
let recentColors: string[] | null = null
export async function getRecentColors(): Promise<string[]> {
  if (!recentColors)
    recentColors = JSON.parse((await api.getSetting('recentColors')) || '[]') as string[]
  return recentColors
}
export async function pushRecentColor(hex: string): Promise<string[]> {
  const h = hex.toLowerCase()
  const list = [h, ...(await getRecentColors()).filter((c) => c !== h)].slice(0, RECENT_COLORS)
  recentColors = list
  await api.setSetting('recentColors', JSON.stringify(list))
  return list
}

// Deterministic color from a string for unassigned values (hex — ColorPicker-compatible)
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
