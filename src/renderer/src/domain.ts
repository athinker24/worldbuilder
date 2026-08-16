// The world's own rules, with nothing about how they get here.
//
// Everything below is pure: a parent chain resolved for a year, a ring's area, an entry's derived
// colour, a year rendered against a user-defined calendar. None of it calls the IPC bridge, none of
// it touches `window`, and that is the point — it used to live in api.ts alongside the bridge, so a
// module that wanted `ringArea` imported the entire door to the main process to get it, and
// check-api.mjs had to stub `window.api` before it could reach a function that computes a polygon's
// area from four numbers.
//
// api.ts re-exports all of it, so every existing import still resolves and nothing had to change to
// make this move. New code should import from here; the re-export is a bridge, not a second home.
//
// The dependency runs ONE WAY — api.ts imports domain.ts and never the reverse. The types moved
// with the functions for exactly that reason: leaving ParentRec, HierConfig and TimelineConfig
// behind would have made domain.ts import api.ts for them, and the pair would have been a cycle.

// Hierarchy configuration: a top→bottom rank ladder per government form
// The bound every list read out of a `.world` is cut to (gate 20: settings arrays are bounded, not
// only typed). It lives here rather than beside the coercion helpers in api.ts because both sides
// need it — getYearRecs below, and asArray over there — and two copies of a safety limit is how
// one of them gets raised on its own.
export const MAX_LIST_ITEMS = 5000

export interface HierConfig {
  govs: { name: string; tags: string[] }[] // each government form's own ordered ladder
}

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

/**
 * Read the year-based {from, id} list in fields[key] (parent chain, ruler history…).
 *
 * The ELEMENTS are checked, not just the array, and this is the one list where that is not
 * pedantry: `parentAt` reads `r.from` in a loop that runs per base polygon on every year tick, so
 * a single null in a shared world's `fields.parent` throws inside `applyYear` — which is the map.
 * `repairImportedJson` cannot reach it either: that gate proves `fields` parses to an object, and
 * this list lives as a JSON string INSIDE one of its values, a level below where it looks.
 *
 * `from` is allowed to be absent as well as null — an older world wrote `{id}` alone, and
 * `parentAt` has always read it as "since the beginning".
 */
export function getYearRecs(fieldsJson: string, key: string): ParentRec[] {
  try {
    const f = JSON.parse(fieldsJson || '{}') as Record<string, string>
    const p: unknown = JSON.parse(f[key] ?? '[]')
    if (!Array.isArray(p)) return []
    return (p.slice(0, MAX_LIST_ITEMS) as unknown[]).filter((r): r is ParentRec => {
      if (!r || typeof r !== 'object') return false
      const rec = r as { from?: unknown; id?: unknown }
      return (
        typeof rec.id === 'number' &&
        (rec.from === null || rec.from === undefined || typeof rec.from === 'number')
      )
    })
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

export const TIMELINE_DEFAULT: TimelineConfig = {
  before: 'BC', // defaults only — the user renames these freely in the timeline settings
  after: 'AD',
  min: -500,
  max: 1500,
  year: 0,
  periods: [],
  events: []
}

export const formatYear = (y: number, cfg: TimelineConfig): string =>
  y < 0 ? `${-y} ${cfg.before}` : `${y} ${cfg.after}`

// Deterministic color from a string for unassigned values (hex — ColorPicker-compatible)
/**
 * A polygon's OUTLINE, from its fill colour: darker and less saturated.
 *
 * Drawing both with one colour makes the outline glow against its own fill — worst on light
 * colours, where a saturated stroke at full strength reads as neon against a pale interior. Every
 * paper map does the opposite: the line is the darker relative of the area it encloses.
 *
 * Derived rather than picked, so it follows whatever colour the user chooses and needs no second
 * control. Polygons only — on a path or a pin the stroke IS the content, and dimming what someone
 * picked would be answering a question they did not ask.
 */
export function outlineColor(fill: string): string {
  const m = /^#?([\da-f]{6})$/i.exec(fill.trim())
  if (!m) return fill // a pattern url, a css name, anything not a plain hex: leave it alone
  const n = parseInt(m[1], 16)
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  // Toward the colour's own grey (its luminance) takes the saturation out without shifting hue,
  // then a flat multiply darkens it. Both are small on purpose: this must read as the same colour.
  const grey = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
  return (
    '#' +
    rgb
      .map((v) => Math.round((v + (grey - v) * 0.25) * 0.72))
      .map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0'))
      .join('')
  )
}

/**
 * The same colour, LIT: `outlineColor`'s other direction, and it lives here so the pair does not
 * get separated.
 *
 * Used to mark a drawing the map was just told to show. A mark has to be visible against the shape
 * it marks, and the shape's own stroke is already the darker relative of its fill — so going darker
 * again would land on the border it is trying to replace. Toward white keeps the hue, which is the
 * whole point: the drawing lights up as ITSELF rather than in some colour the app chose for it, and
 * a colour the user picked is still recognisably theirs while it is lit.
 *
 * Same non-hex escape as its counterpart: a pattern url or a css name is handed back untouched.
 */
export function litColor(base: string): string {
  const m = /^#?([\da-f]{6})$/i.exec(base.trim())
  if (!m) return base
  const n = parseInt(m[1], 16)
  return (
    '#' +
    [(n >> 16) & 255, (n >> 8) & 255, n & 255]
      .map((v) => Math.round(v + (255 - v) * 0.5))
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('')
  )
}

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
