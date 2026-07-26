import { useEffect, useMemo, useRef, useState } from 'react'
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
  getMapBoards,
  getParents,
  getPinImages,
  getTimeline,
  inYearRange,
  lowestRungSet,
  MapBoards,
  MapRow,
  mergeHierConfig,
  ParentRec,
  parentAt,
  PinImage,
  ringArea,
  rootAtYear,
  saveMapBoards,
  savePinImages,
  saveTimeline,
  FolderDef,
  folderColor,
  personFolderIds,
  WorldMap
} from './api'
import ColorPicker from './ColorPicker'
import ContextMenu, { MenuItem, MenuState } from './ContextMenu'
import { ImageStrip } from './pinIcons'
import EntityPage from './EntityPage'
import HierarchyPanel, { ActiveMode } from './HierarchyPanel'
import { alertDialog, confirmDialog } from './dialog'
import Icon from './icons'
import { IconButton } from './ui'
import { useT } from './i18n'
import Timeline from './Timeline'
import MapToolbar from './MapToolbar'
import { startPaneResize } from './paneResize'
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

// --- Two Leaflet patches that steady the POLYGONS under a smooth (fractional) wheel zoom. ------
// Both were measured in a throwaway Leaflet harness (continuous setZoomAround sweep, logging each
// overlay's per-frame deviation from its own layer point); the numbers below are from that run.
// They were once reverted because the tremble persisted — that turned out to be the TEXT
// (see `text-rendering: geometricPrecision` in main.css), a separate cause. These fix the shapes.
// Module level is required: Leaflet captures a layer's handlers when it is ADDED, so a patch
// applied later does not take.
//
// 1. `Map.latLngToLayerPoint` ROUNDS the projected point so overlays land on whole pixels. During
//    a continuous zoom each vertex crosses its pixel boundary at a different moment, so an outline
//    wobbles up to a pixel while the map scales: 0.921px per-vertex wobble, 0.000px unrounded.
//    The rounding must come off for PATHS AND MARKERS TOGETHER — unround only one and the other
//    snaps against it, which just moves the tremble onto the labels (measured: 0.921px again).
//    The map half is in the map-setup effect; this is the marker half.
type Positionable = {
  update(): L.Marker
  _icon?: HTMLElement
  _map?: L.Map
  _latlng: L.LatLng
  _zIndex: number
  _setPos(p: L.Point): void
  _resetZIndex(): void
}
const markerProto = L.Marker.prototype as unknown as Positionable
const stockMarkerUpdate = markerProto.update
markerProto.update = function (this: Positionable): L.Marker {
  if (!this._icon || !this._map) return stockMarkerUpdate.call(this)
  this._setPos(this._map.latLngToLayerPoint(this._latlng)) // stock rounds this point
  this._zIndex = Math.round(this._zIndex) // _setPos derives it from y; a z-index must be integer
  this._resetZIndex()
  return this as unknown as L.Marker
}

// 2. Polyline simplification measures its tolerance in projected PIXELS at the current zoom and
//    re-runs on every re-projection, so the surviving vertex set kept changing: the outline
//    morphed on 174 of 199 swept frames, each change moving the border by up to `smoothFactor`
//    pixels. Invisible inside one realm (neighbours share a colour), glaring in rank/paint view
//    where every boundary is a colour edge. Scaling the tolerance by 2^(z - round(z)) makes it
//    constant in MAP units within a zoom level, so the shape is frozen while zooming and only
//    re-simplifies when crossing a whole zoom: 2 of 199 frames, with BORDER_SMOOTH's LOD intact.
//    Only works together with (1) — alone, the rounding noise flips borderline vertices anyway.
type Simplifiable = { _simplifyPoints(): void; _map?: L.Map; options: { smoothFactor?: number } }
const stockSimplify = (L.Polyline.prototype as unknown as Simplifiable)._simplifyPoints
;(L.Polyline.prototype as unknown as Simplifiable)._simplifyPoints = function (
  this: Simplifiable
): void {
  const zoom = this._map?.getZoom()
  const tol = this.options.smoothFactor
  if (zoom === undefined || !tol) return stockSimplify.call(this)
  this.options.smoothFactor = tol * 2 ** (zoom - Math.round(zoom))
  stockSimplify.call(this)
  this.options.smoothFactor = tol
}

// Shape of the Feature.style JSON (all optional — old records fall back to defaults)
interface FeatureStyle {
  color?: string
  fillOpacity?: number
  weight?: number
  size?: number
  font?: string
  childMapId?: number
  from?: number // year range the feature exists in (timeline); empty = always
  to?: number
  opacity?: number // line (path) opacity
  dash?: LineDash // line pattern (path tool)
  arrow?: LineArrow // direction arrow: none / at the end (migration, campaign, trade)
  curviness?: number // curvature 0-100 (lines only; a visual overlay, never touches vertices)
  img?: string // custom pin image (assets/-relative); replaces the glyph icon when set
  imgFree?: boolean // true = free image without a badge (aspect kept), false/empty = inside the badge
  imgAR?: number // the image's aspect ratio — free-mode height comes from here (not the library)
  fillImg?: string // polygon fill image (assets/-relative) — tiled via an SVG pattern
  text?: string // free text label (Point geometry + this field = a label, not a pin)
  angle?: number // label rotation angle (degrees)
  curve?: number // label curvature -100..100 (Wonderdraft curved text; 0 = straight)
  board?: string // id of the board (drawing layer) it belongs to — matches settings.mapBoards
  minZoom?: number // hide below this zoom (declutter pins/labels when zoomed out)
  maxZoom?: number // hide above this zoom
}

interface Props {
  id: number
  focus?: { featureId: number; token: number } | null // "show on map" from the sidebar — fly to the feature
  reloadToken: number // refresh features in place after undo/redo (no map remount, zoom kept)
  maps: MapRow[]
  folders: FolderDef[]
  onNavigate: (mapId: number) => void
  onOpenEntity: (id: number) => void
  onChanged: () => void
  // Hands the PNG exporter up to App so File > Export can fire it, and null on unmount.
  // Deliberately an opaque () => void — capturePage needs the live .leaflet-host element, which
  // only exists here, and no Leaflet type may leave this file.
  onExportReady?: (fn: (() => void) | null) => void
  // Photoshop's Tab / Shift+Tab, driven from App: hidePanels covers the inspector and the tool
  // settings popover, hideTools additionally hides the floating tool palette.
  hidePanels?: boolean
  hideTools?: boolean
}

interface FeatureLayer extends L.Layer {
  featureId?: number
  // true = this layer is the real/editable straight line with a curve overlay on top, so
  // applyYear drops it to near-invisible opacity (0.03) (see curvePoints)
  isCurveControl?: boolean
}

// Untyped internals of geoman's draw instances (map.pm.Draw.Marker/Line/Polygon) — needed to
// restyle an open draw session WITHOUT re-creating it (see updateDrawSettings). Only the
// fields we use.
interface DrawInstance {
  enabled?: () => boolean
  setOptions?: (o: { markerStyle?: L.MarkerOptions }) => void
  setPathOptions?: (o: L.PathOptions) => void
  _hintMarker?: L.Marker
  _layer?: { setStyle?: (o: L.PathOptions) => void }
}

// Pin = colored round badge with a white cartographic icon inside (divIcon). Center anchor:
// the badge sits centered on the point. Base diameter PIN_BASE; zoom scaling in updateOverlaySizes.
const PIN_BASE = 28
// LOD for polygon/line borders: Leaflet's built-in per-zoom simplification (smoothFactor,
// pixel-space Douglas–Peucker) drops vertices when zoomed out and restores full detail when zoomed
// in — cutting the SVG path-string rebuilt every wheel-zoom frame. Display-only: geoman editing and
// the weld read the real latlngs, not this render simplification. Raise to trade fidelity for speed.
const BORDER_SMOOTH = 2.5
const PIN_DEFAULT_COLOR = '#c0603a'
// Three looks: (1) free custom image — no badge, aspect kept (transparent PNG symbols);
// (2) custom image inside the badge — clipped to a circle (crest/portrait); (3) plain badge.
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
    // Free: iconSize/iconAnchor [0,0] + inner translate(-50%,-50%) (the label pattern) →
    // height comes from the ratio, no DOM measurement (reflow) needed
    const h = w / (m.imgAR || 1)
    return L.divIcon({
      className: 'pin-marker',
      html: `<img class="pin-img-free" src="${escapeHtml(assetUrl(m.img))}" style="width:${w}px;height:${h}px">`,
      iconSize: [0, 0],
      iconAnchor: [0, 0]
    })
  }
  // With an image it is clipped to a circle inside the badge; else a plain colored badge (the glyph set was removed)
  const inner = m.img ? `<img class="pin-badge-img" src="${escapeHtml(assetUrl(m.img))}">` : ''
  return L.divIcon({
    className: 'pin-marker',
    html: `<div class="pin-badge" style="background:${escapeHtml(color)}">${inner}</div>`,
    iconSize: [w, w],
    iconAnchor: [w / 2, w / 2],
    tooltipAnchor: [0, -w / 2]
  })
}

// Free text label (LegendKeeper "Labels"): map text without polygon or pin — a sea, a
// mountain range, a region name. iconSize/iconAnchor [0,0]: the icon's top-left sits exactly
// on the point and the inner div centers itself via translate(-50%,-50%) → no width math per
// text length. Zoom scales it via the `--lz` custom property (LABEL_BASE = zoom-0 base).
const LABEL_BASE = 16
// Derived-mode label (rank/paint): a base font (map units) below this means the region is too
// small, so no label is drawn (CK3 does not name tiny regions either)
const LABEL_MIN = 5
// The text is user input embedded into an html string → must be escaped (no XSS from a shared
// world.db; same rationale as blocking raw HTML in markdown).
const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
// Polygon label content. The span is what `.poly-label` centres with a CSS transform — the
// tooltip container itself is 0x0 so Leaflet never measures the text (see main.css for why).
const polyLabelHtml = (name: string): string => `<span>${escapeHtml(name)}</span>`
// A textPath href resolves document-wide → every label's path id must be unique
let labelSeq = 0
// Feature clipboard (Ctrl+C/V). MODULE level: MapView remounts on map switch (App keys it
// with `m-${id}`) — as a component ref the clipboard would be wiped on switch and pasting
// across maps would be impossible.
type ClipItem = { geometry: string; style: string; entity_id: number | null }
let clipboard: ClipItem[] = []
// Reads/writes go through module-level functions: react-hooks/immutability (rightly) bans
// writing an outer variable from inside a component — the clipboard never enters render, so
// state would be pointless.
const setClipboard = (v: ClipItem[]): void => {
  clipboard = v
}
const getClipboard = (): ClipItem[] => clipboard
const labelDivIcon = (
  s: {
    text?: string
    color?: string
    angle?: number
    curve?: number
    font?: string
  },
  basePx: number
): L.DivIcon => {
  const text = escapeHtml(s.text ?? '')
  const color = escapeHtml(s.color ?? '#ffffff')
  const font = escapeHtml(s.font ?? 'Cinzel')
  const angle = Number(s.angle) || 0
  const curve = Number(s.curve) || 0
  // Straight text renders through SVG textPath too (curve=0 → the arc collapses to a line;
  // measured: same position/width as an HTML div). The single path exists for CLICKING: a
  // div's hit area is always the whole box (clicks beside the letters still select), while
  // SVG with visiblePainted makes only the letters clickable. Design space font-size=100;
  // the SVG sizes in em. The arc is a quadratic Bézier: its midpoint (t=0.5) sits exactly on
  // the anchor (cy = H/2 + sag).
  //
  // ZOOM SCALING IS A TRANSFORM, NOT A FONT SIZE — the size is BAKED here and zoom only writes
  // the `--lz` custom property (inherited from _icon, see updateOverlaySizes). Measured in a
  // Leaflet harness by reading getStartPositionOfChar per glyph over a continuous zoom sweep:
  // rewriting font-size relaid the glyphs on 149 of 149 frames (up to 0.68 user units of
  // per-glyph shift) because every size change re-quantises glyph advances — along a curved
  // textPath that is exactly the letters "dancing". With scale() it was 0 of 149, identical to
  // not touching the label at all. transform-origin stays the default centre, so
  // translate(-50%,-50%) keeps the midpoint pinned to the anchor at every scale and angle.
  const F = 100
  const w = Math.max(text.length * F * 0.62, F) // estimated text width (~0.62em per letter)
  const sag = (curve / 100) * w * 0.3 // arc height (sagitta); + bends up, − bends down
  const pad = F
  const W = w + 2 * pad
  const H = 3 * F + 2 * Math.abs(sag)
  const cy = H / 2 + sag
  const id = `lblp${++labelSeq}`
  const html = `<svg class="map-label-svg" viewBox="0 0 ${W} ${H}" style="width:${W / F}em;height:${H / F}em;font-size:${basePx}px;font-family:'${font}',serif;transform:translate(-50%,-50%) scale(var(--lz,1)) rotate(${angle}deg)"><defs><path id="${id}" fill="none" d="M ${pad},${cy} Q ${W / 2},${cy - 2 * sag} ${W - pad},${cy}"/></defs><text font-size="${F}" fill="${color}" text-anchor="middle" dominant-baseline="central"><textPath href="#${id}" startOffset="50%">${text}</textPath></text></svg>`
  return L.divIcon({ className: 'map-label', html, iconSize: [0, 0], iconAnchor: [0, 0] })
}

// Polygon fill image (LegendKeeper region fills): the SVG <pattern> resolves document-wide via
// url(#id) (same mechanism as the worldArrow marker). One pattern def PER IMAGE, not per
// polygon. objectBoundingBox: the image is stretched over the REFERENCING polygon's bbox → it
// sticks to the polygon and scales with it on zoom (screen-fixed tiling was tried; zoomed out,
// the pattern repeated and broke — the user wanted the image pinned to the polygon). One def
// serves many polygons (the bbox resolves per referencer). fill-opacity works naturally over a
// pattern, so the existing opacity slider needed no change.
const fillPatternId = (path: string): string => `fillpat-${path.replace(/[^a-zA-Z0-9]/g, '_')}`

// Map scale: perUnit = real distance / map unit (px). Two methods: numeric map width
// (Wonderdraft) or measuring a known distance on the map. settings 'mapScales' =
// { [mapId]: {perUnit, unit} }. CRS.Simple is planar, so the math is pure Euclid — no projection.
const ringLen = (ring: number[][]): number => {
  let s = 0
  for (let i = 1; i < ring.length; i++)
    s += Math.hypot(ring[i][0] - ring[i - 1][0], ring[i][1] - ring[i - 1][1])
  return s
}
// ringArea lives in api.ts (shared with Atlas, pure geometry — no dependency on the heavy
// MapView module). ponytail: vertex average — not a shoelace centroid, fine for a label anchor
const ringCentroid = (ring: number[][]): [number, number] => {
  let sx = 0
  let sy = 0
  for (const [x, y] of ring) {
    sx += x
    sy += y
  }
  return [sx / ring.length, sy / ring.length]
}
// PCA main axis: long-axis angle (radians) from the vertex cloud's covariance + width along it.
// CK3/cartography use medial axis; PCA is enough at personal scale (ponytail: medial axis is overkill).
const pcaAxis = (verts: number[][]): { theta: number; extent: number } => {
  let mx = 0
  let my = 0
  for (const [x, y] of verts) {
    mx += x
    my += y
  }
  mx /= verts.length
  my /= verts.length
  let sxx = 0
  let sxy = 0
  let syy = 0
  for (const [x, y] of verts) {
    const dx = x - mx
    const dy = y - my
    sxx += dx * dx
    sxy += dx * dy
    syy += dy * dy
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy)
  const c = Math.cos(theta)
  const s = Math.sin(theta)
  let min = Infinity
  let max = -Infinity
  for (const [x, y] of verts) {
    const p = x * c + y * s
    if (p < min) min = p
    if (p > max) max = p
  }
  return { theta, extent: max - min }
}
const fmtDist = (v: number): string =>
  v >= 100 ? Math.round(v).toLocaleString() : v >= 10 ? v.toFixed(1) : v.toFixed(2)

