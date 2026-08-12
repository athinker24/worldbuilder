import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
  asArray,
  asObject,
  settingObject,
  settingArray,
  perMapRaw,
  perMapEntry,
  savePerMap,
  takeMapSettings,
  restoreMapSettings,
  autoColor,
  EntityRow,
  Feature,
  getHierConfig,
  getMapModes,
  getMapBoards,
  getParents,
  getPinImages,
  getRecentColors,
  pushRecentColor,
  getMapYear,
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
  outlineColor,
  personFolderIds,
  WorldMap
} from './api'
import ColorPicker, { PRESETS } from './ColorPicker'
import ContextMenu, { MenuEntry, MenuState } from './ContextMenu'
import { ImageStrip, PinShape, PinShapePicker, pinShapeBody } from './pinIcons'
import { LabelLayer, type LabelSpec } from './pixiLabels'
import { ShapeLayer, shapeAt, shapeAllAt, pathAt, hexNum, type ShapeSpec } from './pixiShapes'
import EntityPage from './EntityPage'
import HierarchyPanel, { ActiveMode } from './HierarchyPanel'
import { alertDialog, confirmDialog } from './dialog'
import History from './History'
import Icon from './icons'
import Select from './Select'
import { EmptyState, IconButton, Segmented } from './ui'
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
  HALO_LABELS,
  LABEL_HALOS,
  LabelHalo,
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
import { endFrames, frame, logCrash, logEvent, logTime } from './log'

L.Icon.Default.mergeOptions({ iconUrl, iconRetinaUrl, shadowUrl })

/**
 * Options for every `pm.enable()` here. They must be passed at the CALL: geoman's
 * `Edit.enable(options)` does `L.Util.setOptions(this, options)` and never reads
 * `map.pm.globalOptions`, so `setGlobalOptions` reaches only the layers geoman enables itself in
 * its own bulk modes. Setting an edit option there looks right and does nothing.
 *
 * `limitMarkersToCount` leaves geoman holding real, draggable handles for only the few nearest the
 * cursor. On its own that was unacceptable — the vertices you could SEE came and went as the mouse
 * moved. It is fine now only because seeing them is no longer this element's job: every vertex is
 * drawn as a dot in the WebGL layer (ShapeLayer.setHandles), which costs nothing, and these
 * elements are left to do the one thing that needs a DOM node, which is being dragged.
 */
const EDIT_OPTS = { limitMarkersToCount: 20 }

/**
 * The style fields that are PURE PAINT — the ones `renderStyle` carries and `applyYear` can apply
 * on its own, without the map being rebuilt. Exactly the controls a user drags, which is why this
 * set is where the cost went. Everything absent from it (label text, from/to, minZoom/maxZoom,
 * pin image, board, curviness, arrow) is built elsewhere in reloadFeatures and still needs it.
 */
const PAINT_KEYS = new Set(['color', 'fillOpacity', 'opacity', 'weight', 'dash'])

/**
 * What a drawing IS, for the log. Geoman calls both a pin and a free-text label 'Marker', so the
 * active tool is what tells them apart — the same discrimination `pm:create` already makes.
 */
const featureKind = (shape: string | undefined, isLabel: boolean): string =>
  shape === 'Marker' ? (isLabel ? 'label' : 'pin') : shape === 'Line' ? 'path' : 'polygon'

// --- Marker icons are placed with left/top instead of a 3D transform. --------------------------
// Leaflet's setPosition writes `translate3d(x, y, 0)` on every marker element, and an element
// carrying its own 3D transform is one Chromium lifts onto its own compositing layer. That is
// invisible at 117 pins and ruinous in edit mode, where geoman puts a draggable element on every
// vertex plus one between each pair: selecting a many-vertex polygon measured 426 compositing
// layers PER FRAME (UpdateLayer, 115132 events over 270 frames), 100067 raster tasks in ten
// seconds, 27 fps, and the main thread blocked in Commit for 7.6 s out of 12 — not working,
// waiting. Two attempts to fix it by showing FEWER handles were both rejected on sight: nearest-N
// to the cursor scatters and reshuffles as the mouse moves, and hiding the off-screen ones was no
// better. The element count is not the problem; what each element costs is.
//
// Leaflet already has a transform-free path — left/top, what it uses when Browser.any3d is false.
// Patched here for MARKERS ONLY rather than by flipping that flag, which would also change how
// panes are positioned and how zoom animation runs.
//
// The trade is real and it is the right way round: left/top is laid out rather than composited, so
// moving a marker costs layout. But markers do not move individually while panning or zooming —
// the PANE moves and carries them — so that cost lands once per zoom commit, against a per-frame
// compositing cost for every handle on screen.
//
// The stock method still runs first: it keeps `_leaflet_pos` (which getPosition reads) and the
// z-index bookkeeping. Only the mechanism that puts the pixels somewhere changes.
{
  type PosMarker = { _icon?: HTMLElement; _shadow?: HTMLElement }
  const proto = L.Marker.prototype as unknown as {
    _setPos: (this: PosMarker, pos: L.Point) => void
  }
  const stockSetPos = proto._setPos
  proto._setPos = function (pos: L.Point): void {
    stockSetPos.call(this, pos)
    for (const el of [this._icon, this._shadow]) {
      if (!el) continue
      el.style.transform = ''
      el.style.left = `${pos.x}px`
      el.style.top = `${pos.y}px`
    }
  }
}

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
//    where every boundary is a colour edge. Quantising the zoom before scaling the tolerance makes
//    it constant in MAP units inside each step, so the shape is frozen while zooming and only
//    re-simplifies when crossing a step boundary — with BORDER_SMOOTH's LOD intact.
//    Only works together with (1) — alone, the rounding noise flips borderline vertices anyway.
//
//    LOD_STEPS quantises the zoom before scaling, so the vertex set is frozen inside each step
//    instead of drifting every frame. Measured over the same 199-frame sweep: whole zooms
//    re-simplify 4 times, halves 8, quarters 16, eighths 32 — against the 174 that shimmered.
const LOD_STEPS = 4
//    But quantising alone only makes the reshaping RARER, not absent, and simplification earns
//    nothing at the zooms people actually work at: once you are past the fit view only a handful
//    of shapes are on screen, so dropping vertices saves little and every dropped vertex is
//    plainly visible. So the tolerance fades to zero as the view approaches the fit zoom, and
//    above it the exact drawn geometry is rendered — no reshaping at all in normal use. LOD then
//    lives only in the overview band (minZoom is fit − 1), which is where many polygons are on
//    screen at once and each is too small for the loss to read.
//    Set from the base-image effect; -Infinity until a map has an image, which disables the fade
//    and leaves plain quantised LOD.
let mapFitZoom = -Infinity
type Simplifiable = { _simplifyPoints(): void; _map?: L.Map; options: { smoothFactor?: number } }
const stockSimplify = (L.Polyline.prototype as unknown as Simplifiable)._simplifyPoints
;(L.Polyline.prototype as unknown as Simplifiable)._simplifyPoints = function (
  this: Simplifiable
): void {
  const zoom = this._map?.getZoom()
  const tol = this.options.smoothFactor
  if (zoom === undefined || !tol) return stockSimplify.call(this)
  const step = Math.round(zoom * LOD_STEPS) / LOD_STEPS
  // Quantised so the fade itself cannot reintroduce per-frame drift.
  const fade = Math.min(1, Math.max(0, mapFitZoom - step))
  // Leaflet's simplify() returns the points untouched when the tolerance is falsy.
  this.options.smoothFactor = fade === 0 ? 0 : tol * fade * 2 ** (zoom - step)
  stockSimplify.call(this)
  this.options.smoothFactor = tol
}

// 3. Stroke width. Leaflet strokes are screen-fixed, so a road held its pixel width while the
//    terrain under it grew and shrank — a thread when zoomed in, a continent-wide band when
//    zoomed out, while the labels and pins beside it scale with the map by design. A road has a
//    real width in the world, so weight is read as MAP PIXELS, the same unit the geometry is in:
//    the pane carries the zoom scale in --mz (ONE property write per frame, the trick the free
//    labels use for --lz) and each path publishes its own weight as --w, so the CSS multiplies
//    them. Writing --w here rather than at each call site covers polygons, lines, curve overlays
//    and highlights alike.
//    The anchor is zoom 0 (1 map pixel = 1 screen pixel), NOT the fit view. Anchoring at fit was
//    tried and reverted: fit is a negative zoom for any image larger than the viewport, so it
//    inflated every stroke by 1/2**fit — two to three times too thick on a normal map.
//    POLYGONS ARE EXEMPT, and the distinction is cartographic rather than technical: a road has
//    a real width on the ground, so it belongs to the terrain and scales with it. A border has
//    none — it is a pen stroke describing where one thing stops, and on paper maps it is drawn
//    at a constant width whatever the scale. Scaling it just made outlines swallow the land they
//    were describing. Setting --mz on the polygon's own path shadows the pane's value (custom
//    properties inherit), so the exemption costs one line and no second code path.
//    The hook is the RENDERER's _updateStyle(layer), not Path's — Path has no such method, it
//    delegates via this._renderer._updateStyle(this). Patching Path.prototype defined a method
//    nobody calls, so --w was never written and every stroke fell back to the CSS default of 3:
//    the thickness sliders did nothing and weight-2 outlines drew at 3. Hence the hop through
//    _renderer here.
type Styled = { _path?: SVGElement; options: { weight?: number } }
type SvgRenderer = { _updateStyle(layer: Styled): void }
const stockUpdateStyle = (L.SVG.prototype as unknown as SvgRenderer)._updateStyle
;(L.SVG.prototype as unknown as SvgRenderer)._updateStyle = function (
  this: SvgRenderer,
  layer: Styled
): void {
  stockUpdateStyle.call(this, layer)
  const path = layer._path
  if (path && layer.options.weight !== undefined) {
    path.style.setProperty('--w', String(layer.options.weight))
    if (layer instanceof L.Polygon) path.style.setProperty('--mz', '1')
    // The stylesheet floors the width at 0.75px so a hairline survives the smallest zooms — but a
    // weight of ZERO is a choice, not a small number, and the floor was quietly turning it back
    // into a 1px line. An inline width beats the stylesheet and says exactly that.
    path.style.strokeWidth = layer.options.weight === 0 ? '0' : ''
  }
}

