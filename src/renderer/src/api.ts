// Typed client wrapper around the narrow main-process API.
//
// The world's own rules — parent chains, ring area, derived colours, the calendar — moved to
// domain.ts, which knows nothing about IPC. They are re-exported below so that every existing
// `from './api'` still resolves; new code should import them from './domain.ts'. The dependency runs
// one way: this file imports domain.ts, never the reverse.
export * from './domain.ts'

import type { HierConfig, TimelineConfig } from './domain.ts'
import { MAX_LIST_ITEMS, TIMELINE_DEFAULT } from './domain.ts'

const inv = <T>(method: string, ...args: unknown[]): Promise<T> =>
  window.api.invoke(method, ...args) as Promise<T>

// userData/prefs.json — application preferences, per machine, never inside a .world.
export interface UiPrefs {
  language?: string
  theme?: string
  sidebarWidth?: number
  mapPanelWidth?: number
  debugLog?: boolean
  /** Interface scale as a percent; main applies it to the window (see applyUiScale). */
  uiScale?: number
}

/** The rungs the scale moves in — the same list main steps through for Zoom In/Out, repeated
    here because main cannot import the renderer and the renderer cannot import main. If one
    changes, change both; a mismatch shows up as a dropdown that cannot display the value the
    keyboard just set. */
export const UI_SCALES = [75, 90, 100, 110, 125, 150, 175, 200]

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

// Encode each path segment separately, for file names containing spaces etc.
export const assetUrl = (relPath: string): string =>
  'world://data/' + relPath.split('/').map(encodeURIComponent).join('/')

/**
 * Fire-and-forget, meaning BOTH ways a call can fail.
 *
 * The three logging methods carried that promise in a comment and `.catch(() => {})` in the code,
 * which covers a REJECTED promise and nothing else. `inv` reaches into `window.api.invoke`, and
 * when the bridge is missing that throws SYNCHRONOUSLY, straight past the catch — and the bridge is
 * missing exactly when the preload threw, which it does on purpose if context isolation is ever
 * lost (preload/index.ts). Seen live: loading the renderer without a preload, every error the app
 * reported produced a second error from the REPORTER, and the global handler that caught that one
 * called the reporter again. Bounded only by the five-second dedup in main.tsx.
 *
 * Reporting a fault must never be able to become one. There is nowhere to report that there is
 * nowhere to report.
 */
const quiet = (run: () => Promise<unknown>): void => {
  try {
    void run().catch(() => {})
  } catch {
    /* no bridge */
  }
}