// LegendKeeper-style curvature for roads/rivers/borders: a RENDER-ONLY Cardinal spline
// (Hermite). Never touches the raw vertices (geoman's Edit tool still drags the real corners)
// — it only produces a visual overlay (see isCurveControl in reloadFeatures/applyYear).
// curviness 0-100 → tangent strength s (0 = near-straight, 0.5 = classic Catmull-Rom).
const curvePoints = (coords: number[][], curviness: number): L.LatLng[] => {
  if (coords.length < 3) return coords.map(([x, y]) => L.latLng(y, x))
  const s = (Math.max(0, Math.min(100, curviness)) / 100) * 0.5
  const steps = coords.length > 150 ? 4 : 12 // ponytail: fewer subdivisions on very long paths
  const pt = (i: number): number[] => coords[Math.max(0, Math.min(coords.length - 1, i))]
  const out: L.LatLng[] = []
  for (let i = 0; i < coords.length - 1; i++) {
    const p0 = pt(i - 1)
    const p1 = pt(i)
    const p2 = pt(i + 1)
    const p3 = pt(i + 2)
    const m1 = [(p2[0] - p0[0]) * s, (p2[1] - p0[1]) * s]
    const m2 = [(p3[0] - p1[0]) * s, (p3[1] - p1[1]) * s]
    const n = i === coords.length - 2 ? steps + 1 : steps // the joint point is included only on the last segment
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

// ——— Navigation (LegendKeeper "navigation mode"): a route between two pins over the drawn
// road network. The graph is built only when a route is requested (not per frame). Coordinates
// are raw GeoJSON [x, y] = map pixels; CRS.Simple is planar so weights are pure Euclid (same
// contract as ringLen).
interface NavEdge {
  to: number
  w: number
  fid: number // the path feature this edge came from; -1 = off-road connection
}
type NavLine = { fid: number; coords: number[][] }
type NavPin = { fid: number; xy: number[] }
// A pin's nearest projection onto the road network (li: path, si: segment, t: 0-1 along it)
interface NavProj {
  li: number
  si: number
  t: number
  x: number
  y: number
  d: number
}

// A point's projection onto a segment: t = 0-1 position along it, d = perpendicular distance
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

// Build an undirected graph from the road network. Junctions emerge naturally as vertices
// within `eps` collapse into one node (the Chebyshev comparison convention from the weld
// code). Pins are projected onto their nearest segment and JOIN that segment's chain as
// nodes — so a route between two pins on the same stretch never detours to a corner and back.
const buildNavGraph = (
  lines: NavLine[],
  pins: NavPin[],
  eps: number
): { nodes: number[][]; adj: NavEdge[][]; pinNode: Map<number, number> } => {
  const nodes: number[][] = []
  const adj: NavEdge[][] = []
  // ponytail: O(n²) linear scan — a few hundred nodes at personal scale, no spatial index needed
  const findOrAdd = (x: number, y: number): number => {
    for (let i = 0; i < nodes.length; i++)
      if (Math.abs(nodes[i][0] - x) < eps && Math.abs(nodes[i][1] - y) < eps) return i
    nodes.push([x, y])
    adj.push([])
    return nodes.length - 1
  }
  const addEdge = (a: number, b: number, fid: number): void => {
    if (a === b) return // merged vertices → no zero-length self-loops
    const w = Math.hypot(nodes[a][0] - nodes[b][0], nodes[a][1] - nodes[b][1])
    adj[a].push({ to: b, w, fid })
    adj[b].push({ to: a, w, fid })
  }
  // 1. project every pin onto its nearest segment (all paths scanned; distance uncapped)
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
  // 2. build each path as a chain: v0 → (pin projections on that segment, in t order) → v1 → …
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
  // 3. connect pins to their projection points (a pin already on the road lands on the same node, no edge)
  const pinNode = new Map<number, number>()
  pins.forEach((p, i) => {
    const pinIdx = findOrAdd(p.xy[0], p.xy[1])
    pinNode.set(p.fid, pinIdx)
    const pr = proj[i]
    if (pr) addEdge(pinIdx, findOrAdd(pr.x, pr.y), -1)
  })
  return { nodes, adj, pinNode }
}

// Dijkstra (ponytail: O(V²) node pick — runs once per route, no heap needed).
// null when no route exists. Consecutive same-fid edges fold into one NavLeg.
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
  // rebuild the route backwards (to → from), then reverse
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
    // merge by fid (NOT by name: an unnamed road and off-road share the same null)
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
  folders,
  onNavigate,
  onOpenEntity,
  onChanged,
  onExportReady,
  hidePanels,
  hideTools
}: Props): React.JSX.Element {
  const t = useT()
  const divRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const featureGroupRef = useRef<L.FeatureGroup | null>(null)
  const imageLayerRef = useRef<L.ImageOverlay | null>(null)
  // Label base sizes in map units (zoom-0 pixels); converted to pixels on every zoom
  const labelMeta = useRef(new Map<number, { base: number; font: string }>())
  // Which features are free text labels — size/font live baked in the icon, so zoom only needs
  // to know WHICH icons take the `--lz` scale write (pins take a different branch)
  const labelText = useRef(new Set<number>())
  // Pin size multipliers; scale with zoom like polygon labels (glued to the map).
  // ar is set only on FREE custom-image pins (height = width / ar; no DOM measurement).
  const markerSize = useRef(new Map<number, { size: number; ar?: number }>())
  const [worldMap, setWorldMap] = useState<WorldMap | null>(null)
  const worldMapRef = useRef<WorldMap | null>(null) // so handlers (navigation) see current features
  const [selected, setSelected] = useState<Feature | null>(null)
  const selectedRef = useRef<Feature | null>(null) // so edit-mode handlers see the current selection
  // Multi-select (Ctrl+click): the EXTRA selected feature ids. `selected` stays PRIMARY — the
  // panel shows its controls, edits apply to the whole selection. Ctrl is deliberate
  // (Shift+wheel already adjusts size). Order: the primary always comes first.
  const [extraSel, setExtraSel] = useState<number[]>([])
  const selIds = selected ? [selected.id, ...extraSel.filter((x) => x !== selected.id)] : []
  const selIdsRef = useRef<number[]>([])
  const markedSel = useRef<number[]>([]) // last highlighted set (apply the diff, don't scan all layers)
  const lastMouse = useRef<L.LatLng | null>(null) // Ctrl+V target (last map cursor position)
  const clearSel = (): void => {
    setSelected(null)
    setExtraSel([])
  }
  // Inspector width: drag-resizable, remembered in userData/prefs.json like the sidebar.
  const [panelW, setPanelW] = useState(380)
  useEffect(() => {
    api.getPrefs().then((p) => p.mapPanelWidth && setPanelW(p.mapPanelWidth))
  }, [])

  // Leaflet measures its container once at creation and is never told about anything that resizes
  // it afterwards — the inspector opening, either panel being dragged, the sidebar collapsing.
  // A ResizeObserver on the host covers all of them at once instead of an effect per cause.
  // rAF because the observer fires mid-layout; pan:false keeps the top-left anchored so extra
  // width is revealed rather than the view jumping.
  useEffect(() => {
    const host = divRef.current
    if (!host) return
    let frame = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() =>
        mapRef.current?.invalidateSize({ animate: false, pan: false })
      )
    })
    ro.observe(host)
    return () => {
      cancelAnimationFrame(frame)
      ro.disconnect()
    }
  }, [])
  const [allEntities, setAllEntities] = useState<EntityRow[]>([])
  // Person entities cannot be bound to the map (see EntityPage — they exist for family/dynasty fields)
  const personFolders = personFolderIds(folders) // people cannot be bound to the map
  const [linkName, setLinkName] = useState('')
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [hudZoom, setHudZoom] = useState<number | null>(null)
  const hudTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // Map mode (CK3-like): rank → base polygons by their ancestor at that rank; paint → by dimension
  const [activeMode, setActiveMode] = useState<ActiveMode>(null)
  const activeModeRef = useRef<ActiveMode>(null)
  const [layersOpen, setLayersOpen] = useState(false)
  // Maps dropdown (map switching — replaced the sidebar list)
  const [mapsOpen, setMapsOpen] = useState(false)
  const [newMapName, setNewMapName] = useState<string | null>(null)
  const [editMapId, setEditMapId] = useState<number | null>(null) // inline rename
  // Boards (drawing layers on the same map): list + active; features bound via style.board
  const [boards, setBoards] = useState<MapBoards>({ list: [], active: '' })
  const boardsRef = useRef<MapBoards>(boards)
  const [boardsOpen, setBoardsOpen] = useState(false)
  const [newBoardName, setNewBoardName] = useState<string | null>(null)
  const [editBoardId, setEditBoardId] = useState<string | null>(null)
  const featBoard = useRef(new Map<number, string>()) // fid → the feature's board id (style.board)
  // Zoom visibility: fid → {min,max}; baseVisible = visibility APART from zoom (applyYear
  // writes it, refreshZoomVis reads it to toggle only the zoom-limited features)
  const zoomLimits = useRef(new Map<number, { min?: number; max?: number }>())
  const baseVisible = useRef(new Map<number, boolean>())
  // Timeline: layer registry for DB-free toggling on slider ticks
  const yearRef = useRef(0)
  // Years something changes on the map (a feature starts/ends/changes hands) — rail ticks
  const [changeYears, setChangeYears] = useState<number[]>([])
  // Bumped when an event is added from the map → reloads the Timeline config
  const [eventsToken, setEventsToken] = useState(0)
  const layerYears = useRef(new Map<number, { from?: number; to?: number }>())
  const allLayers = useRef(new Map<number, L.Layer[]>())
  // Layers panel: polygon/path/pin/label toggles (persisted in settings, applied DB-free in applyYear)
  const [layersOn, setLayersOn] = useState({ polygon: true, line: true, pin: true, label: true })
  const layersRef = useRef(layersOn)
  const featKind = useRef(new Map<number, 'polygon' | 'line' | 'pin' | 'label'>())
  // Map search: with a non-empty query, matches show in a dropdown (flown to via focusFeature)
  const [searchQ, setSearchQ] = useState('')
  // Pin filter: hidden folders ('' = pin whose article is in no folder). Session-only —
  // persisting this would leave stale records after a rename.
  const [pinHidden, setPinHidden] = useState<Set<string>>(new Set())
  const pinHiddenRef = useRef(pinHidden)
  const pinType = useRef(new Map<number, string>()) // fid → the bound article's folder id
  // Path direction arrow: fid → 'end'|'flow' (via SVG marker-mid/end, applied to the element in applyYear)
  const featArrow = useRef(new Map<number, LineArrow>())
  // Each feature's canonical render style — applyYear repaints from these, DB-free.
  // fillColor is separate: on an image-filled polygon it carries 'url(#fillpat-…)' (not a color).
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
  // De-jure parent chain (rank view + conquest): entity → parent history, rank targets, feature → entity
  const parentHist = useRef(new Map<number, ParentRec[]>())
  const rungTargets = useRef(new Map<number, string>()) // entities at the rank → color
  // Every entity's rank tags — conquest resolves "the ancestor at rank X" for ANY rank, not just
  // the displayed one (rungTargets only covers the active rank).
  const entTags = useRef(new Map<number, string[]>())
  const featEnt = useRef(new Map<number, number>())
  // For the default (root) view: base entities, every entity's color/name, feature areas
  const baseSet = useRef(new Set<number>())
  const entColors = useRef(new Map<number, string>())
  const entNames = useRef(new Map<number, string>())
  const featArea = useRef(new Map<number, number>())
  // Derived-mode labels (rank/paint, CK3-style): not DB features but transient markers built
  // in applyYear. labelGeo: base polygon geometry summary (fixed per reload generation; keys =
  // EPS-grid cell keys of the vertices — polygons sharing a vertex count as adjacent, geoman
  // snapping makes neighbouring coordinates exactly equal). dimValue: the paint value text.
  const labelGeo = useRef(
    new Map<
      number,
      { keys: string[]; verts: number[][]; area: number; centroid: [number, number] }
    >()
  )
  const dimValue = useRef(new Map<number, string>())
  // Derived-mode region labels. Their base size is baked into the icon, so zoom only writes
  // `--lz` on each — nothing else about them is needed on the hot path.
  const derivedLabels = useRef<L.Marker[]>([])
  const derivedSig = useRef('') // fid:group signature — no work on year ticks where ownership is unchanged
  // Mosaic-governed entities (year-independent): those appearing in ANY year of the base
  // polygons' parent histories. Their own drawings never show in the default view — on full
  // annexation (their mosaic emptying that year) the old hand-drawn polygon must not resurface.
  const mosaicManaged = useRef(new Set<number>())
  // Topological weld opens with Ctrl: dragging a vertex with Ctrl held moves the neighbouring
  // polygons' co-located vertices live DURING the drag (one-sided without Ctrl)
  const ctrlRef = useRef(false)
  // partner vertices of the active drag (found on dragstart, moved during drag).
  // oldGeom: the partner's geometry BEFORE the drag — captured here from the live layer
  // instead of stale wm.features, so undo returns to the right spot.
  const dragPartners = useRef<
    { layer: L.Polygon; fid: number; ring: number; idx: number; oldGeom: string }[]
  >([])
  // neighbour layers moved by the weld in this edit session — written to the DB on pm:update
  const weldTouched = useRef(new Map<number, { layer: L.Polygon; oldGeom: string }>())
  // Geometry writes are serial: no commit starts before the previous one, reload included,
  // fully finishes — editing two neighbouring borders back-to-back used to have the reloads
  // clobber each other (the known weld bug).
  const geomSaveChain = useRef<Promise<void>>(Promise.resolve())
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

  // ⚔ Conquest flow: step 1 click the conqueror's border polygon (receiver = its direct
  // parent that year), step 2 pick the conquered base polygons, OK → the picks join the
  // receiver from the slider year on. State + ref are kept together so layer click handlers
  // see the current state without a reload.
  // Two independent ranks. `recvLevel` = the rank the CONQUEROR is identified at, `level` = the
  // rank of what changes hands. The receiver is the clicked entity ITSELF, so nothing needs a
  // parent to conquer (a duchy can take another duchy, a county another county). Conquering at a
  // higher rank re-parents THAT rank's entity, so its whole sub-tree follows and its internal
  // structure survives (a conquered duchy keeps its counties).
  type Conquest =
    | null
    | { step: 'receiver'; level: string | null; recvLevel: string | null }
    | {
        step: 'picking'
        level: string | null
        recvLevel: string | null
        receiverId: number
        receiverName: string
        picked: Set<number>
      }
  const [conquest, setConquestState] = useState<Conquest>(null)
  const conquestRef = useRef<Conquest>(null)
  const setConquest = (c: Conquest): void => {
    conquestRef.current = c
    setConquestState(c)
  }
  const [ladderTags, setLadderTags] = useState<string[]>([])
  // Climb the parent chain to the ancestor carrying `level` (null level = the entity itself).
  // Returns null when that year's chain has no such ancestor. Cycle-guarded.
  const levelAncestor = (eid: number, level: string | null, year: number): number | null => {
    if (!level) return eid
    let cur: number | undefined = eid
    const seen = new Set<number>()
    while (cur !== undefined && !seen.has(cur)) {
      if ((entTags.current.get(cur) ?? []).includes(level)) return cur
      seen.add(cur)
      cur = parentAt(parentHist.current.get(cur) ?? [], year) ?? undefined
    }
    return null
  }
  // Is `maybeAncestor` somewhere up `node`'s chain that year? Guards against conquering your own
  // overlord, which would make the parent chain a loop.
  const isAncestorOf = (maybeAncestor: number, node: number, year: number): boolean => {
    let cur: number | undefined = node
    const seen = new Set<number>()
    while (cur !== undefined && !seen.has(cur)) {
      if (cur === maybeAncestor) return true
      seen.add(cur)
      cur = parentAt(parentHist.current.get(cur) ?? [], year) ?? undefined
    }
    return false
  }

  // 📏 Scale tool (state of the right panel's 'scale' tool): saved scale + active measure
  // session. Session kinds: calib (2 points → distance form), dist (cumulative ruler), area
  // (transient polygon). dist/area create NO persistent features — Wonderdraft's measure tool.
  const [mapScale, setMapScale] = useState<MapScale | null>(null)
  const scaleRef = useRef<MapScale | null>(null)
  const [barZoom, setBarZoom] = useState(0) // for the scale bar (no ref reads during render)
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
  const measureTemp = useRef<L.LayerGroup | null>(null) // transient point/line highlights
  const measurePoly = useRef<L.Polygon | null>(null) // the area session's live polygon
  const endMeasure = (): void => {
    measureTemp.current?.remove()
    measureTemp.current = null
    measurePoly.current = null
    setMeasure(null)
  }
  // Single writer: save/delete the scale (settings 'mapScales', per map)
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
  // For the live measure text: latlng list → length/area with units (px without a scale)
  const measureUnit = mapScale?.unit ?? 'px'
  const measureK = mapScale?.perUnit ?? 1
  const ptsXY = (pts: L.LatLng[]): number[][] => pts.map((p) => [p.lng, p.lat])

  // 🧭 Navigation session (a copy of the Measure pattern): pick two pins → route over the road network.
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
  const navTemp = useRef<L.LayerGroup | null>(null) // route highlight (not a persistent feature)
  const endNav = (): void => {
    navTemp.current?.remove()
    navTemp.current = null
    setNav(null)
  }
  const startNav = (): void => {
    endMeasure()
    setConquest(null) // no overlapping session may remain
    endNav()
    clearSel()
    setNav({ step: 'a' })
  }
  // Custom pin image library (settings 'pinImages', global — the travelModes pattern)
  const [pinImages, setPinImages] = useState<PinImage[]>([])
  const savePinLib = async (list: PinImage[]): Promise<void> => {
    setPinImages(list)
    await savePinImages(list)
  }
  // Upload: pickImage already copies into assets/, validates the extension and returns a
  // relative path. Then the base image's load-probe pattern: learn the ratio + verify decodability.
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

  // Travel modes (settings 'travelModes', global — the mapScales pattern). Speed = units/day.
  const [travelModes, setTravelModesState] = useState<TravelMode[]>([])
  const [travelModeIdx, setTravelModeIdx] = useState(0)
  const saveTravelModes = async (list: TravelMode[]): Promise<void> => {
    setTravelModesState(list)
    if (travelModeIdx >= list.length) setTravelModeIdx(0)
    await api.setSetting('travelModes', JSON.stringify(list))
  }

  // Route computation: build a graph from that year's visible pins and paths → Dijkstra →
  // highlight on the map. Reads wm.features (NOT the refs — pin/path refs stay empty in
  // derived modes).
  const computeRoute = (aFid: number, aName: string, bFid: number, bName: string): void => {
    const wm = worldMapRef.current
    const map = mapRef.current
    if (!wm || !map) return
    const year = yearRef.current
    const inYear = (s: FeatureStyle): boolean =>
      (s.from ?? -Infinity) <= year && year <= (s.to ?? Infinity)
    // The layers panel is deliberately ignored: hiding a path is a display choice, the network remains
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
    // ponytail: junction tolerance = 1/500 of the map's long edge (~6px on a 3000px map).
    // Geoman snapping (on by default) already makes coordinates shared; this tolerance mops up
    // float rounding and small misses. A single tunable number.
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

  // Tool and draw settings — event handlers read via refs (no stale closures)
  const [tool, setToolState] = useState<Tool | null>(null)
  const toolRef = useRef<Tool | null>(null)
  const [drawSettings, setDrawSettingsState] = useState<DrawSettings>(DEFAULT_DRAW)
  const drawRef = useRef<DrawSettings>(DEFAULT_DRAW)
  // Export: at capture time the UI covering the map (Time strip, HUD, Hierarchy panel,
  // conquest/event hints) temporarily leaves the render — a one-way, non-editable PNG like
  // Wonderdraft's "Export" (Save already happens automatically on every edit).
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
      worldMap?.name ?? 'map'
    )
    setExporting(false)
    if (path) alertDialog(t('Exported to {path}', { path }))
  }
  // Publish the exporter to App (File > Export > Current Map as Image). exportMap is a fresh
  // closure every render because it reads worldMap, so hand up a STABLE wrapper over a useLatest
  // ref — the same pattern wheelAdjustRef uses — instead of re-registering on every render.
  const exportLatest = useRef(exportMap)
  useEffect(() => {
    exportLatest.current = exportMap
  })
  useEffect(() => {
    onExportReady?.(() => void exportLatest.current())
    return () => onExportReady?.(null)
  }, [onExportReady])

  // Show the zoom HUD and hide it after 3s of inactivity.
  // The slider range is the map's current min/max zoom (minZoom is dynamic with a base image)
  const [hudRange, setHudRange] = useState<[number, number]>([-4, 4])
  const showHud = (zoom: number): void => {
    const map = mapRef.current
    if (map) setHudRange([map.getMinZoom(), map.getMaxZoom()])
    setHudZoom(zoom)
    clearTimeout(hudTimer.current)
    hudTimer.current = setTimeout(() => setHudZoom(null), 3000)
  }

  // Breadcrumb: walk the parent chain
  const crumbs: MapRow[] = []
  let cur = maps.find((m) => m.id === id)
  while (cur) {
    crumbs.unshift(cur)
    cur = maps.find((m) => m.id === cur!.parent_map_id)
  }

  // Edit mode applies ONLY to the selected feature: with vertex markers on every polygon/path
  // (enableGlobalEditMode) hundreds of points spawned and the map stuttered. Instead,
  // pm.enable() only on the selected feature's layers and pm.disable() on the rest. Called
  // only on a state change (no-op otherwise); heavy marker creation happens for one feature.
  const syncEditMode = (): void => {
    const editing = toolRef.current === 'edit'
    const selFid = selectedRef.current?.id ?? null
    for (const [fid, layers] of allLayers.current) {
      const want = editing && fid === selFid
      for (const l of layers) {
        const pm = (
          l as unknown as {
            pm?: { enabled?: () => boolean; enable: () => void; disable: () => void }
          }
        ).pm
        if (!pm) continue
        const isOn = pm.enabled?.() ?? false
        if (want && !isOn) pm.enable()
        else if (!want && isOn) pm.disable()
      }
    }
  }

  // Move the edit vertex markers to the selected feature when selection or tool changes
  useEffect(() => {
    selectedRef.current = selected
    syncEditMode()
  }, [selected, tool])

  // The single access point to geoman's draw instance (for the untyped internals, see DrawInstance)
  const drawInst = (shape: string): DrawInstance | undefined =>
    (mapRef.current?.pm.Draw as unknown as Record<string, DrawInstance | undefined> | undefined)?.[
      shape
    ]

  // Label PREVIEW (geoman's hint marker): labelDivIcon does not bake size into the html — the
  // fontSize is written from outside (the updateOverlaySizes pattern, design space
  // font-size=100). The hint marker is not in the featureGroup, so nobody wrote it: size/font
  // changes were invisible until placement. Same formula, one style write (no DOM measuring).
  const styleHintLabel = (scale: number): void => {
    const el = (drawInst('Marker')?._hintMarker as unknown as { _icon?: HTMLElement } | undefined)
      ?._icon
    if (!el) return
    el.style.setProperty('--lz', String(scale)) // size/font are baked by applyDrawStyle's icon
  }

  // Apply drawRef.current to the active draw tool (the shared path of tool start + setting
  // change). With drawing ALREADY open, never call enableDraw again: geoman's enable() spawns
  // the hint marker from scratch at `L.marker(map.getCenter())` — size tweaks made the preview
  // leap to the map centre (and wiped begun vertices on polygon/path). When open, restyle in place.
  const applyDrawStyle = (): void => {
    const map = mapRef.current
    const tl = toolRef.current
    if (!map || (tl !== 'polygon' && tl !== 'line' && tl !== 'marker' && tl !== 'label')) return
    const s = drawRef.current
    const shape = tl === 'polygon' ? 'Polygon' : tl === 'line' ? 'Line' : 'Marker'
    const inst = drawInst(shape)
    const live = inst?.enabled?.() ?? false
    if (tl === 'marker' || tl === 'label') {
      const icon =
        tl === 'marker'
          ? pinDivIcon(s.marker)
          : labelDivIcon(s.label, LABEL_BASE * (s.label.size ?? 1))
      if (live) {
        inst?.setOptions?.({ markerStyle: { icon } })
        inst?._hintMarker?.setIcon(icon)
      } else map.pm.enableDraw('Marker', { markerStyle: { icon } })
      if (tl === 'label') styleHintLabel(2 ** map.getZoom())
      return
    }
    const pathOptions =
      tl === 'polygon'
        ? {
            color: s.polygon.color,
            fillColor: s.polygon.fillImg
              ? `url(#${fillPatternId(s.polygon.fillImg)})`
              : s.polygon.color,
            fillOpacity: s.polygon.fillOpacity,
            weight: s.polygon.weight
          }
        : {
            color: s.line.color,
            weight: s.line.weight,
            opacity: s.line.opacity,
            dashArray: lineDashArray(s.line.dash, s.line.weight),
            lineCap: 'round' as const,
            fill: false
          }
    if (live) {
      inst?.setPathOptions?.(pathOptions)
      inst?._layer?.setStyle?.(pathOptions)
    } else map.pm.enableDraw(shape, { pathOptions })
  }

  // Close every geoman mode and open the requested tool; a second press on the same tool closes it
  const activateTool = (t: Tool): void => {
    const map = mapRef.current
    if (!map) return
    endMeasure() // a tool switch ends any active measure/navigation session
    endNav()
    map.pm.disableDraw()
    if (map.pm.globalDragModeEnabled()) map.pm.disableGlobalDragMode()
    if (map.pm.globalRemovalModeEnabled()) map.pm.disableGlobalRemovalMode()
    if (toolRef.current === t) {
      toolRef.current = null
      setToolState(null)
      syncEditMode() // when leaving edit, close the selected feature's vertex markers
      return
    }
    toolRef.current = t
    setToolState(t)
    syncEditMode() // entering edit opens the selection; switching tools closes the old edit
    // the preview shows the real settings (text/color/size/angle) — shared with setting changes
    if (t === 'polygon' || t === 'line' || t === 'marker' || t === 'label') applyDrawStyle()
    // 'scale' / 'nav': no geoman mode — the settings branch opens in the panel, sessions start there
    // 'edit': no global mode — syncEditMode made only the selection editable (above)
    else if (t === 'drag') map.pm.enableGlobalDragMode()
    else if (t === 'remove') map.pm.enableGlobalRemovalMode()
  }
  // Set a tool without the toggle: the context menu must always END UP in that mode, whereas
  // activateTool would close it if it happened to be the current one.
  const setTool = (t: Tool): void => {
    if (toolRef.current !== t) activateTool(t)
  }
  // Escape leaves the active tool. Needed because Edit/Move are reached from the context menu and
  // no longer have a toolbar button to press again — without this they would be one-way doors.
  // The conquest/measure/nav Escape handlers run first (they own their own sessions), so this one
  // stands down whenever a session is live.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || !toolRef.current) return
      if (conquest || measure || nav) return
      const el = e.target as HTMLElement
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return
      activateTool(toolRef.current) // same tool = toggle off
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // Setting change: save + apply to the active draw tool immediately
  const updateDrawSettings = (s: DrawSettings): void => {
    drawRef.current = s
    setDrawSettingsState(s)
    api.setSetting('drawSettings', JSON.stringify(s))
    applyDrawStyle()
  }

  // "Glue" labels and pins to the map: screen size = base (map units) × zoom scale.
  // reposition=true only on setting/content changes (with no map movement); FALSE on the zoom
  // hot path — Leaflet already repositions every tooltip on 'zoom' (DivOverlay.getEvents →
  // _updatePosition), and our map handler runs before those, so the font write lands before
  // Leaflet reads offsetWidth. Calling tooltip.update() per label per tick meant hundreds of
  // synchronous reflows = serious lag.
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
      // location pin: scale the badge divIcon by zoom (centre anchor; without recreating the DOM)
      const ms = markerSize.current.get(fl.featureId)
      const pinEl = (l as unknown as { _icon?: HTMLElement })._icon
      if (ms !== undefined && pinEl) {
        const w = PIN_BASE * ms.size * scale
        if (ms.ar) {
          // free custom image: the box is 0×0, the img carries its own size (centred via CSS transform)
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
      // Free text label: size and font are baked into the icon; zoom only writes `--lz`, which
      // the svg's transform reads (see labelDivIcon for why a transform and not a font size).
      // A custom property INHERITS, so writing it here on _icon reaches the svg — no lookup.
      if (labelText.current.has(fl.featureId) && pinEl)
        pinEl.style.setProperty('--lz', String(scale))
    })
    // Derived-mode labels (on the map, outside the featureGroup): same pattern as free labels
    // — one fontSize write, no DOM measuring (SVG em sizing scales text + arc together)
    for (const m of derivedLabels.current) {
      const el = (m as unknown as { _icon?: HTMLElement })._icon
      if (el) el.style.setProperty('--lz', String(scale)) // base is baked; see labelDivIcon
    }
    // the open label preview (the hint marker is outside the featureGroup too) — scale it on zoom
    if (toolRef.current === 'label') styleHintLabel(scale)
  }

  // Delete + undo record; used by geoman's removal mode, the context menu and the Del key.
  // With several ids, ONE undo record (a multi-select delete reverts in one step).
  const removeFeature = async (...fids: number[]): Promise<void> => {
    const all = (await api.getMap(id))?.features ?? []
    const rows = fids.map((fid) => all.find((f) => f.id === fid)).filter((r) => r !== undefined)
    for (const fid of fids) await api.deleteFeature(fid)
    if (rows.length) {
      // A deleted-then-recreated row gets a NEW id → identity lives in a mutable ref (the undo pattern)
      const refs = rows.map((r) => ({ id: r.id, row: r }))
      const recreate = async (): Promise<void> => {
        for (const r of refs)
          r.id = (
            await api.createFeature({
              map_id: id,
              entity_id: r.row.entity_id ?? undefined,
              geometry: r.row.geometry,
              style: r.row.style
            })
          ).id
      }
      pushUndo({
        undo: recreate,
        redo: async () => {
          for (const r of refs) await api.deleteFeature(r.id)
        }
      })
    }
    clearSel()
    await reloadFeatures()
  }

  // --- Copy / paste / duplicate (Ctrl+C / Ctrl+V / Ctrl+D) ---
  // The clipboard is MODULE level: MapView remounts on map switch (key={m-id}); as a ref the
  // copied features would vanish on switch — this is what makes cross-map pasting work.
  const copySelection = (): void => {
    const feats = worldMapRef.current?.features ?? []
    setClipboard(
      selIdsRef.current
        .map((fid) => feats.find((f) => f.id === fid))
        .filter((f) => f !== undefined)
        .map((f) => ({ geometry: f.geometry, style: f.style, entity_id: f.entity_id }))
    )
  }
  // Shift GeoJSON coordinates (Point/LineString/Polygon — nesting depth is irrelevant)
  const shiftCoords = (c: unknown, dx: number, dy: number): unknown =>
    typeof (c as number[])[0] === 'number'
      ? [(c as number[])[0] + dx, (c as number[])[1] + dy]
      : (c as unknown[]).map((k) => shiftCoords(k, dx, dy))
  const eachPoint = (c: unknown, fn: (p: number[]) => void): void => {
    if (typeof (c as number[])[0] === 'number') fn(c as number[])
    else (c as unknown[]).forEach((k) => eachPoint(k, fn))
  }
  // Paste the clipboard into this map: the group's centre lands under the cursor (without a
  // cursor, a +8-unit offset — Ctrl+D duplication uses this path too). New features are
  // tagged to the ACTIVE board.
  const pasteClipboard = async (atCursor: boolean): Promise<void> => {
    const items = getClipboard()
    if (!items.length) return
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity
    for (const it of items)
      eachPoint(JSON.parse(it.geometry).coordinates, (p) => {
        minX = Math.min(minX, p[0])
        maxX = Math.max(maxX, p[0])
        minY = Math.min(minY, p[1])
        maxY = Math.max(maxY, p[1])
      })
    const cur = atCursor ? lastMouse.current : null
    const dx = cur ? cur.lng - (minX + maxX) / 2 : 8
    const dy = cur ? cur.lat - (minY + maxY) / 2 : -8
    const active = boardsRef.current.list.length ? boardsRef.current.active : undefined
    const make = async (): Promise<number[]> => {
      const out: number[] = []
      for (const it of items) {
        const g = JSON.parse(it.geometry)
        const style = { ...(JSON.parse(it.style || '{}') as FeatureStyle) }
        if (active) style.board = active
        const { id: nid } = await api.createFeature({
          map_id: id,
          entity_id: it.entity_id ?? undefined,
          geometry: JSON.stringify({ ...g, coordinates: shiftCoords(g.coordinates, dx, dy) }),
          style: JSON.stringify(style)
        })
        out.push(nid)
      }
      return out
    }
    const ref = { ids: await make() }
    pushUndo({
      undo: async () => {
        for (const nid of ref.ids) await api.deleteFeature(nid)
      },
      redo: async () => {
        ref.ids = await make()
      }
    })
    await reloadFeatures()
    const fresh = (await api.getMap(id))?.features ?? []
    setSelected(fresh.find((f) => f.id === ref.ids[0]) ?? null)
    setExtraSel(ref.ids.slice(1))
  }
  const duplicateSelection = async (): Promise<void> => {
    const keep = getClipboard()
    copySelection()
    await pasteClipboard(false) // duplication ignores the cursor: fixed offset
    setClipboard(keep) // Ctrl+D must not clobber the clipboard
  }

  // Border evolution: fork the feature into a copy starting at the slider year and close the
  // old one at year-1. The user then nudges only the changed vertices — no redrawing from scratch.
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

  // Add an event bound to a feature (year = the slider year when the menu opened) — the
  // StoryMap pattern. Electron does not support window.prompt, so the name comes from a small
  // form that opens at the top.
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

  // Clicking an event: fly to the feature and flash it twice (applyYear restores the canonical
  // style). On another map, switch there first (clicking again focuses).
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

  // Reload generation: rapid successive edits (dragging a slider) start overlapping reloads;
  // only the LATEST may touch the map. Clearing used to happen BEFORE the first await — each
  // call wiped the whole map, then while awaiting data the next call cut in, and with
  // finishes arriving out of order the map "bounced back and forth" (all features at once,
  // because what was wiped was the entire layer group). Now: stale generations return early
  // after the awaits; clear+build is one synchronous block — the map never shows a blank frame.
  const reloadGen = useRef(0)
  const reloadFeatures = async (): Promise<void> => {
    const gen = ++reloadGen.current
    const wm = await api.getMap(id)
    // Parent histories, the base set and color/name records fill in EVERY mode: conquest year
    // ticks, rank resolution and the default (root) view all feed from here
    const [h, cfgRaw, modes] = await Promise.all([api.hierarchy(), getHierConfig(), getMapModes()])
    if (gen !== reloadGen.current) return // a newer reload started — this one is stale
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
    pinType.current.clear()
    featBoard.current.clear()
    zoomLimits.current.clear()
    baseVisible.current.clear()
    featArrow.current.clear()
    renderStyle.current.clear()
    parentHist.current.clear()
    rungTargets.current.clear()
    entTags.current.clear()
    featEnt.current.clear()
    weldTouched.current.clear()
    dragPartners.current = []
    const cfg = mergeHierConfig(cfgRaw, h.govs)
    baseSet.current.clear()
    entColors.current.clear()
    entNames.current.clear()
    featArea.current.clear()
    labelGeo.current.clear()
    dimValue.current.clear()
    // Derived labels live on the map, not in the featureGroup — fg.clearLayers() won't remove them
    for (const m of derivedLabels.current) m.remove()
    derivedLabels.current = []
    derivedSig.current = ''
    for (const e of h.entities) {
      const recs = getParents(e.fields)
      if (recs.length) parentHist.current.set(e.id, recs)
      entNames.current.set(e.id, e.name)
      entColors.current.set(
        e.id,
        (JSON.parse(e.fields || '{}') as Record<string, string>)['color'] ?? autoColor(e.name)
      )
      if (e.tags.length) entTags.current.set(e.id, e.tags)
    }
    // Ladder tags top→bottom (deduped across government forms) — the conquest rank picker
    setLadderTags([...new Set(cfg.govs.flatMap((g) => g.tags))])
    // The lowest rank is per-government: each ladder's LAST tag is that government's base
    // rank (shared lowestRungSet source with Atlas).
    for (const eid of lowestRungSet(cfg, h.entities)) baseSet.current.add(eid)
    // Mosaic-governed: start from the base entities drawn on this map and take the closure of
    // their parent histories (chain: barony histories yield counties, county histories kingdoms)
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
    // Rank mode: base polygons painted by their ancestor at that rank (color resolved in
    // applyYear). Paint mode: base polygons colored by fields[dim]; empty values grey.
    let paint: { base: Set<number>; color: Map<number, string> } | null = null
    let rank: { base: Set<number> } | null = null
    const mode = activeModeRef.current
    if (mode?.kind === 'paint') {
      const color = new Map<number, string>()
      for (const e of h.entities) {
        if (!baseSet.current.has(e.id)) continue
        const value = (JSON.parse(e.fields || '{}') as Record<string, string>)[mode.key]
        color.set(e.id, value ? (modes.colors[mode.key]?.[value] ?? autoColor(value)) : '#666666')
        if (value) dimValue.current.set(e.id, value) // label text; a valueless (grey) region gets none
      }
      paint = { base: baseSet.current, color }
    } else if (mode?.kind === 'rank') {
      rank = { base: baseSet.current }
      // Rank targets: entities carrying the displayed tag
      for (const e of h.entities)
        if (e.tags.includes(mode.key)) rungTargets.current.set(e.id, entColors.current.get(e.id)!)
    }
    const chYears = new Set<number>()
    const derived = paint ?? rank // derived modes: base polygons only, no labels
    for (const f of wm.features) {
      const isPolygon = f.geometry.includes('"Polygon"')
      const isLine = f.geometry.includes('"LineString"')
      if (derived && (f.entity_id === null || !derived.base.has(f.entity_id) || !isPolygon))
        continue
      const style = JSON.parse(f.style || '{}') as FeatureStyle
      // A label has Point geometry like a pin — the discriminator is the text field in style
      const isLabel = !isPolygon && !isLine && style.text !== undefined
      const color = paint
        ? paint.color.get(f.entity_id!)!
        : rank
          ? '#666666' // the rank color is resolved from the parent chain in applyYear
          : (style.color ?? folderColor(folders, f.entity_folder))
      const lineOpacity = isLine ? (style.opacity ?? 0.9) : 1
      const dashArray = isLine ? lineDashArray(style.dash, style.weight ?? 3) : ''
      // Fill images only on polygons in their own view (derived modes paint by data)
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
          // LOD: fewer rendered vertices when zoomed out (see BORDER_SMOOTH). Pins/labels are
          // Point layers — smoothFactor is a no-op for them, so applying it unconditionally is fine.
          smoothFactor: BORDER_SMOOTH,
          // On an image-filled polygon Leaflet's viewport clipping is OFF: clipping shrinks
          // the path's bbox, the objectBoundingBox pattern stretches over the clipped piece →
          // the image slides on zoom/pan. With noClip the path is always the full polygon,
          // the bbox fixed, the image glued. (Unclipped render cost is negligible at personal scale.)
          noClip: fillColor !== color
        } as L.PolylineOptions,
        pointToLayer: (_gf, latlng) =>
          L.marker(latlng, {
            icon: isLabel ? labelDivIcon(style, LABEL_BASE * (style.size ?? 1)) : pinDivIcon(style)
          })
      })
      featKind.current.set(
        f.id,
        isPolygon ? 'polygon' : isLine ? 'line' : isLabel ? 'label' : 'pin'
      )
      if (!isPolygon && !isLine && !isLabel) pinType.current.set(f.id, f.entity_folder ?? '')
      if (style.board !== undefined) featBoard.current.set(f.id, style.board)
      if (style.minZoom !== undefined || style.maxZoom !== undefined)
        zoomLimits.current.set(f.id, { min: style.minZoom, max: style.maxZoom })
      // Direction arrow (at the end): marker-end on the real line's path (applied in applyYear)
      if (isLine && style.arrow === 'end') featArrow.current.set(f.id, 'end')
      if (style.from !== undefined || style.to !== undefined)
        layerYears.current.set(f.id, { from: style.from, to: style.to })
      if (f.entity_id !== null) {
        featEnt.current.set(f.id, f.entity_id)
        // conquest years become rail ticks
        for (const r of parentHist.current.get(f.entity_id) ?? [])
          if (r.from !== null) chYears.add(r.from)
      }
      if (style.from !== undefined) chYears.add(style.from)
      if (style.to !== undefined) chYears.add(style.to + 1) // the change shows the year after the end
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
        // Curvature: the real line (for vertex editing) stays near-invisible, with a
        // non-interactive curve overlay in the same style on top (matched via isCurveControl in applyYear)
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
          if (derived) {
            // Geometry summary for derived labels. Grid rounding (EPS=0.01) is the same
            // tolerance as the weld's Chebyshev compare; snapping makes coordinates exactly
            // equal, so cells hold. ponytail: a vertex pair within EPS but across a cell
            // boundary could in theory split a component — write the 4 neighbour cells too if seen.
            const geom = JSON.parse(f.geometry) as { type: string; coordinates: number[][][] }
            if (geom.type === 'Polygon') {
              const ring = geom.coordinates[0]
              labelGeo.current.set(f.id, {
                keys: ring.map(([x, y]) => `${Math.round(x / 0.01)}_${Math.round(y / 0.01)}`),
                verts: ring,
                area: ringArea(ring),
                centroid: ringCentroid(ring)
              })
            }
          }
        }
        // Badge scaling ONLY for pins; a label is Point too but its font scales (the labelText branch)
        if (!isPolygon && !isLabel)
          markerSize.current.set(f.id, {
            size: style.size ?? 1,
            ar: style.img && style.imgFree ? (style.imgAR ?? 1) : undefined
          })
        if (isLabel) labelText.current.add(f.id)
        // No tooltip on a label — its text is already visible
        if (f.entity_name && !derived && !isLabel) {
          // On a polygon the name sits centred, sized with the polygon; on a marker it shows
          // on hover. escapeHtml is REQUIRED: Leaflet renders string tooltips via innerHTML
          // (DivOverlay._updateContent) — an entity NAMED `<img onerror=…>` in a shared .dunya
          // would run code with no click.
          if (isPolygon) {
            layer.bindTooltip(polyLabelHtml(f.entity_name), {
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
            layer.bindTooltip(escapeHtml(f.entity_name), { sticky: true })
          }
        }
        layer.on('click', (ev) => {
          if (measureRef.current) return // measure session: the click falls through to the map handler
          // 🧭 Navigation: clicks pick the start/destination pin
          const nv = navRef.current
          if (nv && nv.step !== 'result') {
            if (isPolygon || isLine) return // only pins can be picked
            const name = f.entity_name ?? `#${f.id}`
            if (nv.step === 'a') setNav({ step: 'b', aFid: f.id, aName: name })
            else if (f.id !== nv.aFid) computeRoute(nv.aFid, nv.aName, f.id, name)
            return
          }
          // Conquest mode: clicks pick receiver/conquered, the selection panel never opens
          const c = conquestRef.current
          if (c) {
            if (!f.entity_id || !isPolygon) return
            const year = yearRef.current
            // Clicks land on base polygons; roll each one up to the rank being used.
            if (c.step === 'receiver') {
              // The conqueror is the clicked entity itself — no parent needed.
              const recv = levelAncestor(f.entity_id, c.recvLevel, year)
              if (recv === null) {
                alertDialog(t('This region has no owner at that rank in this year.'))
                return
              }
              setConquest({
                step: 'picking',
                level: c.level,
                recvLevel: c.recvLevel,
                receiverId: recv,
                receiverName:
                  entNames.current.get(recv) ??
                  allEntities.find((x) => x.id === recv)?.name ??
                  `#${recv}`,
                picked: new Set()
              })
              return
            }
            const at = levelAncestor(f.entity_id, c.level, year)
            if (at === null) {
              alertDialog(t('This region has no owner at that rank in this year.'))
              return
            }
            // step 2: toggle the pick — skip the conqueror itself and what it already owns
            if (at === c.receiverId) return
            if (parentAt(parentHist.current.get(at) ?? [], year) === c.receiverId) return
            if (isAncestorOf(at, c.receiverId, year)) {
              alertDialog(t('A region cannot conquer the realm it belongs to.'))
              return
            }
            const picked = new Set(c.picked)
            if (picked.has(at)) picked.delete(at)
            else picked.add(at)
            setConquest({ ...c, picked })
            highlightPicked(picked, c.level)
            return
          }
          // Ctrl+click: add to / remove from the selection (primary unchanged → same panel controls)
          if ((ev as L.LeafletMouseEvent).originalEvent?.ctrlKey && selectedRef.current) {
            if (f.id !== selectedRef.current.id)
              setExtraSel((e) => (e.includes(f.id) ? e.filter((x) => x !== f.id) : [...e, f.id]))
            return
          }
          setSelected(f)
          setExtraSel([])
        })
        // saveGeometry has two phases: (1) snapshotUpdates runs SYNCHRONOUSLY — captures+clears
        // layer geometries and weldTouched at pm:update time (deferred, it would blend into the
        // next gesture);
        // (2) commitGeometry ASYNC — seri zincirde DB'ye yazar + gerekiyorsa reload eder.
        const snapshotUpdates = (
          e: { layer: L.Layer },
          weld: boolean
        ): { id: number; old: string; next: string }[] => {
          const updates = [
            {
              id: f.id,
              old: f.geometry,
              next: JSON.stringify((e.layer as L.Polygon).toGeoJSON().geometry)
            }
          ]
          if (weld) {
            for (const [fid, p] of weldTouched.current) {
              if (fid === f.id) continue
              updates.push({
                id: fid,
                old: p.oldGeom, // pre-drag (captured at dragstart) — no stale wm
                next: JSON.stringify(p.layer.toGeoJSON().geometry)
              })
            }
            weldTouched.current.clear()
          }
          return updates
        }
        const commitGeometry = async (
          updates: { id: number; old: string; next: string }[]
        ): Promise<void> => {
          pushUndo({
            undo: async () => {
              for (const u of updates) await api.updateFeature(u.id, { geometry: u.old })
            },
            redo: async () => {
              for (const u of updates) await api.updateFeature(u.id, { geometry: u.next })
            }
          })
          for (const u of updates) await api.updateFeature(u.id, { geometry: u.next })
          if (updates.length > 1) await reloadFeatures() // redraw the welded neighbours
        }
        // Snapshot synchronous, commit on the serial chain — reloads never clobber each other.
        // .catch is mandatory: one rejected commit would poison the chain for good and every
        // later save would silently drop.
        const saveGeometry = (e: { layer: L.Layer }, weld: boolean): void => {
          const updates = snapshotUpdates(e, weld)
          geomSaveChain.current = geomSaveChain.current
            .then(() => commitGeometry(updates))
            .catch((err) => console.error('geometry save failed:', err))
        }
        // Live weld: starting a vertex drag with Ctrl held finds the neighbours' co-located
        // vertices and moves them along for the whole drag (a single magnet-point feel).
        // ponytail: editing two neighbours at once via geoman could have the last save clobber the weld.
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
          const EPS = 0.01 // ponytail: co-location tolerance (map units) — a single tunable if needed
          for (const [fid, lys] of allLayers.current) {
            if (fid === f.id) continue
            for (const ly of lys) {
              const poly = ly as L.Polygon
              if (!poly.getLatLngs) continue
              // The partner's pre-drag geometry is captured once, ONLY for a matched polygon
              // (no mutation yet) — never stringify hundreds of unmatched polygons for nothing
              let oldGeom: string | null = null
              partnerRings(poly).forEach((ring, ri) =>
                ring.forEach((pt, vi) => {
                  if (Math.abs(pt.lat - ll.lat) < EPS && Math.abs(pt.lng - ll.lng) < EPS) {
                    if (oldGeom === null) oldGeom = JSON.stringify(poly.toGeoJSON().geometry)
                    dragPartners.current.push({ layer: poly, fid, ring: ri, idx: vi, oldGeom })
                  }
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
            // the same partner can match on several vertices — the first recorded oldGeom is kept (identical anyway)
            if (!weldTouched.current.has(p.fid))
              weldTouched.current.set(p.fid, { layer: p.layer, oldGeom: p.oldGeom })
            // the partner's vertex markers stay at the old spot — refresh edit mode
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
        // Weld applies to vertex editing; not to whole-polygon dragging — a move means
        // "detach from the neighbour", it must not tow the neighbour along.
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
          // Edit and Move are MODIFYING actions on an existing drawing, so they live here rather
          // than in the creation toolbar. Both select the feature first: edit mode applies only to
          // the selection (syncEditMode), and the [selected, tool] effect re-syncs once the state
          // lands. setTool, not activateTool — the latter toggles off when handed the current tool.
          items.push({
            label: t('✏️ Edit shape'),
            onClick: () => (setSelected(f), setTool('edit'))
          })
          items.push({ label: t('✋ Move'), onClick: () => (setSelected(f), setTool('drag')) })
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
    // reposition=true: features were just built and tooltips positioned at the base font; after
    // the font scales they need one recentre (label drift on setting changes came from this). Rare path.
    applyYear(yearRef.current, true)
    // The full rebuild recreated the layers → reopen edit on the selected feature's NEW layers
    // (selected only; not global — that was where the lag came from)
    syncEditMode()
  }

  // CK3-style derived region labels (rank/paint): ADJACENT base polygons in the same group
  // (that year's rank owner / paint value) union-find into one component (adjacency = shared
  // vertex grid cell, guaranteed by geoman snapping); each component gets a name label tilted
  // along its long axis (PCA) with a slight arc, font scaled to component width, none when
  // tiny. The labels are not DB features — transient markers added straight to the map (NOT
  // the featureGroup: exempt from fg.clearLayers churn, updateOverlaySizes eachLayer and
  // geoman edit mode). interactive:false is critical — conquest clicks must fall through to
  // the polygon below.
  const rebuildDerivedLabels = (
    year: number,
    rungOwnerAt: (eid: number) => number | null
  ): void => {
    const map = mapRef.current
    const mode = activeModeRef.current
    const clear = (): void => {
      for (const m of derivedLabels.current) m.remove()
      derivedLabels.current = []
      derivedSig.current = ''
    }
    if (!map || !mode || !layersRef.current.label) {
      clear()
      return
    }
    // 1. Visible base polygons + group key + text
    const items: { fid: number; key: string }[] = []
    const textOf = new Map<string, string>()
    for (const [fid] of labelGeo.current) {
      const y = layerYears.current.get(fid)
      if (y && !((y.from ?? -Infinity) <= year && year <= (y.to ?? Infinity))) continue
      if (!onActiveBoard(fid)) continue // a polygon on an inactive board joins no label
      const eid = featEnt.current.get(fid)
      if (eid === undefined) continue
      let key: string
      let text: string
      if (mode.kind === 'paint') {
        const v = dimValue.current.get(eid)
        if (!v) continue
        key = 'b' + v
        text = v
      } else {
        const o = rungOwnerAt(eid)
        if (o === null) continue
        key = 'k' + o
        text = entNames.current.get(o) ?? ''
      }
      items.push({ fid, key })
      textOf.set(key, text)
    }
    // 2. Signature: on ticks with unchanged ownership, touch nothing (playback is free)
    const sig = items.map((i) => `${i.fid}:${i.key}`).join('|')
    if (sig === derivedSig.current) return
    clear()
    derivedSig.current = sig
    // 3. Union-find: same-group polygons sharing a vertex cell form one component
    const parent = new Map<number, number>()
    const find = (x: number): number => {
      let r = x
      while (parent.get(r) !== r) r = parent.get(r)!
      let c = x
      while (parent.get(c) !== c) {
        const n = parent.get(c)!
        parent.set(c, r)
        c = n
      }
      return r
    }
    for (const { fid } of items) parent.set(fid, fid)
    const seen = new Map<string, number>() // `${group}|${cell}` → first fid to see it
    for (const { fid, key } of items) {
      for (const vk of labelGeo.current.get(fid)!.keys) {
        const k = `${key}|${vk}`
        const first = seen.get(k)
        if (first === undefined) seen.set(k, fid)
        else parent.set(find(fid), find(first))
      }
    }
    // 4. One label per component
    const comps = new Map<number, { key: string; fids: number[] }>()
    for (const { fid, key } of items) {
      const r = find(fid)
      const c = comps.get(r)
      if (c) c.fids.push(fid)
      else comps.set(r, { key, fids: [fid] })
    }
    for (const { key, fids } of comps.values()) {
      const text = textOf.get(key) ?? ''
      if (!text) continue
      let verts: number[][] = []
      let cx = 0
      let cy = 0
      let totalArea = 0
      for (const fid of fids) {
        const g = labelGeo.current.get(fid)!
        verts = verts.concat(g.verts)
        // Anchor: area-weighted component centroid — the label sits over the WHOLE component,
        // not one piece (user feedback: the text should span the polygons' union)
        cx += g.centroid[0] * g.area
        cy += g.centroid[1] * g.area
        totalArea += g.area
      }
      cx /= totalArea
      cy /= totalArea
      const { theta, extent } = pcaAxis(verts)
      // In CRS.Simple lat (y) goes up, CSS rotate is clockwise → angle inverted; normalized to ±90 (no upside-down text)
      let angle = (-theta * 180) / Math.PI
      if (angle > 90) angle -= 180
      if (angle < -90) angle += 180
      // Spread the text over ~80% of the main axis: labelDivIcon estimates ~0.62em per letter
      const base = Math.min(300, (extent * 0.8) / (0.62 * Math.max(4, text.length)))
      if (base < LABEL_MIN) continue // a tiny region gets no label
      const m = L.marker([cy, cx], {
        icon: labelDivIcon({ text, color: '#ffffff', angle, curve: 10 }, base),
        interactive: false,
        pmIgnore: true
      } as L.MarkerOptions).addTo(map)
      derivedLabels.current.push(m)
    }
  }

  // Applying the year: (1) hide/restore features outside their year range, (2) in rank mode
  // paint base polygons in that year's rank ancestor's color, (3) in the default view paint in
  // the chain top's color + place root labels. Every slider tick runs only this — no DB.
  // Selection highlight: a CSS class, NOT setStyle (`.sel-feature` = drop-shadow). Writing a
  // style would bury the polygon's color under the highlight while the user edits it in the
  // panel. getElement() works for both Path (SVG) and Marker (divIcon). applyYear rebuilds
  // layers, so it is called again at the end; the diff is applied (no full layer scan).
  const markSelection = (): void => {
    const cls = (fid: number, on: boolean): void => {
      for (const l of allLayers.current.get(fid) ?? [])
        (l as { getElement?: () => Element | null | undefined })
          .getElement?.()
          ?.classList.toggle('sel-feature', on)
    }
    for (const fid of markedSel.current) cls(fid, false)
    markedSel.current = selIdsRef.current
    for (const fid of selIdsRef.current) cls(fid, true)
  }

  const applyYear = (year: number, reposition = false): void => {
    yearRef.current = year
    const fg = featureGroupRef.current
    if (!fg) return
    const rankOn = activeModeRef.current?.kind === 'rank'
    // Default (root) view: base polygons painted in the color of the entity at the TOP of
    // that year's chain (no parent = top); the root's name becomes one label over its largest piece.
    const topOnly = activeModeRef.current === null
    // Climb the parent chain by year to the entity that HOLDS this one at the displayed rank
    // (cycle-guarded). We deliberately keep climbing past the first match and return the TOPMOST
    // one: after a same-rank conquest (duchy A takes duchy B) B still carries the rank tag, so
    // stopping at the first match would keep painting B's land in B's own color and the conquest
    // would be invisible in this view — the holder is A. The owner id resolves separately: color
    // + derived label text share one climb.
    const rungOwnerAt = (eid: number): number | null => {
      let cur: number | undefined = eid
      const seen = new Set<number>()
      let holder: number | null = null
      while (cur !== undefined && !seen.has(cur)) {
        if (rungTargets.current.has(cur)) holder = cur
        seen.add(cur)
        cur = parentAt(parentHist.current.get(cur) ?? [], year) ?? undefined
      }
      return holder // null = no owner at this rank that year
    }
    const rungColor = (eid: number): string => {
      const o = rungOwnerAt(eid)
      return o !== null ? rungTargets.current.get(o)! : '#666666'
    }
    // Top of the chain (cycle-guarded, memoised per applyYear)
    const rootMemo = new Map<number, number>() // per-applyYear memo; the climb is the shared rootAtYear
    const rootOf = (eid: number): number => {
      const hit = rootMemo.get(eid)
      if (hit !== undefined) return hit
      const root = rootAtYear(eid, year, (id) => parentHist.current.get(id) ?? [])
      rootMemo.set(eid, root)
      return root
    }
    const inYears = (fid: number): boolean => {
      const y = layerYears.current.get(fid)
      return !y || inYearRange(y.from, y.to, year)
    }
    // Pass 1 (root view only): group visible base polygons by root, pick each root's label
    // carrier (the largest piece)
    const carrier = new Map<number, number>() // rootId → fid
    if (topOnly) {
      for (const [fid] of allLayers.current) {
        const eid = featEnt.current.get(fid)
        if (eid === undefined || !baseSet.current.has(eid) || !inYears(fid)) continue
        if (!onActiveBoard(fid)) continue // a feature on another board joins no label
        if (!featArea.current.has(fid)) continue // polygons only
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
      // Board (drawing layer): a feature on an inactive board is never shown
      if (!onActiveBoard(fid)) visible = false
      // Layers panel: with its kind toggled off the feature is never shown
      const kind = featKind.current.get(fid)
      if (kind && !layersRef.current[kind]) visible = false
      // Pin filter: pins of a hidden entity type are not shown
      if (kind === 'pin' && pinHiddenRef.current.has(pinType.current.get(fid) ?? ''))
        visible = false
      const eid = featEnt.current.get(fid)
      const isBase = eid !== undefined && baseSet.current.has(eid) && featArea.current.has(fid)
      let st = renderStyle.current.get(fid)
      let labelRoot: number | null = null // root id when carrier; -1 = hide the base label
      if (topOnly && eid !== undefined) {
        if (isBase) {
          // Only the color comes from the root; opacity/weight stay the feature's own
          // (fillColor reverts to flat too — fill images are void in the political mosaic)
          const root = rootOf(eid)
          const c = entColors.current.get(root) ?? '#666666'
          if (st) st = { ...st, color: c, fillColor: c }
          labelRoot = carrier.get(root) === fid ? root : -1
        } else if (featArea.current.has(fid)) {
          // Hiding rules apply to POLYGON borders only: when a parent's hand-drawn border is
          // represented by the mosaic there must be no double image. Pins and paths (whoever
          // their entity is) are decoration and always keep their own look.
          if (parentAt(parentHist.current.get(eid) ?? [], year) !== null) {
            visible = false // has a parent → not the top of the chain
          } else if (mosaicManaged.current.has(eid)) {
            visible = false // its border derives from the mosaic (in any year); never show the old drawing
          }
        }
      }
      if (rankOn && st) {
        const c = eid !== undefined ? rungColor(eid) : '#666666'
        st = { ...st, color: c, fillColor: c }
      }
      // The zoom gate comes last: baseVisible = visibility APART from zoom (refreshZoomVis
      // reads it), then hide when outside the zoom range
      baseVisible.current.set(fid, visible)
      if (!zoomOk(fid)) visible = false
      const arrow = featArrow.current.get(fid)
      for (const l of layers) {
        if (visible && !fg.hasLayer(l)) {
          fg.addLayer(l)
          // Re-adding the same layer object to the featureGroup does NOT bring geoman's vertex
          // markers back (measured) → refresh manually when edit mode is on. ONLY for the
          // selected feature (not global — that was the source of the lag).
          if (toolRef.current === 'edit' && selectedRef.current?.id === fid)
            (l as unknown as { pm?: { enable: () => void } }).pm?.enable()
        } else if (!visible && fg.hasLayer(l)) fg.removeLayer(l)
        if (visible && st && (l as L.Path).setStyle) {
          // dashArray returns to canonical — the conquest highlight's dashed edge must not
          // stick, while path (line) patterns survive (kept in renderStyle). isCurveControl:
          // the real/editable line under a curve overlay stays near-invisible (a low but
          // painted value, because a fully transparent SVG can be unclickable).
          ;(l as L.Path).setStyle({
            color: st.color,
            fillColor: st.fillColor,
            fillOpacity: st.fillOpacity,
            weight: st.weight,
            opacity: (l as FeatureLayer).isCurveControl ? 0.03 : st.opacity,
            dashArray: st.dashArray
          })
        }
        // The 'end' arrow: only on the VISIBLE layer (the overlay when curved, else the real
        // line) — added to the control line too, context-stroke ignores stroke-opacity and a
        // ghost second arrow appears.
        if (visible && arrow === 'end' && !(l as FeatureLayer).isCurveControl) {
          const el = (l as L.Path).getElement?.() as SVGElement | null
          el?.setAttribute('marker-end', 'url(#worldArrow)')
        }
        // Permanent labels: all hidden when the layers panel says so; in the root view the
        // carrier bears the root's name, other base labels stay hidden
        if (visible) {
          const tt = l.getTooltip?.()
          const el = tt?.getElement()
          if (tt && el && tt.options.permanent) {
            if (!layersRef.current.label || labelRoot === -1) el.style.display = 'none'
            else {
              if (labelRoot !== null) {
                const name = entNames.current.get(labelRoot) ?? ''
                tt.setContent(polyLabelHtml(name)) // a string tooltip = innerHTML (same as bindTooltip)
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
    rebuildDerivedLabels(year, rungOwnerAt) // mod yoksa kendini temizler
    updateOverlaySizes(reposition) // re-added label/pin sizes settle onto the current zoom
    markSelection() // layers were rebuilt → rewrite the selection highlight
  }

  // Refresh the highlight when the selection changes (ref + DOM class). No applyYear call —
  // the highlight is a class now, not a style, so the layers need no touching.
  useEffect(() => {
    selIdsRef.current = selIds
    markSelection()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selIds.join(',')])

  // Load the layers panel from settings (persisted); toggles apply instantly, DB-free
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

  // Map switching: create a new map (name from the inline form) → refresh App + go there
  const createMap = async (name: string): Promise<void> => {
    if (!name.trim()) return
    const { id: newId } = await api.createMap({ name: name.trim() })
    setNewMapName(null)
    onChanged()
    onNavigate(newId)
  }

  // Rename a map (inline) — not undoable (the old sidebar had no rename either)
  const renameMap = (mapId: number, name: string): void => {
    void api.updateMap(mapId, { name }).then(onChanged)
  }

  // Delete a map (with undo — a copy of App's pattern). Only NON-ACTIVE maps can be deleted
  // (deleting the active one leaves no obvious view to land on — switch away first).
  const deleteMapWithUndo = async (mapId: number): Promise<void> => {
    const name = maps.find((m) => m.id === mapId)?.name ?? ''
    if (!(await confirmDialog(t('Delete "{name}" and all drawings on it?', { name })))) return
    const full = await api.getMap(mapId)
    if (!full) return
    const mapRow = {
      id: full.id,
      name: full.name,
      parent_map_id: full.parent_map_id,
      image_path: full.image_path,
      width: full.width,
      height: full.height,
      layers: full.layers
    }
    const feats = full.features.map((f) => ({
      id: f.id,
      map_id: f.map_id,
      entity_id: f.entity_id,
      geometry: f.geometry,
      style: f.style
    }))
    const childIds = maps.filter((x) => x.parent_map_id === mapId).map((x) => x.id)
    pushUndo({
      undo: () => api.restoreMap(mapRow, feats, childIds).then(onChanged),
      redo: () => api.deleteMap(mapId).then(onChanged)
    })
    await api.deleteMap(mapId)
    onChanged()
  }

  // Zoom visibility: whether the feature sits inside its min/max zoom range
  const zoomOk = (fid: number): boolean => {
    const z = zoomLimits.current.get(fid)
    if (!z) return true
    const cur = mapRef.current?.getZoom() ?? 0
    return (z.min == null || cur >= z.min) && (z.max == null || cur <= z.max)
  }
  // On zoom change: toggle only the zoom-limited features, preserving their non-zoom
  // visibility (baseVisible). Never scans all features (hot path); markers carry no style,
  // re-adding suffices.
  const refreshZoomVis = (): void => {
    const fg = featureGroupRef.current
    if (!fg) return
    for (const [fid] of zoomLimits.current) {
      const shown = (baseVisible.current.get(fid) ?? true) && zoomOk(fid)
      for (const l of allLayers.current.get(fid) ?? []) {
        if (shown && !fg.hasLayer(l)) {
          fg.addLayer(l)
          if (toolRef.current === 'edit' && selectedRef.current?.id === fid)
            (l as unknown as { pm?: { enable: () => void } }).pm?.enable()
        } else if (!shown && fg.hasLayer(l)) fg.removeLayer(l)
      }
    }
    // Leaflet rebuilds the element from SCRATCH on re-add (Marker._initIcon / Path._initPath)
    // → the selection highlight's CSS class was lost. Same refresh as at the end of applyYear.
    markSelection()
  }

  const togglePinType = (ty: string): void => {
    const v = new Set(pinHiddenRef.current)
    if (v.has(ty)) v.delete(ty)
    else v.add(ty)
    pinHiddenRef.current = v
    setPinHidden(v)
    applyYear(yearRef.current)
  }

  // --- Boards (drawing layers) ---
  // The board a feature belongs to: style.board; an undefined or no-longer-existing id → the
  // FIRST board (deletion/rename cannot orphan features — no rewriting, this resolution is
  // the single source).
  const resolveBoard = (fid: number): string | undefined => {
    const { list } = boardsRef.current
    if (!list.length) return undefined
    const b = featBoard.current.get(fid)
    return b !== undefined && list.some((x) => x.id === b) ? b : list[0].id
  }
  const onActiveBoard = (fid: number): boolean => {
    const { list, active } = boardsRef.current
    return !list.length || resolveBoard(fid) === active
  }

  const persistBoards = (data: MapBoards): void => {
    boardsRef.current = data
    setBoards(data)
    void saveMapBoards(id, data)
  }
  const switchBoard = (bid: string): void => {
    if (bid === boardsRef.current.active) return
    persistBoards({ ...boardsRef.current, active: bid })
    applyYear(yearRef.current) // DB'siz yeniden filtrele
  }
  const addBoard = (name: string): void => {
    if (!name.trim()) return
    const bid = crypto.randomUUID()
    const list = [...boardsRef.current.list, { id: bid, name: name.trim() }]
    // The first board created becomes active (existing features show on it via the undefined→first rule)
    persistBoards({ list, active: boardsRef.current.list.length ? boardsRef.current.active : bid })
    setNewBoardName(null)
  }
  const renameBoard = (bid: string, name: string): void => {
    if (!name.trim()) return
    persistBoards({
      ...boardsRef.current,
      list: boardsRef.current.list.map((b) => (b.id === bid ? { ...b, name: name.trim() } : b))
    })
  }
  const removeBoard = async (bid: string): Promise<void> => {
    const b = boardsRef.current.list.find((x) => x.id === bid)
    if (
      !(await confirmDialog(
        t('Delete board "{name}"? Its drawings move to the first board.', {
          name: b?.name ?? ''
        })
      ))
    )
      return
    const list = boardsRef.current.list.filter((x) => x.id !== bid)
    // Deleting the active board switches to the first remaining; with none left the filter is off (one canvas)
    const active = bid === boardsRef.current.active ? (list[0]?.id ?? '') : boardsRef.current.active
    persistBoards({ list, active })
    applyYear(yearRef.current)
  }

  // The feature's kind — search list icon + pin filter chips (pure derivation from state)
  const kindOf = (f: WorldMap['features'][number]): 'polygon' | 'line' | 'pin' | 'label' => {
    if (f.geometry.includes('"Polygon"')) return 'polygon'
    if (f.geometry.includes('"LineString"')) return 'line'
    return (JSON.parse(f.style || '{}') as FeatureStyle).text !== undefined ? 'label' : 'pin'
  }

  // Map search: match by entity name (bound features) or free label text.
  // useMemo: the zoom HUD renders every tick — keep per-feature JSON.parse off the hot path.
  const searchMatches = useMemo(() => {
    const q = searchQ.trim().toLocaleLowerCase('tr')
    if (!q) return []
    return (worldMap?.features ?? [])
      .map((f) => ({
        f,
        kind: kindOf(f),
        name: f.entity_name ?? (JSON.parse(f.style || '{}') as FeatureStyle).text ?? ''
      }))
      .filter((m) => m.name.toLocaleLowerCase('tr').includes(q))
      .slice(0, 12)
  }, [worldMap, searchQ])

  // Folders of this map's pins (filter chips; a filter over a single folder is pointless)
  const pinTypes = useMemo(
    () => [
      ...new Set(
        (worldMap?.features ?? [])
          .filter((f) => kindOf(f) === 'pin')
          .map((f) => f.entity_folder ?? '')
      )
    ],

    [worldMap]
  )

  // Conquest pick highlights: restore canonical styles first, then highlight the picked entities' polygons
  // `picked` holds entities at the conquest RANK, so every base polygon underneath one of them
  // lights up — picking a duchy highlights all of its counties.
  const highlightPicked = (picked: Set<number>, level: string | null): void => {
    applyYear(yearRef.current)
    const year = yearRef.current
    for (const [fid, eid] of featEnt.current) {
      const at = levelAncestor(eid, level, year)
      if (at === null || !picked.has(at)) continue
      for (const ly of allLayers.current.get(fid) ?? [])
        (ly as L.Path).setStyle?.({ color: '#ffffff', weight: 4, dashArray: '6' })
    }
  }

  // Feature shortcuts: Del/Backspace delete, Ctrl+C copy, Ctrl+V paste under the cursor,
  // Ctrl+D duplicate — all work with MULTI-select. None fire while typing in an input.
  // Bare effect (dep dizisi yok): handler'lar her render tazelenir, bayat closure olmaz.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement
      const typing =
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
      if (typing) return
      const has = selIdsRef.current.length > 0
      const k = e.key.toLowerCase()
      if ((e.key === 'Delete' || e.key === 'Backspace') && has) {
        e.preventDefault()
        // App has Del too (deletes the ENTITIES selected in the sidebar). Both listen on
        // window, so Del with a map feature selected deleted BOTH. This handler registers in
        // the capture phase → runs before App's and cuts the chain here.
        e.stopImmediatePropagation()
        void removeFeature(...selIdsRef.current)
      } else if (e.ctrlKey && k === 'c' && has) copySelection()
      else if (e.ctrlKey && k === 'v' && getClipboard().length) {
        e.preventDefault()
        void pasteClipboard(true)
      } else if (e.ctrlKey && k === 'd' && has) {
        e.preventDefault() // the browser's "add bookmark"
        void duplicateSelection()
      }
    }
    window.addEventListener('keydown', onKey, true) // capture: before App's Del handler
    return () => window.removeEventListener('keydown', onKey, true)
  })

  // Esc: cancel the conquest flow, clear the pick highlights
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

  // Esc: end the active measure session
  useEffect(() => {
    if (!measure) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') endMeasure()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measure !== null])

  // Esc ends the active navigation session and clears its route highlight.
  useEffect(() => {
    if (!nav) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') endNav()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav !== null])

  // Conquest confirm: every picked entity attaches to the receiver from the slider year on (one undo record)
  const commitConquest = async (): Promise<void> => {
    const c = conquestRef.current
    setConquest(null)
    if (!c || c.step !== 'picking' || c.picked.size === 0) {
      applyYear(yearRef.current)
      return
    }
    const year = yearRef.current
    const updates: { id: number; old: string; next: string }[] = []
    for (const eid of c.picked) {
      const e = await api.getEntity(eid)
      if (!e) continue
      const f = JSON.parse(e.fields || '{}') as Record<string, string>
      const recs = getParents(e.fields).filter((r) => r.from !== year) // a second conquest in the same year overrides
      recs.push({ from: year, id: c.receiverId })
      recs.sort((a, b) => (a.from ?? -Infinity) - (b.from ?? -Infinity))
      f['parent'] = JSON.stringify(recs)
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

  // Map setup (from scratch when the id changes)
  useEffect(() => {
    if (!divRef.current) return
    // Left-drag panning off (free for drawing/selection); pan with middle mouse; no zoom
    // buttons (there is a HUD). scrollWheelZoom off: replaced below by a custom continuous
    // (fractional, animation-free) wheel zoom
    // One explicit renderer for the whole map, so its container placement can be corrected below
    const renderer = L.svg()
    const map = L.map(divRef.current, {
      renderer,
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
    // The map half of patch 1 (see the module top): project without the `._round()`. Every path
    // vertex, marker and tooltip goes through this one call, so they all share one fractional space.
    map.latLngToLayerPoint = (latlng: L.LatLngExpression): L.Point =>
      map.project(L.latLng(latlng)).subtract(map.getPixelOrigin())
    // A third, independent 1px source, measured the same way: the labels sat EXACTLY on their
    // layer point while the polygons swung 0.99px, because path coordinates and the renderer's
    // viewBox both come from latLngToLayerPoint while Renderer._updateTransform places the
    // container from its own unrounded projection. That leftover fraction sawtooths across ±0.5px
    // as the zoom changes, sliding every polygon a whole pixel under everything on top of it.
    // When the renderer is already in sync with the map's zoom — every frame of our animate:false
    // wheel zoom, since _resetView re-projects — put the container exactly where its own viewBox
    // says. Measured after: 0.000px. The scaled branch is left alone for real animated zooms
    // (flyTo), where the renderer deliberately lags and IS being scaled.
    const rend = renderer as unknown as {
      _updateTransform(center: L.LatLng, zoom: number): void
      _zoom: number
      _bounds?: L.Bounds
      _container?: HTMLElement
    }
    const stockTransform = rend._updateTransform.bind(rend)
    rend._updateTransform = (center: L.LatLng, zoom: number): void => {
      const min = rend._bounds?.min
      if (zoom === rend._zoom && min && rend._container) L.DomUtil.setPosition(rend._container, min)
      else stockTransform(center, zoom)
    }
    map.pm.setGlobalOptions({ tooltips: false }) // silence geoman's "Click to place marker" hints

    const host = divRef.current
    let panning = false
    let last: [number, number] = [0, 0]
    const onDown = (e: MouseEvent): void => {
      if (e.button === 1) {
        e.preventDefault() // block the autoscroll cursor
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
    // Continuous/SMOOTH wheel zoom: each tick adds to a TARGET zoom and a rAF loop eases the
    // current zoom toward it. Every frame animate:false setZoomAround → 'zoom' event → labels/
    // pins scale synchronously per frame (Leaflet's own animation does not, hence manual).
    // Previously it jumped to the target INSTANTLY → ~0.15 leap per wheel tick = stepped feel.
    // ponytail: 0.0015 sensitivity, 0.2 ease — single numbers to tune if it feels fast/slow/harsh.
    // wheelZooming: while the rAF runs, the 'zoom' event does DOM only (label/pin scaling) and
    // React state (HUD/scale bar) is not updated per frame — 60fps React re-renders (Timeline/
    // panel) would stutter. React state updates once when the zoom settles (below).
    let wheelTarget: number | null = null
    let wheelPt: L.Point | null = null
    let wheelRaf: number | null = null
    let wheelZooming = false
    const wheelStep = (): void => {
      if (wheelTarget === null) {
        wheelRaf = null
        return
      }
      const cur = map.getZoom()
      const diff = wheelTarget - cur
      if (Math.abs(diff) < 0.004) {
        map.setZoomAround(wheelPt!, wheelTarget, { animate: false })
        wheelTarget = null
        wheelRaf = null
        wheelZooming = false
        showHud(map.getZoom()) // on settle, one React update for HUD + scale bar
        setBarZoom(map.getZoom())
        return
      }
      map.setZoomAround(wheelPt!, cur + diff * 0.2, { animate: false })
      wheelRaf = requestAnimationFrame(wheelStep)
    }
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      if (e.shiftKey && wheelAdjustRef.current) {
        wheelAdjustRef.current(e.deltaY) // Shift held: resize the selection instead of zooming
        return
      }
      const base = wheelTarget ?? map.getZoom()
      wheelTarget = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), base - e.deltaY * 0.0015))
      wheelPt = map.mouseEventToContainerPoint(e)
      wheelZooming = true
      if (wheelRaf === null) wheelRaf = requestAnimationFrame(wheelStep)
    }
    host.addEventListener('mousedown', onDown)
    host.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    const fg = new L.FeatureGroup()
    featureGroupRef.current = fg
    map.addLayer(fg)

    // The Ctrl+V paste target: the cursor's last map position (never enters React state —
    // every move would re-render; read only at paste time)
    map.on('mousemove', (e: L.LeafletMouseEvent) => {
      lastMouse.current = e.latlng
    })

    map.on('zoom zoomend', () => {
      refreshZoomVis() // toggle zoom-limited pins/labels for the current zoom (before sizing)
      updateOverlaySizes() // DOM: every frame (smooth zoom) — labels/pins scale in sync
      // React state (HUD + scale bar) immediately only OUTSIDE wheel zoom; on wheel, at settle (above)
      if (!wheelZooming) {
        showHud(map.getZoom())
        setBarZoom(map.getZoom())
      }
    })

    // Measure session clicks: calib switches to the form at 2 points; dist/area accumulate points
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

    // Right-click on empty space → tool menu (over a feature the layer handler takes over)
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
      // A snapshot of the current tool settings becomes the feature's persistent style.
      // from = the slider year at draw time: the feature is invisible in years it does not
      // exist (changeable/clearable in the selected feature panel's "Time" block).
      const s = drawRef.current
      const shape = (e as { shape?: string }).shape
      // Label and pin tools are both 'Marker' to geoman → the active tool disambiguates
      const isLabelDraw = toolRef.current === 'label'
      const from = yearRef.current
      const styleObj =
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
                  from
                }
      // Bind to the active board (when boards exist) → visible only on it
      if (boardsRef.current.list.length)
        (styleObj as Record<string, unknown>).board = boardsRef.current.active
      const style = JSON.stringify(styleObj)
      // A drawing IS an article: a polygon/pin/path gets its own entity at draw time, so it shows
      // up in the sidebar tree and opens as an article (map system and article system are one).
      // Free text labels stay pure decoration — they carry their own text and would only clutter
      // the tree. Rename the entity from the panel or the sidebar afterwards.
      const entName = isLabelDraw
        ? null
        : shape === 'Marker'
          ? t('New pin')
          : shape === 'Line'
            ? t('New path')
            : t('New region')
      const ent = entName ? await api.createEntity({ name: entName }) : null
      const created = await api.createFeature({
        map_id: id,
        geometry,
        style,
        ...(ent ? { entity_id: ent.id } : {})
      })
      const ref: { id: number; eid?: number } = { id: created.id, eid: ent?.id }
      pushUndo({
        undo: async () => {
          await api.deleteFeature(ref.id)
          if (ref.eid !== undefined) await api.deleteEntity(ref.eid)
          onChanged()
        },
        redo: async () => {
          if (entName) ref.eid = (await api.createEntity({ name: entName })).id
          ref.id = (
            await api.createFeature({
              map_id: id,
              geometry,
              style,
              ...(ref.eid !== undefined ? { entity_id: ref.eid } : {})
            })
          ).id
          onChanged()
        }
      })
      toolRef.current = null
      setToolState(null)
      await reloadFeatures()
      if (ent) onChanged() // the new article must appear in the sidebar tree at once
    })
    map.on('pm:remove', async (e) => {
      const fid = (e.layer as FeatureLayer).featureId
      if (fid) await removeFeature(fid)
    })

    map.setView([500, 500], 0) // default; the base image loads in its own effect
    reloadFeatures()
    // Seed the current year from the persisted timeline BEFORE the user can draw, so a new
    // feature's `from` is the year actually shown — not a stale 0 (yearRef starts at 0 and only
    // syncs once Timeline's async onYear resolves). Otherwise a polygon drawn at a BC year could
    // be saved as from:0 and vanish from that year's view.
    getTimeline().then((tl) => {
      yearRef.current = tl.year
      applyYear(tl.year)
    })
    api.listEntities().then(setAllEntities)
    api.getSetting('mapScales').then((raw) => {
      const sc = (JSON.parse(raw || '{}') as Record<number, MapScale>)[id] ?? null
      scaleRef.current = sc
      setMapScale(sc)
    })
    api.getSetting('travelModes').then((raw) => setTravelModesState(JSON.parse(raw || '[]')))
    getMapBoards(id).then((b) => {
      boardsRef.current = b
      setBoards(b)
      applyYear(yearRef.current) // apply the board filter once loaded
    })
    getPinImages().then(setPinImages)
    api.getSetting('drawSettings').then((raw) => {
      if (!raw) return
      // Merge per field: settings missing from old records (e.g. font) come from defaults
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
    clearSel()

    return () => {
      clearTimeout(hudTimer.current)
      measureTemp.current = null // map.remove() tears the group down anyway
      measurePoly.current = null
      navTemp.current = null
      setMeasure(null)
      setNav(null)
      if (wheelRaf !== null) cancelAnimationFrame(wheelRaf)
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

  // "Show on map": retry at short intervals until the feature loads, then fly to it
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

  // Base image: add/refresh the layer when image_path changes (no remount → appears instantly)
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
      // Prevent escaping into ugly grey space beyond the image: pan bounded, no zooming out past fit
      map.options.maxBoundsViscosity = 1
      map.setMaxBounds(L.latLngBounds(bounds).pad(0.5))
      map.setMinZoom(map.getBoundsZoom(bounds) - 1)
    }
  }, [worldMap?.image_path, worldMap?.width, worldMap?.height])

  // After undo/redo: refresh features without remounting the map (zoom/position kept)
  const firstToken = useRef(true)
  useEffect(() => {
    if (firstToken.current) {
      firstToken.current = false
      return
    }
    reloadFeatures()
    clearSel()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadToken])

  const selStyle = selected ? (JSON.parse(selected.style || '{}') as FeatureStyle) : {}
  const selIsPolygon = selected ? selected.geometry.includes('"Polygon"') : false
  const selIsLine = selected ? selected.geometry.includes('"LineString"') : false
  // A label is Point too — must branch off BEFORE the pin path (discriminator: style.text)
  const selIsLabel = selStyle.text !== undefined

  // Edit the selected feature(s)' style — ONE undo record per selection (no slider spam).
  // In multi-select the patch applies to ALL (each over its own style): this is how the
  // existing panel controls become bulk editing, no separate "bulk" UI needed. A key
  // meaningless for a feature (fillOpacity on a pin) is already ignored at render.
  const styleEditRef = useRef<{
    key: string
    items: { fid: number; orig: string; latest: string }[]
  } | null>(null)
  const editSelectedStyle = async (patch: Partial<FeatureStyle>): Promise<void> => {
    if (!selected) return
    const key = selIds.join(',')
    if (styleEditRef.current?.key !== key) {
      const styleOf = (fid: number): string =>
        (fid === selected.id
          ? selected.style
          : worldMapRef.current?.features.find((x) => x.id === fid)?.style) || '{}'
      const ref = { key, items: selIds.map((fid) => ({ fid, orig: styleOf(fid), latest: '' })) }
      styleEditRef.current = ref
      pushUndo({
        undo: async () => {
          for (const it of ref.items) await api.updateFeature(it.fid, { style: it.orig })
        },
        redo: async () => {
          for (const it of ref.items) await api.updateFeature(it.fid, { style: it.latest })
        }
      })
    }
    const items = styleEditRef.current.items
    // Parallel: each feature's write is independent — dragging a slider with many selected
    // used to stack serial IPC round trips (20 selected = 20 sequential trips per tick).
    await Promise.all(
      items.map((it) => {
        it.latest = JSON.stringify({
          ...(JSON.parse(it.latest || it.orig) as FeatureStyle),
          ...patch
        })
        return api.updateFeature(it.fid, { style: it.latest })
      })
    )
    setSelected({ ...selected, style: items[0].latest }) // items[0] = the primary (selIds order)
    await reloadFeatures()
  }

  // Zoom visibility (pin + label): the user PICKS the threshold with a slider (shown as a
  // percentage). Ticking the box starts at the current zoom, then fine-tune; minZoom = "hide
  // below this (further out)", maxZoom = "hide above this (closer in)".
  const zoomPct = (z: number): string => `%${Math.round(2 ** z * 100)}`
  const zoomVisRow = (key: 'minZoom' | 'maxZoom', label: string): React.JSX.Element => {
    const val = selStyle[key]
    return (
      <>
        <label className="zoom-vis-head">
          <input
            type="checkbox"
            checked={val != null}
            onChange={(e) =>
              editSelectedStyle({ [key]: e.target.checked ? mapRef.current?.getZoom() : undefined })
            }
          />
          {label}
        </label>
        {val != null && (
          <div className="zoom-vis-slider">
            <input
              type="range"
              min={hudRange[0]}
              max={hudRange[1]}
              step="any"
              value={val}
              onChange={(e) => editSelectedStyle({ [key]: Number(e.target.value) })}
            />
            <span className="zoom-pct">{zoomPct(val)}</span>
          </div>
        )}
      </>
    )
  }
  const zoomVisControls = (): React.JSX.Element => (
    <>
      <label>{t('Hide by zoom — now {z}', { z: zoomPct(barZoom) })}</label>
      {zoomVisRow('minZoom', t('Hide when zoomed out below'))}
      {zoomVisRow('maxZoom', t('Hide when zoomed in above'))}
    </>
  )

  // Shift+wheel: resize the selected feature — or, with nothing selected, the active draw
  // tool's DEFAULT — instead of zooming (the Wonderdraft pattern). onWheel lives in a
  // mount-once useEffect closure, so the fresh selection is read via a ref, reassigned every
  // render with the current selStyle/editSelectedStyle. ponytail: every tick goes
  // editSelectedStyle → reloadFeatures (same path as dragging a slider; reloadGen already
  // prevents flicker); the defaults branch refreshes the preview instantly via updateDrawSettings.
  const drawTool = tool === 'polygon' || tool === 'line' || tool === 'marker' || tool === 'label'
  const wheelAdjustRef = useRef<((deltaY: number) => void) | null>(null)
  useEffect(() => {
    // Keep the callback ref fresh every render (the useLatest pattern); onWheel mounts once
    // and reads the current selection here. A bare-effect ref write is safe in this pattern —
    // silence the rule on this line.
    // eslint-disable-next-line react-hooks/immutability
    wheelAdjustRef.current =
      !selected && !drawTool
        ? null
        : (deltaY: number) => {
            const dir = deltaY < 0 ? 1 : -1 // wheel up = grow
            const wclamp = (v: number, max: number): number => Math.max(1, Math.min(max, v))
            const sclamp = (v: number): number => Math.max(0.5, Math.min(10, Number(v.toFixed(2))))
            if (!selected) {
              const d = drawRef.current
              if (tool === 'line')
                updateDrawSettings({
                  ...d,
                  line: { ...d.line, weight: wclamp(d.line.weight + dir, 12) }
                })
              else if (tool === 'polygon')
                updateDrawSettings({
                  ...d,
                  polygon: { ...d.polygon, weight: wclamp(d.polygon.weight + dir, 10) }
                })
              else if (tool === 'marker')
                updateDrawSettings({
                  ...d,
                  marker: { ...d.marker, size: sclamp(d.marker.size + dir * 0.25) }
                })
              else if (tool === 'label')
                updateDrawSettings({
                  ...d,
                  label: { ...d.label, size: sclamp(d.label.size + dir * 0.25) }
                })
              return
            }
            if (selIsLine || selIsPolygon) {
              const max = selIsLine ? 12 : 10
              editSelectedStyle({
                weight: wclamp((selStyle.weight ?? (selIsLine ? 3 : 2)) + dir, max)
              })
            } else {
              editSelectedStyle({ size: sclamp((selStyle.size ?? 1) + dir * 0.25) })
            }
          }
  })

  // 📍 from the hierarchy panel: focus when the feature is on this map, else switch maps
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
        <div className="map-search">
          <input
            placeholder={t('Search on map…')}
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setSearchQ('')
              if (e.key === 'Enter' && searchMatches.length) {
                focusFeature(searchMatches[0].f.id)
                setSearchQ('')
              }
            }}
          />
          {searchMatches.length > 0 && (
            <div className="layers-panel">
              {searchMatches.map(({ f, kind, name }) => (
                <div
                  key={f.id}
                  className="layers-row"
                  onClick={() => {
                    focusFeature(f.id)
                    setSearchQ('')
                  }}
                >
                  <span className="layers-icon">
                    {{ polygon: '⬟', line: '〰', pin: '📍', label: '🏷' }[kind]}
                  </span>
                  <span className="layers-text">
                    <span className="layers-name">{name}</span>
                    {f.entity_folder && (
                      <span className="layers-desc">
                        {folders.find((x) => x.id === f.entity_folder)?.name ?? ''}
                      </span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="layers-menu">
          <button
            className={`layers-btn ${mapsOpen ? 'open' : ''}`}
            onClick={() => setMapsOpen((o) => !o)}
          >
            🗺 {t('Maps')}
            {maps.length > 1 && <span className="layers-count">{maps.length}</span>}
          </button>
          {mapsOpen && (
            <>
              <div
                className="layers-backdrop"
                onClick={() => (setMapsOpen(false), setNewMapName(null))}
              />
              <div className="layers-panel">
                <div className="layers-panel-head">{t('Maps')}</div>
                {maps.map((m) =>
                  editMapId === m.id ? (
                    // Inline rename (uncontrolled + onBlur — updateMap+refresh per keystroke used to flicker)
                    <div key={m.id} className="base-row">
                      <input
                        className="base-name"
                        autoFocus
                        defaultValue={m.name}
                        onBlur={(e) => {
                          const v = e.target.value.trim()
                          if (v && v !== m.name) renameMap(m.id, v)
                          setEditMapId(null)
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') e.currentTarget.blur()
                          if (e.key === 'Escape') setEditMapId(null)
                        }}
                      />
                    </div>
                  ) : (
                    <div
                      key={m.id}
                      className="layers-row"
                      style={{ paddingLeft: m.parent_map_id ? 26 : undefined }}
                      onClick={() => m.id !== id && onNavigate(m.id)}
                    >
                      <span className="layers-icon">🗺</span>
                      <span
                        className="layers-name"
                        style={
                          m.id === id ? { color: 'var(--accent)', fontWeight: 600 } : undefined
                        }
                      >
                        {m.name}
                      </span>
                      <button
                        className="mini map-row-btn"
                        title={t('Rename')}
                        onClick={(e) => (e.stopPropagation(), setEditMapId(m.id))}
                      >
                        ✎
                      </button>
                      {m.id !== id && (
                        <button
                          className="mini danger map-row-btn"
                          title={t('Remove')}
                          onClick={(e) => (e.stopPropagation(), deleteMapWithUndo(m.id))}
                        >
                          ×
                        </button>
                      )}
                    </div>
                  )
                )}
                {newMapName !== null ? (
                  <form
                    className="base-row"
                    onSubmit={(e) => (e.preventDefault(), createMap(newMapName))}
                  >
                    <input
                      className="base-name"
                      autoFocus
                      placeholder={t('map name')}
                      value={newMapName}
                      onChange={(e) => setNewMapName(e.target.value)}
                      onKeyDown={(e) => e.key === 'Escape' && setNewMapName(null)}
                    />
                    <button className="mini" type="submit">
                      ✓
                    </button>
                  </form>
                ) : (
                  <button className="mini base-add" onClick={() => setNewMapName('')}>
                    ＋ {t('New map')}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
        {worldMap && !worldMap.image_path && (
          <button
            onClick={async () => {
              const path = await api.pickImage()
              if (!path) return
              const img = new Image()
              img.onload = async () => {
                await api.updateMap(id, {
                  image_path: path,
                  width: img.naturalWidth,
                  height: img.naturalHeight,
                  layers: JSON.stringify([{ type: 'image', path }])
                })
                await reloadFeatures()
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
        {/* Export moved to File ▸ Export ▸ Current Map as Image (App drives it via onExportReady);
            the header keeps only map CONTEXT: search, maps, boards, layers. */}
        <div className="layers-menu">
          <button
            className={`layers-btn ${boardsOpen ? 'open' : ''}`}
            onClick={() => setBoardsOpen((o) => !o)}
          >
            📚 {t('Boards')}
            {boards.list.length > 0 && (
              <span className="layers-count">
                {(boards.list.find((b) => b.id === boards.active)?.name ?? boards.list[0]?.name) ||
                  boards.list.length}
              </span>
            )}
          </button>
          {boardsOpen && (
            <>
              <div
                className="layers-backdrop"
                onClick={() => (setBoardsOpen(false), setNewBoardName(null), setEditBoardId(null))}
              />
              <div className="layers-panel">
                <div className="layers-panel-head">{t('Boards')}</div>
                {boards.list.length === 0 && (
                  <div className="layers-desc" style={{ padding: '4px 8px' }}>
                    {t('Everything is on one board. Add a board to split drawings into layers.')}
                  </div>
                )}
                {boards.list.map((b) =>
                  editBoardId === b.id ? (
                    <div key={b.id} className="base-row">
                      <input
                        className="base-name"
                        autoFocus
                        defaultValue={b.name}
                        onBlur={(e) => {
                          renameBoard(b.id, e.target.value)
                          setEditBoardId(null)
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') e.currentTarget.blur()
                          if (e.key === 'Escape') setEditBoardId(null)
                        }}
                      />
                    </div>
                  ) : (
                    <div key={b.id} className="layers-row" onClick={() => switchBoard(b.id)}>
                      <span className="layers-icon">{b.id === boards.active ? '◉' : '○'}</span>
                      <span
                        className="layers-name"
                        style={
                          b.id === boards.active
                            ? { color: 'var(--accent)', fontWeight: 600 }
                            : undefined
                        }
                      >
                        {b.name}
                      </span>
                      <button
                        className="mini map-row-btn"
                        title={t('Rename')}
                        onClick={(e) => (e.stopPropagation(), setEditBoardId(b.id))}
                      >
                        ✎
                      </button>
                      <button
                        className="mini danger map-row-btn"
                        title={t('Remove')}
                        onClick={(e) => (e.stopPropagation(), removeBoard(b.id))}
                      >
                        ×
                      </button>
                    </div>
                  )
                )}
                {newBoardName !== null ? (
                  <form
                    className="base-row"
                    onSubmit={(e) => (e.preventDefault(), addBoard(newBoardName))}
                  >
                    <input
                      className="base-name"
                      autoFocus
                      placeholder={t('board name')}
                      value={newBoardName}
                      onChange={(e) => setNewBoardName(e.target.value)}
                      onKeyDown={(e) => e.key === 'Escape' && setNewBoardName(null)}
                    />
                    <button className="mini" type="submit">
                      ✓
                    </button>
                  </form>
                ) : (
                  <button className="mini base-add" onClick={() => setNewBoardName('')}>
                    ＋ {t('New board')}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
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
                {pinTypes.length > 1 && (
                  <>
                    <div className="layers-panel-head">{t('Pin folders')}</div>
                    <div className="tag-row pin-type-row">
                      {pinTypes.map((ty) => (
                        <span
                          key={ty}
                          className={`tag-chip clickable ${pinHidden.has(ty) ? '' : 'active'}`}
                          onClick={() => togglePinType(ty)}
                        >
                          {folders.find((x) => x.id === ty)?.name || t('(no folder)')}
                        </span>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>
      <div className="map-body">
        <div className="map-host-wrap">
          {/* SVG marker def for the path direction arrow (referenced document-wide via
              url(#worldArrow); context-stroke makes the arrow follow the line's color,
              markerUnits=strokeWidth scales it with weight → screen-fixed on zoom, no hot path) */}
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
              {/* Polygon fill patterns: one per unique image used on the map + in the draw
                  default. objectBoundingBox + preserveAspectRatio=none: the image stretches
                  over the polygon's bbox — glued to the polygon, scaling with it on zoom. */}
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
          {/* Scale bar: a round distance (1/2/5×10ⁿ) is picked, pixel width comes from zoom.
              Zoom updates HUD state every tick so the render stays fresh. Kept in exports. */}
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
                // Changing the year stales the route (it may run over roads that do not exist
                // that year) → drop it. applyYear itself is not wrapped: reloadFeatures' internal
                // calls must not drop the route, and no branch belongs on the hot path.
                onYear={(y) => {
                  if (navRef.current?.step === 'result') endNav()
                  applyYear(y)
                }}
                onLocate={focusFeature}
              />
              {conquest?.step === 'receiver' && (
                <div className="link-hint">
                  {t('⚔ Click the conqueror — the picks join it…')}{' '}
                  <label>
                    {t('conqueror')}{' '}
                    <select
                      value={conquest.recvLevel ?? ''}
                      title={t('Which rank the conqueror is taken as')}
                      onChange={(e) =>
                        setConquest({ ...conquest, recvLevel: e.target.value || null })
                      }
                    >
                      <option value="">{t('base')}</option>
                      {ladderTags.map((tag) => (
                        <option key={tag} value={tag}>
                          {tag}
                        </option>
                      ))}
                    </select>
                  </label>{' '}
                  <label>
                    {t('takes')}{' '}
                    <select
                      value={conquest.level ?? ''}
                      title={t(
                        'Which ladder rank changes hands (upper ranks take their whole branch)'
                      )}
                      onChange={(e) => setConquest({ ...conquest, level: e.target.value || null })}
                    >
                      <option value="">{t('base')}</option>
                      {ladderTags.map((tag) => (
                        <option key={tag} value={tag}>
                          {tag}
                        </option>
                      ))}
                    </select>
                  </label>{' '}
                  <button className="mini" onClick={() => setConquest(null)}>
                    {t('cancel')}
                  </button>
                </div>
              )}
              {conquest?.step === 'picking' && (
                <div className="link-hint">
                  {t('⚔ Select polygons to join {name} ({n} selected)', {
                    name: conquest.receiverName,
                    n: conquest.picked.size
                  })}{' '}
                  <span className="tag-chip">
                    {conquest.recvLevel ?? t('base')} ← {conquest.level ?? t('base')}
                  </span>{' '}
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
                    step="any"
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
                // The conquest rank defaults to the rank you are LOOKING at (viewing duchies →
                // you conquer duchies); the hint bar's picker can still change it.
                onConquest={() => {
                  const at = activeMode?.kind === 'rank' ? activeMode.key : null
                  setConquest({ step: 'receiver', level: at, recvLevel: at })
                }}
                onOpenEntity={onOpenEntity}
                onLocate={locateEntity}
              />
              {/* Floating tool palette + its settings popover. Both sit inside .map-host-wrap
                  (position:relative) like the other floats, so opening the 380px inspector shrinks
                  that box and they slide left with it — no collision handling needed. Inside the
                  !exporting guard so neither lands in the exported PNG. */}
              {!hideTools && <MapToolbar active={tool} onTool={activateTool} />}
              {tool && !selected && !hidePanels && (
                <div className="map-tool-popover">
                  <ToolPanel
                    active={tool}
                    settings={drawSettings}
                    onSettings={updateDrawSettings}
                    scale={mapScale}
                    mapWidthPx={worldMap?.width ?? null}
                    measuring={
                      measure?.kind === 'dist' || measure?.kind === 'area' ? measure.kind : null
                    }
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
                    onRemovePinImage={(path) =>
                      savePinLib(pinImages.filter((p) => p.path !== path))
                    }
                  />
                </div>
              )}
            </>
          )}
        </div>
        {selected && !hidePanels && (
          <div
            className="pane-resize"
            title={t('Drag to resize')}
            onMouseDown={(e) =>
              startPaneResize(e, {
                from: panelW,
                edge: 'left', // handle on the panel's left: dragging left widens it
                min: 280,
                max: 640,
                onMove: setPanelW,
                onDone: (w) => api.savePrefs({ mapPanelWidth: w })
              })
            }
          />
        )}
        {selected && (
          // display:none, not unmounted — hiding panels must not tear down the inspector's
          // EntityPage and lose whatever the user was editing in it.
          <div
            className="map-panel"
            style={{
              width: panelW,
              minWidth: panelW,
              display: hidePanels ? 'none' : undefined
            }}
          >
            {/* The inspector names the OBJECT, not the row id: "Drawing #47" told
                you nothing you could act on. Kind + bound entity is what the user
                is actually looking at. */}
            <div className="inspector-head">
              <Icon
                name={
                  selIsPolygon ? 'polygon' : selIsLine ? 'path' : selIsLabel ? 'label' : 'map-pin'
                }
                size={14}
              />
              <span className="inspector-title">
                {selIds.length > 1
                  ? t('{n} drawings selected', { n: selIds.length })
                  : (selected.entity_name ??
                    selStyle.text ??
                    t(
                      selIsPolygon
                        ? 'Polygon'
                        : selIsLine
                          ? 'Path'
                          : selIsLabel
                            ? 'Label'
                            : 'Location'
                    ))}
              </span>
              <IconButton icon="x" label={t('Close')} onClick={clearSel} />
            </div>
            <div className="inspector-body">
              {selIds.length > 1 && (
                // Controls follow the primary feature's kind; edits apply to the WHOLE selection
                <div className="panel-block">
                  <label>
                    {t('Edits apply to all selected drawings. Ctrl+click to add/remove.')}
                  </label>
                </div>
              )}

              <div className="panel-block">
                <label>{t('Appearance')}</label>
                {selIsPolygon ? (
                  <>
                    <ColorPicker
                      value={selStyle.color ?? folderColor(folders, selected.entity_folder)}
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
                      onImg={(p) =>
                        editSelectedStyle(
                          selStyle.fillImg === p ? { fillImg: undefined } : { fillImg: p }
                        )
                      }
                      onUpload={() => uploadPinImage((p) => editSelectedStyle({ fillImg: p }))}
                      onRemoveImg={(path) => savePinLib(pinImages.filter((p) => p.path !== path))}
                    />
                    {selStyle.fillImg && (
                      <button
                        className="mini"
                        onClick={() => editSelectedStyle({ fillImg: undefined })}
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
                    {zoomVisControls()}
                  </>
                ) : (
                  <>
                    {/* Free mode has no badge → color has no effect, hide the control */}
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
                          selStyle.img === img
                            ? { img: undefined, imgAR: undefined }
                            : { img, imgAR }
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
                    {zoomVisControls()}
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
                        <span>
                          <Icon name="ruler" size={12} />
                          {t('Length: {val} {unit}', {
                            val: fmtDist(ringLen(g.coordinates as number[][]) * k),
                            unit: mapScale.unit
                          })}
                        </span>
                      </div>
                    )
                  // ponytail: outer ring only — no holed polygons are drawn
                  const ring = (g.coordinates as number[][][])[0]
                  return (
                    <div className="panel-block scale-info">
                      <span>
                        <Icon name="polygon" size={12} />
                        {t('Area: {val} {unit}²', {
                          val: fmtDist(ringArea(ring) * k * k),
                          unit: mapScale.unit
                        })}
                      </span>
                      <span>
                        <Icon name="ruler" size={12} />
                        {t('Perimeter: {val} {unit}', {
                          val: fmtDist(ringLen(ring) * k),
                          unit: mapScale.unit
                        })}
                      </span>
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

              {selected.entity_id ? (
                <div className="panel-block">
                  <button
                    className="mini"
                    onClick={async () => (
                      await api.updateFeature(selected.id, { entity_id: null }),
                      reloadFeatures(),
                      setSelected({
                        ...selected,
                        entity_id: null,
                        entity_name: null,
                        entity_folder: null
                      })
                    )}
                  >
                    <Icon name="unlink" size={12} />
                    {t('Unlink entity')}
                  </button>
                </div>
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
                      .filter((en) => !(en.folder && personFolders.has(en.folder)))
                      .map((en) => (
                        <option key={en.id} value={en.name} />
                      ))}
                  </datalist>
                  <button
                    className="mini"
                    onClick={async () => {
                      if (!linkName.trim()) return
                      const found = allEntities.find(
                        (en) => en.name === linkName && !(en.folder && personFolders.has(en.folder))
                      )
                      if (found) return linkEntity(found.id)
                      const { id: newId } = await api.createEntity({ name: linkName.trim() })
                      setAllEntities(await api.listEntities())
                      onChanged()
                      await linkEntity(newId)
                    }}
                  >
                    <Icon name="plus" size={12} />
                    {t('Link / Create')}
                  </button>
                </div>
              )}
            </div>
            {/* The bound article, shown as its identity RAIL — the same sections
                the full page renders, so the inspector and the page are visibly
                two views of one object rather than two interfaces. The document
                (markdown, note tabs, relations) stays on the full page: it is
                unusable at 380px, and "Open full page" sits in the rail header. */}
            {selected.entity_id && (
              <EntityPage
                id={selected.entity_id}
                folders={folders}
                compact
                onOpen={onOpenEntity}
                onChanged={() => (reloadFeatures(), onChanged())}
                onDeleted={() => (clearSel(), reloadFeatures())}
              />
            )}
          </div>
        )}
      </div>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  )
}
