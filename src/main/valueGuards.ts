// What a value coming out of a world file — or in from the renderer — is allowed to BE.
//
// Every function here is pure: a string in, a name or a boolean out, no database, no filesystem,
// no module state. They lived in db.ts among the code that owns the connection, which made them
// look like part of it; they are not, and the rule they encode is easier to trust where nothing
// around it can write anything.
//
// The two gates they serve are in docs/security-gates.md: gate 2 (an embedded image name is
// validated, never repaired) and gate 39 (the WRITE boundary asks what the OPEN asks). That second
// one is the reason these are one copy and not two — `repairJson` and `assertFeaturePatch` MUST
// agree, and a rule this exact drifts on the first change to either if it exists twice.

/**
 * The only names `assets/` accepts — the one rule shared by both writers into that folder.
 *
 * `importAsset` is handed a path the USER picked in a native dialog. `unpackWorld` is handed a
 * name a SHARED `.world` carries, and it used to reduce whatever it was given to `basename()` and
 * write it. Confinement was never the hole there — basename closed that — but the CONTENT and the
 * EXTENSION were free: a world could drop arbitrary bytes into a folder inside the user's
 * Documents under any name it liked. `setup.exe` next to the map images, a `.dll` beside an
 * executable the user might later run from there, a `.lnk`, a `.url`. Nothing has to run for that
 * to be worth refusing, and the app was already refusing it on the other side of the same folder:
 * importAsset has always taken images only, so a `.world` was the way past the app's own rule.
 *
 * Nothing legitimate is lost. `importAsset` is the only thing that ever PUT a file in assets/, so
 * every name a real world carries is already an image name that passed this test once.
 *
 * The name is validated, never repaired. A name that needs fixing is not a name our own save
 * wrote, and silently turning `../logo.png` into `logo.png` writes over the image that IS ours.
 *
 * - the character class covers separators (escape), `:` (an NTFS alternate data stream, which
 *   `basename` leaves intact) and the control range (a newline in a filename)
 * - CON/NUL/COM1… are devices on Windows whatever the extension: writing `nul.png` writes nowhere
 * - the length bound is per component, well under the 255 a filesystem accepts
 */
// The control range is the point: a newline or a NUL inside a filename is exactly what this
// refuses, so it has to be spelled out rather than left to a shorthand.
/** Longest name assets/ accepts. importAsset clips to it when it disambiguates — see there. */
export const MAX_ASSET_NAME = 200
// eslint-disable-next-line no-control-regex
const ASSET_NAME = /^[^\\/:*?"<>|\u0000-\u001f]+\.(png|jpe?g|webp|gif)$/i
const WIN_DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)\./i
export function assetName(raw: unknown): string | null {
  return typeof raw === 'string' &&
    raw.length <= MAX_ASSET_NAME &&
    ASSET_NAME.test(raw) &&
    !WIN_DEVICE.test(raw)
    ? raw
    : null
}

/**
 * WHAT THE APP ACCEPTS IN A JSON COLUMN — one definition, used by both gates.
 *
 * These four were closures inside `repairImportedJson`, which was right while the entry gate was
 * the only place that asked the question. It is not any more: `updateFeature` writes the same
 * columns from the renderer and used to check nothing at all, so the app could put a row into its
 * own working copy that its own open would then reset (see assertFeaturePatch). Two copies of a
 * rule this exact would drift on the first change to either, so there is one copy and both callers
 * use it.
 *
 * They are pure — a string in, a boolean out, no database, no state — which is what makes lifting
 * them out mechanical rather than a redesign.
 *
 * Nesting depth, counted by scanning rather than parsing. Whether a deeply nested value parses at
 * all depends on how much STACK is left, so the gate and the consumer can disagree:
 * `{"a":{"a":…}}` 10000 deep parses fine here in main and then throws RangeError in the renderer,
 * underneath React's own call stack. Measured with a 208 KB file — it opened cleanly and left the
 * map and the entity page unable to render. Parsing to find out is therefore the wrong test; the
 * depth has to be bounded before anyone parses.
 *
 * 64 is far above anything this app writes: notes are an array of flat objects (3), the parent
 * history is an array of pairs (2), a GeoJSON polygon is 4. Quote-aware, because a brace inside a
 * string is not nesting; backslash skips the next character so an escaped quote does not end the
 * string early.
 */
const MAX_JSON_DEPTH = 64
export function depthOk(v: string): boolean {
  let depth = 0
  let inStr = false
  for (let i = 0; i < v.length; i++) {
    const c = v[i]
    if (inStr) {
      if (c === '\\') i++
      else if (c === '"') inStr = false
    } else if (c === '"') inStr = true
    else if (c === '{' || c === '[') {
      if (++depth > MAX_JSON_DEPTH) return false
    } else if (c === '}' || c === ']') depth--
  }
  return true
}
export function isPlainObject(v: string): boolean {
  if (!depthOk(v)) return false
  try {
    const p: unknown = JSON.parse(v)
    return typeof p === 'object' && p !== null && !Array.isArray(p)
  } catch {
    return false
  }
}
export function isArray(v: string): boolean {
  if (!depthOk(v)) return false
  try {
    return Array.isArray(JSON.parse(v))
  } catch {
    return false
  }
}
/** The geometry types the app draws. A `.world` may name no other. */
const GEOM_TYPES = new Set([
  'Point',
  'LineString',
  'Polygon',
  'MultiPoint',
  'MultiLineString',
  'MultiPolygon'
])
/**
 * `isPlainObject` is not enough for the geometry column, and it is the only one where that is
 * true. `{"type":"Polygon","coordinates":"x"}` is a perfectly good object, and it is what Leaflet
 * is handed: L.geoJSON walks `coordinates` and throws inside the reload, which is the same dead
 * map the syntax check exists to prevent, one step further in. So the shape is checked too,
 * shallowly: a known type and an array of coordinates.
 *
 * Nothing deeper, and that is a decision rather than an omission. The numbers themselves are
 * tolerated everywhere downstream (a NaN draws nothing; it does not throw), and a gate that walked
 * every ring of every polygon on open would cost more than it saves. It also has to stay this
 * shallow for the WRITE path to be able to share it: undo writes back the string the file came
 * with, so a rule stricter here than at the open would make Ctrl+Z fail on a world that opened
 * cleanly.
 */
export function isGeometry(v: string): boolean {
  if (!isPlainObject(v)) return false
  const g = JSON.parse(v) as { type?: unknown; coordinates?: unknown }
  return typeof g.type === 'string' && GEOM_TYPES.has(g.type) && Array.isArray(g.coordinates)
}