export const api = {
  listEntities: (search = '') => inv<EntityRow[]>('listEntities', search),
  getEntity: (id: number) => inv<Entity | null>('getEntity', id),
  findEntityByName: (name: string) => inv<EntityRow | null>('findEntityByName', name),
  createEntity: (e: { name: string; content?: string; fields?: string }) =>
    inv<{ id: number }>('createEntity', e),
  updateEntity: (id: number, patch: Partial<Pick<Entity, 'name' | 'content' | 'fields'>>) =>
    inv<void>('updateEntity', id, patch),
  // The entity counterpart of updateFeatures: conquest re-parents every picked realm and that is
  // one action, so it is one transaction.
  updateEntities: (
    list: { id: number; patch: Partial<Pick<Entity, 'name' | 'content' | 'fields'>> }[]
  ) => inv<void>('updateEntities', list),
  deleteEntity: (id: number) => inv<void>('deleteEntity', id),
  deleteEntities: (ids: number[]) => inv<void>('deleteEntities', ids),
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
  // Error reporting. Deliberately fire-and-forget: a failure to report must never turn into a
  // second failure on top of the first. Through `quiet`, because `.catch()` alone was not that —
  // see below.
  logError: (where: string, message: string, stack: string, ctx: Record<string, unknown>) =>
    quiet(() => inv<void>('logRendererError', where, message, stack, ctx)),
  // Session events, batched by log.ts. Fire-and-forget for the same reason as logError: failing to
  // write a log line must never become a second failure on top of whatever it was describing.
  logEvents: (
    batch: { level: string; scope: string; data?: Record<string, unknown>; at: number }[]
  ) => quiet(() => inv<void>('logEvents', batch)),
  logSessionInfo: (info: Record<string, unknown>) => quiet(() => inv<void>('logSessionInfo', info)),
  openLogFolder: () => inv<void>('openLogFolder'),
  entityPlacements: () =>
    inv<{ entity_id: number; map_id: number; board: string | null }[]>('entityPlacements'),
  featuresByEntity: (entityId: number) =>
    inv<{ id: number; map_id: number; style: string; map_name: string }[]>(
      'featuresByEntity',
      entityId
    ),

  addLink: (from_id: number, to_id: number, relation: string) =>
    inv<{ id: number }>('addLink', from_id, to_id, relation),
  deleteLink: (id: number) => inv<void>('deleteLink', id),
  // Adding a family tie when the person is new is two writes into two tables, so it is one call
  // and one transaction — see db.ts. Either endpoint may be the creation, because a mother is
  // self→person and a child is person→self.
  addRelation: (
    from: number | { name: string; fields?: string },
    to: number | { name: string; fields?: string },
    relation: string
  ) =>
    inv<{ linkId: number; from_id: number; to_id: number; created?: number }>(
      'addRelation',
      from,
      to,
      relation
    ),
  deleteRelation: (linkId: number, createdEntityId?: number) =>
    inv<void>('deleteRelation', linkId, createdEntityId),
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
  // One user action that moves several drawings is ONE transaction in main — a weld writing a
  // border and its neighbour must not be able to half-happen. Use this instead of a loop of
  // updateFeature calls whenever the writes belong to a single undo step.
  updateFeatures: (
    list: { id: number; patch: Partial<Pick<Feature, 'entity_id' | 'geometry' | 'style'>> }[]
  ) => inv<void>('updateFeatures', list),
  deleteFeature: (id: number) => inv<void>('deleteFeature', id),
  deleteFeatures: (ids: number[]) => inv<void>('deleteFeatures', ids),
  createFeatures: (
    list: { map_id: number; entity_id?: number; geometry: string; style?: string }[]
  ) => inv<number[]>('createFeatures', list),
  // Whole user actions that span two tables. They exist because the entity's id is an input to
  // the feature, so the writes cannot be a batch — see the note above them in db.ts.
  createDrawing: (d: {
    map_id: number
    geometry: string
    style?: string
    entityName?: string
    entity_id?: number
  }) => inv<{ featureId: number; entityId?: number }>('createDrawing', d),
  deleteDrawing: (featureId: number, entityId?: number) =>
    inv<void>('deleteDrawing', featureId, entityId),
  createFeatureFork: (id: number, newStyle: string, closedStyle: string) =>
    inv<{ id: number }>('createFeatureFork', id, newStyle, closedStyle),
  deleteFeatureFork: (copyId: number, sourceId: number, sourceStyle: string) =>
    inv<void>('deleteFeatureFork', copyId, sourceId, sourceStyle),
  updateFeatureLink: (
    featureId: number,
    entityId: number | null,
    style: string,
    prevEntityId: number | null
  ) =>
    inv<{
      dropped: {
        id: number
        name: string
        content: string
        fields: string
        created_at: string
      } | null
    }>('updateFeatureLink', featureId, entityId, style, prevEntityId),

  getSetting: (key: string) => inv<string | null>('getSetting', key),
  setSetting: (key: string, value: string) => inv<void>('setSetting', key, value),

  pickImage: () => inv<string | null>('pickImage'),
  backupNow: () => inv<string>('backupNow'),
  // Dumps note tabs into a readable .txt tree (notes/<map>/<type>/<entity>/<note>.txt) + opens the folder
  exportNotes: () => inv<{ path: string; files: number; skipped: number }>('exportNotes'),
  // The .world file model: save / save as / open + dirty state
  saveWorld: () => inv<string | null>('saveWorld'),
  saveWorldAs: () => inv<string | null>('saveWorldAs'),
  openWorld: () => inv<string | null>('openWorld'),
  worldInfo: () => inv<{ file: string | null; dirty: boolean }>('worldInfo'),
  // package.json's version, for a bug report to cite — otherwise nothing in the UI says which
  // build someone is running.
  appVersion: () => inv<string>('appVersion'),
  // Start screen: recent worlds (userData/recent.json — independent of the working copy)
  recentWorlds: () => inv<{ path: string; name: string; missing: boolean }[]>('recentWorlds'),
  openRecent: (path: string) => inv<boolean>('openRecent', path),
  // The most recent session closed without saving, shown in its own start-screen section — a
  // system snapshot, not a file the user named, so it is not part of recentWorlds().
  previousSession: () => inv<{ path: string; name: string } | null>('previousSession'),
  openPreviousSession: () => inv<boolean>('openPreviousSession'),
  forgetRecent: (path: string) => inv<void>('forgetRecent', path),
  newWorld: () => inv<void>('newWorld'),
  // Same behaviour as newWorld in this app — a separate command because that is where users
  // look for it (see newProject in main/index.ts).
  closeWorld: () => inv<void>('closeWorld'),
  // Application preferences (userData/prefs.json) — per machine, NOT part of the .world.
  // Layout (panel widths, sidebar open) belongs here for the same reason as language/theme:
  // it describes how you like the app, not what the world contains.
  getPrefs: () => inv<UiPrefs>('getPrefs'),
  savePrefs: (patch: UiPrefs) => inv<void>('savePrefs', patch),
  // Export is three calls rather than one: the save dialog first (so a cancel costs nothing and
  // the map is not left stripped while a filename is chosen), then the capture. The window grows
  // in between only for a hi-res export — see beginHiResExport in main for why that is the only
  // way to get an image denser than the screen.
  chooseExportPath: (defaultName: string) => inv<string | null>('chooseExportPath', defaultName),
  captureMapImage: (
    rect: { x: number; y: number; width: number; height: number },
    filePath: string
  ) => inv<string | null>('captureMapImage', rect, filePath),
  beginHiResExport: (addW: number, addH: number) =>
    inv<[number, number] | null>('beginHiResExport', addW, addH),
  endHiResExport: () => inv<void>('endHiResExport')
}