// Shape of the Feature.style JSON (all optional — old records fall back to defaults)
interface FeatureStyle {
  color?: string
  fillOpacity?: number
  weight?: number
  size?: number
  shape?: PinShape // pin mark from the abstract set; absent = disc (pinIcons)
  font?: string
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
  halo?: LabelHalo // label halo: paper-coloured, dark, or none (see pixiLabels)
  haloWidth?: number // halo thickness, fraction of the font size
  tracking?: number // letter spacing, fraction of the font size
  bold?: boolean
  italic?: boolean
  hideName?: boolean // polygon: do not draw the article's name on it (place a label instead)
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
  /** After a step taken from the History menu: App refreshes the sidebar and bumps
   *  reloadToken, which is what brings the map back in step. */
  onUndone: () => void
  // Hands the PNG exporter up to App so File > Export can fire it, and null on unmount.
  // Deliberately an opaque () => void — capturePage needs the live .leaflet-host element, which
  // only exists here, and no Leaflet type may leave this file.
  onExportReady?: (fn: (() => void) | null) => void
  // Photoshop's Tab / Shift+Tab, driven from App: hidePanels covers the inspector and the tool
  // settings popover, hideTools additionally hides the floating tool palette.
  /** False while another workspace is on screen. The map stays MOUNTED so returning
      to it does not rebuild Leaflet and throw away your zoom and position — but its
      window-level shortcuts must stand down, or Del on the entity list would also
      delete the selected drawing (that handler runs in the capture phase and stops
      propagation, so it would swallow App's Del outright). */
  active?: boolean
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
  /** geoman's own "remove last vertex" — the action behind its toolbar button. Private, but the
   *  dependency is pinned and reimplementing it means reaching into the same half-drawn state. */
  _removeLastVertex?: () => void
  /** The vertices placed so far — geoman disables the whole session when the last one goes. */
  _markers?: unknown[]
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
// Lowered from 2.5: with LOD_STEPS quantising the zoom, what remains visible at a step boundary is
// the tolerance itself, since that is how far a dropped vertex can pull the outline. 1.6px keeps
// most of the vertex saving while putting the largest possible jump under two pixels.
const BORDER_SMOOTH = 1.6
const PIN_DEFAULT_COLOR = '#c0603a'
// Three looks: (1) free custom image — no badge, aspect kept (transparent PNG symbols);
// (2) custom image inside the badge — clipped to a circle (crest/portrait); (3) plain badge.
const pinDivIcon = (m: {
  size?: number
  color?: string
  shape?: PinShape
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
  // With an image it is clipped to a circle inside the badge; without one it is a shape from
  // the abstract set (see pinIcons). The svg is 100%×100% of the icon box, which the zoom hot
  // path already resizes — so shapes scale with zoom for free, no branch added there.
  // Only `color` is interpolated, and it goes through cssColor rather than escapeHtml: it lands
  // inside a style attribute, where escaping is undone by the HTML parser before CSS reads it.
  // The shape bodies are static markup.
  const css = cssColor(color, PIN_DEFAULT_COLOR)
  const html = m.img
    ? `<div class="pin-badge" style="background:${css}">` +
      `<img class="pin-badge-img" src="${escapeHtml(assetUrl(m.img))}"></div>`
    : `<svg class="pin-shape" viewBox="0 0 24 24" style="color:${css}">${pinShapeBody(m.shape)}</svg>`
  return L.divIcon({
    className: 'pin-marker',
    html,
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
/**
 * The widest base image that goes to the GPU whole.
 *
 * WebGL guarantees far less than this and real hardware allows far more (D3D11 does 16384), but
 * a texture that exceeds the limit does not degrade — the upload fails and the map has no
 * picture. 8192 is past any hand-made world map and inside every desktop GPU of the last decade;
 * anything larger is scaled once at load rather than refused.
 */
const MAX_BASE_PX = 8192
// Derived-mode label (rank/paint): a base font (map units) below this means the region is too
// small, so no label is drawn (CK3 does not name tiny regions either)
const LABEL_MIN = 5
// The text is user input embedded into an html string → must be escaped (no XSS from a shared
// world.db; same rationale as blocking raw HTML in markdown).
const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/**
 * Values that land INSIDE a `style="…"` attribute, where escapeHtml is the wrong tool.
 *
 * It looks right and is not: the HTML parser decodes `&#39;` back to `'` before the CSS parser
 * ever sees the attribute, so `x'; background:url(…` reassembles itself on the other side of the
 * escaping and the extra declarations apply. A pin's colour and a label's font come out of a
 * shared world's style JSON as free strings, so that is reachable from a file. Nothing dramatic
 * follows today — the CSP's `img-src` keeps a `url()` from leaving the machine — but the fix
 * belongs at the source rather than in an argument about what CSS can still do.
 *
 * Cut, do not repair. These are a hex colour and a font NAME; anything that is not one is not a
 * damaged version of one, it is something else, and the fallback is a perfectly good pin.
 */
const cssColor = (v: string | undefined, fallback: string): string =>
  /^#[0-9a-fA-F]{3,8}$/.test(v ?? '') ? (v as string) : fallback
const cssFont = (v: string | undefined): string =>
  (v ?? '').replace(/[^\w -]/g, '').slice(0, 40) || 'Cinzel'
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
  // Both land inside attributes CSS reads (`fill=` is a presentation attribute, `font-family` is
  // in a style attribute), so they are checked rather than escaped — see cssColor.
  const color = cssColor(s.color, '#ffffff')
  const font = cssFont(s.font)
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
  // A textPath is only built when the label is actually CURVED. It used to render every label,
  // straight ones included, for a single code path — but a textPath places, rotates and fills
  // each glyph as its own path, so nothing the text pipeline caches applies and the whole run is
  // re-outlined on every zoom frame. Labels turned out to be 93 % of all rasterisation on a
  // realistic map (605 ms/s with them on, 40 ms/s with them off, same gesture), so that was not
  // a free abstraction. A straight run is a plain <text>, which Skia can render as a cached
  // glyph blob. The click behaviour that motivated using SVG in the first place is unchanged:
  // it comes from `pointer-events: visiblePainted` on the text (main.css), which makes only the
  // painted letters clickable, and that is true of <text> with or without a textPath.
  //
  // Geometry is deliberately identical between the two branches: the straight path ran from
  // (pad, cy) to (W - pad, cy) and startOffset 50 % put the midpoint at ((pad + W - pad) / 2, cy)
  // = (W / 2, cy), which is exactly where the plain <text> anchor sits. Same position, same
  // width, no visual change.
  const body =
    curve === 0
      ? `<text x="${W / 2}" y="${cy}" font-size="${F}" fill="${color}" text-anchor="middle" dominant-baseline="central">${text}</text>`
      : (() => {
          const id = `lblp${++labelSeq}`
          return (
            `<defs><path id="${id}" fill="none" d="M ${pad},${cy} Q ${W / 2},${cy - 2 * sag} ${W - pad},${cy}"/></defs>` +
            `<text font-size="${F}" fill="${color}" text-anchor="middle" dominant-baseline="central">` +
            `<textPath href="#${id}" startOffset="50%">${text}</textPath></text>`
          )
        })()
  const html = `<svg class="map-label-svg" viewBox="0 0 ${W} ${H}" style="width:${W / F}em;height:${H / F}em;font-size:${basePx}px;font-family:'${font}',serif;transform:translate(-50%,-50%) scale(var(--lz,1)) rotate(${angle}deg)">${body}</svg>`
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
// True area-weighted (shoelace) centroid, matching what Leaflet's own Polygon.getCenter() would
// return. Needed specifically because getCenter() throws until the layer is added to the map
// ("Must add layer to map before using getCenter()"), and polygon labels are created BEFORE
// that point in reloadFeatures — this works straight off the raw GeoJSON ring instead. Unlike
// ringCentroid (vertex average, fine for a derived-label anchor spanning several polygons), a
// vertex average pulls toward whichever edge has more points — exactly the failure mode a
// detailed, many-vertex coastline invites, which is the shape a per-polygon name label sits on.
const ringAreaCentroid = (ring: number[][]): [number, number] => {
  let a = 0
  let cx = 0
  let cy = 0
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i]
    const [x1, y1] = ring[(i + 1) % ring.length]
    const cross = x0 * y1 - x1 * y0
    a += cross
    cx += (x0 + x1) * cross
    cy += (y0 + y1) * cross
  }
  a *= 0.5
  if (Math.abs(a) < 1e-9) return ringCentroid(ring) // degenerate ring — fall back rather than divide by ~0
  return [cx / (6 * a), cy / (6 * a)]
}
// Adjacency tolerance for derived-label clustering, as a FRACTION of the map's own long side.
//
// It was a flat 0.01 (the vertex grid's own cell), and on real hand-drawn borders that caught
// nothing: measured across a real world's map, neighbours that look welded sit 0.039 to 0.14 units
// apart on a 1024-unit map — snapping residue, a hundredth of a pixel, invisible and not something
// anyone drew on purpose. Regions that are GENUINELY apart on that same map start at 18.8 units.
// Two populations separated by more than a hundredfold, so the threshold is not a close call; this
// puts it at ~1 unit there and ~4 on a 4096-unit map, still an order of magnitude under anything
// real. "Only touching neighbours merge" is the rule — this is what touching measures as.
const ADJ_FRAC = 0.001
// Squared distance from a point to a segment. The T-junction test below runs it per vertex per
// candidate segment, so it stays allocation-free and never takes a square root.
const segDist2 = (
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number => {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const qx = px - (ax + t * dx)
  const qy = py - (ay + t * dy)
  return qx * qx + qy * qy
}
/**
 * Do these two rings touch? A vertex of either lying ON an edge of the other counts.
 *
 * The vertex-cell test that runs first only catches neighbours that share a CORNER, which is what
 * geoman produces when a vertex is dragged onto a vertex. It also snaps a vertex onto an EDGE, and
 * that leaves the other polygon with no vertex there at all: a T-junction, two polygons sharing a
 * real border and not one coordinate. Both directions are checked because a T-junction is
 * one-sided by construction — the vertex belongs to whichever polygon was drawn second.
 */
const ringsTouch = (a: number[][], b: number[][], tol: number): boolean => {
  const tol2 = tol * tol
  const hit = (pts: number[][], ring: number[][]): boolean => {
    for (const [px, py] of pts)
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
        if (segDist2(px, py, ring[j][0], ring[j][1], ring[i][0], ring[i][1]) <= tol2) return true
    return false
  }
  return hit(a, b) || hit(b, a)
}
// Below this the two PCA eigenvalues are too close to call a direction (see pcaAxis). 0.15 sits
// just under a 1.2:1 rectangle, measured against open rings — anything rounder is written level.
const ANISO_MIN = 0.15
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
  // A shape with no dominant axis has no meaningful angle to follow, and atan2 does not know
  // that: the two eigenvalues of the covariance come out equal and the direction it returns is
  // whatever the rounding leaned toward — a square answers 45°, which is a name written up the
  // diagonal of a region that is not diagonal at all. Compare the eigenvalues instead
  // ((l1-l2)/(l1+l2), scale-free) and write horizontally below ANISO_MIN, which sits just under a
  // 1.2:1 rectangle. Past it the axis is real and the label follows it as before.
  const trace = sxx + syy
  const spread = Math.sqrt((sxx - syy) ** 2 + 4 * sxy * sxy)
  const theta = trace > 0 && spread / trace < ANISO_MIN ? 0 : 0.5 * Math.atan2(2 * sxy, sxx - syy)
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
  onUndone,
  maps,
  folders,
  onNavigate,
  onOpenEntity,
  onChanged,
  onExportReady,
  active = true,
  hidePanels,
  hideTools
}: Props): React.JSX.Element {
  const t = useT()
  const divRef = useRef<HTMLDivElement>(null)
  // Cached host rect for onWheel's point conversion — see that call site for why this exists
  // instead of just calling map.mouseEventToContainerPoint(e) every wheel tick.
  const hostRectRef = useRef<DOMRect | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const featureGroupRef = useRef<L.FeatureGroup | null>(null)
  // The base image: its own canvas under Leaflet's panes, and the picture decoded once (see
  // drawBase). x/y/w/h are the image's rectangle in zoom-0 layer space, the same space the WebGL
  // layers work in — MapView owns every conversion out of Leaflet, here as everywhere.
  const baseCanvas = useRef<HTMLCanvasElement | null>(null)
  /**
   * Where the base image sits, in zoom-0 layer points. The PICTURE is not here: it is a mipmapped
   * texture in the shape layer (see setBase in pixiShapes). What is left on the 2D canvas is the
   * frame around it — the shadow and the rim — which is seven stroked rectangles a frame and was
   * never the expensive part. Splitting it that way keeps the look exactly as it was drawn while
   * the one costly call, drawImage of 16.7 million pixels, is gone.
   */
  const baseImg = useRef<{ x: number; y: number; w: number; h: number } | null>(null)
  // Polygon name labels live in a WebGL layer, not the DOM — see pixiLabels.ts for the
  // measurements that forced it. `polySpec` is the label each polygon WOULD draw; applyYear
  // decides which of them are actually visible this year and hands that subset to the layer.
  const polySpec = useRef(new Map<number, LabelSpec>())
  // Free text labels: the same WebGL treatment, but they are selectable and draggable, so the
  // Leaflet marker stays and only its LOOK moves. Its icon becomes an empty transparent box that
  // exists purely to be clicked and grabbed — no glyphs in it, so it costs what a pin costs.
  // This is the "display in Pixi, interact as a real Leaflet layer" split CLAUDE.md describes.
  // Polygons and paths are drawn by a WebGL layer, so the things Leaflet used to give for free
  // now need somewhere to live: the geometry in zoom-0 space (what the layer draws and what hit
  // testing runs against), and each feature's click handler, which is invoked from a single
  // map-level listener once the hit test says which shape was under the cursor. Keeping the
  // handler bodies exactly as they were — closures over the feature row and all — is deliberate:
  // routing changed, none of the conquest, navigation or selection logic did.
  const featRings = useRef(new Map<number, number[][][]>())
  /**
   * The geometry each feature currently has IN THE DATABASE — what an undo of the next edit
   * has to return to.
   *
   * It cannot come from the feature row the handlers close over. A single-feature edit
   * deliberately does not reload (see commitGeometry), so `f.geometry` still holds whatever the
   * last reload read: edit twice without a reload between and the second edit records the state
   * from BEFORE the first, so one Ctrl+Z jumps back two steps and the step between them is gone.
   *
   * The weld partners never had this problem because they capture their own `oldGeom` from the
   * live layer at `pm:markerdragstart`; this is the same idea for the primary feature, kept as a
   * ref rather than by mutating `f.geometry` — that row object is shared with `worldMapRef`,
   * which copy/paste and createFeatureFork read, and writing through it would change what they see.
   *
   * Seeded on every reload, advanced after every successful commit, and moved with undo/redo so
   * the window before the reload lands is right too.
   */
  const featGeom = useRef(new Map<number, string>())
  const featClick = useRef(new Map<number, (ev: L.LeafletMouseEvent) => void>())
  const shapeLayer = useRef<ShapeLayer | null>(null)
  // What the shape layer is currently drawing — the hit test searches this, so it has to be the
  // same list, in the same order, that produced what is on screen.
  const shapeSpecs = useRef<ShapeSpec[]>([])
  const freeSpec = useRef(new Map<number, LabelSpec>())
  // Hit-box size in zoom-0 units, scaled onto the transparent icon by updateOverlaySizes.
  const labelHit = useRef(new Map<number, { w: number; h: number; angle: number }>())
  const labelLayer = useRef<LabelLayer | null>(null)
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
  // The same position in SCREEN pixels: what is under the cursor can only be asked of the DOM.
  const lastPoint = useRef<{ x: number; y: number } | null>(null)
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
    hostRectRef.current = host.getBoundingClientRect()
    let frame = 0
    const ro = new ResizeObserver(() => {
      hostRectRef.current = host.getBoundingClientRect()
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
  /**
   * The one resize that must NOT wait a frame: the inspector opening and closing.
   *
   * It is a flex sibling of the map, so selecting a polygon takes ~380px of width away from the
   * map in the very layout React is writing — while both WebGL canvases still hold a bitmap of
   * the OLD width. Their backing store is only resized inside draw(), and the observer above
   * cannot get there in time: it fires mid-layout, so it is obliged to defer to a frame. For that
   * one frame the browser stretches the old picture into the new box, and the whole map squashes
   * and snaps back — on open and again on close. That flicker is what looked like a reload.
   *
   * A layout effect runs after the DOM change and before the paint, which is exactly the window
   * this needs: invalidateSize fires `move` synchronously, our handler redraws both canvases at
   * the new size, and the frame that reaches the screen is already correct. The observer stays
   * for everything that resizes the map WITHOUT re-rendering this component (dragging either
   * pane's edge, collapsing the sidebar, the window itself).
   */
  const panelOpen = !!selected && !hidePanels
  useLayoutEffect(() => {
    mapRef.current?.invalidateSize({ animate: false, pan: false })
  }, [panelOpen])
  // Zoom at which the whole map fits the window — the origin for the % readout.
  // State, not a ref: it is read while rendering the HUD and changes only when a
  // base image loads, so it is nowhere near the zoom hot path.
  const [fitZoom, setFitZoom] = useState(0)
  const activeRef = useRef(active)
  useEffect(() => {
    activeRef.current = active
  }, [active])

  /**
   * Sizing the view to the base image: the initial zoom, the pan limits and the zoom floor. Split
   * out of the base-image effect because it can no longer be done once.
   *
   * App mounts this component as soon as a world has a map, BEFORE anything is pressed, so that
   * pressing Maps is a `display` flip rather than a load. Inside `display:none` the host is 0x0 —
   * and every number here comes from the viewport, so `getBoundsZoom` would be asked to fit the
   * world into no pixels at all. It answers -Infinity, which then becomes the map's minZoom and
   * locks it. So a call at no size does NOTHING and leaves `fittedRef` false; the effect below
   * runs it again the first time the map is actually shown.
   */
  const fitBoundsRef = useRef<L.LatLngBoundsLiteral | null>(null)
  const fittedRef = useRef(false)
  const applyFit = useCallback((): void => {
    const map = mapRef.current
    const bounds = fitBoundsRef.current
    const host = divRef.current
    if (!map || !bounds || !host?.clientWidth || !host.clientHeight) return
    // The host may have gone from 0x0 to full size a moment ago; Leaflet still believes the old
    // one until told, and everything below reads its size.
    map.invalidateSize({ animate: false, pan: false })
    map.fitBounds(bounds, { animate: false }) // same reason as focusFeature — no animated zoom here
    const fit = map.getBoundsZoom(bounds)
    setFitZoom(fit)
    mapFitZoom = fit // read by the LOD fade (module scope)
    // Prevent escaping into ugly grey space beyond the image: pan bounded, no zooming out past fit
    map.options.maxBoundsViscosity = 1
    // A full image's width of slack on every side. The old half was measurably tight: a drag
    // asking for 828 px only got 153 before hitting the wall. Grey space beyond the edge is the
    // price, and roaming room is worth more than never seeing any.
    map.setMaxBounds(L.latLngBounds(bounds).pad(1))
    // Exactly `fit`, not `fit - 1`, and the floor matters more than it looks.
    //
    // Leaflet's _rebound does two different things. While the view is SMALLER than the bounds it
    // clamps, which is the intent here. Once the view is LARGER it re-centres instead — so every
    // pan step gets yanked back to the middle, and dragging turns into a fight: the map shakes,
    // slips out from under the cursor and refuses to go where it is pushed.
    //
    // Allowing one level below fit put the map exactly on that boundary. At fit - 1 the view
    // covers twice the image, and pad(0.5) makes the bounds twice the image too, so the two
    // sides of the comparison were equal and which branch ran came down to rounding noise.
    // Holding the floor at fit keeps the view inside the bounds at every reachable zoom, so only
    // the clamping branch can run. It also makes this line agree with the comment above it.
    map.setMinZoom(fit)
    fittedRef.current = true
  }, [])

  /**
   * The first time the map is actually on screen, size it — see applyFit.
   *
   * A LAYOUT effect, for the same reason the inspector's invalidateSize above is one, and getting
   * this wrong is visible rather than theoretical. The map is built at `setView([500, 500], 0)`:
   * in CRS.Simple y grows upward, so on a 4096 image that is the bottom-left corner at 1:1 pixels,
   * about two and a half zoom levels closer than the fit. A passive effect runs AFTER the paint,
   * so the browser put that corner on screen for a frame and the fit arrived afterwards — the map
   * appeared zoomed into its bottom-left and then jumped out to the real view. A layout effect
   * runs after the DOM change and before the paint, so the first frame anyone sees is the fitted
   * one. Reading the host's size here also forces the pending layout, which is what makes the
   * measurement the true one rather than the 0x0 it was mounted at.
   */
  useLayoutEffect(() => {
    if (active && !fittedRef.current) applyFit()
  }, [active, applyFit])
  const [allEntities, setAllEntities] = useState<EntityRow[]>([])
  // Person entities cannot be bound to the map (see EntityPage — they exist for family/dynasty fields)
  const personFolders = personFolderIds(folders) // people cannot be bound to the map
  const [linkName, setLinkName] = useState('')
  // "Draw into" — the article the next drawings join instead of each making its own. The islands
  // of an archipelago, the exclaves of a realm: pieces of one thing, drawn one after another.
  // Session-only and reset by a map switch (this component remounts): a target that survived a
  // restart would silently attach tomorrow's drawings to yesterday's article.
  const [drawInto, setDrawInto] = useState<{ id: number; name: string } | null>(null)
  // Read by pm:create, which is registered once at map setup and would otherwise close over the
  // value this component had on its first render. Written in an effect, like every other ref here.
  const drawIntoRef = useRef<typeof drawInto>(null)
  const [drawIntoName, setDrawIntoName] = useState('')
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [hudZoom, setHudZoom] = useState<number | null>(null)
  const hudTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // Map mode (CK3-like): rank → base polygons by their ancestor at that rank; paint → by dimension
  const [activeMode, setActiveMode] = useState<ActiveMode>(null)
  const activeModeRef = useRef<ActiveMode>(null)
  const [layersOpen, setLayersOpen] = useState(false)
  // Collapsed branches of the map tree. Session state, like the sidebar's folders: which branches
  // you had shut says nothing about the world, and a list this small is cheap to reopen.
  const [collapsedMaps, setCollapsedMaps] = useState<Set<number>>(new Set())
  // Create the next map INSIDE the open one — the natural move when you are on a continent and
  // adding one of its cities.
  const [newMapInside, setNewMapInside] = useState(true)
  // The "no base image" card, dismissed for this map. Persisted, not session state: someone
  // working without a base image would otherwise dismiss the same invitation every launch, which
  // is the definition of a nag. It rides in the .world because it is about that map, not about
  // this machine.
  const [hintOff, setHintOff] = useState(false)
  const [histOpen, setHistOpen] = useState(false)
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
        // The same image as an assets/-relative path. fillColor's `url(#…)` is an SVG reference
        // and means nothing to the WebGL layer, which needs the file itself.
        fillImg?: string
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
  const derivedSpecs = useRef<LabelSpec[]>([])
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
      if (!activeRef.current) return
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
  // Which entries this map is about — the hierarchy panel's rank list and paint legend are
  // filtered to it, so a realm drawn only on another map stops appearing under a rank chip here.
  // Filled in reloadFeatures beside mosaicManaged; see the comment there for what it contains.
  const [mapScope, setMapScope] = useState<Set<number>>(new Set())
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
    await savePerMap('mapScales', id, sc)
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
  // Alt+click cycle: repeated Alt+clicks at (about) the same point step one shape down the
  // z-stack each time, wrapping back to the top past the bottom. `order` is cached from the
  // first click at a point (topmost-first, same order shapeAt already resolves) so a repeat
  // click at the same spot advances through it rather than recomputing "topmost only" again.
  const cycleRef = useRef<{ x: number; y: number; order: number[]; idx: number } | null>(null)
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

  // Travel modes (settings 'travelModes', PER MAP — the mapScales pattern, and per map for the
  // same reason it is): speed is units/day, and the unit is whatever this map was calibrated in.
  // One project-wide list meant "horse: 60" read as 60 km/day on a continent measured in km and
  // 60 m/day on a city measured in metres — the same number saying two different things.
  const [travelModes, setTravelModesState] = useState<TravelMode[]>([])
  const [travelModeIdx, setTravelModeIdx] = useState(0)
  const saveTravelModes = async (list: TravelMode[]): Promise<void> => {
    setTravelModesState(list)
    if (travelModeIdx >= list.length) setTravelModeIdx(0)
    await savePerMap('travelModes', id, list)
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

  // Breadcrumb: walk the parent chain.
  //
  // `seen` is not defensive programming for its own sake. The UI's cycle guard sits where a cycle
  // would be CREATED (see the map tree's right-click move), which covers everything this app does
  // to its own data — and covers nothing about a `.world` someone sent you, where parent_map_id is
  // just a column with whatever is in it. Without this the loop never ends and never throws: it
  // unshifts into an array until the tab dies. db.ts breaks such a loop at the entry gate now, so
  // this is the second of two locks, and it is the cheap one.
  const crumbs: MapRow[] = []
  const walked = new Set<number>()
  let cur = maps.find((m) => m.id === id)
  while (cur && !walked.has(cur.id)) {
    walked.add(cur.id)
    crumbs.unshift(cur)
    cur = maps.find((m) => m.id === cur!.parent_map_id)
  }

  /**
   * Feed the WebGL layer the vertex dots for whatever is being edited, read LIVE off the Leaflet
   * layer so a vertex being dragged carries its dot with it. Empty when not editing.
   *
   * Geoman is left holding real, draggable handles for only the few nearest the cursor (see
   * EDIT_OPTS). Every vertex is still visible, because the dots are drawn here for nothing —
   * which is what makes that limit acceptable now and did not when the handles WERE the display.
   */
  const refreshHandles = (): void => {
    const map = mapRef.current
    const sl = shapeLayer.current
    if (!map || !sl) return
    const fid = selectedRef.current?.id
    if (fid === undefined || toolRef.current !== 'edit') return sl.setHandles([], [])
    const pts: number[][] = []
    const mids: number[][] = []
    // A ring at a time, because the midpoints belong BETWEEN neighbours in one ring — running them
    // over a flattened list would draw a point across the gap from a polygon's last vertex to the
    // next ring's first, which is not an edge at all.
    const ring = (pt: L.LatLng[], closed: boolean): void => {
      const proj = pt.map((ll) => {
        const p = map.project(ll, 0)
        return [p.x, p.y]
      })
      pts.push(...proj)
      const last = closed ? proj.length : proj.length - 1
      for (let i = 0; i < last; i++) {
        const a = proj[i]
        const b = proj[(i + 1) % proj.length]
        mids.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])
      }
    }
    for (const l of allLayers.current.get(fid) ?? []) {
      const geom = (l as L.Polyline).getLatLngs?.()
      if (!geom) continue
      const closed = l instanceof L.Polygon
      const walk = (v: unknown): void => {
        const arr = v as unknown[]
        if (Array.isArray(arr[0])) return void arr.forEach(walk)
        ring(arr as L.LatLng[], closed)
      }
      if (Array.isArray(geom) && geom.length) walk(geom)
    }
    sl.setHandles(pts, mids)
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
            pm?: { enabled?: () => boolean; enable: (o?: object) => void; disable: () => void }
          }
        ).pm
        if (!pm) continue
        const isOn = pm.enabled?.() ?? false
        if (want && !isOn) pm.enable(EDIT_OPTS)
        else if (!want && isOn) pm.disable()
      }
    }
    refreshHandles()
  }

  // Move the edit vertex markers to the selected feature when selection or tool changes
  useEffect(() => {
    drawIntoRef.current = drawInto
  }, [drawInto])
  useEffect(() => {
    selectedRef.current = selected
    syncEditMode()
    // syncEditMode reads only refs; listing it would re-run this on every render instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, tool])

  // The single access point to geoman's draw instance (for the untyped internals, see DrawInstance)
  /**
   * Delete the vertex the cursor is over, if it is over one. Returns false when it is not.
   *
   * The handles are geoman's own markers — invisible (the dots are drawn in WebGL) but real DOM
   * elements, so what is under the cursor is a question only the DOM can answer. Removal then goes
   * through GEOMAN's path rather than cutting the coordinates ourselves: it already validates the
   * minimum vertex count, refreshes its markers and fires pm:update, which is what carries the
   * change into the undo record and the database.
   *
   * They only exist in edit mode, so finding one IS the mode check. And `limitMarkersToCount: 20`
   * keeps the nearest twenty to the cursor — the one under it is always among them.
   */
  const removeVertexUnderCursor = (): boolean => {
    const p = lastPoint.current
    if (!p) return false
    const el = (document.elementFromPoint(p.x, p.y) as HTMLElement | null)?.closest(
      '.leaflet-marker-icon'
    )
    if (!el) return false
    el.dispatchEvent(
      // bubbles: Leaflet resolves the target by walking up from the element to its container.
      new MouseEvent('contextmenu', { bubbles: true, clientX: p.x, clientY: p.y })
    )
    return true
  }

  /**
   * The paint an article is already drawn in ON THIS MAP — what a drawing joining it should look
   * like. Read from this map on purpose: the point is matching what sits next to it, and a drawing
   * on another map is not that. Same geometry kind first; a pin's colour on a polygon would be a
   * strange thing to inherit.
   *
   * One rule, two callers — drawing into an article and linking an existing drawing to one — so
   * the two cannot drift into producing different results for the same intent.
   */
  const lookOf = (entityId: number, want: 'polygon' | 'line' | 'point'): Partial<FeatureStyle> => {
    const kind = (g: string): string =>
      g.includes('"Polygon"') ? 'polygon' : g.includes('"LineString"') ? 'line' : 'point'
    const mine = (worldMapRef.current?.features ?? []).filter((f) => f.entity_id === entityId)
    const src = mine.find((f) => kind(f.geometry) === want) ?? mine[0]
    if (!src) return {}
    const st = JSON.parse(src.style || '{}') as FeatureStyle
    const out: Partial<FeatureStyle> = {}
    // Appearance only. Never `from`/`to`, `text`, `board` or the zoom range: those say WHERE and
    // WHEN a drawing is, not what it looks like, and inheriting them would move it.
    for (const k of ['color', 'fillOpacity', 'weight', 'opacity', 'dash'] as const)
      if (st[k] !== undefined) (out as Record<string, unknown>)[k] = st[k]
    return out
  }

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

  // Pin PREVIEW: the same problem as the label's, and it had no answer. A placed pin is
  // PIN_BASE × size × 2^zoom (updateOverlaySizes); the hint marker is not in the featureGroup, so
  // nothing ever scaled it and it stayed at the zoom-0 size — at any other zoom the preview was a
  // different size from the pin it was previewing, which reads as the size setting not working.
  // Baked into the icon rather than written onto the element: the badge, the free image and the
  // anchor all size themselves from it, so one multiplication covers every branch.
  const hintPinIcon = (scale: number): L.DivIcon => {
    const m = drawRef.current.marker
    return pinDivIcon({ ...m, size: (m.size ?? 1) * scale })
  }
  const styleHintPin = (scale: number): void => {
    drawInst('Marker')?._hintMarker?.setIcon(hintPinIcon(scale))
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
      const scale = 2 ** map.getZoom()
      const icon =
        tl === 'marker'
          ? hintPinIcon(scale)
          : labelDivIcon(s.label, LABEL_BASE * (s.label.size ?? 1))
      if (live) {
        inst?.setOptions?.({ markerStyle: { icon } })
        inst?._hintMarker?.setIcon(icon)
      } else map.pm.enableDraw('Marker', { markerStyle: { icon } })
      if (tl === 'label') styleHintLabel(scale)
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
      logEvent('INFO', 'tool.changed', { tool: 'none', from: t })
      syncEditMode() // when leaving edit, close the selected feature's vertex markers
      return
    }
    logEvent('INFO', 'tool.changed', { tool: t, from: toolRef.current ?? 'none' })
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
  // A stable door into activateTool for the handlers registered once per map — pm:create is bound
  // inside the init effect and would otherwise hold the first render's closure forever. Same
  // useLatest pattern as exportLatest and wheelAdjustRef.
  const activateLatest = useRef(activateTool)
  useEffect(() => {
    activateLatest.current = activateTool
  })
  // Escape leaves the active tool. Needed because Edit/Move are reached from the context menu and
  // no longer have a toolbar button to press again — without this they would be one-way doors.
  // The conquest/measure/nav Escape handlers run first (they own their own sessions), so this one
  // stands down whenever a session is live.
  //
  // With no tool active it closes the inspector instead — ONE key, innermost thing first, which is
  // what Escape means everywhere else. Clicking empty map deliberately does not deselect (a click
  // on the map is how you pan it), so without this the inspector could only be closed by selecting
  // something else or deleting what was in it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!activeRef.current) return
      if (e.key !== 'Escape') return
      if (conquest || measure || nav) return
      const el = e.target as HTMLElement
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return
      if (toolRef.current)
        activateTool(toolRef.current) // same tool = toggle off
      else if (selectedRef.current) clearSel()
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

  // "Glue" labels and pins to the map: screen size = base (map units) × zoom scale. Runs every
  // zoom frame — see the wheel-loop call site.
  //
  // Polygon names used to be PERMANENT Leaflet tooltips, on the theory that Leaflet repositions
  // them on 'zoom' anyway (DivOverlay.getEvents → _updatePosition) so our own font write just
  // had to land first in the same tick. Measured with DevTools on a 16-polygon map: that
  // "free" Leaflet reposition reads container.offsetWidth/offsetHeight inside
  // Tooltip.prototype._setPosition — a forced synchronous layout — for EVERY permanent tooltip,
  // on EVERY animation frame of the app's own wheel-zoom easing loop. That was 65-68% of total
  // frame time (Layout, Chrome's own profiler), not the polygon redraw anyone suspected, and it
  // scales with how many named polygons are on screen — worse on a fuller map, not better.
  // direction:'center' does not avoid it either: Tooltip._setPosition reads tooltipWidth/Height
  // in every direction branch, center included.
  //
  // Polygon names are now `polyLabels` markers — the exact divIcon/textPath mechanism already
  // used for derived region labels and free-text labels (see labelDivIcon), positioned and
  // resized entirely by OUR OWN writes, with no Leaflet-internal read-after-write in the loop.
  // Push the current view into the WebGL label layer and draw one frame. The canvas sits over the
  // map container rather than inside a Leaflet pane, so the origin is the pixel origin corrected
  // by wherever Leaflet has currently parked the map pane. One draw call, whatever the label count.
  const drawLabels = (): void => {
    const map = mapRef.current
    const layer = labelLayer.current
    if (!map || !layer) return
    const zoom = map.getZoom()
    const size = map.getSize()
    // Deliberately NOT map.getPixelOrigin(): Leaflet's _getNewPixelOrigin ends in ._round(), so
    // that value snaps to whole pixels and re-snaps as the zoom eases — which drags the entire
    // label layer back and forth by up to a pixel every frame and reads as the text shaking. It
    // is the same 1px rounding this file already patches out of latLngToLayerPoint (patch 1).
    //
    // Deriving the origin instead keeps it fractional, and the map pane's position cancels out on
    // the way: container = project(ll, zoom) - pixelOrigin + panePos, and pixelOrigin is
    // project(center, zoom) - size/2 + panePos, so the two panePos terms fall away and what is
    // left is exact. getCenter() already accounts for panning, so this stays right while dragging.
    const c = map.project(map.getCenter(), zoom)
    layer.draw(c.x - size.x / 2, c.y - size.y / 2, 2 ** zoom, size.x, size.y)
  }

  /**
   * The base image, drawn on its own canvas.
   *
   * It used to be an `L.imageOverlay`, and that <img> was the single most expensive thing on the
   * map without anyone suspecting it: Leaflet resizes the element at every zoom commit, and a size
   * change makes Chromium DECODE the picture again at the new size. A trace of the first zoom
   * after a pause put 170 ms in `ImageFrameGenerator::decodeAndScale` with the main thread parked
   * in `LayerTreeHost::WaitForCommitCompletion` — on a 4096x4096 png, which is an ordinary size for
   * a world map. It came back on every launch and after every idle spell, because the decoded
   * copies are a cache and the cache gets dropped. `will-change: transform` does not help: what
   * changes is the element's SIZE, not a transform.
   *
   * An ImageBitmap is decoded ONCE and blitted; scaling it is the GPU's business and costs nothing
   * per frame. That is also why this is a plain 2D canvas and not a third Pixi app — one textured
   * quad does not need a renderer.
   *
   * z-index 350 puts it UNDER Leaflet's overlay pane (400), which is where the selected feature
   * and anything being edited still live as real SVG. Drawing it into the shape layer's canvas
   * (450) would have hidden them.
   */
  const drawBase = (ox: number, oy: number, scale: number, w: number, h: number): void => {
    const cv = baseCanvas.current
    if (!cv) return
    const dpr = window.devicePixelRatio || 1
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr)
      cv.height = Math.round(h * dpr)
    }
    const ctx = cv.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    const b = baseImg.current
    if (!b) return
    const x = b.x * scale - ox
    const y = b.y * scale - oy
    const dw = b.w * scale
    const dh = b.h * scale
    // The "lit object on a dark table" the CSS box-shadow used to give it. Concentric strokes
    // rather than ctx.shadowBlur: a 40px blur of a rect this size, on the frame path, is a real
    // cost, and six fading lines are indistinguishable at these opacities.
    for (let i = 6; i >= 1; i--) {
      ctx.strokeStyle = `rgba(0,0,0,${0.06 * (7 - i) * 0.14})`
      ctx.lineWidth = i * 6
      ctx.strokeRect(x - i * 3, y - i * 3 + 8, dw + i * 6, dh + i * 6)
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.09)'
    ctx.lineWidth = 1
    ctx.strokeRect(x - 0.5, y - 0.5, dw + 1, dh + 1)
  }

  /** The same view, handed to the shape layer. Split only because the two canvases are separate. */
  const drawShapes = (ox?: number, oy?: number, sc?: number, w?: number, h?: number): void => {
    const map = mapRef.current
    const sl = shapeLayer.current
    if (!map) return
    if (ox !== undefined) {
      drawBase(ox, oy!, sc!, w!, h!)
      if (!sl) return
      sl.setScale(sc!)
      sl.draw(ox, oy!, sc!, w!, h!)
      return
    }
    const zoom = map.getZoom()
    const size = map.getSize()
    const c = map.project(map.getCenter(), zoom)
    drawBase(c.x - size.x / 2, c.y - size.y / 2, 2 ** zoom, size.x, size.y)
    if (!sl) return
    sl.setScale(2 ** zoom)
    sl.draw(c.x - size.x / 2, c.y - size.y / 2, 2 ** zoom, size.x, size.y)
  }

  const updateOverlaySizes = (): void => {
    const map = mapRef.current
    if (!map || !featureGroupRef.current) return
    const scale = 2 ** map.getZoom()
    // Viewport cull: writing --lz/size is a per-element style write, and the browser's own
    // "Recalculate Style" cost after it scales with how many elements got touched THIS FRAME —
    // measured at ~5ms/123 elements on a fuller map (DevTools, "First invalidated" traced back
    // to this loop). Most of those elements sit off-screen during a zoomed-in pan/zoom, so
    // skipping them is free correctness: a marker that's off-screen doesn't need to look right
    // this frame. Padded so markers don't visibly pop as they cross the edge. The moveend
    // listener below (not a hot path — fires once per pan gesture) catches up anything that
    // panned into view carrying a stale scale from the last time it was on-screen.
    const bounds = map.getBounds().pad(0.25)
    featureGroupRef.current.eachLayer((l) => {
      const fl = l as FeatureLayer
      if (fl.featureId === undefined) return
      const pinEl = (l as unknown as { _icon?: HTMLElement })._icon
      if (!pinEl) return
      const latlng = (l as unknown as Partial<L.Marker>).getLatLng?.()
      if (latlng && !bounds.contains(latlng)) return
      // location pin: scale the badge divIcon by zoom (centre anchor; without recreating the DOM)
      const ms = markerSize.current.get(fl.featureId)
      if (ms !== undefined) {
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
      // Free text label: the text is drawn in WebGL, so all that is sized here is the transparent
      // box that catches clicks and drags. An empty div, so this is a box-model write with no
      // glyphs behind it — the cheap half of what a label used to cost on every frame.
      const hit = labelHit.current.get(fl.featureId)
      if (hit) {
        const w = hit.w * scale
        const h = hit.h * scale
        pinEl.style.width = `${w}px`
        pinEl.style.height = `${h}px`
        pinEl.style.marginLeft = `${-w / 2}px`
        pinEl.style.marginTop = `${-h / 2}px`
      }
    })
    // Polygon name labels and derived region labels need nothing here: they are drawn in WebGL
    // and the whole set follows the zoom from one container matrix (see drawLabels /
    // pixiLabels.ts). Derived labels were the last text on this path — a per-frame write per
    // label, which is exactly what the WebGL move exists to stop doing.
    // Stroke widths (see patch 3): one property on the pane, inherited by every path, instead
    // of a setStyle per feature per frame. Anchored at zoom 0, so a weight of 3 means 3 MAP
    // pixels — the unit the geometry itself is in.
    const pane = map.getPane('overlayPane')
    if (pane) pane.style.setProperty('--mz', String(2 ** map.getZoom()))
    // the open pin/label preview (the hint marker is outside the featureGroup too) — scale it on
    // zoom. Once per zoom commit, not per frame: the gesture itself scales the pane it sits in.
    if (toolRef.current === 'label') styleHintLabel(scale)
    else if (toolRef.current === 'marker') styleHintPin(scale)
  }

  // Delete + undo record; used by geoman's removal mode, the context menu and the Del key.
  // With several ids, ONE undo record (a multi-select delete reverts in one step).
  const removeFeature = async (...fids: number[]): Promise<void> => {
    const all = (await api.getMap(id))?.features ?? []
    const rows = fids.map((fid) => all.find((f) => f.id === fid)).filter((r) => r !== undefined)
    // Every deletion route lands here — the Del key, delete mode, the context menu — so one line
    // here covers all of them. `count` because a multi-select delete is ONE undoable action.
    if (rows.length)
      logEvent('INFO', 'feature.deleted', { count: rows.length, ids: fids.join(',') })
    // One transaction: a multi-select delete is ONE action, and a loop that stopped part-way left
    // some drawings gone with no undo record at all (the record is pushed below, after this).
    await api.deleteFeatures(fids)
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
        label: fids.length > 1 ? 'Delete {n} drawings' : 'Delete drawing',
        params: { n: fids.length },
        undo: recreate,
        // The ids come back different from `recreate`, so this cannot be a single batch call
        // built ahead of time — it reads the refs at the moment it runs.
        redo: async () => api.deleteFeatures(refs.map((r) => r.id))
      })
    }
    clearSel()
    await reloadFeatures('delete')
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
    // One paste is one action, so one transaction: a loop of creates could leave half a
    // clipboard on the map under an undo entry claiming all of it.
    const make = (): Promise<number[]> =>
      api.createFeatures(
        items.map((it) => {
          const g = JSON.parse(it.geometry)
          const style = { ...(JSON.parse(it.style || '{}') as FeatureStyle) }
          if (active) style.board = active
          return {
            map_id: id,
            entity_id: it.entity_id ?? undefined,
            geometry: JSON.stringify({ ...g, coordinates: shiftCoords(g.coordinates, dx, dy) }),
            style: JSON.stringify(style)
          }
        })
      )
    const ref = { ids: await make() }
    pushUndo({
      label: 'Paste {n} drawings',
      params: { n: ref.ids.length },
      undo: async () => api.deleteFeatures(ref.ids),
      redo: async () => {
        ref.ids = await make()
      }
    })
    await reloadFeatures('paste')
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

  /* The colours offered inside the drawing's own context menu. Whatever this world has actually
     been painted with, then the picker's six starters to fill the row — a recolour reachable in
     one gesture is worth nothing if the row is empty in a world nobody has picked a colour in
     yet. Deduped, because the starters are what a first colour is usually picked FROM. */
  const quickColors = async (): Promise<string[]> =>
    [...new Set([...(await getRecentColors()), ...PRESETS])].slice(0, 8)

  /* Recolour ONE drawing — the one that was right-clicked, not the selection.
     Deliberately not `editSelectedStyle`: that reads `selected`/`selIds` out of render scope, and
     this runs from a closure built during reloadFeatures, which would have captured whatever the
     selection was at that reload. Acting on the subject the menu names is also the more honest
     rule; the panel is still where a selection is restyled together. */
  const recolorFeature = async (feat: Feature, color: string): Promise<void> => {
    const orig = feat.style || '{}'
    const next = JSON.stringify({ ...(JSON.parse(orig) as FeatureStyle), color })
    // Written first, pushed second: an undo entry for a write that did not land rewrites a row
    // nothing touched (the rule gate 40 exists for).
    await api.updateFeature(feat.id, { style: next })
    pushUndo({
      label: 'Restyle a drawing',
      undo: async () => api.updateFeature(feat.id, { style: orig }),
      redo: async () => api.updateFeature(feat.id, { style: next })
    })
    await pushRecentColor(color)
    await reloadFeatures('recolor')
  }

  // Border evolution: fork the feature into a copy starting at the slider year and close the
  // old one at year-1. The user then nudges only the changed vertices — no redrawing from scratch.
  const createFeatureFork = async (f: Feature): Promise<void> => {
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
    // ONE transaction. A copy with no closed original is two borders claiming the same land in
    // the same year, which is the state this feature exists to avoid — so the two writes are one.
    const created = await api.createFeatureFork(f.id, newStyle, closedStyle)
    const ref = { id: created.id }
    pushUndo({
      label: 'Change border from {year}',
      params: { year },
      undo: async () => api.deleteFeatureFork(ref.id, f.id, f.style),
      redo: async () => {
        ref.id = (await api.createFeatureFork(f.id, newStyle, closedStyle)).id
      }
    })
    await reloadFeatures('fork')
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
    /*
     * animate:false, and it has to be.
     *
     * Leaflet's animated zoom moves the map by putting a CSS transition on the map PANE and only
     * telling anyone the zoom changed when the transition ends. Everything of ours that draws
     * itself — both WebGL canvases and the base image — sits OVER the panes rather than inside
     * one (see paintZoom), so it inherits nothing from that transform and hears nothing until
     * `zoomend`. For the length of the flight the polygons therefore sat at the old zoom over a
     * map that had already left: they looked like they were hanging in the air, which is what a
     * user reported.
     *
     * The same conflict is why our own wheel zoom exists: the smooth part of it is OUR transform,
     * applied to the pane and the canvases in the same frame. A flight could be routed through
     * that loop as well, and it is the only way to have one — Leaflet's own is unusable here.
     * Until someone wants it enough to write it, a jump is honest and costs nothing.
     */
    map.fitBounds(b.pad(0.4), { maxZoom: 2, animate: false })
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
  /**
   * `why` is not decoration. This is the most expensive thing the renderer does — the whole map is
   * re-read from SQLite and every layer rebuilt — and the log has already caught it running 139
   * times in 11 seconds, and 14 times in 2 seconds after a single polygon was selected. Which of
   * the fourteen callers is responsible is the entire question, and a line saying only how long it
   * took cannot answer it. It also stops unrelated reloads coalescing into one line, and it becomes
   * the trail value: `map.reload(style) ×14`.
   */
  const reloadFeatures = async (why = 'other'): Promise<void> => {
    const gen = ++reloadGen.current
    // The map is unresponsive for as long as this runs — every layer is rebuilt — so it is the one
    // renderer operation whose duration is always worth a line.
    const done = logTime('map.reload', { why })
    const wm = await api.getMap(id)
    // Parent histories, the base set and color/name records fill in EVERY mode: conquest year
    // ticks, rank resolution and the default (root) view all feed from here
    const [h, cfgRaw, modes] = await Promise.all([api.hierarchy(), getHierConfig(), getMapModes()])
    if (gen !== reloadGen.current) return // a newer reload started — this one is stale
    setWorldMap(wm)
    worldMapRef.current = wm
    if (!wm || !featureGroupRef.current) return
    const fg = featureGroupRef.current
    const map = mapRef.current! // set alongside featureGroupRef in the same setup effect
    fg.clearLayers()
    // Polygon labels are not Leaflet layers at all — fg.clearLayers() never saw them. The WebGL
    // layer is refilled at the end of applyYear, which is what decides visibility.
    polySpec.current.clear()
    freeSpec.current.clear()
    labelHit.current.clear()
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
    featRings.current.clear()
    featGeom.current.clear()
    featClick.current.clear()
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
    derivedSpecs.current = []
    dimValue.current.clear()
    derivedSig.current = '' // the geometry summary is about to be rebuilt: force a recompute
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
    // The hierarchy panel's scope. Two sources, and the second is the one that is easy to miss:
    // an entry DRAWN here, plus every entry that RULES land here without a drawing of its own —
    // a duchy whose counties are on this map is exactly what the duchy view paints, so it belongs
    // in the duchy list even though it has no polygon anywhere. That second set is mosaicManaged,
    // which is already "something below points at me", built per map just above.
    // Entities are world data on purpose (a county belongs to its duchy whichever map draws it,
    // which is what lets a chain resolve across maps) — so this scopes the VIEW, not the query.
    {
      const scope = new Set<number>(mosaicManaged.current)
      for (const f of wm.features) if (f.entity_id !== null) scope.add(f.entity_id)
      setMapScope(scope)
    }
    // A parent's own polygon is hidden in a derived view because the mosaic of what lies UNDER it
    // already draws that land, and two images of the same region is the thing the mosaic exists to
    // prevent. When nothing lies under it ON THIS MAP that reasoning inverts: a duchy with no
    // counties yet, a realm drawn before it was carved up, has only its own drawing to stand for
    // the land — and dropping that made the region vanish the moment a filter was pressed while
    // the panel went on listing the entry and its colour. `mosaicManaged` is already exactly
    // "something below points at me", so it answers this question too, per map and across every
    // year for the same reason it is built that way.
    //
    // Ranks only: an untagged drawing is not part of the ladder and stays out of these views
    // exactly as before, so pressing a filter still narrows the map rather than redrawing it.
    const inDerived = (eid: number): boolean =>
      baseSet.current.has(eid) || (entTags.current.has(eid) && !mosaicManaged.current.has(eid))
    // Rank mode: polygons painted by their ancestor at that rank (color resolved in applyYear).
    // Paint mode: polygons colored by fields[dim]; empty values grey.
    let paint: { shows: (eid: number) => boolean; color: Map<number, string> } | null = null
    let rank: { shows: (eid: number) => boolean } | null = null
    const mode = activeModeRef.current
    if (mode?.kind === 'paint') {
      const color = new Map<number, string>()
      for (const e of h.entities) {
        if (!inDerived(e.id)) continue
        const value = (JSON.parse(e.fields || '{}') as Record<string, string>)[mode.key]
        color.set(e.id, value ? (modes.colors[mode.key]?.[value] ?? autoColor(value)) : '#666666')
        if (value) dimValue.current.set(e.id, value) // label text; a valueless (grey) region gets none
      }
      paint = { shows: inDerived, color }
    } else if (mode?.kind === 'rank') {
      rank = { shows: inDerived }
      // Rank targets: entities carrying the displayed tag
      for (const e of h.entities)
        if (e.tags.includes(mode.key)) rungTargets.current.set(e.id, entColors.current.get(e.id)!)
    }
    const chYears = new Set<number>()
    const derived = paint ?? rank // derived modes: base polygons only, no labels
    for (const f of wm.features) {
      const isPolygon = f.geometry.includes('"Polygon"')
      const isLine = f.geometry.includes('"LineString"')
      // Before the mode filter below: what is in the database is a fact about the feature, not
      // about whether this view happens to draw it.
      featGeom.current.set(f.id, f.geometry)
      if (derived && (f.entity_id === null || !derived.shows(f.entity_id) || !isPolygon)) continue
      const style = JSON.parse(f.style || '{}') as FeatureStyle
      // A label has Point geometry like a pin — the discriminator is the text field in style
      const isLabel = !isPolygon && !isLine && style.text !== undefined
      const color = paint
        ? paint.color.get(f.entity_id!)!
        : rank
          ? '#666666' // the rank color is resolved from the parent chain in applyYear
          : (style.color ?? folderColor(folders, f.entity_folder))
      // A polygon's outline is the darker, calmer relative of its fill (see outlineColor). Lines
      // and pins keep exactly what the user picked: there the stroke IS the content.
      const stroke = isPolygon ? outlineColor(color) : color
      const lineOpacity = isLine ? (style.opacity ?? 0.9) : 1
      const dashArray = isLine ? lineDashArray(style.dash, style.weight ?? 3) : ''
      // Fill images only on polygons in their own view (derived modes paint by data)
      const fillColor =
        !derived && isPolygon && style.fillImg ? `url(#${fillPatternId(style.fillImg)})` : color
      const gj = L.geoJSON(JSON.parse(f.geometry), {
        style: {
          color: stroke,
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
        pointToLayer: (_gf, latlng) => {
          if (!isLabel) return L.marker(latlng, { icon: pinDivIcon(style) })
          // The glyphs go to the WebGL layer; what stays here is an empty box to click and drag.
          const size = LABEL_BASE * (style.size ?? 1)
          const text = style.text ?? ''
          const at = map.project(latlng, 0)
          freeSpec.current.set(f.id, {
            id: f.id,
            x: at.x,
            y: at.y,
            text,
            // Straight from a shared world's style JSON into Pixi, which THROWS on a colour
            // string it cannot parse — one bad value would take the label layer, and with it the
            // map, down. Same two checks as the DOM path above.
            color: cssColor(style.color, '#ffffff'),
            font: cssFont(style.font),
            size,
            angle: Number(style.angle) || 0,
            curve: Number(style.curve) || 0,
            halo: style.halo,
            haloWidth: style.haloWidth,
            tracking: style.tracking,
            bold: style.bold,
            italic: style.italic,
            // The declutter range travels WITH the label: the WebGL layer re-checks it every
            // frame, which is the only way it can appear and disappear mid-zoom (refreshZoomVis
            // reaches the Leaflet grab box and nothing else).
            minZoom: style.minZoom,
            maxZoom: style.maxZoom
          })
          // The box that catches clicks, and it has to COVER the glyphs: what it misses falls
          // through to whatever is underneath, which on a region label is the polygon it names —
          // so the click selects the region instead of the label. ~0.62em per letter is the same
          // estimate the text layout uses, plus the letter spacing, which widens the drawn text
          // and would otherwise leave its ends hanging outside the box. A tenth of a size in
          // padding on each axis: the box is invisible, and being slightly generous costs nothing
          // while being slightly short costs the click.
          const trackW = Number(style.tracking) || 0
          labelHit.current.set(f.id, {
            w: Math.max(text.length * size * (0.62 + trackW), size) + size * 0.2,
            h: size * 1.4,
            // Rotated with CSS rather than inflated: an axis-aligned box around angled text covers
            // a lot of map that is not the label, and misses the ends that stick out of it.
            angle: Number(style.angle) || 0
          })
          return L.marker(latlng, {
            icon: L.divIcon({
              className: 'map-label',
              html: '',
              iconSize: [0, 0],
              iconAnchor: [0, 0]
            })
          })
        }
      })
      // Geometry in zoom-0 space, for the WebGL layer to draw and for hit testing to search. Kept
      // here rather than read back off the Leaflet layer because those layers are no longer in the
      // map for polygons and paths — only the selected one ever is.
      if (isPolygon || isLine) {
        const gjc = (JSON.parse(f.geometry) as { coordinates: number[][] | number[][][] })
          .coordinates
        const asRings = (isPolygon ? gjc : [gjc]) as number[][][]
        // A curved path is drawn from the SAME sampled spline the DOM overlay draws: the stored
        // vertices are editable control points, never what is shown. Sampling here rather than in
        // the WebGL layer keeps the curve in one place — and makes the hit test follow the line
        // the user can actually see, which the raw vertices did not.
        const rings =
          isLine && style.curviness
            ? [curvePoints(asRings[0], style.curviness).map((ll) => [ll.lng, ll.lat])]
            : asRings
        featRings.current.set(
          f.id,
          rings.map((ring) =>
            ring.map((pt) => {
              const p = map.project(L.latLng(pt[1], pt[0]), 0)
              return [p.x, p.y]
            })
          )
        )
      }
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
        color: stroke,
        fillColor,
        fillImg: !derived && isPolygon ? style.fillImg : undefined,
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
              const closed = geom.coordinates[0]
              // GeoJSON closes a ring by REPEATING its first vertex, and that duplicate is a real
              // weight in everything below: it drags both the vertex-average centroid and the PCA
              // mean toward one corner, which tilts the label's axis on a shape that should read
              // dead level — measured at -10.9° on a 1.5:1 rectangle and -3.6° on a 3:1. Every
              // ring in the table is closed, so this was every derived label, always in the same
              // direction. The open ring is what the rest of this wants anyway: ringsTouch wraps
              // to close by itself, and ringArea already indexes modulo its length.
              const n = closed.length
              const ring =
                n > 1 && closed[0][0] === closed[n - 1][0] && closed[0][1] === closed[n - 1][1]
                  ? closed.slice(0, -1)
                  : closed
              labelGeo.current.set(f.id, {
                keys: ring.map(([x, y]) => `${Math.round(x / 0.01)}_${Math.round(y / 0.01)}`),
                verts: ring,
                area: ringArea(ring),
                centroid: ringCentroid(ring)
              })
            }
          }
        }
        // Badge scaling ONLY for pins. A label is a Point too, but what it scales is its
        // transparent hit box (the labelHit branch), not a badge.
        if (!isPolygon && !isLabel)
          markerSize.current.set(f.id, {
            size: style.size ?? 1,
            ar: style.img && style.imgFree ? (style.imgAR ?? 1) : undefined
          })
        // No tooltip on a label — its text is already visible
        // hideName: the article's name is not drawn on this polygon. For a shape whose automatic
        // label lands badly — an archipelago, a crescent, anything the centroid falls outside —
        // the answer is a real label placed by hand, not a better guess at where to put this one.
        if (f.entity_name && !derived && !isLabel && !style.hideName) {
          // escapeHtml is REQUIRED (both branches): a string tooltip/label renders via innerHTML
          // — an entity NAMED `<img onerror=…>` in a shared .world would run code with no click.
          if (isPolygon) {
            // A marker, not a bound tooltip — see the note in updateOverlaySizes for why
            // (Leaflet's own tooltip auto-reposition on zoom was the app's single biggest cost).
            // The true area-weighted centroid (ringAreaCentroid, matching what Leaflet's own
            // Polygon.getCenter() would give — NOT getBounds().getCenter(), which drifts off-
            // shape for an irregular coastline like these) computed off the raw ring: the layer
            // is not added to the map yet at this point in the loop, and getCenter() throws
            // until it is.
            const font = cssFont(style.font)
            const b = (layer as L.Polygon).getBounds()
            const base = Math.min(
              200,
              Math.max(8, (b.getEast() - b.getWest()) / Math.max(4, f.entity_name.length))
            )
            const ring = (JSON.parse(f.geometry) as { coordinates: number[][][] }).coordinates[0]
            const [cx, cy] = ringAreaCentroid(ring)
            // Stored in zoom-0 layer space, which is what the WebGL layer draws in — so a zoom
            // moves the whole label set by changing two numbers, not by touching any of them.
            const at = map.project(L.latLng(cy, cx), 0)
            polySpec.current.set(f.id, {
              id: f.id,
              x: at.x,
              y: at.y,
              text: f.entity_name,
              color: '#ffffff',
              font,
              size: base,
              angle: 0,
              curve: 0
            })
          } else {
            layer.bindTooltip(escapeHtml(f.entity_name), { sticky: true })
          }
        }
        const onFeatureClick = (ev: L.LeafletMouseEvent): void => {
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
          logEvent('INFO', 'feature.selected', {
            feature: f.id,
            kind: featKind.current.get(f.id),
            entity: f.entity_id ?? undefined
          })
          setSelected(f)
          setExtraSel([])
        }
        // A shape can be clicked in either of two ways, because it is drawn in either of two
        // places. Normally it lives in the WebGL layer and is not in the map at all, so the
        // map-level listener resolves the hit test and calls what is filed here by id. During an
        // edit session it is a real Leaflet layer again — and then Leaflet finds it first and the
        // map never fires its own click, so the layer has to keep listening for itself too.
        // Wiring only one of the two left every polygon unselectable in edit mode.
        if (isPolygon || isLine) featClick.current.set(f.id, onFeatureClick)
        layer.on('click', onFeatureClick)
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
              // featGeom, NOT f.geometry — see the ref. A single-feature edit does not reload, so
              // the row this closure holds still describes the state before the PREVIOUS edit.
              old: featGeom.current.get(f.id) ?? f.geometry,
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
          // ONE transaction, and the undo entry only after it has committed.
          //
          // Both halves were wrong together. The writes were a loop of independent calls, so a
          // weld that failed on the third of five left the first two applied — the two sides of
          // the same border disagreeing, which is the one thing the weld exists to prevent. And
          // `pushUndo` ran BEFORE them, so a failure left a step in the history that had not
          // happened: Ctrl+Z then rewrote rows nothing had touched.
          const write = (which: 'old' | 'next') => async (): Promise<void> => {
            await api.updateFeatures(
              updates.map((u) => ({ id: u.id, patch: { geometry: u[which] } }))
            )
            // Only after the batch has landed — see featGeom. All of them or none of them now,
            // so this can move as a set instead of per write.
            for (const u of updates) featGeom.current.set(u.id, u[which])
          }
          await write('next')()
          pushUndo({
            label: updates.length > 1 ? 'Move {n} borders' : 'Move a border',
            params: { n: updates.length },
            undo: write('old'),
            redo: write('next')
          })
          if (updates.length > 1) {
            await reloadFeatures('weld') // redraw the welded neighbours (recreates every label too)
          } else {
            // No reload here (see snapshotUpdates), so a moved or reshaped polygon's own label —
            // drawn independently of the layer now, not bound to it — would otherwise sit at its
            // pre-edit position until something else forced a reload.
            const spec = polySpec.current.get(f.id)
            if (spec && isPolygon) {
              const c = (layer as L.Polygon).getCenter()
              const at = map.project(c, 0)
              polySpec.current.set(f.id, { ...spec, x: at.x, y: at.y })
              applyYear(yearRef.current)
            }
            // The same problem for a FREE LABEL, and it was missed: the glyphs are drawn from
            // freeSpec, not from the layer, so dragging one moved its marker and its row in the
            // database while the text stayed where it started — until something else forced a
            // reload. What moves is the grab box; the text has to be told.
            const fs = freeSpec.current.get(f.id)
            if (fs && isLabel) {
              const at = map.project((layer as L.Marker).getLatLng(), 0)
              freeSpec.current.set(f.id, { ...fs, x: at.x, y: at.y })
              applyYear(yearRef.current)
            }
          }
        }
        // Snapshot synchronous, commit on the serial chain — reloads never clobber each other.
        // .catch is mandatory: one rejected commit would poison the chain for good and every
        // later save would silently drop.
        const saveGeometry = (e: { layer: L.Layer }, weld: boolean): void => {
          const updates = snapshotUpdates(e, weld)
          geomSaveChain.current = geomSaveChain.current
            .then(() => commitGeometry(updates))
            .catch((err) => {
              // The catch itself is load-bearing: without it one rejection poisons the chain and
              // every later save is dropped. What it must NOT be is silent. It used to end at
              // console.error, which in a packaged build is nowhere — the Leaflet layer is already
              // sitting at its new position, the database still holds the old one, and nothing on
              // screen says so until the next reload quietly puts the shape back.
              //
              // App's global rejection listener cannot help here: this catch consumes the
              // rejection, which is exactly why it has to report for itself.
              //
              // logCrash, not logEvent: the renderer's Level deliberately has no ERROR — an error
              // is not a batched event here, it ships the queue first and gets the block with the
              // last fifty things the app did, which is what makes "my drag did not save"
              // answerable at all.
              //
              // Ids and a count, never the geometry: the log is meant to be pasted into a message
              // and a ring is thousands of numbers. The message is clipped because it can carry
              // text from the file (a constraint error names columns and values).
              const msg = String(err instanceof Error ? err.message : err).slice(0, 120)
              logCrash('edit.geometry', msg, err instanceof Error ? (err.stack ?? '') : '', {
                feature: f.id,
                features: updates.length
              })
              // Fire and forget, DELIBERATELY not awaited: alertDialog resolves when the user
              // clicks OK, and awaiting it here would hold the save chain open for as long as the
              // dialog is up — the next edit would queue behind a modal. Guarded for the reason
              // gate 38 exists: reporting a fault must never be able to become one.
              try {
                void alertDialog(
                  t('That change to the drawing could not be saved. See the error log.')
                ).catch(() => {})
              } catch {
                /* no dialog host — the log line above is still written */
              }
            })
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
          // The dots are read off the live layer, so a dragged vertex has to redraw them or its
          // own dot stays behind while the handle moves — the one place the split would show.
          refreshHandles()
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
                pm?: { enabled?: () => boolean; disable: () => void; enable: (o?: object) => void }
              }
            ).pm
            if (pm?.enabled?.()) {
              pm.disable()
              pm.enable(EDIT_OPTS)
            }
          }
          dragPartners.current = []
        })
        // Weld applies to vertex editing; not to whole-polygon dragging — a move means
        // "detach from the neighbour", it must not tow the neighbour along.
        layer.on('pm:update', (e) => saveGeometry(e, true))
        // The dots are read off the live layer, so anything that CHANGES the vertex list has to
        // redraw them. Dragging did (above); adding and removing did not — so a deleted vertex
        // left its dot behind and the midpoints either side of it kept pointing at an edge that
        // no longer existed. The shape was right and the handles were not, which is exactly what
        // "it deletes but looks different" was.
        layer.on('pm:vertexremoved pm:vertexadded pm:markerdragend', () => refreshHandles())
        // Live: the glyphs follow the grab box while it is being dragged. Without it the text
        // waits for the drop and teleports — functional, and it looks broken. One node moved by
        // two numbers, no re-measure (see moveLabel).
        layer.on('pm:drag', () => {
          if (!isLabel) return
          const at = map.project((layer as L.Marker).getLatLng(), 0)
          labelLayer.current?.moveLabel(f.id, at.x, at.y)
          drawLabels()
        })
        layer.on('pm:dragend', (e) => saveGeometry(e, false))
        layer.on('contextmenu', async (e: L.LeafletMouseEvent) => {
          e.originalEvent.preventDefault()
          // While a shape is being drawn, right-click belongs to the drawing — it takes back the
          // last vertex, and the map-level handler does that. Leaflet fires this on the layer AND
          // on the map, so without standing down here a right-click over an existing polygon both
          // undid a vertex and opened this menu on top of it. That is the other half of the same
          // bug: whether the undo appeared to work depended on what happened to be under the
          // cursor, and a world is mostly covered in polygons.
          if (toolRef.current === 'polygon' || toolRef.current === 'line') {
            const d = drawInst(toolRef.current === 'line' ? 'Line' : 'Polygon')
            if (d?.enabled?.()) return
          }
          /* Right-clicking a drawing SELECTS it — which is what a file list, a layer panel and
             every canvas app already do, and what half of these items were doing by hand anyway
             (Edit and Move both had to select first). Three things fall out of it: the panel is
             already showing this drawing, so "Show in panel" / "Link to entry…" stopped being an
             item; the Del hint below is TRUE from here; and the menu and the panel can no longer
             disagree about what you are working on.
             Left alone when the drawing is already part of a multi-selection — otherwise
             right-clicking one of five silently dropped the other four. */
          if (!selIdsRef.current.includes(f.id)) setSelected(f)
          const items: MenuEntry[] = []
          if (f.entity_id)
            items.push(
              {
                icon: 'file-text',
                label: t('Open entry'),
                onClick: () => onOpenEntity(f.entity_id!)
              },
              'sep'
            )
          // Edit and Move are MODIFYING actions on an existing drawing, so they live here rather
          // than in the creation toolbar. Both select the feature first: edit mode applies only to
          // the selection (syncEditMode), and the [selected, tool] effect re-syncs once the state
          // lands. setTool, not activateTool — the latter toggles off when handed the current tool.
          items.push(
            {
              icon: 'pencil',
              label: t('Edit shape'),
              onClick: () => (setSelected(f), setTool('edit'))
            },
            {
              icon: 'maximize',
              label: t('Move'),
              onClick: () => (setSelected(f), setTool('drag'))
            },
            'sep',
            {
              icon: 'clock',
              label: t('Change border from this year'),
              onClick: () => createFeatureFork(f)
            },
            {
              icon: 'calendar',
              label: t('Add event to this drawing'),
              onClick: () => setEventDraft({ f, year: yearRef.current })
            },
            'sep',
            {
              icon: 'trash',
              label: t('Delete'),
              hint: 'Del',
              danger: true,
              onClick: () => removeFeature(f.id)
            }
          )
          setMenu({
            x: e.originalEvent.clientX,
            y: e.originalEvent.clientY,
            /* Which of the overlapping things under the cursor this menu caught. On a crowded
               border the county and the duchy are one pixel apart, and the seven commands were
               identical either way — the menu never said whose seven they were. The KIND is on
               the same line because a region and the free label naming it carry the SAME name,
               and that is the one pair nothing else distinguishes. */
            header: {
              name: f.entity_name || style.text || t('Untitled drawing'),
              color: style.color,
              note: isLabel
                ? t('Label')
                : isLine
                  ? t('Path')
                  : isPolygon
                    ? t('Region')
                    : t('Location')
            },
            swatches: { colors: await quickColors(), onPick: (c) => recolorFeature(f, c) },
            items
          })
        })
        fg.addLayer(layer)
      })
    }
    setChangeYears([...chYears].sort((a, b) => a - b))
    applyYear(yearRef.current)
    // The full rebuild recreated the layers → reopen edit on the selected feature's NEW layers
    // (selected only; not global — that was where the lag came from)
    syncEditMode()
    done({ features: wm?.features.length ?? 0 })
  }

  // CK3-style derived region labels (rank/paint): ADJACENT base polygons in the same group
  // (that year's rank owner / paint value) union-find into one component (adjacency = shared
  // vertex grid cell, guaranteed by geoman snapping); each component gets a name label tilted
  // along its long axis (PCA) with a slight arc, font scaled to component width, none when
  // tiny. The labels are not DB features — they are specs handed to the WebGL label layer along
  // with the polygon names, and applyYear owns the one setLabels call that carries both.
  //
  // They were DOM markers until they were the LAST text on the map that still was, which meant
  // updateOverlaySizes wrote a font size per label per frame — the exact cost the WebGL move
  // exists to remove, and it only showed in the two modes that use them. Two footguns went with
  // them: `interactive:false` (a canvas takes no clicks, so conquest clicks fall through by
  // construction) and staying out of the featureGroup to dodge clearLayers churn.
  //
  // They now obey LOD_HIDE_ABOVE like every other name — zoom past the region and its name goes,
  // which is what a map is expected to do and what polygon names already did.
  const rebuildDerivedLabels = (
    year: number,
    rungOwnerAt: (eid: number) => number | null
  ): void => {
    const map = mapRef.current
    const mode = activeModeRef.current
    const clear = (): void => {
      derivedSpecs.current = []
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
    // Unchanged ownership: keep the specs already built. They are handed to setLabels again by
    // the caller either way, so returning early costs nothing and keeps a year tick free.
    if (sig === derivedSig.current) return
    clear()
    derivedSig.current = sig
    const specs: LabelSpec[] = []
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
    // Both the adjacency tolerance and the label size below are FRACTIONS of the open map's own
    // long side, not fixed pixels: numbers tuned against one base image come out wrong the moment
    // a differently-sized one is used. `worldMapRef`, not the `worldMap` state, for the same
    // staleness reason `mode` above reads `activeModeRef` — this function is a fresh closure every
    // render, and the ref is what sees the CURRENT map rather than whichever one it closed over.
    // Falls back to MAX_BASE_PX when there is no base image yet, so this never divides by zero.
    const wmr = worldMapRef.current
    const mapSpan = Math.max(wmr?.width ?? MAX_BASE_PX, wmr?.height ?? MAX_BASE_PX)
    const adjTol = mapSpan * ADJ_FRAC
    // Second pass: neighbours that touch along an edge without sharing a corner (see ringsTouch).
    // Left out, a realm drawn with T-junctions got its name written once per piece instead of once
    // over the whole thing — which is the repeated label, and it is easy to produce by hand because
    // geoman snaps a vertex to an edge just as readily as to a vertex.
    //
    // Two filters keep this cheap, and both matter: pairs already in one component are skipped, so
    // the ordinary case (merged by a shared corner in the pass above) costs a find() and nothing
    // more, and boxes that do not overlap are skipped before any geometry is looked at. Measured on
    // a mode switch: 400 adjacent polygons in one realm, 36-70 ms, indistinguishable from before.
    // ponytail: still O(pairs) within a group, so the slow case is polygons that overlap by box and
    // never touch — 60 mutually overlapping 102-vertex slivers cost 330 ms, contrived (real
    // neighbours touch, and touching merges them out of the loop) and paid on a mode switch rather
    // than per frame. A segment grid is the upgrade if a real map ever finds it.
    const box = new Map<number, [number, number, number, number]>()
    for (const { fid } of items) {
      let x0 = Infinity
      let y0 = Infinity
      let x1 = -Infinity
      let y1 = -Infinity
      for (const [x, y] of labelGeo.current.get(fid)!.verts) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
      box.set(fid, [x0, y0, x1, y1])
    }
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const A = items[i]
        const B = items[j]
        if (A.key !== B.key) continue
        const ra = find(A.fid)
        const rb = find(B.fid)
        if (ra === rb) continue
        const a = box.get(A.fid)!
        const b = box.get(B.fid)!
        if (a[0] - adjTol > b[2] || b[0] - adjTol > a[2]) continue
        if (a[1] - adjTol > b[3] || b[1] - adjTol > a[3]) continue
        if (
          ringsTouch(labelGeo.current.get(A.fid)!.verts, labelGeo.current.get(B.fid)!.verts, adjTol)
        )
          parent.set(ra, rb)
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
      // Spread the text over ~80% of the main axis: labelDivIcon estimates ~0.62em per letter.
      // Cap and floor as FRACTIONS of the map's own span (mapSpan, above), not fixed pixels —
      // fixed numbers tuned against one map's base image drift wrong on a differently-sized one.
      // The fractions were picked against a real 4096px map: 0.045 keeps the cap from engaging
      // until a region is genuinely large (a fixed 300 used to engage around a quarter of the
      // map's width, collapsing most non-trivial regions to one identical size); 0.005 excludes
      // slivers rather than almost nothing, the way the fixed LABEL_MIN=5 effectively did.
      const labelCap = mapSpan * 0.045
      const labelFloor = Math.max(LABEL_MIN, mapSpan * 0.005)
      const base = Math.min(labelCap, (extent * 0.8) / (0.62 * Math.max(4, text.length)))
      if (base < labelFloor) continue // a tiny region gets no label
      // Negative ids: these are not features, and the layer diffs by id — a collision with a real
      // feature's label would make one of the two vanish depending on rebuild order.
      const p = map.project(L.latLng(cy, cx), 0)
      specs.push({
        id: -1 - specs.length,
        x: p.x,
        y: p.y,
        text,
        color: '#ffffff',
        font: 'Cinzel', // labelDivIcon's default, which is what these looked like as DOM
        size: base,
        angle,
        curve: 10
      })
    }
    derivedSpecs.current = specs
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

  const applyYear = (year: number): void => {
    yearRef.current = year
    const fg = featureGroupRef.current
    if (!fg) return
    // The polygon labels this year actually shows, gathered as the gate below decides each
    // feature's fate and handed to the WebGL layer in one go at the end.
    const shownLabels: LabelSpec[] = []
    // Same for the shapes. Whichever feature is selected is left OUT and drawn by Leaflet instead,
    // because geoman edits a real layer with real vertex handles — the "display in Pixi, edit as a
    // Leaflet layer" split. Everything else never enters the DOM at all, which is the point.
    const shownShapes: ShapeSpec[] = []
    const editingId = selectedRef.current?.id ?? null
    // While a TOOL is active, every shape goes back to being a Leaflet layer and the WebGL layer
    // draws nothing.
    //
    // Geoman is why: it only ever sees what is in the map. Drawing and editing snap to other
    // layers' vertices, delete mode listens on the layer itself, drag mode moves it. With the
    // neighbours in WebGL there was nothing to snap to — and the topological weld depends on that
    // snapping (it finds partners by matching coordinates that snapping made identical), as does
    // the adjacency behind derived region labels, so losing it quietly breaks two features that
    // look unrelated to rendering.
    //
    // The trade is deliberate and cheap: every one of these tools is a deliberate, stationary act
    // — you are placing vertices, not flying around the map — so paying the old rendering cost for
    // the length of a session buys back every drawing behaviour exactly as it was, with no second
    // implementation of snapping to get subtly wrong. `scale`/`nav` only measure and pick, so they
    // need no layers and keep the fast path.
    const tl = toolRef.current
    const editSession = tl !== null && tl !== 'scale' && tl !== 'nav'
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
          if (st) st = { ...st, color: outlineColor(c), fillColor: c, fillImg: undefined }
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
        st = { ...st, color: outlineColor(c), fillColor: c, fillImg: undefined }
      }
      // The zoom gate comes last: baseVisible = visibility APART from zoom (refreshZoomVis
      // reads it), then hide when outside the zoom range
      baseVisible.current.set(fid, visible)
      // Free text: the marker below is only the grab handle, so the WebGL layer has to be told
      // separately that this one is on screen — every gate above already applies to it. The zoom
      // range is deliberately NOT one of them: it is carried on the spec and re-checked per frame,
      // because it is the one gate that opens and closes without anything else changing.
      if (visible) {
        const fs = freeSpec.current.get(fid)
        if (fs) shownLabels.push(fs)
      }
      if (!zoomOk(fid)) visible = false
      const arrow = featArrow.current.get(fid)
      // A polygon or path: drawn by the WebGL layer, and kept out of the map entirely unless it is
      // the one being edited. `inDom` is what the gate below now asks instead of `visible`.
      const rings = featRings.current.get(fid)
      const inDom = !rings || editSession || fid === editingId
      if (rings && visible && st && !editSession)
        shownShapes.push({
          id: fid,
          rings,
          closed: kind !== 'line',
          // With a fill image the flat colour is only what shows until it loads, and fillColor is
          // an `url(#…)` there — the outline colour is the closer stand-in.
          fill: kind === 'line' ? null : hexNum(st.fillImg ? st.color : (st.fillColor ?? st.color)),
          fillImg: st.fillImg ? assetUrl(st.fillImg) : undefined,
          fillAlpha: st.fillOpacity ?? 0.25,
          stroke: hexNum(st.color),
          strokeAlpha: st.opacity ?? 1,
          weight: st.weight ?? 2,
          arrow: arrow === 'end',
          selected: selIdsRef.current.includes(fid),
          dash: st.dashArray
            ? String(st.dashArray)
                .split(/[ ,]+/)
                .map(Number)
                .filter((n) => n > 0)
            : []
        })
      for (const l of layers) {
        if (visible && inDom && !fg.hasLayer(l)) {
          fg.addLayer(l)
          // Re-adding the same layer object to the featureGroup does NOT bring geoman's vertex
          // markers back (measured) → refresh manually when edit mode is on. ONLY for the
          // selected feature (not global — that was the source of the lag).
          if (toolRef.current === 'edit' && selectedRef.current?.id === fid)
            (l as unknown as { pm?: { enable: (o?: object) => void } }).pm?.enable(EDIT_OPTS)
        } else if ((!visible || !inDom) && fg.hasLayer(l)) fg.removeLayer(l)
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
        // Polygon name labels: all hidden when the layers panel says so; in the root view the
        // carrier bears the root's name, other base labels stay hidden. A label that is not
        // pushed here is simply not drawn — there is no element to hide.
        if (visible && layersRef.current.label && labelRoot !== -1) {
          const spec = polySpec.current.get(fid)
          if (spec && labelRoot !== null) {
            // The carrier speaks for the whole realm, so it takes the root's name and is sized
            // to it rather than to the piece it happens to sit on.
            const name = entNames.current.get(labelRoot) ?? ''
            const b = (l as L.Polygon).getBounds()
            shownLabels.push({
              ...spec,
              text: name,
              size: Math.min(
                200,
                Math.max(8, (b.getEast() - b.getWest()) / Math.max(4, name.length))
              )
            })
          } else if (spec) shownLabels.push(spec)
        }
      }
    }
    shapeSpecs.current = shownShapes
    shapeLayer.current?.setShapes(shownShapes)
    shapeLayer.current?.setHidden(editingId)
    drawShapes()
    // Derived region labels are built BEFORE the hand-off, because they go out in the same call:
    // one list, one diff, one draw. It clears itself when no mode is active.
    rebuildDerivedLabels(year, rungOwnerAt)
    labelLayer.current?.setLabels(shownLabels.concat(derivedSpecs.current))
    // The estimate above is a placeholder until the glyphs have been laid out; this is the real
    // size. Only free labels have a box to correct — a polygon's name is not clickable.
    //
    // The angle is folded in HERE, as the axis-aligned box around the rotated text, rather than by
    // rotating the element: `transform` is the property Leaflet's drag writes, and two writers on
    // one property is why dragging a label stopped working and left it in the wrong place.
    // Everything is derived from the measurement each time, never from the previous value — a
    // padding added to its own result creeps upward every time this runs.
    for (const [fid, hit] of labelHit.current) {
      const m = labelLayer.current?.extentOf(fid)
      if (!m) continue
      const pad = m.h * 0.15
      const w = m.w + pad
      const h = m.h + pad
      const a = (hit.angle * Math.PI) / 180
      const cos = Math.abs(Math.cos(a))
      const sin = Math.abs(Math.sin(a))
      labelHit.current.set(fid, {
        ...hit,
        w: w * cos + h * sin,
        h: w * sin + h * cos
      })
    }
    drawLabels()
    // The selected feature's Leaflet layer is added and removed BY this function now, so geoman
    // has to be pointed at it afterwards — enabling edit mode before the layer exists leaves a
    // polygon you can select but whose vertex handles never appear.
    syncEditMode()
    updateOverlaySizes() // re-added label/pin sizes settle onto the current zoom
    markSelection() // layers were rebuilt → rewrite the selection highlight
  }

  // Refresh the highlight when the selection changes (ref + DOM class). No applyYear call —
  // the highlight is a class now, not a style, so the layers need no touching.
  useEffect(() => {
    selIdsRef.current = selIds
    // Selection and the active tool now change what is DRAWN WHERE, not just how it looks. The
    // selected shape leaves the WebGL list and becomes a real Leaflet layer so geoman has vertex
    // handles, and an active tool hands ALL of them back to Leaflet so geoman can snap between
    // them. Both are applyYear's decision, so it has to re-run — markSelection() alone left the
    // selected feature with no layer at all, which is why editing did nothing.
    applyYear(yearRef.current)
    markSelection()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selIds.join(','), tool])

  // Load the layers panel from settings (PER MAP, persisted); toggles apply instantly, DB-free.
  // Per map because the kinds themselves are: a city plan has no realm polygons to hide, so the
  // toggles set there used to follow you back to the continent and hide things you had not hidden.
  useEffect(() => {
    perMapRaw('mapLayers').then((whole) => {
      // The value before this key was per map is one flat set of toggles, which is why the filter
      // is on the VALUE being a boolean: it recognises the old shape, ignores the new shape's
      // per-map objects when this map has no entry of its own, and drops anything a shared world
      // put there that is neither.
      const stored = asObject<Record<string, unknown>>(perMapEntry<object>(whole, id) ?? whole, {})
      const on = Object.fromEntries(
        Object.entries(stored).filter(([, x]) => typeof x === 'boolean')
      ) as Partial<typeof layersOn>
      if (!Object.keys(on).length) return
      const v = { ...layersRef.current, ...on }
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
    savePerMap('mapLayers', id, v)
    applyYear(yearRef.current)
  }

  // Map switching: create a new map (name from the inline form) → refresh App + go there
  const createMap = async (name: string): Promise<void> => {
    if (!name.trim()) return
    const { id: newId } = await api.createMap({
      name: name.trim(),
      ...(newMapInside ? { parent_map_id: id } : {})
    })
    setNewMapName(null)
    onChanged()
    onNavigate(newId)
  }

  /**
   * Every map at or below this one. The cycle guard: a map may not be moved under its own
   * descendant, or the breadcrumb chain — which walks parents upward — never terminates.
   */
  const subtreeOf = (rootId: number): Set<number> => {
    const out = new Set([rootId])
    let grew = true
    while (grew) {
      grew = false
      for (const m of maps)
        if (m.parent_map_id !== null && out.has(m.parent_map_id) && !out.has(m.id)) {
          out.add(m.id)
          grew = true
        }
    }
    return out
  }

  /** Stop offering a base image for this map. A list of map ids in one setting rather than a flag
   *  per map: it is the same shape `mapScales` and `mapBoards` already use. */
  const dismissMapHint = async (): Promise<void> => {
    setHintOff(true)
    const raw = await api.getSetting('hideMapHint')
    const list = new Set(settingArray<number>(raw))
    list.add(id)
    await api.setSetting('hideMapHint', JSON.stringify([...list]))
  }

  /** Pick the map's base image. Lifted out of the button it used to live inside when that button
   *  moved from the toolbar to the centre of an empty map. */
  const pickBaseImage = async (): Promise<void> => {
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
      await reloadFeatures('image')
    }
    img.onerror = () =>
      alertDialog(t('Could not load image. The file may be corrupt or in an unsupported format.'))
    img.src = assetUrl(path)
  }

  /** One row of the map tree. Extracted from the old inline list so the tree walk can recurse. */
  const mapRow = (m: MapRow, depth: number, hasKids: boolean, shut: boolean): React.JSX.Element => {
    const pad = 8 + depth * 14
    if (editMapId === m.id)
      // Inline rename (uncontrolled + onBlur — updateMap+refresh per keystroke used to flicker)
      return (
        <div className="base-row" style={{ paddingLeft: pad }}>
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
      )
    return (
      <div
        className="layers-row"
        style={{ paddingLeft: pad }}
        onClick={() => m.id !== id && onNavigate(m.id)}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          // Where this map may go. Its own subtree is excluded: a map under its own descendant
          // makes the breadcrumb walk upward forever, and the guard belongs here — at the only
          // place that can create the cycle — rather than in the walk that would hang.
          const banned = subtreeOf(m.id)
          setMenu({
            x: e.clientX,
            y: e.clientY,
            // Every row below says "Move under …", so without this the menu never names the map
            // being moved — and the row it was opened from is behind the menu by then.
            header: { name: m.name, note: t('Move to') },
            items: [
              ...(m.parent_map_id !== null
                ? [
                    {
                      icon: 'arrow-up-right' as const,
                      label: t('Move to the top level'),
                      onClick: () => moveMapUnder(m.id, null)
                    },
                    'sep' as const
                  ]
                : []),
              ...maps
                .filter((x) => !banned.has(x.id) && x.id !== m.parent_map_id)
                .map((x) => ({
                  icon: 'map' as const,
                  label: t('Move under "{name}"', { name: x.name }),
                  onClick: () => moveMapUnder(m.id, x.id)
                }))
            ]
          })
        }}
      >
        {/* The twisty sits in the icon's place for a parent, so rows stay aligned either way. */}
        <span
          className="layers-icon"
          onClick={(e) => {
            if (!hasKids) return
            e.stopPropagation() // opening a branch is not opening the map
            setCollapsedMaps((c) => {
              const n = new Set(c)
              if (!n.delete(m.id)) n.add(m.id)
              return n
            })
          }}
          style={hasKids ? { cursor: 'pointer' } : undefined}
        >
          <Icon name={hasKids ? (shut ? 'chevron-right' : 'chevron-down') : 'map'} size={14} />
        </span>
        <span
          className="layers-name"
          style={m.id === id ? { color: 'var(--accent)', fontWeight: 600 } : undefined}
        >
          {m.name}
        </span>
        <button
          className="mini map-row-btn"
          title={t('Rename')}
          onClick={(e) => (e.stopPropagation(), setEditMapId(m.id))}
        >
          <Icon name="pencil" size={12} />
        </button>
        {m.id !== id && (
          <button
            className="mini danger map-row-btn"
            title={t('Remove')}
            aria-label={t('Remove')}
            onClick={(e) => (e.stopPropagation(), deleteMapWithUndo(m.id))}
          >
            <Icon name="trash" size={12} />
          </button>
        )}
      </div>
    )
  }

  /**
   * The map list as a TREE: children under their parent, one level of indent each.
   *
   * It was a flat list in insertion order with a single 26px indent for anything that had a
   * parent — so a child sat wherever it happened to be created and a grandchild looked like a
   * sibling of its own parent. `parent_map_id` existed the whole time; nothing rendered it.
   *
   * A map whose parent has been deleted comes back to the top rather than disappearing with it —
   * the same rule boards use for an orphaned id, and for the same reason: a dangling reference
   * must never be able to hide the user's work.
   */
  const mapTree = (parent: number | null, depth: number): React.JSX.Element[] => {
    const known = (pid: number | null): boolean => pid !== null && maps.some((m) => m.id === pid)
    const rows = maps.filter((m) =>
      parent === null ? !known(m.parent_map_id) : m.parent_map_id === parent
    )
    return rows.flatMap((m) => {
      const kids = maps.filter((x) => x.parent_map_id === m.id)
      const shut = collapsedMaps.has(m.id)
      return [
        <div key={m.id}>{mapRow(m, depth, kids.length > 0, shut)}</div>,
        ...(shut ? [] : mapTree(m.id, depth + 1))
      ]
    })
  }

  /** Re-parent a map. Right-click a row rather than a permanent control per row: with a dozen
   *  maps a select on every line is more clutter than the operation is worth. */
  const moveMapUnder = (mapId: number, parent: number | null): void => {
    void api.updateMap(mapId, { parent_map_id: parent }).then(onChanged)
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
    await api.deleteMap(mapId)
    // The map's scale, boards, year, travel modes and layer toggles go with it — see
    // takeMapSettings for why leaving them behind is a data bug and not untidiness. AFTER the
    // delete: a refused delete must not strip the settings off a map that is still there.
    const savedSettings = await takeMapSettings(mapId)
    // After the write, not before it: a failed delete must not leave a step in the history for
    // something that did not happen (the rule the batch methods in db.ts already follow).
    pushUndo({
      label: 'Delete map "{name}"',
      params: { name: mapRow.name },
      undo: () =>
        api
          .restoreMap(mapRow, feats, childIds)
          .then(() => restoreMapSettings(mapId, savedSettings))
          .then(onChanged),
      // The id comes back the same (restoreMap writes it), so the settings are the same ones to
      // lift again; the snapshot above stays the one undo replays.
      redo: () =>
        api
          .deleteMap(mapId)
          .then(() => takeMapSettings(mapId))
          .then(() => onChanged())
    })
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
            (l as unknown as { pm?: { enable: (o?: object) => void } }).pm?.enable(EDIT_OPTS)
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
      // The most important guard of the six: this one runs in the CAPTURE phase and
      // calls stopImmediatePropagation, so left live it would eat App's Del on the
      // entity list and delete a drawing instead.
      if (!activeRef.current) return
      const target = e.target as HTMLElement
      const typing =
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
      if (typing) return
      const has = selIdsRef.current.length > 0
      // Same guard as App's, and it crashed here first: this listener is in the capture phase, so
      // an event without a `key` took out BOTH handlers — the identical message is why the error
      // report only showed one of them.
      const k = (e.key ?? '').toLowerCase()
      if ((e.key === 'Delete' || e.key === 'Backspace') && has) {
        e.preventDefault()
        // A vertex under the cursor takes the key first: deleting one point is the smaller,
        // likelier intent, and losing the whole border to a misplaced Del is expensive.
        if (removeVertexUnderCursor()) {
          e.stopImmediatePropagation()
          return
        }
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
      if (!activeRef.current) return
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
      if (!activeRef.current) return
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
      if (!activeRef.current) return
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
    // One transaction, and the undo entry after it — the same two corrections commitGeometry
    // needed. A conquest that stopped part-way used to leave some realms taken and some not,
    // under a single history step claiming all of them.
    const write = (which: 'old' | 'next') => (): Promise<void> =>
      api.updateEntities(updates.map((u) => ({ id: u.id, patch: { fields: u[which] } })))
    await write('next')()
    pushUndo({
      label: 'Conquest in {year}',
      params: { year },
      undo: write('old'),
      redo: write('next')
    })
    onChanged()
    await reloadFeatures('conquest')
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
      // Left-double-click is a DRAWING gesture here — it is how geoman finishes a polygon — and
      // Leaflet's stock meaning for it (zoom in one whole step, animated) collided with that: a
      // double click that missed a shape jumped the map. Zoom is the wheel, and only the wheel.
      doubleClickZoom: false,
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
    // tooltips: silence geoman's "Click to place marker" hints.
    // continueDrawing: a tool stays armed after a shape is finished, so a row of pins or a
    // handful of labels is one tool press instead of one per drawing. It is geoman that ends
    // the session on completion, so dropping our own tool reset is not enough — this is what
    // re-arms it. Escape leaves the tool (see the Escape effect), which is the way out.
    map.pm.setGlobalOptions({ tooltips: false, continueDrawing: true })

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
    // Panning is throttled to the FRAME, not the mouse. A mouse reports at 125-1000 Hz while the
    // screen draws at 60, and every panBy(animate:false) fires a synchronous moveend, which is
    // Leaflet's full Renderer._update — re-clip and re-path every polygon. Driving that straight
    // off mousemove meant doing a whole frame's rendering work several times per frame and
    // throwing most of it away: measured 6407 mousemove dispatches costing 10.1 s of main-thread
    // time in a 112 s recording. Deltas accumulate and are applied once per rAF (panBy is a
    // relative translation, so summing them is exact, not an approximation).
    let panDx = 0
    let panDy = 0
    let panRaf: number | null = null
    /**
     * Trim a pan to what the world's edge actually allows, BEFORE asking for it.
     *
     * Handing Leaflet an offset that runs past maxBounds does not simply get refused — it
     * shimmers. Leaflet corrects by projecting the requested centre, offsetting it and
     * unprojecting again, and that round trip lands on a slightly different sub-pixel every time,
     * so a blocked drag vibrates by a fraction of a pixel each frame instead of sitting still.
     * Measured: 828 px requested, 153 px delivered, and every remaining step reading
     * ask(-20,-1) got(0.5,0.1), ask(-30,0) got(-0.3,0.0) — noise, not movement.
     *
     * Clamping the request instead means Leaflet's correction never has to run. It is also
     * stateless, which the first attempt at this was not: tracking which axis had "hit the edge"
     * needed a rule for when to let go again, and every version of that rule left the drag stuck
     * against one side or the other.
     */
    const allowedPan = (dx: number, dy: number): [number, number] => {
      const mb = map.options.maxBounds
        ? L.latLngBounds(map.options.maxBounds as L.LatLngBoundsLiteral)
        : null
      if (!mb) return [dx, dy]
      const z = map.getZoom()
      const half = map.getSize().divideBy(2)
      const c = map.project(map.getCenter(), z)
      // Two opposite corners are enough: this projection only scales and flips, so the box stays
      // axis-aligned — but which corner lands on which side depends on the flip, hence min/max.
      const p1 = map.project(mb.getNorthWest(), z)
      const p2 = map.project(mb.getSouthEast(), z)
      const fit = (v: number, lo: number, hi: number, viewLo: number, viewHi: number): number => {
        const room0 = lo - viewLo // most negative offset the edge allows
        const room1 = hi - viewHi // most positive
        // Bounds narrower than the view: no offset satisfies both edges, so do not move at all
        // rather than let Leaflet resolve it by yanking the map back to centre.
        if (room0 > room1) return 0
        return Math.max(room0, Math.min(room1, v))
      }
      return [
        fit(dx, Math.min(p1.x, p2.x), Math.max(p1.x, p2.x), c.x - half.x, c.x + half.x),
        fit(dy, Math.min(p1.y, p2.y), Math.max(p1.y, p2.y), c.y - half.y, c.y + half.y)
      ]
    }

    const panStep = (): void => {
      panRaf = null
      const [dx, dy] = allowedPan(panDx, panDy)
      panDx = 0
      panDy = 0
      if (dx === 0 && dy === 0) return
      map.panBy([dx, dy], { animate: false })
    }
    const onMove = (e: MouseEvent): void => {
      if (!panning) return
      panDx += last[0] - e.clientX
      panDy += last[1] - e.clientY
      last = [e.clientX, e.clientY]
      if (panRaf === null) panRaf = requestAnimationFrame(panStep)
    }
    const onUp = (): void => {
      if (!panning) return
      panning = false
      // Flush whatever the last frame did not get to, so the map lands exactly where the cursor
      // left it rather than a few pixels behind.
      if (panRaf !== null) cancelAnimationFrame(panRaf)
      panStep()
      // Catch up culled markers that panned into view. NOT map.on('moveend'): panBy runs with
      // animate:false, so Leaflet fires a full synchronous moveend on EVERY pan step (not once
      // per gesture) — hooking moveend directly reran the (real, ~5ms) style-recalc cost
      // throughout the drag instead of once at release.
      updateOverlaySizes()
    }
    // Continuous/SMOOTH wheel zoom: each tick adds to a TARGET zoom and a rAF loop eases the
    // current zoom toward it. Every frame animate:false setZoomAround → 'zoom' event → labels/
    // pins scale synchronously per frame (Leaflet's own animation does not, hence manual).
    // Previously it jumped to the target INSTANTLY → ~0.15 leap per wheel tick = stepped feel.
    // ponytail: 0.0015 sensitivity, 0.2 ease — single numbers to tune if it feels fast/slow/harsh.
    // wheelZooming: while the rAF runs, the 'zoom' event does DOM only (label/pin scaling) and
    // React state (HUD/scale bar) is not updated per frame — 60fps React re-renders (Timeline/
    // panel) would stutter. React state updates once when the zoom settles (below).
    // THE EASE IS A CSS TRANSFORM, NOT SIXTY REAL ZOOMS.
    //
    // `setZoomAround(..., {animate:false})` goes through Map._resetView, which fires `viewreset` —
    // Leaflet's FULL rebuild: every polygon reprojected, every `d` rewritten, the layer restyled
    // and repainted. Calling that once per animation frame was, measured on a realistic map, 425
    // ms/s inside this callback alone (2.6 ms every frame) plus the ~420 ms/s of Paint, Style,
    // Layerize, Layout and Commit it triggers — together nearly all of the main thread's 983 ms/s.
    //
    // Leaflet's own renderer already separates the two:
    //     zoom      -> _onZoom  -> _updateTransform   (a CSS transform, nothing else)
    //     viewreset -> _reset   -> _update            (the full rebuild)
    // which is why its native zoom animation transforms during the gesture and rebuilds at the end.
    //
    // This was tried once before and was much WORSE, for a reason that no longer applies: scaling
    // the pane makes the browser re-rasterise the content inside it, and back then the labels were
    // DOM elements costing 920 ms/s of rasterisation. They are drawn in WebGL now and the whole
    // layer rasterises at 37 ms/s, so there is nothing expensive left inside the pane to re-raster.
    //
    // COMMIT_SPAN bounds how far the view can drift from its last real rebuild, so the softness of
    // a stretched rasterisation never exceeds ~27 % of a size step however long a scroll runs.
    const COMMIT_SPAN = 0.35
    let wheelTarget: number | null = null
    let wheelRaf: number | null = null
    let wheelZooming = false
    // The zoom being DISPLAYED. map.getZoom() is the last committed one and lags behind for the
    // length of the ease; the gap between them is exactly what the pane transform is showing.
    let wheelShown: number | null = null
    // Frozen per baseline rather than tracking the live cursor: the transform is absolute against
    // its baseline, so moving the anchor underneath would slide the map sideways.
    let wheelAnchor: L.Point | null = null

    /** Show `z` without telling Leaflet: one composited transform, plus the WebGL labels. */
    const paintZoom = (z: number): void => {
      const zc = map.getZoom()
      const s = map.getZoomScale(z, zc)
      const p = wheelAnchor!
      const pane = map.getPanes().mapPane
      // Leaflet parks the pane with its own translate and remembers it in _leaflet_pos, which we
      // never touch — so this composes on top and Leaflet's bookkeeping stays true.
      const pos = L.DomUtil.getPosition(pane) ?? new L.Point(0, 0)
      const t = p.add(pos.subtract(p).multiplyBy(s))
      pane.style.transformOrigin = '0 0'
      pane.style.transform = `translate3d(${t.x}px,${t.y}px,0) scale(${s})`
      // The label canvas sits OVER the panes, not inside one, so it inherits none of that. Driving
      // it with the same eased zoom keeps the two in lockstep — and costs one draw call, because
      // Pixi never cared what Leaflet thinks the zoom is.
      // BOTH WebGL canvases sit over the panes rather than inside one, so neither inherits that
      // transform and both have to be driven here. Missing one is not subtle: the shapes stayed
      // at the committed zoom while everything around them scaled, and the map looked like it had
      // come unstuck from itself.
      const size = map.getSize()
      const c = map.project(map.getCenter(), zc)
      const ox = s * (c.x - size.x / 2 + p.x) - p.x
      const oy = s * (c.y - size.y / 2 + p.y) - p.y
      labelLayer.current?.draw(ox, oy, 2 ** z, size.x, size.y)
      drawShapes(ox, oy, 2 ** z, size.x, size.y)
    }

    /** Drop the visual transform and make `z` real — the one full rebuild per gesture. */
    const commitZoom = (z: number): void => {
      const pane = map.getPanes().mapPane
      pane.style.transformOrigin = ''
      L.DomUtil.setPosition(pane, L.DomUtil.getPosition(pane) ?? new L.Point(0, 0))
      map.setZoomAround(wheelAnchor!, z, { animate: false })
    }

    const wheelStep = (): void => {
      if (wheelTarget === null) {
        wheelRaf = null
        return
      }
      // The frame counter, and the ONLY logging call allowed on a per-frame path: an integer
      // increment, no allocation, no queue. Frame rate is measured from the frames the map was
      // already drawing rather than from a loop of our own, because a permanent
      // requestAnimationFrame would undo the on-demand rendering everything here is built on.
      frame()
      const cur = wheelShown ?? map.getZoom()
      const diff = wheelTarget - cur
      if (Math.abs(diff) < 0.004) {
        commitZoom(wheelTarget)
        wheelTarget = null
        wheelShown = null
        wheelRaf = null
        wheelZooming = false
        showHud(map.getZoom()) // on settle, one React update for HUD + scale bar
        setBarZoom(map.getZoom())
        // Almost always a no-op: onWheel already built the textures for this zoom. It stays as
        // the backstop for the paths that reach a zoom without a wheel gesture.
        labelLayer.current?.setResolution(2 ** map.getZoom())
        drawLabels()
        // The gesture is over, which is the only moment its frame rate means anything. Silent
        // unless it was genuinely poor for long enough to matter (see log.ts).
        endFrames('zoom')
        // One line per GESTURE, never per frame — and DEBUG even then. At INFO this was 60 of the
        // first real session's 110 lines and buried everything else: on this map zooming is not an
        // action a user takes occasionally, it is how they look at anything. It is exactly the
        // "continuous render updates" the log is not supposed to contain, arriving one settle at a
        // time instead of one frame at a time. Detailed logging is where it belongs, and it is the
        // first thing that switch actually turns on. Cost: with the switch off, main no longer
        // knows the zoom for an error report's context — a renderer error still carries its own.
        logEvent('DEBUG', 'map.zoomed', { zoom: map.getZoom().toFixed(2) })
        return
      }
      const z = cur + diff * 0.2
      wheelShown = z
      // Re-baseline before the GPU has to stretch the last rasterisation too far.
      if (Math.abs(z - map.getZoom()) > COMMIT_SPAN) commitZoom(z)
      else paintZoom(z)
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
      // Build the label textures for where the zoom is GOING, not where it is. Sizing them to the
      // current zoom means every frame of a zoom-in displays them larger than they were drawn —
      // magnifying a texture, which is exactly what looks blurry. Taking the larger of the two
      // ends instead means the gesture only ever shrinks them, and minification stays sharp.
      // One rebuild per gesture, at the start, rather than a chase.
      labelLayer.current?.setResolution(2 ** Math.max(map.getZoom(), wheelTarget))
      // NOT map.mouseEventToContainerPoint(e): that calls Leaflet's DomUtil.getScale(container),
      // which reads container.getBoundingClientRect() — a forced synchronous layout, EVERY wheel
      // DOM event (a continuous scroll can fire dozens/sec, each one landing right after this
      // same loop's own style writes from updateOverlaySizes, so the read can't be satisfied from
      // a cached layout — DevTools' "Forced reflow" Insight named exactly this stack). The host
      // never has a CSS transform/zoom applied, so container scale is always 1:1 — a plain
      // offset against the cached rect (kept fresh by the ResizeObserver above) is equivalent.
      const r = hostRectRef.current ?? host.getBoundingClientRect()
      wheelZooming = true
      // Only the first tick of a gesture sets the anchor — see wheelAnchor for why it is frozen.
      if (wheelRaf === null) {
        wheelAnchor = L.point(e.clientX - r.left, e.clientY - r.top)
        wheelRaf = requestAnimationFrame(wheelStep)
      }
    }
    host.addEventListener('mousedown', onDown)
    host.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    // The WebGL label canvas. Deliberately NOT a Leaflet pane: panes are transformed by Leaflet
    // on every zoom and pan, and the whole point here is that the layer positions itself from two
    // numbers instead of being moved around. z-index sits above the marker pane (600) and below
    // the controls (800). pointer-events stays off so a canvas never swallows a click meant for
    // the map: a label is clicked through its own transparent Leaflet marker, a shape through the
    // map-level hit test over `shapeSpecs`.
    // Shapes get their own canvas UNDER the markers, labels theirs above. One canvas cannot do
    // both: Leaflet stacks its panes by z-index (overlay 400, markers 600) and regions have to sit
    // below the pins while names sit above them, so the two WebGL layers straddle the marker pane.
    // The base image's canvas, BELOW Leaflet's overlay pane (400) — the selected feature and
    // anything under geoman are still real SVG in there and must stay visible over the map.
    const bc = document.createElement('canvas')
    bc.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;z-index:350;pointer-events:none'
    host.appendChild(bc)
    baseCanvas.current = bc

    // 350, not 450. The base image lives in this canvas now and must stay UNDER
    // Leaflet's overlay pane (400), where the selected feature and anything under geoman are
    // still real SVG. The WebGL shapes go under it too, which is the right way round: the thing
    // being edited belongs on top.
    const sc = document.createElement('canvas')
    sc.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;z-index:350;pointer-events:none'
    host.appendChild(sc)
    // A fill image arrives after the frame that asked for it, so the layer says when to redraw.
    const shapes = new ShapeLayer(sc, () => drawShapes())
    shapeLayer.current = shapes
    shapes.ready
      .then(() => applyYear(yearRef.current))
      .catch(() => {
        shapeLayer.current = null
        sc.remove()
      })

    const lc = document.createElement('canvas')
    lc.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;z-index:650;pointer-events:none'
    host.appendChild(lc)
    const layer = new LabelLayer(lc)
    labelLayer.current = layer
    // WebGL can fail to come up (a driver blacklist, a headless session). Say so once and carry
    // on: the map still works, it just has no name labels.
    layer.ready
      .then(() => drawLabels())
      .catch((err) => {
        labelLayer.current = null
        lc.remove()
        logCrash('MapView.labelLayer', String(err?.message ?? err), String(err?.stack ?? ''), {
          detail: 'WebGL label layer failed to start; map labels are off'
        })
      })
    map.on('move', () => {
      drawLabels()
      drawShapes()
    })

    const fg = new L.FeatureGroup()
    featureGroupRef.current = fg
    map.addLayer(fg)

    // The Ctrl+V paste target: the cursor's last map position (never enters React state —
    // every move would re-render; read only at paste time)
    map.on('mousemove', (e: L.LeafletMouseEvent) => {
      lastMouse.current = e.latlng
      lastPoint.current = { x: e.originalEvent.clientX, y: e.originalEvent.clientY }
    })

    map.on('zoom zoomend', () => {
      refreshZoomVis() // toggle zoom-limited pins/labels for the current zoom (before sizing)
      updateOverlaySizes() // DOM: every frame (smooth zoom) — labels/pins scale in sync
      // React state (HUD + scale bar) immediately only OUTSIDE wheel zoom; on wheel, at settle (above)
      if (!wheelZooming) {
        showHud(map.getZoom())
        setBarZoom(map.getZoom())
        // Re-rasterise glyphs for the zoom we landed on. Only once the movement is over: doing it
        // per frame is precisely the cost the WebGL layer exists to avoid.
        labelLayer.current?.setResolution(2 ** map.getZoom())
        drawLabels()
      }
    })
    // updateOverlaySizes now culls to the viewport (see its own comment) — a marker panned into
    // view may carry a stale --lz/size from the last time IT was on-screen. The catch-up call
    // for middle-mouse panning lives in onUp below (map.on('moveend') fires on every mousemove
    // tick of that drag, not once per gesture — see onUp's comment for why).

    // Measure session clicks: calib switches to the form at 2 points; dist/area accumulate points
    // Polygons and paths left the DOM, so Leaflet no longer routes clicks to them. This does it
    // instead: hit test the shapes the WebGL layer is currently drawing, then call that feature's
    // own handler — the same closure that used to be bound to its layer, so selection, conquest
    // picking and navigation behave exactly as before.
    //
    // Runs before the measure handler below and stops there if it hit something, matching the old
    // order: a click on a shape was consumed by the shape, and only empty map fell through.
    map.on('click', (e: L.LeafletMouseEvent) => {
      if (measureRef.current) return // a measure session wants the raw map click
      const specs = shapeSpecs.current
      if (!specs.length) return
      const p = map.project(e.latlng, 0)
      // Alt+click: cycle down through everything stacked at this point instead of only the
      // topmost. `order` is topmost-first, the same order shapeAt already resolves — cached on
      // the FIRST click at a point so a repeat click here steps through it instead of
      // recomputing "topmost only" again. Starts at index 1 (one below the top), not 0, since a
      // plain click already reaches the top — so the first Alt+click is immediately useful.
      if (e.originalEvent?.altKey) {
        const tol = 8 / 2 ** map.getZoom()
        const c = cycleRef.current
        const same = c && Math.hypot(c.x - p.x, c.y - p.y) < tol
        const order = same ? c!.order : shapeAllAt(specs, p.x, p.y)
        if (!order.length) return
        const idx = same ? (c!.idx + 1) % order.length : order.length > 1 ? 1 : 0
        cycleRef.current = { x: p.x, y: p.y, order, idx }
        featClick.current.get(order[idx])?.(e)
        return
      }
      cycleRef.current = null // a plain click elsewhere starts the next Alt+click cycle fresh
      // Paths are picked by proximity, and the tolerance has to be in the same zoom-0 space the
      // geometry is in — a fixed number of screen pixels divided by the current scale.
      const fid = shapeAt(specs, p.x, p.y) ?? pathAt(specs, p.x, p.y, 8 / 2 ** map.getZoom())
      if (fid === null) return
      featClick.current.get(fid)?.(e)
    })

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
      const el = e.originalEvent.target as HTMLElement
      // WHILE DRAWING it takes back the last vertex instead of opening the menu — the thing you
      // want the instant you misplace a point, and the button every drawing tool has.
      //
      // It keeps the old escape too, without a special case: geoman's own _removeLastVertex
      // disables the session once the last vertex is gone, so right-clicking your way back out of
      // a shape leaves the tool exactly as right-click always did.
      //
      // THIS RUNS FIRST, and the order is the whole fix rather than a tidy-up. It used to sit
      // below the "over a feature, let the layer handle it" guard, and while you are drawing that
      // guard is true most of the time: geoman's rubber-band line follows the cursor and the edges
      // already placed lie exactly where you are clicking, and every one of them carries
      // `leaflet-interactive`. So the undo landed or did not depending on whether that pixel
      // happened to have a line under it — which is why it took two or three tries and read as
      // random. Nothing else wants a right-click during a draw session, so nothing else gets one.
      const drawing = drawInst(toolRef.current === 'line' ? 'Line' : 'Polygon')
      if ((toolRef.current === 'polygon' || toolRef.current === 'line') && drawing?.enabled?.()) {
        e.originalEvent.preventDefault()
        drawing._removeLastVertex?.()
        return
      }
      // Over a feature the layer handler takes over; over a VERTEX HANDLE geoman removes the
      // vertex (its removeVertexOn default) — the menu must not steal either.
      if (el.classList?.contains('leaflet-interactive') || el.closest?.('.leaflet-marker-icon'))
        return
      e.originalEvent.preventDefault()
      /* The four drawing tools ARM, they do not place. Placing a pin and a label at the clicked
         point was tried and taken back out: two of the four then behaved differently from the
         other two — one opened the tool's panel and waited, the other was already done — and a
         menu whose neighbouring items work by different rules has to be read every time instead
         of aimed at. A polygon and a path cannot be placed from a point, so the rule that makes
         all four the same is the arming one.
         The click point still matters to the one item that is genuinely about a POSITION. */
      // The paste target, so "Paste here" means this point rather than wherever the pointer last
      // crossed the map (a right-click after a zoom would otherwise paste somewhere else).
      lastMouse.current = e.latlng
      const items: MenuEntry[] = [
        { icon: 'polygon', label: t('Draw polygon'), onClick: () => activateTool('polygon') },
        { icon: 'path', label: t('Draw path'), onClick: () => activateTool('line') },
        { icon: 'map-pin', label: t('Add location'), onClick: () => activateTool('marker') },
        { icon: 'label', label: t('Add label'), onClick: () => activateTool('label') }
      ]
      // Absent rather than greyed: an empty clipboard has nothing to say about this point.
      if (getClipboard().length)
        items.push('sep', {
          icon: 'clipboard',
          label: t('Paste here'),
          hint: 'Ctrl+V',
          onClick: () => pasteClipboard(true)
        })
      items.push(
        'sep',
        { icon: 'pencil', label: t('Edit mode'), onClick: () => activateTool('edit') },
        { icon: 'maximize', label: t('Move mode'), onClick: () => activateTool('drag') },
        { icon: 'trash', label: t('Delete mode'), onClick: () => activateTool('remove') }
      )
      setMenu({ x: e.originalEvent.clientX, y: e.originalEvent.clientY, items })
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
      // The article the drawing joins, if one was picked. A LABEL may join one as well — that is
      // what replaces a polygon's own name: the name is turned off and a hand-placed label bound
      // to the same article says it instead. It still creates nothing when no target is set.
      const into = drawIntoRef.current
      const from = yearRef.current
      const styleObj =
        shape === 'Marker' && isLabelDraw
          ? {
              /* A label with no text is not a small label, it is an UNREACHABLE one: the grab box
                 is measured from the glyphs, so an empty one has no hit area and cannot be
                 selected, moved or deleted again. The tool's default text is '', so this was one
                 stray click away on the existing path too. */
              text: s.label.text || t('New label'),
              color: s.label.color,
              font: s.label.font,
              size: s.label.size,
              angle: s.label.angle,
              curve: s.label.curve,
              halo: s.label.halo,
              haloWidth: s.label.haloWidth,
              tracking: s.label.tracking,
              bold: s.label.bold,
              italic: s.label.italic,
              from
            }
          : shape === 'Marker'
            ? {
                size: s.marker.size,
                color: s.marker.color,
                // The mark itself. Left out once, and since pinShapeBody falls back to the first
                // shape in the list, every pin came out a disc however the picker was set — the
                // preview showed the right one, because that reads drawRef directly.
                shape: s.marker.shape,
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
      // Joining an article means looking like it: an islet drawn into a region should come out
      // the region's colour, not the colour the tool happened to be set to. Read from THIS map on
      // purpose — the point is matching what is next to it, and a drawing on another map is not.
      // Same kind first (a pin's colour on a polygon would be a strange thing to inherit), then
      // whatever the article is drawn as.
      // Not for a label: its whole appearance is what the user is choosing, and inheriting a
      // polygon's fill opacity and outline weight would only litter its style with dead keys.
      if (into && !isLabelDraw)
        Object.assign(
          styleObj,
          lookOf(into.id, shape === 'Line' ? 'line' : shape === 'Marker' ? 'point' : 'polygon')
        )
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
      // A target set in the tool popover wins: the drawing joins that article and NOTHING is
      // created — which is also what makes undo right, since `ref.eid` stays undefined and the
      // article the user picked is not deleted when the drawing is.
      // ONE transaction: a drawing IS an article, so this is two inserts into two tables, and
      // failing between them left an entity with no drawing — an empty row in the sidebar the
      // user never made and could not explain.
      const made = await api.createDrawing({
        map_id: id,
        geometry,
        style,
        ...(into ? { entity_id: into.id } : entName ? { entityName: entName } : {})
      })
      const ent = into ?? (made.entityId !== undefined ? { id: made.entityId } : null)
      const created = { id: made.featureId }
      // What was drawn, in the app's own words rather than geoman's. Three sessions in a row this
      // was the missing line: a feature count going 16 → 17 says something appeared, not what.
      logEvent('INFO', `${featureKind(shape, isLabelDraw)}.created`, {
        feature: created.id,
        entity: ent?.id,
        year: from
      })
      // eid is what undo deletes along with the drawing — so ONLY when this draw created it.
      const ref: { id: number; eid?: number } = { id: created.id, eid: into ? undefined : ent?.id }
      pushUndo({
        // The KIND is part of the key, not a parameter: as a parameter it would drop the raw
        // English word into a Turkish sentence ("polygon çizildi").
        label: `Draw a ${featureKind(shape, isLabelDraw)}`,
        undo: async () => {
          await api.deleteDrawing(ref.id, ref.eid)
          onChanged()
        },
        redo: async () => {
          // `entName` set means THIS draw invented the article, so redo has to invent it again
          // (the row is gone, and its id with it); otherwise the drawing rejoins the one it was
          // linked to. Both are one transaction.
          const again = await api.createDrawing({
            map_id: id,
            geometry,
            style,
            ...(entName ? { entityName: entName } : into ? { entity_id: into.id } : {})
          })
          ref.id = again.featureId
          ref.eid = again.entityId
          onChanged()
        }
      })
      // A SHAPE ends its tool; a PIN or a LABEL does not. Both halves are deliberate. You rarely
      // place exactly one pin or one name, so those stay armed on `continueDrawing` (set at map
      // setup) and Escape ends them. A polygon or a path is a piece of work with a definite end —
      // you close the ring and you are done with it — and leaving the tool armed there meant the
      // next click anywhere started a shape nobody asked for.
      //
      // Through activateTool, not by clearing toolRef here: geoman has ALREADY re-armed itself by
      // this point (that is what continueDrawing does), so the draw session has to be disabled as
      // well as the state cleared, and the toolbar button, the `tool.changed` line and
      // syncEditMode all hang off that one door. Handed the current tool it toggles off, which is
      // exactly what Escape does — this just makes finishing the shape do it too.
      if (toolRef.current === 'polygon' || toolRef.current === 'line')
        activateLatest.current(toolRef.current)
      await reloadFeatures('draw')
      if (ent) onChanged() // the new article must appear in the sidebar tree at once
    })
    map.on('pm:remove', async (e) => {
      const fid = (e.layer as FeatureLayer).featureId
      if (fid) await removeFeature(fid)
    })

    map.setView([500, 500], 0) // default; the base image loads in its own effect
    reloadFeatures('open')
    // Seed the current year from the persisted timeline BEFORE the user can draw, so a new
    // feature's `from` is the year actually shown — not a stale 0 (yearRef starts at 0 and only
    // syncs once Timeline's async onYear resolves). Otherwise a polygon drawn at a BC year could
    // be saved as from:0 and vanish from that year's view.
    // The same fallback rule as Timeline's own load, and it has to be: seeding from the project
    // year while the strip shows this map's would put the two a century apart for one round trip,
    // which is exactly the window this seed exists to cover.
    Promise.all([getTimeline(), getMapYear(id)]).then(([tl, mine]) => {
      const year = mine ?? tl.year
      yearRef.current = year
      applyYear(year)
    })
    api.listEntities().then(setAllEntities)
    perMapRaw('mapScales').then((whole) => setMapScale(perMapEntry<MapScale>(whole, id) ?? null))
    api.getSetting('hideMapHint').then((raw) => {
      setHintOff(settingArray<number>(raw).includes(id))
    })
    // A bare array under this key is the value from before it was per map. It becomes THIS map's
    // starting point rather than disappearing on upgrade; the first edit here writes it back in
    // the new shape and the old one stops being read.
    perMapRaw('travelModes').then((whole) =>
      setTravelModesState(asArray<TravelMode>(perMapEntry<TravelMode[]>(whole, id) ?? whole))
    )
    getMapBoards(id).then((b) => {
      boardsRef.current = b
      setBoards(b)
      applyYear(yearRef.current) // apply the board filter once loaded
    })
    getPinImages().then(setPinImages)
    api.getSetting('drawSettings').then((raw) => {
      if (!raw) return
      // Merge per field: settings missing from old records (e.g. font) come from defaults
      const p = settingObject<Partial<DrawSettings>>(raw, {})
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
      labelLayer.current?.destroy()
      labelLayer.current = null
      lc.remove()
      shapeLayer.current?.destroy()
      shapeLayer.current = null
      sc.remove()
      // The picture is the shape layer's texture now and goes down with it (destroy() above frees
      // the source); what is left here is four numbers. MapView remounts on every map switch, and
      // a 4096x4096 texture is ~67 MB, so the release has to be certain either way.
      baseImg.current = null
      baseCanvas.current = null
      bc.remove()
      if (wheelRaf !== null) cancelAnimationFrame(wheelRaf)
      if (panRaf !== null) cancelAnimationFrame(panRaf)
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

  // "Show on map" from the sidebar: retry at short intervals until the feature loads, then fly.
  //
  // This searched the featureGroup — what is IN the Leaflet map — and since shapes moved to WebGL
  // a polygon is only there while a tool is active. So the button quietly did nothing for exactly
  // the features it is most used on, gave up after two seconds and said nothing; pins and labels
  // still worked, which is what made it look intermittent rather than broken. The layers live in
  // `allLayers` whether or not they are in the map, which is what focusFeature has always used —
  // so poll that and then delegate, rather than keep a second, worse copy of the same behaviour.
  // The sidebar gains the flash the other routes already had.
  useEffect(() => {
    if (!focus) return
    let tries = 0
    const t = setInterval(() => {
      if (allLayers.current.get(focus.featureId)?.length) {
        clearInterval(t)
        focusFeature(focus.featureId)
      } else if (++tries > 20) {
        clearInterval(t)
        // The failure this whole comment is about, said out loud. A feature that cannot be found
        // after two seconds is a bug, and it left no trace anywhere before.
        logEvent('WARN', 'feature.locate', { feature: focus.featureId, found: false })
      }
    }, 100)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.token])

  // Base image: decode it once into an ImageBitmap and hand the rectangle to drawBase. No Leaflet
  // layer any more — see drawBase for why the <img> was the most expensive thing on the map.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    let dropped = false
    baseImg.current = null
    shapeLayer.current?.setBase(null, 0, 0, 0, 0)
    if (worldMap?.image_path && worldMap.width && worldMap.height) {
      const bounds: L.LatLngBoundsLiteral = [
        [0, 0],
        [worldMap.height, worldMap.width]
      ]
      /*
       * The bytes, not an <img>. This is the second half of the decode story in drawBase.
       *
       * Moving the picture onto a canvas stopped Leaflet resizing an element and re-decoding on
       * every zoom — but the decode itself was still being done the expensive way. This used to
       * load an `<img>` and call `createImageBitmap(el)` from its onload, and Chromium decodes an
       * already-loaded element SYNCHRONOUSLY ON THE MAIN THREAD: a trace of a launch shows
       * `EventDispatch type=load → el.onload → Decode Image 170ms`, one unbroken block, landing a
       * few seconds in — which is exactly when someone opens a map and reaches for the wheel. It
       * read as "the first zoom is stuck" and it was never the zoom at all.
       *
       * `createImageBitmap` from a BLOB decodes on a background thread instead, so the main
       * thread keeps its frames. The element is gone with it, which also settles the CORS
       * question it needed `crossOrigin` for: `world://` is registered with `supportFetchAPI` and
       * `corsEnabled` and its handler answers with the header, so the bitmap is clean and the
       * canvas is never tainted.
       */
      const p0 = map.project(L.latLng(0, 0), 0)
      const p1 = map.project(L.latLng(worldMap.height, worldMap.width), 0)
      // How long the map spends WITHOUT its picture. The main thread no longer stalls on the
      // decode, but that is only half the question: a background decode that arrives late shows
      // as the drawings appearing over an empty canvas and the image landing after them, which
      // is a different complaint with the same words. One line per map open.
      const tImg = performance.now()
      let bytes = 0
      void fetch(assetUrl(worldMap.image_path))
        .then((r) => r.blob())
        .then((b) => {
          bytes = b.size
          return createImageBitmap(b)
        })
        // A texture cannot be wider than the GPU allows, and a world map is exactly the kind of
        // file that gets exported at 8192 or 16384 "just in case". Past the limit the upload
        // fails and the map loses its picture with nothing on screen to say why, so it is scaled
        // down ONCE here — on the background thread, like the decode above.
        .then((bmp) =>
          Math.max(bmp.width, bmp.height) <= MAX_BASE_PX
            ? bmp
            : createImageBitmap(bmp, {
                resizeWidth: Math.round(
                  bmp.width * (MAX_BASE_PX / Math.max(bmp.width, bmp.height))
                ),
                resizeHeight: Math.round(
                  bmp.height * (MAX_BASE_PX / Math.max(bmp.width, bmp.height))
                ),
                resizeQuality: 'high'
              }).then((small) => {
                bmp.close()
                logEvent('INFO', 'map.baseImage.scaled', { to: MAX_BASE_PX })
                return small
              })
        )
        .then((bmp) => {
          logEvent('INFO', 'map.baseImage', {
            ms: Math.round(performance.now() - tImg),
            kb: Math.round(bytes / 1024),
            px: `${bmp.width}x${bmp.height}`
          })
          if (dropped) return bmp.close()
          const rect = {
            x: Math.min(p0.x, p1.x),
            y: Math.min(p0.y, p1.y),
            w: Math.abs(p1.x - p0.x),
            h: Math.abs(p1.y - p0.y)
          }
          baseImg.current = rect
          // The picture becomes a texture; the shadow and rim stay on the 2D canvas below.
          shapeLayer.current?.setBase(bmp, rect.x, rect.y, rect.w, rect.h)
          drawShapes() // it arrives a frame or two after the map is up; nothing else asks again
        })
        // A missing or unreadable base image must not take the map down with it: the drawings are
        // the map's content and they render perfectly well over an empty canvas.
        .catch((err) =>
          logEvent('WARN', 'map.baseImage', { error: String(err?.message ?? err).slice(0, 80) })
        )
      fitBoundsRef.current = bounds
      applyFit()
    } else {
      fitBoundsRef.current = null
      drawShapes() // no image: clear whatever the last map left on the canvas
    }
    return () => {
      dropped = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worldMap?.image_path, worldMap?.width, worldMap?.height])

  // After undo/redo: refresh features without remounting the map (zoom/position kept)
  const firstToken = useRef(true)
  useEffect(() => {
    if (firstToken.current) {
      firstToken.current = false
      return
    }
    reloadFeatures('undo')
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
  /**
   * Re-derive ONE feature's paint entry, by the same rules reloadFeatures uses (see the block that
   * fills renderStyle there — if that changes, this changes with it). Also writes the new style
   * back into the cached row, so the next real reload does not resurrect the old one.
   */
  const repaint = (fid: number, styleJson: string): void => {
    const f = worldMapRef.current?.features.find((x) => x.id === fid)
    if (!f) return
    f.style = styleJson
    const style = JSON.parse(styleJson || '{}') as FeatureStyle
    const kind = featKind.current.get(fid)
    const isLine = kind === 'line'
    const isPolygon = kind === 'polygon'
    const color = style.color ?? folderColor(folders, f.entity_folder)
    renderStyle.current.set(fid, {
      color: isPolygon ? outlineColor(color) : color,
      fillColor: isPolygon && style.fillImg ? `url(#${fillPatternId(style.fillImg)})` : color,
      fillImg: isPolygon ? style.fillImg : undefined,
      fillOpacity: style.fillOpacity ?? 0.25,
      weight: style.weight ?? (isLine ? 3 : 2),
      opacity: isLine ? (style.opacity ?? 0.9) : 1,
      dashArray: isLine ? lineDashArray(style.dash, style.weight ?? 3) : ''
    })
  }

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
        label: selIds.length > 1 ? 'Restyle {n} drawings' : 'Restyle a drawing',
        params: { n: selIds.length },
        // Restyling a selection is one action, so both directions go through the batch.
        undo: async () =>
          api.updateFeatures(ref.items.map((it) => ({ id: it.fid, patch: { style: it.orig } }))),
        redo: async () =>
          api.updateFeatures(ref.items.map((it) => ({ id: it.fid, patch: { style: it.latest } })))
      })
    }
    const items = styleEditRef.current.items
    // ONE round trip and ONE transaction. This was Promise.all over per-feature calls, which
    // fixed the round-trip count but not the atomicity: a slider drag with twenty selected could
    // leave some restyled and some not, under a single undo entry claiming all of them.
    await api.updateFeatures(
      items.map((it) => {
        it.latest = JSON.stringify({
          ...(JSON.parse(it.latest || it.orig) as FeatureStyle),
          ...patch
        })
        return { id: it.fid, patch: { style: it.latest } }
      })
    )
    setSelected({ ...selected, style: items[0].latest }) // items[0] = the primary (selIds order)
    // The edit itself. Its only trace used to be the reload it caused, so removing that reload
    // made a real action invisible — the same trap as `entity.located`: an event recorded through
    // its own side effect disappears the moment the side effect is optimised away.
    // Called per tick, and left to the coalescer: a drag becomes one line with a count and a span.
    // Which key changed is part of the shape, so switching sliders mid-gesture starts a new line.
    logEvent('INFO', 'style.changed', {
      what: Object.keys(patch).join(','),
      features: items.length
    })
    // Dragging one slider used to rebuild the whole map on every tick — measured from a real
    // session: ~75 full reloads in eight seconds, each re-reading the map from SQLite and
    // recreating every layer, to change the opacity of one polygon.
    //
    // It never needed to. The paint properties live in `renderStyle`, and `applyYear` repaints
    // from that ref without touching the database — which is exactly why the YEAR slider is
    // smooth. A style edit can take the same road, as long as it only touches paint: anything
    // else (label text, year range, zoom limits, pin image, board) is built elsewhere in
    // reloadFeatures and still needs the full pass. Derived modes are excluded too — there the
    // colour comes from the mode, not the feature, and recomputing it here would fight applyYear.
    // Polygons and paths only. A pin or a label carries its colour in a divIcon that is BUILT in
    // reloadFeatures, and applyYear never rebuilds one — so the fast path would have made the
    // colour picker silently do nothing on a pin. They keep the full pass; they are also not what
    // produces the storm, since the sliders that fire per tick belong to shapes.
    const shapes = items.every((it) => {
      const k = featKind.current.get(it.fid)
      return k === 'polygon' || k === 'line'
    })
    if (shapes && !activeModeRef.current && Object.keys(patch).every((k) => PAINT_KEYS.has(k))) {
      for (const it of items) repaint(it.fid, it.latest)
      applyYear(yearRef.current)
      return
    }
    await reloadFeatures('style')
  }

  // Zoom visibility (pin + label): the user PICKS the threshold with a slider (shown as a
  // percentage). Ticking the box starts at the current zoom, then fine-tune; minZoom = "hide
  // below this (further out)", maxZoom = "hide above this (closer in)".
  const zoomPct = (z: number): string => `%${Math.round(2 ** (z - fitZoom) * 100)}`
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
      <label className="cap">
        {t('Hide by zoom')}
        <span>{zoomPct(barZoom)}</span>
      </label>
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
            // min: a polygon may have no outline (its fill still shows it), a path may not.
            const wclamp = (v: number, max: number, min = 1): number =>
              Math.max(min, Math.min(max, v))
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
                  polygon: { ...d.polygon, weight: wclamp(d.polygon.weight + dir, 10, 0) }
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
                weight: wclamp(
                  (selStyle.weight ?? (selIsLine ? 3 : 2)) + dir,
                  max,
                  selIsLine ? 1 : 0
                )
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
      alertDialog(t('This entry has no drawing on the map.'))
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
      // animate:false for the reason spelled out in focusFeature.
      mapRef.current.fitBounds(b.pad(0.4), { maxZoom: 2, animate: false })
    }
  }

  const linkEntity = async (entityId: number): Promise<void> => {
    const feat = selected!
    const prev = feat.entity_id
    if (prev === entityId) return
    const kind = featKind.current.get(feat.id)
    const look = lookOf(
      entityId,
      kind === 'line' ? 'line' : kind === 'polygon' ? 'polygon' : 'point'
    )
    const style = JSON.stringify({ ...(JSON.parse(feat.style || '{}') as FeatureStyle), ...look })
    // ONE transaction AND one history step. The rebind and the cleanup of the article the drawing
    // left are the same action, and they used to be two writes with TWO pushUndo calls — so a
    // single Ctrl+Z put the drawing back and left the article deleted. The orphan test moved into
    // main with the write: it is three reads and a decision, and doing it there makes this one
    // round trip as well as one transaction.
    const { dropped } = await api.updateFeatureLink(feat.id, entityId, style, prev)
    pushUndo({
      label: dropped ? 'Link the drawing and remove the emptied entry' : 'Link the drawing',
      undo: async () => {
        if (dropped) await api.restoreEntity(dropped, [], [])
        await api.updateFeature(feat.id, { entity_id: prev, style: feat.style })
        onChanged()
      },
      redo: async () => {
        await api.updateFeatureLink(feat.id, entityId, style, prev)
        onChanged()
      }
    })
    setLinkName('')
    onChanged()
    await reloadFeatures('link')
    setSelected((await api.getMap(id))?.features.find((f) => f.id === feat.id) ?? null)
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
                // A result list you could not Tab into: typing a name and then having to reach
                // for the mouse is the one thing a search box must not ask for.
                <button
                  key={f.id}
                  className="layers-row"
                  onClick={() => {
                    focusFeature(f.id)
                    setSearchQ('')
                  }}
                >
                  <span className="layers-icon">
                    <Icon
                      name={
                        (
                          {
                            polygon: 'polygon',
                            line: 'path',
                            pin: 'map-pin',
                            label: 'label'
                          } as const
                        )[kind]
                      }
                      size={14}
                    />
                  </span>
                  <span className="layers-text">
                    <span className="layers-name">{name}</span>
                    {f.entity_folder && (
                      <span className="layers-desc">
                        {folders.find((x) => x.id === f.entity_folder)?.name ?? ''}
                      </span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="layers-menu">
          <button
            className={`layers-btn tier-1 ${mapsOpen ? 'open' : ''}`}
            onClick={() => setMapsOpen((o) => !o)}
          >
            <Icon name="map" size={14} />
            {t('Maps')}
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
                {mapTree(null, 0)}
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
                      <Icon name="check" size={12} />
                    </button>
                  </form>
                ) : null}
                {newMapName !== null && (
                  /* Inside the open map by default: on a continent, the next map you make is
                     almost always one of its cities. Unticking makes it a sibling instead. */
                  <label className="layers-row" style={{ paddingLeft: 8 }}>
                    <input
                      type="checkbox"
                      checked={newMapInside}
                      onChange={(e) => setNewMapInside(e.target.checked)}
                    />
                    <span className="layers-name">
                      {t('inside "{name}"', { name: crumbs[crumbs.length - 1]?.name ?? '' })}
                    </span>
                  </label>
                )}
                {newMapName === null && (
                  <button className="mini base-add" onClick={() => setNewMapName('')}>
                    <Icon name="plus" size={12} /> {t('New map')}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
        {/* Export moved to File ▸ Export ▸ Current Map as Image (App drives it via onExportReady);
            the header keeps only map CONTEXT: search, maps, boards, layers. */}
        <div className="layers-menu">
          <button
            className={`layers-btn tier-2 ${boardsOpen ? 'open' : ''}`}
            onClick={() => setBoardsOpen((o) => !o)}
          >
            <Icon name="board" size={14} />
            {t('Boards')}
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
                    <div key={b.id} className="layers-row">
                      {/* A tick when it is the one being drawn on, and nothing when it is not —
                          the row already says which by its weight and colour. The ◉/○ pair it
                          replaces was the only place in the app drawing a control out of text. */}
                      <span className="layers-icon">
                        {b.id === boards.active && <Icon name="check" size={13} />}
                      </span>
                      {/* The name switches boards; rename and remove sit beside it. The row was
                          the click target and held two buttons, which is the one arrangement
                          that cannot become a button itself. */}
                      <button
                        className={`layers-name board-pick ${b.id === boards.active ? 'on' : ''}`}
                        onClick={() => switchBoard(b.id)}
                      >
                        {b.name}
                      </button>
                      <button
                        className="mini map-row-btn"
                        title={t('Rename')}
                        onClick={(e) => (e.stopPropagation(), setEditBoardId(b.id))}
                      >
                        <Icon name="pencil" size={12} />
                      </button>
                      <button
                        className="mini danger map-row-btn"
                        title={t('Remove')}
                        aria-label={t('Remove')}
                        onClick={(e) => (e.stopPropagation(), removeBoard(b.id))}
                      >
                        <Icon name="x" size={12} />
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
                      <Icon name="check" size={12} />
                    </button>
                  </form>
                ) : (
                  <button className="mini base-add" onClick={() => setNewBoardName('')}>
                    <Icon name="plus" size={12} /> {t('New board')}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
        <div className="layers-menu">
          {/* "3/4" was a ratio, and the question it answers is not a ratio: it is "is anything
              hidden right now?". The glyph says it — an open eye when everything is drawn, a
              closed one and the accent when something is not, which is also the state worth
              noticing from across the map. The count moves into the tooltip, where a number
              belongs. */}
          {(() => {
            const off = Object.values(layersOn).filter((v) => !v).length
            return (
              <button
                className={`layers-btn tier-3 ${layersOpen ? 'open' : ''} ${off ? 'filtered' : ''}`}
                title={off ? t('{n} layer(s) hidden', { n: off }) : t('Everything is shown')}
                aria-label={t('Layers')}
                onClick={() => setLayersOpen((o) => !o)}
              >
                <Icon name={off ? 'eye-off' : 'eye'} size={14} />
              </button>
            )
          })()}
          {layersOpen && (
            <>
              <div className="layers-backdrop" onClick={() => setLayersOpen(false)} />
              <div className="layers-panel">
                <div className="layers-panel-head">{t('Show on map')}</div>
                {(
                  [
                    ['polygon', 'polygon', t('Polygons'), t('State / region borders')],
                    ['line', 'path', t('Paths'), t('Roads, routes, rivers')],
                    ['pin', 'map-pin', t('Pins'), t('Markers on the map')],
                    ['label', 'label', t('Labels'), t('Names on polygons and free text')]
                  ] as const
                ).map(([k, icon, label, desc]) => (
                  <label key={k} className="layers-row">
                    <input type="checkbox" checked={layersOn[k]} onChange={() => toggleLayer(k)} />
                    <span className="layers-icon">
                      <Icon name={icon} size={14} />
                    </span>
                    <span className="layers-text">
                      <span className="layers-name">{label}</span>
                      <span className="layers-desc">{desc}</span>
                    </span>
                  </label>
                ))}
                {pinTypes.length > 1 && (
                  <>
                    <div className="layers-panel-head">{t('Pin folders')}</div>
                    {/* Shown/hidden, which is the question the four rows above this one already
                        answer with checkboxes — these were chips, in the same panel, for the same
                        job. A chip cannot say "ticked" and these have to. */}
                    {pinTypes.map((ty) => (
                      <label key={ty} className="layers-row">
                        <input
                          type="checkbox"
                          checked={!pinHidden.has(ty)}
                          onChange={() => togglePinType(ty)}
                        />
                        <span className="layers-icon">
                          <Icon name="map-pin" size={14} />
                        </span>
                        <span className="layers-text">
                          <span className="layers-name">
                            {folders.find((x) => x.id === ty)?.name || t('(no folder)')}
                          </span>
                        </span>
                      </label>
                    ))}
                  </>
                )}
              </div>
            </>
          )}
        </div>
        {/* History, beside Layers and Boards. Most of what it lists are drawings, so having to
            leave the map to step back through them was the one place it must not be. */}
        <div className="layers-menu">
          <button
            className={`layers-btn tier-3 ${histOpen ? 'open' : ''}`}
            title={t('History')}
            onClick={() => setHistOpen((o) => !o)}
          >
            <Icon name="clock" size={14} />
          </button>
          {histOpen && (
            <>
              <div className="layers-backdrop" onClick={() => setHistOpen(false)} />
              <div className="layers-panel">
                <div className="layers-panel-head">{t('History')}</div>
                <History onApplied={onUndone} />
              </div>
            </>
          )}
        </div>
      </div>
      <div className="map-body">
        <div className="map-host-wrap">
          {/* SVG marker def for the path direction arrow (referenced document-wide via
              url(#worldArrow); context-stroke makes the arrow follow the line's color,
              markerUnits=strokeWidth sizes it in multiples of the line's own weight, so it
              stays in proportion however the stroke scales — no hot path).

              Geometry, in units of the stroke width w (markerWidth 3 over a 10-unit viewBox
              means 1 viewBox unit = 0.3w): a plain triangle 3w long and 3w across the base.
              refX=6 seats it so the tip lands 1.2w PAST the line's last point and the base
              1.8w behind it. Both numbers are load-bearing. The old marker had the tip only
              0.4w past the end, so the round line cap (0.5w) poked out through it and the
              stroke ran visibly past the arrow; and at the end point the head must be at
              least half the line wide to cover it — here it is 0.6w, so the cap tucks fully
              inside and no stroke shows through. The old swallowtail notch is gone too: at
              this size it read as a barb rather than an arrow. */}
          <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden>
            <defs>
              <marker
                id="worldArrow"
                viewBox="0 0 10 10"
                refX="6"
                refY="5"
                markerWidth="3"
                markerHeight="3"
                orient="auto"
                markerUnits="strokeWidth"
              >
                <path d="M0,0 L10,5 L0,10 z" fill="context-stroke" />
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
          {!exporting && !worldMap?.image_path && worldMap && !hintOff && (
            /* A map with no base image is an empty screen, and the middle of an empty screen is
               where you look — not the far end of a toolbar. pointer-events: none on the wrapper
               so the empty map underneath is still pannable; the button itself takes clicks. */
            <div className="map-empty">
              <EmptyState
                icon="image"
                title={t('No base image yet')}
                hint={t('Drawings work without one, but a map usually starts with a picture.')}
              >
                <button className="primary" onClick={pickBaseImage}>
                  {t('Add base image')}
                </button>
                <button className="mini" onClick={dismissMapHint}>
                  {t('Work without one')}
                </button>
              </EmptyState>
            </div>
          )}
          {!exporting && (
            <>
              <Timeline
                mapId={id}
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
                  <Icon name="conquest" size={13} /> {t('Click the conqueror; the picks join it…')}{' '}
                  <label>
                    {t('conqueror')}{' '}
                    <Select
                      value={conquest.recvLevel ?? ''}
                      title={t('Which rank the conqueror is taken as')}
                      onChange={(v) => setConquest({ ...conquest, recvLevel: v || null })}
                      options={[
                        { value: '', label: t('base') },
                        ...ladderTags.map((tag) => ({ value: tag, label: tag }))
                      ]}
                    />
                  </label>{' '}
                  <label>
                    {t('takes')}{' '}
                    <Select
                      value={conquest.level ?? ''}
                      title={t(
                        'Which ladder rank changes hands (upper ranks take their whole branch)'
                      )}
                      onChange={(v) => setConquest({ ...conquest, level: v || null })}
                      options={[
                        { value: '', label: t('base') },
                        ...ladderTags.map((tag) => ({ value: tag, label: tag }))
                      ]}
                    />
                  </label>{' '}
                  <button className="mini" onClick={() => setConquest(null)}>
                    {t('cancel')}
                  </button>
                </div>
              )}
              {conquest?.step === 'picking' && (
                <div className="link-hint">
                  <Icon name="conquest" size={13} />{' '}
                  {t('Select polygons to join {name} ({n} selected)', {
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
                  <Icon name="map" size={13} />{' '}
                  {nav.step === 'a'
                    ? t('Click the START pin…')
                    : t('Now click the DESTINATION pin ({from} → …)', { from: nav.aName })}{' '}
                  <button className="mini" onClick={endNav}>
                    {t('cancel')}
                  </button>
                </div>
              )}
              {measure?.kind === 'calib' && (
                <div className="link-hint">
                  <Icon name="ruler" size={13} />{' '}
                  {measure.pts.length === 0
                    ? t('Click the FIRST point of a known distance…')
                    : t('Now click the SECOND point…')}{' '}
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
                  <Icon name="ruler" size={13} /> {t('Real distance between the two points:')}{' '}
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
                  <Icon name="ruler" size={13} />{' '}
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
                  <Icon name="polygon" size={13} />{' '}
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
                  <Icon name="calendar" size={13} />{' '}
                  {t('Event name (year {n}):', { n: eventDraft.year })}{' '}
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
                    // animate:false to match the wheel path: an animated setZoom per
                    // drag frame queues transitions that fight each other, and each one
                    // transforms the renderer instead of redrawing it.
                    onChange={(e) =>
                      mapRef.current?.setZoom(Number(e.target.value), { animate: false })
                    }
                  />
                  <span className="zoom-pct">{zoomPct(hudZoom)}</span>
                </div>
              )}
              <HierarchyPanel
                active={activeMode}
                scope={mapScope}
                reloadToken={reloadToken}
                onMode={(m) => {
                  activeModeRef.current = m
                  setActiveMode(m)
                  setConquest(null)
                  reloadFeatures('mode')
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
              {!hideTools && !histOpen && <MapToolbar active={tool} onTool={activateTool} />}
              {/* …and out of the way while History is open: both float against the same right
                  edge, and the tool settings are not what you are looking at when you are stepping
                  back through the session. It comes back on its own — the condition is derived,
                  so closing History restores whatever the tool state already was. */}
              {tool && !selected && !hidePanels && !histOpen && (
                <div className="map-tool-popover">
                  {/* Draw into an existing article instead of making a new one per drawing — the
                      islets of an archipelago, the exclaves of a realm. Only for the tools that
                      would create an article: a free-text label never does. */}
                  {(tool === 'polygon' ||
                    tool === 'line' ||
                    tool === 'marker' ||
                    tool === 'label') && (
                    <div className="panel-block">
                      <label>{t('Add to entry:')}</label>
                      {drawInto ? (
                        <button className="mini" onClick={() => setDrawInto(null)}>
                          <Icon name="unlink" size={12} />
                          {drawInto.name}
                        </button>
                      ) : (
                        <>
                          <input
                            // Its own id: two datalists with one id is invalid HTML even when
                            // they cannot appear together (tool popover vs selected panel).
                            list="entity-list-draw"
                            placeholder={t('new entry each time')}
                            value={drawIntoName}
                            onChange={(e) => {
                              setDrawIntoName(e.target.value)
                              // Chosen from the list = chosen: no second click to confirm what the
                              // datalist already made unambiguous.
                              const hit = allEntities.find(
                                (en) =>
                                  en.name === e.target.value &&
                                  !(en.folder && personFolders.has(en.folder))
                              )
                              if (hit) {
                                setDrawInto({ id: hit.id, name: hit.name })
                                setDrawIntoName('')
                              }
                            }}
                          />
                          <datalist id="entity-list-draw">
                            {allEntities
                              .filter((en) => !(en.folder && personFolders.has(en.folder)))
                              .map((en) => (
                                <option key={en.id} value={en.name} />
                              ))}
                          </datalist>
                        </>
                      )}
                    </div>
                  )}
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
                  <p className="hint">{t('Edits apply to every selected drawing.')}</p>
                </div>
              )}

              <div className="panel-block">
                <label className="panel-title">{t('Appearance')}</label>
                {selIsPolygon ? (
                  <>
                    <ColorPicker
                      value={selStyle.color ?? folderColor(folders, selected.entity_folder)}
                      onChange={(color) => editSelectedStyle({ color })}
                    />
                    <label className="cap">
                      {t('Fill opacity')}
                      <span>{(selStyle.fillOpacity ?? 0.25).toFixed(2)}</span>
                    </label>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={selStyle.fillOpacity ?? 0.25}
                      onChange={(e) => editSelectedStyle({ fillOpacity: Number(e.target.value) })}
                    />
                    {/* 0 = no outline at all. A polygon still reads as one from its fill; a PATH
                        would simply vanish, which is why only this one goes down to zero. */}
                    <label className="cap">
                      {t('Outline thickness')}
                      <span>{selStyle.weight ?? 2}px</span>
                    </label>
                    <input
                      type="range"
                      min={0}
                      max={10}
                      step={1}
                      value={selStyle.weight ?? 2}
                      onChange={(e) => editSelectedStyle({ weight: Number(e.target.value) })}
                    />
                    <label>
                      <input
                        type="checkbox"
                        checked={!selStyle.hideName}
                        onChange={(e) => editSelectedStyle({ hideName: !e.target.checked })}
                      />{' '}
                      {t('Show the name on the map')}
                    </label>
                    {selStyle.hideName ? (
                      <p className="hint">{t('Name it with the Label tool instead.')}</p>
                    ) : (
                      <>
                        <label>{t('Label font')}</label>
                        <Select
                          value={selStyle.font ?? 'Cinzel'}
                          style={{ fontFamily: selStyle.font ?? 'Cinzel' }}
                          onChange={(v) => editSelectedStyle({ font: v })}
                          options={FONTS.map((f) => ({
                            value: f,
                            label: f,
                            style: { fontFamily: f }
                          }))}
                        />
                      </>
                    )}
                    <label>{t('Fill image')}</label>
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
                    <label className="cap">
                      {t('Thickness')}
                      <span>{selStyle.weight ?? 3}px</span>
                    </label>
                    <input
                      type="range"
                      min={1}
                      max={12}
                      step={1}
                      value={selStyle.weight ?? 3}
                      onChange={(e) => editSelectedStyle({ weight: Number(e.target.value) })}
                    />
                    <label className="cap">
                      {t('Opacity')}
                      <span>{(selStyle.opacity ?? 0.9).toFixed(2)}</span>
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
                    <Select
                      value={selStyle.dash ?? 'solid'}
                      onChange={(v) => editSelectedStyle({ dash: v as LineDash })}
                      options={LINE_DASHES.map((d) => ({ value: d, label: t(DASH_LABELS[d]) }))}
                    />
                    <label className="cap">
                      {t('Curviness')}
                      <span>{selStyle.curviness ?? 0}</span>
                    </label>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={5}
                      value={selStyle.curviness ?? 0}
                      onChange={(e) => editSelectedStyle({ curviness: Number(e.target.value) })}
                    />
                    <label>{t('Direction arrow')}</label>
                    <Select
                      value={selStyle.arrow ?? 'none'}
                      onChange={(v) => editSelectedStyle({ arrow: v as LineArrow })}
                      options={LINE_ARROWS.map((a) => ({ value: a, label: t(ARROW_LABELS[a]) }))}
                    />
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
                    <Select
                      value={selStyle.font ?? 'Cinzel'}
                      style={{ fontFamily: selStyle.font ?? 'Cinzel' }}
                      onChange={(v) => editSelectedStyle({ font: v })}
                      options={FONTS.map((f) => ({ value: f, label: f, style: { fontFamily: f } }))}
                    />
                    <label className="cap">
                      {t('Size')}
                      <span>×{(selStyle.size ?? 1).toFixed(2)}</span>
                    </label>
                    <input
                      type="range"
                      min={0.5}
                      max={10}
                      step={0.25}
                      value={selStyle.size ?? 1}
                      onChange={(e) => editSelectedStyle({ size: Number(e.target.value) })}
                    />
                    <label className="cap">
                      {t('Angle')}
                      <span>{selStyle.angle ?? 0}°</span>
                    </label>
                    <input
                      type="range"
                      min={-90}
                      max={90}
                      step={5}
                      value={selStyle.angle ?? 0}
                      onChange={(e) => editSelectedStyle({ angle: Number(e.target.value) })}
                    />
                    <label className="cap">
                      {t('Curve')}
                      <span>{selStyle.curve ?? 0}</span>
                    </label>
                    <input
                      type="range"
                      min={-100}
                      max={100}
                      step={5}
                      value={selStyle.curve ?? 0}
                      onChange={(e) => editSelectedStyle({ curve: Number(e.target.value) })}
                    />
                    <label>{t('Halo')}</label>
                    <Select
                      value={selStyle.halo ?? 'dark'}
                      onChange={(v) => editSelectedStyle({ halo: v as LabelHalo })}
                      options={LABEL_HALOS.map((h) => ({ value: h, label: t(HALO_LABELS[h]) }))}
                    />
                    {(selStyle.halo ?? 'dark') !== 'none' && (
                      <>
                        <label className="cap">
                          {t('Halo thickness')}
                          <span>{(selStyle.haloWidth ?? 0.08).toFixed(2)}</span>
                        </label>
                        <input
                          type="range"
                          min={0.02}
                          max={0.2}
                          step={0.01}
                          value={selStyle.haloWidth ?? 0.08}
                          onChange={(e) => editSelectedStyle({ haloWidth: Number(e.target.value) })}
                        />
                      </>
                    )}
                    <label className="cap">
                      {t('Letter spacing')}
                      <span>{(selStyle.tracking ?? 0).toFixed(2)}</span>
                    </label>
                    <input
                      type="range"
                      min={0}
                      max={0.5}
                      step={0.01}
                      value={selStyle.tracking ?? 0}
                      onChange={(e) => editSelectedStyle({ tracking: Number(e.target.value) })}
                    />
                    <div className="field-row">
                      <label>
                        <input
                          type="checkbox"
                          checked={selStyle.bold ?? false}
                          onChange={(e) => editSelectedStyle({ bold: e.target.checked })}
                        />{' '}
                        {t('Bold')}
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          checked={selStyle.italic ?? false}
                          onChange={(e) => editSelectedStyle({ italic: e.target.checked })}
                        />{' '}
                        {t('Italic')}
                      </label>
                    </div>
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
                    {/* A custom image replaces the mark entirely, so the shape row is pointless then */}
                    {!selStyle.img && (
                      <>
                        <label>{t('Shape')}</label>
                        <PinShapePicker
                          shape={selStyle.shape}
                          color={selStyle.color ?? '#c0603a'}
                          onPick={(shape) => editSelectedStyle({ shape })}
                        />
                      </>
                    )}
                    <label>{t('Pin image')}</label>
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
                        {/* See the same line in ToolPanel: the strip is its own remove button. */}
                        <p className="hint">{t('Click an image again to remove it.')}</p>
                        {/* The tool panel's twin — same control for the same choice, and it has
                            to stay the twin: one shows the default, this shows one drawing. */}
                        <Segmented
                          label={t('Image style')}
                          options={[
                            { key: 'badge', label: t('Badge') },
                            { key: 'free', label: t('Free') }
                          ]}
                          value={selStyle.imgFree ? 'free' : 'badge'}
                          onChange={(k) => editSelectedStyle({ imgFree: k === 'free' })}
                        />
                      </>
                    )}
                    <label className="cap">
                      {t('Size')}
                      <span>×{(selStyle.size ?? 1).toFixed(2)}</span>
                    </label>
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
                <label className="panel-title">{t('Time')}</label>
                <p className="hint">{t('Blank = always. A negative year is before the epoch.')}</p>
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

              {selected.entity_id && (
                <div className="panel-block">
                  <button
                    className="mini"
                    onClick={async () => (
                      await api.updateFeature(selected.id, { entity_id: null }),
                      reloadFeatures('unlink'),
                      setSelected({
                        ...selected,
                        entity_id: null,
                        entity_name: null,
                        entity_folder: null
                      })
                    )}
                  >
                    <Icon name="unlink" size={12} />
                    {t('Unlink entry')}
                  </button>
                </div>
              )}
              {/* Shown whether or not the drawing is already bound. It used to appear ONLY when it
                  was not — and since every drawing is born with its own article, that state barely
                  exists, so moving an islet into its region meant unlinking first to reveal the
                  field that does it. One step now, and the emptied article goes with it. */}
              <div className="panel-block">
                <label>
                  {selected.entity_id ? t('Move to another entry') : t('Link to entry')}
                </label>
                <input
                  list="entity-list-map"
                  placeholder={t('search entry…')}
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
                onChanged={() => (reloadFeatures('article'), onChanged())}
                onDeleted={() => (clearSel(), reloadFeatures('article-deleted'))}
              />
            )}
          </div>
        )}
      </div>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  )
}