export async function getHierConfig(): Promise<HierConfig> {
  const raw = await api.getSetting('hierarchyConfig')
  if (!raw) return { govs: [] }
  const parsed = parseSetting(raw, { govs: [] })
  // Legacy shape: a [{tag, mode}] array → convert to the new shape
  if (Array.isArray(parsed)) {
    // `c.mode` on a null element throws, and this runs on a file someone else wrote — one bad
    // entry would take the whole rank panel down rather than the entry with it.
    const old = asArray<{ tag?: unknown; mode?: unknown }>(parsed)
    return {
      govs: [
        {
          name: 'Default',
          tags: old
            .filter((c) => c && c.mode === 'filtre' && typeof c.tag === 'string')
            .map((c) => c.tag as string)
        }
      ]
    }
  }
  // Coerced like every other loader rather than trusted: `govs` is mapped over to build the
  // ladders and each gov's `tags` is mapped again, so both are size- and type-checked here.
  // asObject, not `parsed` directly. `parseSetting` falls back only when JSON.parse THROWS, so the
  // literal value `null` comes through as null — and `null.govs` is a TypeError that takes the rank
  // panel and Project Preferences down. `repairImportedJson` does not catch it either: it only
  // examines settings values that start with `{` or `[`. This was the one loader in the file
  // reading `parsed` without a coercion, and a hostile-value pass over every loader is what found
  // it (scripts/check-api.mjs).
  const obj = asObject<Partial<HierConfig>>(parsed, {})
  return {
    govs: asArray<{ name?: unknown; tags?: unknown }>(obj.govs).map((g) => ({
      name: asString(g?.name, ''),
      tags: asArray<unknown>(g?.tags).filter((x): x is string => typeof x === 'string')
    }))
  }
}

export const saveHierConfig = (cfg: HierConfig): Promise<void> =>
  api.setSetting('hierarchyConfig', JSON.stringify(cfg))

// Map modes: user-defined dimensions (religion, language…) and colors per dimension+value.
// The value is read from the entity's fields[dim]; autoColor kicks in when no color is assigned.
export interface MapModes {
  dims: string[]
  colors: Record<string, Record<string, string>> // dim → value → hex
}

/**
 * Shape coercion for values that come out of the `settings` table.
 *
 * `repairImportedJson` (db.ts) already guarantees that anything JSON-looking in there PARSES —
 * it resets what does not, at the gate, before the renderer ever sees it. What it cannot know is
 * the shape each key is supposed to have, and the loaders below spread a parsed value straight
 * into a typed object. A `.world` carrying `{"dims": "x"}` or `{"periods": 5}` therefore reaches
 * `.map()` on a string and takes down a whole screen — the map, the timeline, the sidebar —
 * where the honest outcome is that one setting falls back to its default.
 *
 * Not defensive habit: these three are the shapes this file actually consumes, and they are
 * applied only where a wrong one would throw during render.
 */
/**
 * Parse a settings value, or fall back.
 *
 * The gate in db.ts only validates values that LOOK like JSON — it checks anything starting with
 * `{` or `[`, because the same table legitimately holds plain text ('dark', 'tr', a file path).
 * So a `.world` that writes `hello` under `templates` walks straight past it, and every loader
 * below used to hand that to JSON.parse and throw during the screen's first render. The
 * fallback is the same one an absent value gets.
 */
const parseSetting = (raw: string | null | undefined, fallback: unknown): unknown => {
  if (!raw) return fallback
  try {
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

/**
 * How many items a settings array may carry out of a `.world`.
 *
 * The coercion below proved the value was an ARRAY and stopped there, which is only half of what
 * a shared file has to be held to: every one of these lists is rendered item by item somewhere —
 * a tab per template, a row per folder, a swatch per recent colour, a chip per map-mode dimension
 * on EVERY entry page, a band per era, a dot per event. A settings value is a plain JSON string
 * in a table, so `templates` holding a million entries costs the file about ten megabytes and
 * costs whoever opens it the app.
 *
 * This is gate 17's rule ("nothing unbounded may reach a per-item renderer") applied to the other
 * place it was needed. The number is chosen against what a person builds: the largest of these
 * lists in a real world runs to a few dozen, and anyone who reaches five thousand map-mode
 * dimensions has stopped building a world.
 */
// Nullish elements are dropped as well as the array being bounded. Almost every consumer reads a
// field off each item (`p.name`, `f.id`, `r.from`), so one `null` in a shared world's list is a
// throw during render — and none of these lists has ever legitimately held one.
// Exported as well as used below: a per-map value arrives through `perMapRaw`, which has already
// parsed, so those call sites need the coercion WITHOUT the parse in front of it. Same two rules,
// one copy — `settingArray`/`settingObject` further down are these with a JSON.parse bolted on.
export const asArray = <T>(v: unknown): T[] =>
  Array.isArray(v)
    ? (v.slice(0, MAX_LIST_ITEMS).filter((x) => x !== null && x !== undefined) as T[])
    : []
export const asObject = <T extends object>(v: unknown, fallback: T): T =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as T) : fallback
const asNumber = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback
const asString = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback)

/**
 * The two coercions above, exported for settings that are read where they are USED rather than
 * through a loader here — the layers panel, the per-map scale, the dismissed base-image hints,
 * travel modes, drawing defaults.
 *
 * Those six sites each did a bare `JSON.parse(raw || '{}')`. The gate in `repairImportedJson`
 * DELETES a settings value that looks like JSON and is not, which covers `{bozuk` — but a value
 * that does not start with `{` or `[` is not checked at all, because the same table legitimately
 * holds `dark`, `tr` and a file path. So `mapScales` set to the word `hello` by a shared world
 * threw inside a `.then()`, and the scale bar, the layer toggles or the drawing defaults simply
 * did not arrive, with an unhandled rejection as the only trace.
 */
export const settingObject = <T extends object>(raw: string | null | undefined, fallback: T): T =>
  asObject<T>(parseSetting(raw, fallback), fallback)
export const settingArray = <T>(raw: string | null | undefined): T[] =>
  asArray<T>(parseSetting(raw, []))

export async function getMapModes(): Promise<MapModes> {
  const raw = await api.getSetting('mapModes')
  if (!raw) return { dims: [], colors: {} }
  const p = asObject<Partial<MapModes>>(parseSetting(raw, {}), {})
  return { dims: asArray<string>(p.dims), colors: asObject(p.colors, {}) }
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

// Sidebar file tree (settings 'entityFolders', global): user-made folders that group articles.
// An article's membership is fields['folder'] = a folder id (absent = root). Folders nest
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
  asArray<FolderDef>(parseSetting(await api.getSetting('entityFolders'), []))

export const saveEntityFolders = (list: FolderDef[]): Promise<void> =>
  api.setSetting('entityFolders', JSON.stringify(list))

// The old typeColor, re-homed: a drawing's default color is its article's folder color.
export const folderColor = (folders: FolderDef[], folderId: string | null): string =>
  folders.find((f) => f.id === folderId)?.color ?? '#888888'

// Ids of folders flagged as "people" (replaces the old TypeDef.isPerson)
export const personFolderIds = (folders: FolderDef[]): Set<string> =>
  new Set(folders.filter((f) => f.isPerson).map((f) => f.id))

export const getTemplates = async (): Promise<EntityTemplate[]> =>
  asArray<EntityTemplate>(parseSetting(await api.getSetting('templates'), []))

export const saveTemplates = (list: EntityTemplate[]): Promise<void> =>
  api.setSetting('templates', JSON.stringify(list))

// Favourites (settings 'favorites'): the articles that get a group of their own at the top of
// the sidebar. Ids, in the world file — deliberately NOT a field on the entity: which articles
// you keep to hand is your way of working in this world, not a property OF the article, and in
// `fields` it would surface in templates, in the notes export and on the entity page. An id
// whose article is gone is simply skipped when the group is built (the orphan-id rule boards
// already use), so a deletion never has to reach in here.
export const getFavorites = async (): Promise<number[]> =>
  asArray<unknown>(parseSetting(await api.getSetting('favorites'), []))
    .filter((v) => typeof v === 'number')
    .map((v) => v as number)

export const saveFavorites = (ids: number[]): Promise<void> =>
  api.setSetting('favorites', JSON.stringify(ids))

// Custom pin image library (settings 'pinImages', global): images the user uploaded to use
// as pins. path = assets/-relative path, ar = aspect ratio. Purely picker convenience — a
// pin's own style carries img+imgAR itself, so pins keep rendering correctly even after a
// record is removed from here.
export interface PinImage {
  path: string
  ar: number
}

export const getPinImages = async (): Promise<PinImage[]> =>
  asArray<PinImage>(parseSetting(await api.getSetting('pinImages'), []))

export const savePinImages = (list: PinImage[]): Promise<void> =>
  api.setSetting('pinImages', JSON.stringify(list))

/**
 * Per-map settings: one `{ [mapId]: value }` row rather than a row per map — the shape `mapScales`
 * and `mapBoards` have always used, written down here because there are now five of them.
 *
 * The line for which side a setting falls on: **anything measured in a map's own terms belongs to
 * that map**, because the ruler itself does. `mapScales` is per map, so a continent calibrated in
 * km and a city in metres share no unit — which makes a project-wide travel speed in units/day
 * wrong on at least one of them. The same reasoning puts the year the slider sits on here, while
 * the calendar it sits on stays project-wide: a world has one history, one rank ladder and one
 * religion list however many maps draw it.
 *
 * `perMapRaw` hands back the WHOLE parsed value, not just this map's entry, because a key that used
 * to be project-wide is recognised by the shape of the whole thing — see the two callers in MapView
 * that fall back to it, so an upgrade re-uses the old value instead of silently dropping it.
 */
export const perMapRaw = async (key: string): Promise<unknown> =>
  parseSetting(await api.getSetting(key), {})

export const perMapEntry = <T>(whole: unknown, mapId: number): T | undefined =>
  asObject<Record<string, T>>(whole, {})[mapId]

/** Write one map's entry, or drop it with `null`. Read-modify-write: other maps' entries survive.
 *  asObject on the way IN as well, for the reason saveMapBoards gives below. */
export async function savePerMap<T>(key: string, mapId: number, value: T | null): Promise<void> {
  const all = asObject<Record<string, T>>(await perMapRaw(key), {})
  if (value === null) delete all[mapId]
  else all[mapId] = value
  await api.setSetting(key, JSON.stringify(all))
}

/**
 * Every per-map key, so that deleting a map can take its entries with it.
 *
 * This is not tidiness. `maps.id` is a plain rowid and SQLite HANDS IT BACK: delete the most
 * recently created map, make a new one, and it is born holding the dead map's scale, its board
 * list and its year — a map you never calibrated, already calibrated, in a unit you did not
 * choose. Leaving the entries behind was survivable while there were two of these; there are five.
 * A key added above and not added here re-opens it silently.
 */
const PER_MAP_KEYS = ['mapScales', 'mapBoards', 'mapYears', 'travelModes', 'mapLayers']

/** Lift one map's per-map settings out, handing them back so undo can put them back. */
export async function takeMapSettings(mapId: number): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  for (const k of PER_MAP_KEYS) {
    const v = perMapEntry<unknown>(await perMapRaw(k), mapId)
    if (v === undefined) continue
    out[k] = v
    await savePerMap(k, mapId, null)
  }
  // `hideMapHint` is a LIST of map ids rather than an object keyed by one — the single per-map
  // setting with a different shape, so it is handled beside the loop instead of bent into it.
  const hint = settingArray<number>(await api.getSetting('hideMapHint'))
  if (hint.includes(mapId)) {
    out.hideMapHint = true
    await api.setSetting('hideMapHint', JSON.stringify(hint.filter((x) => x !== mapId)))
  }
  return out
}

/** Put back what `takeMapSettings` lifted — deleting a map is undoable, so this has to be too. */
export async function restoreMapSettings(
  mapId: number,
  saved: Record<string, unknown>
): Promise<void> {
  for (const k of PER_MAP_KEYS) if (k in saved) await savePerMap(k, mapId, saved[k])
  if (saved.hideMapHint) {
    const hint = settingArray<number>(await api.getSetting('hideMapHint'))
    if (!hint.includes(mapId)) await api.setSetting('hideMapHint', JSON.stringify([...hint, mapId]))
  }
}

// Boards (settings 'mapBoards', per map): multiple drawing layers on the same map, the same
// mental model as image-editor layers. Each feature is tied to the board (id) it was drawn on
// via `style.board`;
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
  const all = asObject<Record<number, MapBoards>>(
    parseSetting(await api.getSetting('mapBoards'), {}),
    {}
  )
  const one = asObject<Partial<MapBoards>>(all[mapId], {})
  return { list: asArray(one.list), active: asString(one.active, '') }
}

export const saveMapBoards = async (mapId: number, data: MapBoards): Promise<void> => {
  // asObject on the way IN as well: spreading a string here would write one key per character
  // back into the setting, which is how a bad value stops being the file's problem and becomes
  // the world's.
  const all = asObject<Record<number, MapBoards>>(
    parseSetting(await api.getSetting('mapBoards'), {}),
    {}
  )
  if (data.list.length) all[mapId] = data
  else delete all[mapId]
  await api.setSetting('mapBoards', JSON.stringify(all))
}

export async function getTimeline(): Promise<TimelineConfig> {
  const raw = await api.getSetting('timeline')
  if (!raw) return TIMELINE_DEFAULT
  const p = asObject<Partial<TimelineConfig>>(parseSetting(raw, {}), {})
  // The numbers drive a range input and the arrays are mapped over during render, so each one is
  // taken only if it is what it claims to be. Everything else keeps the default it had.
  return {
    ...TIMELINE_DEFAULT,
    ...p,
    before: asString(p.before, TIMELINE_DEFAULT.before),
    after: asString(p.after, TIMELINE_DEFAULT.after),
    min: asNumber(p.min, TIMELINE_DEFAULT.min),
    max: asNumber(p.max, TIMELINE_DEFAULT.max),
    year: asNumber(p.year, TIMELINE_DEFAULT.year),
    periods: asArray(p.periods),
    events: asArray(p.events)
  }
}

export const saveTimeline = (t: TimelineConfig): Promise<void> =>
  api.setSetting('timeline', JSON.stringify(t))

/**
 * The year each map is being LOOKED at (settings 'mapYears', per map).
 *
 * The calendar above stays project-wide — one world, one set of eras, and the events and ruler
 * histories that hang off it are world data. What is per map is where the slider stands, because
 * that is a reading position and not a fact about the world: a campaign map parked at the empire's
 * founding and a city map parked three centuries later are two questions being asked at once, and
 * sharing one number meant switching maps silently moved the other one's borders.
 *
 * Undefined rather than a fallback when the map has no entry, because the caller's fallback is
 * `timeline.year` and it is read in the same breath: a newly created map opens where you were
 * rather than at zero, and from the first drag it keeps its own.
 */
export async function getMapYear(mapId: number): Promise<number | undefined> {
  const v = perMapEntry<unknown>(await perMapRaw('mapYears'), mapId)
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

export const saveMapYear = (mapId: number, year: number): Promise<void> =>
  savePerMap('mapYears', mapId, Math.round(year))

// Language and theme are APPLICATION preferences, so they live in userData/prefs.json rather than
// the settings table: a row there would ride inside a shared .world (opening someone else's world
// would change your language) and resetWorld() would wipe it on the next launch.
// Interface language — default English; changeable from Preferences.
export type Lang = 'en' | 'tr'

export async function getLanguage(): Promise<Lang> {
  const { language } = await api.getPrefs()
  return language === 'tr' ? 'tr' : 'en'
}

export const saveLanguage = (lang: Lang): Promise<void> => api.savePrefs({ language: lang })

// Theme — neutral grey dark is the default; App.tsx writes <html data-theme>, all colors come from
// CSS tokens. A theme IS a data-theme value plus a token block in main.css and nothing else, which
// is what would make a user-defined one an addition rather than a rewrite.
export type Theme = 'dark' | 'light' | 'teal'
const THEMES: Theme[] = ['dark', 'light', 'teal']

export async function getTheme(): Promise<Theme> {
  const { theme } = await api.getPrefs()
  // An unknown value falls back rather than reaching the DOM: prefs.json is hand-editable, and a
  // stray data-theme would leave every token at its :root value with no way to tell why.
  return THEMES.find((t) => t === theme) ?? 'dark'
}

export const saveTheme = (theme: Theme): Promise<void> => api.savePrefs({ theme })

// Developer logging. Per machine, like language and theme — and deliberately NOT in the world's
// settings table, or opening someone else's .world would switch it on for you.
export async function getDebugLog(): Promise<boolean> {
  const { debugLog } = await api.getPrefs()
  return debugLog === true
}
export const saveDebugLog = (on: boolean): Promise<void> => api.savePrefs({ debugLog: on })

// The color picker's "recent" strip (settings 'recentColors'; newest first, 12 entries).
// Cached in memory — no DB round trip per open; a page can hold many pickers.
const RECENT_COLORS = 12
let recentColors: string[] | null = null
export async function getRecentColors(): Promise<string[]> {
  // Filtered to actual hex, not merely to an array. This list is read, then written back by the
  // next pushRecentColor — so whatever a shared world seeded here would be persisted into the
  // user's OWN world on their next colour pick, which is the failure saveMapBoards' comment
  // describes: a bad value stops being the file's problem and becomes the world's. Every entry
  // this app has ever written is `#rrggbb`, so nothing real is lost.
  if (!recentColors)
    recentColors = asArray<unknown>(parseSetting(await api.getSetting('recentColors'), [])).filter(
      (c): c is string => typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c)
    )
  return recentColors
}
export async function pushRecentColor(hex: string): Promise<string[]> {
  const h = hex.toLowerCase()
  const list = [h, ...(await getRecentColors()).filter((c) => c !== h)].slice(0, RECENT_COLORS)
  recentColors = list
  await api.setSetting('recentColors', JSON.stringify(list))
  return list
}
