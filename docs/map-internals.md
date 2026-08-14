# Map internals

How the map screen actually works: Leaflet and `CRS.Simple`, the WebGL rendering split, the base
image, the timeline, rank and paint modes, and the dead ends that were measured rather than
guessed. Read this before editing `MapView.tsx`, `pixiLabels.ts`, `pixiShapes.ts`,
`ToolPanel.tsx`, `Timeline.tsx` or `HierarchyPanel.tsx`.

- [The map is MOUNTED when a world opens, not when it is asked for (`App.tsx`)](#the-map-is-mounted-when-a-world-opens-not-when-it-is-asked-f-0)
- [The map layer (`MapView.tsx`)](#the-map-layer-mapviewtsx-1)
- [The rendering split (`pixiLabels.ts` + `pixiShapes.ts`, Pixi v8) — measured, not assumed](#the-rendering-split-pixilabelsts-pixishapests-pixi-v8-measur-2)
- [The base image is a mipmapped TEXTURE in the shape layer (`setBase` in `pixiShapes.ts`), and its frame is what stayed on the 2D canvas (`drawBase` in `MapView.tsx`)](#the-base-image-is-a-mipmapped-texture-in-the-shape-layer-set-3)
- [The tool panel (`ToolPanel.tsx`)](#the-tool-panel-toolpaneltsx-4)
- [Hierarchy / government system (parallel ladders)](#hierarchy-government-system-parallel-ladders-5)
- [Timeline (`Timeline.tsx`)](#timeline-timelinetsx-6)
- [Map modes / painting (religion, language, culture…)](#map-modes-painting-religion-language-culture-7)
- [The path tool (lines)](#the-path-tool-lines-8)
- [Map scale (`MapView.tsx` + `ToolPanel.tsx`)](#map-scale-mapviewtsx-toolpaneltsx-9)
- [Custom pin images (`MapView.tsx` + `pinIcons.tsx`)](#custom-pin-images-mapviewtsx-piniconstsx-10)
- [Polygon fill images (`MapView.tsx`)](#polygon-fill-images-mapviewtsx-11)
- [Free text labels (`MapView.tsx`)](#free-text-labels-mapviewtsx-12)
- [Navigation (`MapView.tsx` + `ToolPanel.tsx`)](#navigation-mapviewtsx-toolpaneltsx-13)
- [Boards / drawing layers (`MapView.tsx` + `api.ts`)](#boards-drawing-layers-mapviewtsx-apits-14)
- [Map switching (`MapView.tsx` + `App.tsx`)](#map-switching-mapviewtsx-apptsx-15)
- [Zoom-based visibility (`MapView.tsx`)](#zoombased-visibility-mapviewtsx-16)
- [Map search + pin filter (`MapView.tsx`)](#map-search-pin-filter-mapviewtsx-17)
- [Multi-select + clipboard (`MapView.tsx`)](#multiselect-clipboard-mapviewtsx-18)
- [A SHAPE ends its tool; a pin or a label does not](#a-shape-ends-its-tool-a-pin-or-a-label-does-not-19)
- [The context menu (`ContextMenu.tsx`) is one component behind six call sites, and what makes it contextual is the SUBJECT, not the items](#the-context-menu-contextmenutsx-is-one-component-behind-six--20)
- [A draw session owns the right button OUTRIGHT, and that takes both handlers](#a-draw-session-owns-the-right-button-outright-and-that-takes-21)
- [Other map behaviors](#other-map-behaviors-22)
- [A map with no base image](#a-map-with-no-base-image-23)
- [Sliders are the PLATFORM's,](#sliders-are-the-platforms-24)

---

<a id="the-map-is-mounted-when-a-world-opens-not-when-it-is-asked-f-0"></a>

## The map is MOUNTED when a world opens, not when it is asked for (`App.tsx`):

once `mapId` is set, the map view stays mounted behind every other workspace — the wrapper is
`display:none`, never an unmount — which is why returning to the map from an entry has always been
instant. Only the FIRST visit was slow, because that is when Leaflet, the drawings, both WebGL
layers and the base image all arrive at once (~600 ms, watched). So an effect sets `mapId` as soon
as a world has a map, WITHOUT navigating, choosing the target by the same rule `openMaps` uses (last
used, else the first). Use `setMapId`, never `openMap`: that would navigate, write `lastMapId`
(which matches main's dirty-flag regex — it would mark the world unsaved by opening it) and claim in
the log that someone went somewhere. It runs ONCE per renderer, which is once per world, since every
path that opens or resets a world reloads the renderer. **What could not stay as it was is the
fit:** inside `display:none` the host is 0×0 and the initial zoom, the pan bounds and the zoom FLOOR
all come from the viewport — `getBoundsZoom` asked to fit a world into no pixels answers -Infinity,
which becomes `minZoom` and locks the map. The sizing block lives in `applyFit`, which does nothing
at no size, and a **`useLayoutEffect`** on `active` runs it the first time the map is really shown.
Layout, not passive: the map is built at `setView([500, 500], 0)`, which in CRS.Simple is the
bottom-left corner at 1:1 pixels, and a passive effect runs after the paint — so the map appeared
zoomed into that corner and jumped out to the real view a frame later. `map.mounted` is its own log
event because `openMap` only writes `map.changed` when the id CHANGES, which stopped being true of
the first visit.

<a id="the-map-layer-mapviewtsx-1"></a>

## The map layer (`MapView.tsx`):

Leaflet + `CRS.Simple` + the leaflet-geoman drawing plugin, with polygons, paths and labels drawn in
WebGL (see the rendering split below). Leaflet's default zoom controls are off; instead there is a
fractional custom wheel-zoom handler: each tick adds to a TARGET zoom and a `requestAnimationFrame`
loop EASES the current zoom toward it (`cur + (target−cur)*0.2`) — smooth zoom instead of stepped
jumps. During the ease the map pane is moved by ONE CSS transform (`paintZoom`) and a real Leaflet
rebuild (`commitZoom`) happens only when the gesture settles or the zoom drifts past `COMMIT_SPAN`
(0.35; 1.5 was tried and visibly stretched polygons). Panning is rAF-throttled and pre-clamped by
`allowedPan` — handing Leaflet an offset past `maxBounds` makes it correct by
projecting/offsetting/unprojecting, which lands on a different sub-pixel every frame and vibrates
instead of stopping. `updateOverlaySizes` (DOM) runs every frame, but React state (HUD/scale bar)
updates only when the zoom settles (the `wheelZooming` flag — avoids 60fps re-render stutter).
zoomSnap:0; HUD and zoom-visibility sliders use `step="any"`. Polygon labels and marker icons are
screen-fixed in stock Leaflet; this project scales them manually with zoom in `updateOverlaySizes`
so they grow and shrink with the map.

<a id="the-rendering-split-pixilabelsts-pixishapests-pixi-v8-measur-2"></a>

## The rendering split (`pixiLabels.ts` + `pixiShapes.ts`, Pixi v8) — measured, not assumed:

labels were 93–96 % of all rasterisation, because a browser re-rasterises scaled content at every
new device scale and these scale continuously with the map. Both modules work in "layer point at
zoom 0" space with the container carrying `scale = 2^zoom` and `position = -origin`, so a zoom frame
is two numbers and one draw call. `getPixelOrigin()` is `._round()`ed by Leaflet — derive the origin
from `project(center, zoom) - size/2` or the whole layer shakes. `pixi.js/unsafe-eval` is REQUIRED
(Pixi builds shaders with `new Function()`); **do not relax the CSP instead** — a `.world` is
hostile input. The **interaction split is "display in WebGL, interact as a real Leaflet layer"**: a
map-level listener hit-tests `shapeSpecs` and calls the feature's own handler filed by id in
`featClick`, while layers keep their own listener for when they ARE in the DOM. **Whenever a tool is
active (`scale`/`nav` excepted), every shape goes back to Leaflet and the WebGL layer draws
nothing** — geoman only ever sees layers that are in the map, and snapping, the topological weld
that depends on it, delete mode's per-layer listener and drag mode all need real ones. Free-text
labels keep a transparent Leaflet marker as a grab handle; only their LOOK moved. Per-frame gates
(zoom range, the LOD that drops a name grown past 1.5 screen heights) live in `draw()` rather than
in the caller's list building, because they open and close mid-gesture with nothing else changing.
Do NOT cull by writing `visible`/`culled` per frame: in Pixi v8 that dirties the render group and
forces a batch rebuild (measured — it made lag worse everywhere). **A label's texture is exactly as
wide as the text MEASURED, and the measurement uses whatever font is loaded at that instant** — so
`pixiLabels` rebuilds on `document.fonts.ready` AND on `loadingdone`; without it the first view of a
world measured in the fallback serif and every label came out cut off part-way through (`Türkiye` as
`Türki`), which editing any name appeared to "fix" because that rebuilt them all. **Destroying is
where the memory leaks hide:** `graphics.destroy({children:true})` does NOT free the GraphicsContext
(Pixi frees it only for `destroy()` with no options or an explicit `context:true`) and
`text.destroy()` does not free its TextStyle — the shape rebuild runs every 0.35 of a zoom level, so
the missing option cost 260 MB/min and V8 could never reclaim it (`GraphicsContextSystem` keeps a
record per context uid until the context is destroyed). Since rendering is on demand, Pixi's
`postrender` collection never runs once the map stops, so an idle pass renders one frame (marking
the visible scene as just-used) and then calls `renderer.gc.run()`. **Never call
`TexturePool.clear()`/`CanvasPool.clear()`** — `returnTexture` assumes its bucket exists, so
clearing breaks the return path of textures still in use and throws on the next release. **WebGL
will not upload a cross-origin image**, and `world://` is another origin: the scheme declares
`corsEnabled`, its handler answers with `Access-Control-Allow-Origin`, and the loader sets
`crossOrigin` before `src` — a plain `Image`, since Pixi's `Assets.load` counts only http(s) as
absolute and mangles a custom scheme. Fill images rely on Pixi's default `textureSpace: 'local'` (=
objectBoundingBox); passing a matrix is worse than redundant, Pixi inverts it and appends it to the
normalisation it already did. Still DOM: derived region labels (rank/paint modes) and pins.

<a id="the-base-image-is-a-mipmapped-texture-in-the-shape-layer-set-3"></a>

## The base image is a mipmapped TEXTURE in the shape layer (`setBase` in `pixiShapes.ts`), and its frame is what stayed on the 2D canvas (`drawBase` in `MapView.tsx`).

It was an `L.imageOverlay` once, and that `<img>` was the most expensive thing on the map: Leaflet
resizes the element at every zoom commit and a size change makes Chromium DECODE the picture again
(170 ms in `ImageFrameGenerator::decodeAndScale` on a 4096×4096 png, back after every launch,
because the decoded copies are a cache that gets dropped). Then it was an `ImageBitmap` blitted per
frame, and `drawImage` still resampled 16.7M pixels at every new scale — 43–52 ms a frame, measured,
the largest thing left on the map. It is now uploaded ONCE with `autoGenerateMipmaps`, and the
hardware samples the level it needs: **a zoom costs nothing per frame** (first gesture 62–76 ms → 20
ms). Three rules came out of getting there. **Decode the BYTES, never the element** —
`createImageBitmap(blob)` scales on a background thread while `createImageBitmap(img)` decodes
synchronously on the main one, which is why the image is `fetch`ed and why the CSP carries
`connect-src 'self' world:`. **Upload while the map is still loading** (`setBase` draws a frame
immediately): left to the first frame that draws it, the one-time cost lands inside the user's first
gesture, which was the whole complaint. **The frame is not the picture** — the rim and shadow are
seven stroked rectangles a frame and stayed on their own canvas below, which is why the look is
unchanged; the sprite lives in a container BELOW `root` (a sibling, like `handleRoot`, because
`rebuild()` destroys everything under `root`), the shapes canvas sits at **z-350** so both stay
under Leaflet's overlay pane where the selected feature and geoman's layers are still real SVG, and
the texture is released explicitly on destroy (`children: true` frees display objects, not the
source — 67 MB per map switch). An image wider than `MAX_BASE_PX` (8192) is scaled once at load:
past the GPU limit an upload does not degrade, it fails. `.leaflet-map-pane` carries `will-change:
transform` so the pane is promoted before the first gesture rather than during it. **Two fixes were
tried and reverted, do not repeat them:** transforming the base canvas during the ease (a
viewport-sized canvas has nothing painted past its edges, so zooming out revealed blank margins) and
caching a pre-scaled copy (the redraw after one arrived asked for the next size, a request chain
that made every frame worse).

<a id="the-tool-panel-toolpaneltsx-4"></a>

## The tool panel (`ToolPanel.tsx`):

drawing defaults (`DrawSettings` — color, opacity, font, size) are stored in the `settings` table.
Every new drawing snapshots the defaults at creation into its own `style`; later default changes
never affect already-drawn shapes. **A drawing can JOIN an existing article** instead of getting one
of its own (an archipelago's islets, a realm's exclaves): a target picker in the tool popover,
session-only and reset by a map switch, and the always-visible link field in the selected-feature
panel. Both go through `lookOf` — ONE rule for "look like the article you are joining" (colour, fill
opacity, outline, line opacity, dash; read from THIS map, same geometry kind first; never
`from`/`to`, `text`, `board` or the zoom range, which say where and when a drawing is). When a
drawing leaves an article that is then empty — no drawings anywhere, no body, links or fields — that
article is deleted, because the app invented it at draw time; still as an undo step. **A polygon's
outline is derived from its fill** (`outlineColor` in api.ts): a quarter of the way to its own grey,
then darkened — one colour for both made every border glow. Polygons only; on a path or a pin the
stroke IS the content. Outline weight may be 0, which needs an inline `stroke-width: 0` because the
stylesheet floors it at 0.75px for hairlines.

<a id="hierarchy-government-system-parallel-ladders-5"></a>

## Hierarchy / government system (parallel ladders):

no schema change — everything lives in the `fields` JSON and the `hierarchyConfig` key in
`settings`. An entity writes free tags like `#county` into `fields.hierarchy` and a government-form
name like `feudal`/`nomadic` into `fields.government` (`EntityPage.tsx`). `hierarchy()` in `db.ts`
returns ALL entities (with raw `fields` JSON); `HierConfig` in `api.ts` overlays the user's
ordering: each government form has its own top-to-bottom rank ladder (`govs: {name, tags}[]`).
`ProjectPreferences.tsx` edits this in tabs (one per government form). The legacy single-ladder
`hierarchyConfig` shape is auto-converted in `getHierConfig()`. **De-jure parent chain:** each
entity carries a year-based parent history in `fields["parent"]` (JSON: `[{from: number|null, id}]`,
`ParentRec`/`getParents`/`parentAt` in `api.ts`; `from:null` = from the beginning) — the
barony→county→duchy chain builds from this, edited in the "Belongs to" block on EntityPage (the data
key stays `parent`). **Rank view (the realm view):** pressing a rank chip in `HierarchyPanel`
(`ActiveMode {kind:'kademe'}`) draws only BASE polygons, each painted in the color of its ancestor
at the displayed rank for that year (`fields.color` ?? `autoColor(name)`, changeable via the panel's
color picker) — higher ranks' borders are derived, never drawn separately. Resolution happens
DB-free in `applyYear` (the `parentHist`/`rungTargets`/`featEnt` refs). The old "filter" mode was
removed. **The default view (no mode) = a derived root view:** base polygons are painted in the
color of the entity at the TOP of that year's chain (no parent = top), and the root's name is
written as a single label over its LARGEST piece (`carrier` — no clustering, largest-piece rule;
tooltip updated via `setContent`). Entities that have a parent that year hide their own drawings;
additionally, "mosaic-governed" entities (any entity appearing in ANY year of the base polygons'
parent histories — `mosaicManaged`, computed as a closure) never show their own hand-drawn polygons
in ANY year (the hiding rules apply ONLY to polygons — pins and paths bound to an entity are
decoration and remain in every view) — after full annexation, the annexed state's old polygon does
not resurface; the region stays in the conqueror's color. Mosaic-less roots and entity-less
decorations/pins keep their own look. Conquest is thus visible in the default view too.

<a id="timeline-timelinetsx-6"></a>

## Timeline (`Timeline.tsx`):

the calendar is fully user-defined — the `timeline` key in `settings`: `{before, after, min, max,
year, periods}` (`TimelineConfig` in `api.ts`; years are signed integers, negative = before the
epoch; `formatYear` renders them). **The calendar is the world's; the YEAR THE SLIDER STANDS AT is
the map's** (`mapYears`, `getMapYear`/`saveMapYear`) — one world has one set of eras and one
chronology, but where you are reading from is a question per map, and sharing one number meant
opening a city plan silently moved the continent's borders to whatever year you had left it at. A
map with no entry yet opens at `timeline.year`, which is still written on every drag, so a new map
starts where you were rather than at zero. Two readers, one rule: Timeline's own load and MapView's
pre-draw seed (which exists so a polygon drawn before the strip resolves gets the right `from`) —
seeding from the project year while the strip showed the map's would put them a century apart for
exactly the window that seed covers. **The rail and the "this year" chips show this map's events
plus the locationless ones**; the ⚙ list is the editor and deliberately shows all of them. The strip
sits top-center over the map; the ⚙ popover edits era abbreviations, the range and named eras. Also
on the strip: ▶ playback (rAF loop, speeds 1×/5×/20× years/sec — reads via `cfgRef`/`speedRef`, no
stale closures), change-year ticks on the rail (the `changeYears` prop gathered in MapView's
`reloadFeatures` + era boundaries, native `datalist`), clickable era bands under the rail
(`autoColor(name)` colored), click-the-year manual entry, ←/→ keyboard stepping (while the strip is
open), ⏪/⏩ hold-to-repeat. **Events:** `timeline.events` (`{name, year, fid?, mid?}` — fid/mid: the
linked feature and its map) — right-click a feature → "Add event to this drawing" (the name comes
from an inline top form — Electron does not support `window.prompt`; year = the slider year when the
menu opened; the `eventsToken` prop makes Timeline reload its config while preserving slider
position), locationless events via the ⚙ popover. Clicking an event on another map switches there
first. Events show as dots on the rail; clicking jumps the year + flies to the linked feature and
flashes it twice (`focusFeature` — after the flash `applyYear` restores the canonical style). Entity
pages have a "Map history" block: all the entity's features as chips with year ranges, clicking
shows them on the map via App's `focus` mechanism (`featuresByEntity` returns style + map_name).
Feature dates live in `FeatureStyle.from/to` (style JSON — no schema change), entered in the
selected-feature panel's "Time" block. **The smoothness pattern:** `reloadFeatures` fills the
`allLayers`/`layerYears` refs while building layers; every slider tick runs only `applyYear` — it
adds/removes layers from the featureGroup, never touches the DB, never rebuilds. `reloadFeatures`
itself is generation-counted (`reloadGen`): under rapid successive calls (dragging a style slider)
only the latest generation touches the map, and clear+build sits in ONE synchronous block after the
awaits — moving the clear before the awaits makes the whole map flicker (happened, fixed).
`reloadFeatures` ends with `applyYear(yearRef.current)` so mode changes/undo don't break the date
filter. **Border evolution (two paths):** (1) Geometry change: right-click → "Change border from
this year on" (`forkFeature`) — forks the feature into a copy starting at the slider year, closes
the old one at year−1; the user nudges only the changed vertices with geoman editing. (2) **Conquest
(the main path, via hierarchy):** in rank view, "⚔ Conquest" in the panel → step 1: click the
conqueror's border base polygon (receiver = that entity's direct parent that year, `parentAt`); step
2: pick the conquered base polygons (white dashed highlight), OK → each picked entity's
`fields.parent` gains `{from: sliderYear, id: receiver}` (`commitConquest`, one undo record; a
second conquest in the same year overrides the previous). Dragging the slider back restores old
ownership automatically; conquest years become rail ticks. The old polygon→polygon `succ` system was
removed. Vertex interpolation is deliberately absent. **Topological weld (live, with Ctrl):** in
edit mode, when a vertex drag starts WITH CTRL HELD (`pm:markerdragstart`), neighbouring polygon
vertices sharing the same coordinate (EPS 0.01) are found into `dragPartners`; during
`pm:markerdrag` the partner vertices move along live (`setLatLngs`); on `pm:markerdragend` partners
are recorded into `weldTouched` (`{layer, oldGeom}`) and geoman markers refresh via disable/enable;
persisting is two-phase (`pm:update`, vertex editing only — not whole-polygon moves):
**`snapshotUpdates` SYNCHRONOUSLY** captures+clears layer geometries + `weldTouched` (deferred,
gestures would blend), **`commitGeometry` ASYNC** writes the main feature + partners to the DB in
one undo record. Writes are **serial** (the `geomSaveChain` promise chain): no commit starts before
the previous one, reload included, finishes — editing two neighbouring borders back-to-back used to
have reloads clobber each other (the old known weld bug, fixed). The partner's old geometry is
captured **from the live layer at dragstart** (not stale `wm.features`) → undo returns to the right
spot. A Ctrl-less drag is one-sided. Geoman snapping (on by default) is what makes neighbouring
borders share coordinates — partner matching relies on it.

<a id="map-modes-painting-religion-language-culture-7"></a>

## Map modes / painting (religion, language, culture…):

the dimensions are user-defined, in the `mapModes` key of `settings`: `{dims: string[], colors:
{dim: {value: hex}}}` (`MapModes` + `getMapModes`/`saveMapModes` in `api.ts`). Dimensions are
added/removed in Project Preferences; each added dimension appears as a field row on entity pages
(`fields.din = "İslam"` style — the assignment is a direct field, not a link; the old link-based
painting was removed as fragile). On the map, pressing a 🎨 chip in `HierarchyPanel` sends
`MapView.reloadFeatures` down the paint branch: color comes from the `fields[dim]` value
(`autoColor(value)` deterministically when unassigned in `colors`), empty values grey. **What a
derived view draws is "lowest rank, PLUS anything nothing lies under" (`inDerived`)**, not lowest
rank alone. A parent's own polygon is hidden because the mosaic beneath it already draws that land —
but a duchy with no counties yet has no mosaic, and hiding it meant the region VANISHED the moment a
filter was pressed while the panel went on listing the entry and its colour. `mosaicManaged` is
already "something below points at me", so it answers this too; ranks only, so an untagged drawing
still stays out and a filter still narrows the map. Note the honest consequence: that duchy also
appears, grey and unlabelled, in the COUNTY view, which is the same thing a base polygon with no
owner at the displayed rank has always done. The active mode between panel + MapView is one type:
`ActiveMode = {kind: 'kademe'|'boya', key} | null` (defined in `HierarchyPanel.tsx`; the kind
strings are internal state constants). **The panel's LISTS are scoped to the open map** (`mapScope`,
built in `reloadFeatures` beside `mosaicManaged` and passed down as a prop): `api.hierarchy()`
returns every entity in the world — correctly, that is what makes a chain resolve across maps — and
the panel was rendering all of them, so a realm drawn only on another map sat under a rank chip here
and a religion practised only there took a colour row in the legend. The scope is two sets and the
second is the easy one to miss: entries DRAWN here, plus every entry that RULES land here without a
drawing of its own (a duchy whose counties are on this map is exactly what the duchy view paints) —
which is `mosaicManaged`, already built per map for the `inDerived` rule above. **The chips are not
filtered**, only what is under them: the ladder is project structure and a rank with nothing beneath
it stays pressable. One filter feeds both lists, so they cannot drift apart. **Derived region
labels:** in rank/paint modes every same-group ADJACENT base-polygon cluster gets a name label
(`rebuildDerivedLabels`, MapView): adjacency is TWO tests, and the second is not optional: a shared
vertex grid cell (EPS=0.01, union-find) catches neighbours that share a CORNER, which is what geoman
produces when a vertex is dragged onto a vertex — but it snaps a vertex onto an EDGE just as
readily, and that leaves the other polygon with no vertex there at all. Those T-junctions share a
real border and not one coordinate, so a realm drawn that way got its name written once per piece:
the repeated label. `ringsTouch` (vertex-to-segment, both directions) runs as a second pass over
pairs still in different components whose boxes overlap. **Its tolerance is a FRACTION of the map's
long side (`ADJ_FRAC`, 0.001), not the vertex grid's 0.01** — measured on a real world, borders that
look welded sit 0.039 to 0.14 units apart on a 1024-unit map (snapping residue, a hundredth of a
pixel, nothing anyone drew), while genuinely separate regions on that same map start at 18.8. A
hundredfold between the two populations, so the line is not a close call; a flat 0.01 sat below BOTH
and caught nothing on real data — the ordinary case costs a `find()` and nothing more (400 adjacent
polygons: 36-70 ms, unchanged), the contrived one is polygons overlapping by box that never touch
(60 × 102-vertex slivers: 330 ms, on a mode switch, not per frame). Angle = the component vertices'
PCA main axis (`pcaAxis`, normalized to ±90), **with the closing vertex dropped and near-isotropic
shapes written level**. Both were real tilt: GeoJSON closes a ring by repeating its first vertex,
and that duplicate is a genuine weight in the covariance AND in `ringCentroid` — it pulls both
toward one corner, measured at −10.9° on a 1.5:1 rectangle and −3.6° on a 3:1, on every derived
label, always the same way; and when the two eigenvalues are too close to call, `atan2` answers with
whatever the rounding leaned toward, so a square came out at 45°. `ANISO_MIN` (0.15, just under
1.2:1) is the cutoff. Anchor = the component's area-weighted centroid (the label sits over the whole
cluster), the base font spreads the text over ~80% of the axis width (hidden below `LABEL_MIN`),
look = `labelDivIcon` (slight arc, curve:10). The labels are NOT DB features — transient markers
added straight to the map (`derivedLabels` ref; not in the featureGroup → exempt from clearLayers
churn and geoman; `interactive:false` is required — conquest clicks fall through). Called
unconditionally at the end of `applyYear`; the `derivedSig` signature makes ownership-unchanged year
ticks free. Zoom scaling is a single fontSize write at the end of `updateOverlaySizes` (the hot-path
contract). The geometry summary is written to the `labelGeo` ref in reloadFeatures (derived modes
only); paint texts live in `dimValue`.

<a id="the-path-tool-lines-8"></a>

## The path tool (lines):

〰 Path in the tool panel, geoman `Line` drawing → GeoJSON LineString (no schema change). Style:
color/weight/opacity/pattern (`FeatureStyle.opacity`/`dash`; `LineDash` in `ToolPanel.tsx` +
`lineDashArray(dash, weight)` produces the dashArray). `renderStyle` also carries
`opacity`+`dashArray` and `applyYear` applies them in setStyle (the canonical pattern survives; the
conquest highlight's `dashArray` is still cleared). Lines hide in rank/paint modes (the `isPolygon`
filter); year ranges (from/to), entity binding and undo are shared with polygons. The selected panel
has three branches: polygon/path/pin.

<a id="map-scale-mapviewtsx-toolpaneltsx-9"></a>

## Map scale (`MapView.tsx` + `ToolPanel.tsx`):

the 📏 Scale tool in the right panel (no geoman mode). The unit is free text; two calibration
methods: numeric "map width = N units" (`perUnit = N / worldMap.width`) or a two-point measurement
on the map — both write per-map into the `mapScales` key of `settings` (`{[mapId]: {perUnit,
unit}}`, `persistScale`). Unsaved measuring sub-tools: distance ruler + area (transient layer, a
`Measure` session, cleared by Esc/tool switch). CRS.Simple is planar so the math is pure
Euclid/shoelace (`ringLen`/`ringArea`): length on a selected path, area+perimeter on a polygon, a
zoom-aware scale bar bottom-left (kept in exports).

<a id="custom-pin-images-mapviewtsx-piniconstsx-10"></a>

## Custom pin images (`MapView.tsx` + `pinIcons.tsx`):

the embedded glyph icon set (the old `PIN_ICONS`/`PinGlyph`/`PinIconPicker`) was REMOVED entirely at
the user's request — only the **external image** (upload your own) feature remains. `pinIcons.tsx`
exports `ImageStrip` (the image library strip; pins and polygon fills share it) and, added later, a
small set of ABSTRACT MARKS — `PIN_SHAPES`/`pinShapeBody`/`PinShapePicker`, eight silhouettes (disc,
ring, ringed dot, star, diamond, square, triangle, cross), not pictograms. `pinDivIcon` has three
branches — `img && imgFree` → frameless image (aspect kept, `iconSize [0,0]` +
`translate(-50%,-50%)`), `img` → image clipped to a circle inside the badge, otherwise the
`style.shape` mark (absent = the first in the list, a disc). **A style snapshot that forgets `shape`
is invisible as a bug**, because that fallback is a perfectly good pin: `pm:create` dropped it for a
while and every pin came out a disc while the preview showed the right mark. The DRAW PREVIEW is the
hint marker, which is outside the featureGroup and so is never visited by `updateOverlaySizes` —
`hintPinIcon` bakes `2^zoom` into its size (and `styleHintLabel` does the label's equivalent) or the
preview is a different size from the pin it previews. Data: `FeatureStyle.img/imgFree/imgAR` (no
schema change; the `FeatureStyle.icon`/`DrawSettings.marker.icon` fields were deleted). **`imgAR` is
stored in the pin's own style** — so it renders independently of the library. The library is
`pinImages` in `settings` = `{path, ar}[]` (`getPinImages`/`savePinImages` in `api.ts`). In the
panel (ToolPanel marker branch + the selected-pin panel): the `ImageStrip` + a Badge/Free toggle;
the color picker hides in free mode. Upload via `api.pickImage()` (copies into assets + validates
extension) + a `new Image()` load-probe (ratio + decodability). Asset files are not deleted
immediately (removing from the library only drops the record) but unused ones are collected
**automatically**: `pruneUnusedAssets()` in `db.ts` — files whose names appear nowhere in the DB
text (fields/content/style/image_path/layers/settings) are deleted (conservative matching — never
deletes one in use). Called at the start of `packWorld` (save) + end of `unpackWorld` (open)
(moments where the undo stack is irrelevant). Fully automatic — no UI. Shrinks the `.world` too.

<a id="polygon-fill-images-mapviewtsx-11"></a>

## Polygon fill images (`MapView.tsx`):

`FeatureStyle.fillImg` — an SVG `<pattern>` defined once per image in hidden defs (`fillPatternId`),
the polygon filled via `fillColor: url(#…)` (Leaflet writes fillColor as-is into the attribute).
**`patternContentUnits="objectBoundingBox"` + `preserveAspectRatio="none"`** — the image stretches
over the polygon's bbox and scales with it on zoom (do NOT return to screen-fixed tiling: zoomed
out, the pattern repeated and broke). Image-filled polygons **require `noClip: true`**: Leaflet's
viewport clipping shrinks the path's bbox and the pattern stretches over the clipped piece, sliding
on zoom/pan. `renderStyle.fillColor` is a separate field; root/rank overrides turn it into a flat
color too — fill images are deliberately void in the political mosaic. `fill-opacity` works
naturally over a pattern (the opacity slider is unchanged). The library is shared with pins
(`pinImages`), UI is `ImageStrip` (pinIcons.tsx); both panels have a "Remove fill image" button (the
library × only removes from the list).

<a id="free-text-labels-mapviewtsx-12"></a>

## Free text labels (`MapView.tsx`):

the 🏷 Label tool — map text without polygon or pin. A label = **Point geometry + `style.text`**
(pins are Point too; this field is the discriminator — `isLabel`/`selIsLabel` always check it, no
schema change). **The text is drawn by `pixiLabels.ts`** (one `Text` for a straight run, one per
glyph along the arc for a curved one — a long curved name is therefore many objects); what stays in
Leaflet is a transparent marker sized by `labelHit` as the grab handle, so dragging, selection and
geoman still work on a real layer. `labelDivIcon` survives only for the draw-tool PREVIEW
(`styleHintLabel` — the hint marker is outside the featureGroup, so `updateOverlaySizes` never
visits it and size/font changes were invisible until placement). **The grab box is MEASURED, not
estimated** (`LabelLayer.extentOf`): the old letters×0.62em guess could not know the font's metrics,
the letter spacing, or how far a curve throws the glyphs, and what the box missed fell through to
the polygon underneath — clicking a region's name selected the region. The angle is folded in as the
axis-aligned rectangle around the rotated text; do NOT rotate the element with `transform`, which is
the property Leaflet's Draggable writes during a drag (one property, two writers — dragging broke).
**A dragged label needs two paths**: `moveLabel` moves one node per frame with no re-measure so the
glyphs follow the drag, and `freeSpec` is updated at `pm:dragend` so the next rebuild agrees —
handing `setLabels` a new list per frame re-lays out every glyph run on the map. Labels also carry
`halo` (none/light/dark) + `haloWidth`, `tracking`, `bold`, `italic`; `same()` in pixiLabels
compares them, since it is what decides whether the scene is rebuilt at all. A polygon can switch
its own name off (`style.hideName`) and be named by a hand-placed label bound to the same article
instead. **`markerSize` is set only for `!isPolygon && !isLabel`** — otherwise labels fall into pin
badge scaling. `pm:create` distinguishes a label via `toolRef.current === 'label'` (geoman calls
both `shape:'Marker'`). `featKind`'s `'label'` value binds to the layers panel's 🏷 toggle (both
polygon names and free text).

<a id="navigation-mapviewtsx-toolpaneltsx-13"></a>

## Navigation (`MapView.tsx` + `ToolPanel.tsx`):

the 🧭 Route tool — pick two pins, the route is computed over the drawn road network (hand-written
graph + Dijkstra, module level: `buildNavGraph`/`navRoute`/`projectOnSeg`; no dependency). Junctions
= vertices coinciding within `findOrAdd`'s tolerance (the map's long edge/500); pins join the
nearest segment's chain as nodes; a distant pin connects via a `fid = -1` "off-road" edge. Data
comes from `worldMapRef` (not the refs — pin/path refs stay empty in derived modes). Travel modes
are a free list, **per map**: `travelModes` in `settings` = `{[mapId]: {name, speed}[]}` (speed =
units/day). Per map because the UNIT is — `mapScales` is per map, so one project-wide "horse: 60"
read as 60 km/day on a continent measured in km and 60 m/day on a city measured in metres, the same
number saying two different things. A bare array under the key is the pre-per-map value and becomes
that map's starting point rather than vanishing. The session copies the `Measure` pattern
(`navRef`/`navTemp`/`endNav`). Roads that cross without sharing a vertex are deliberately not
connected.

<a id="boards-drawing-layers-mapviewtsx-apits-14"></a>

## Boards / drawing layers (`MapView.tsx` + `api.ts`):

multiple named boards over the same map (the same mental model as image-editor layers, NO external
images). A "📚 Boards" menu in the toolbar. Each feature's `style.board` = a board id (no schema
change); list+active in `settings.mapBoards` = `{[mapId]: {list:{id,name}[], active}}`
(`getMapBoards`/`saveMapBoards`). New features are tagged to `boardsRef.current.active` in
`pm:create` (when boards exist). Visibility: `onActiveBoard(fid)` added to the single gate in
`applyYear` — all kinds + carrier/rebuildDerivedLabels; DB-free. Robustness: `resolveBoard` drops an
undefined/orphan board id to list[0] (rename never breaks features — bound by id; deleting a board
orphans nothing; one resolution rule, no rewriting). When the first board is created, untagged
existing features show on it. id = `crypto.randomUUID()`. `style.board` is in FeatureStyle.

<a id="map-switching-mapviewtsx-apptsx-15"></a>

## Map switching (`MapView.tsx` + `App.tsx`):

switching between maps lives in the map toolbar's "🗺 Maps" dropdown, NOT a sidebar list
(radio=active→switch, inline rename uncontrolled+onBlur, × deletes [non-active; `deleteMapWithUndo`
— moved from App, `pushUndo`/`restoreMap`], a real TREE — children under their parent, one level of
indent each, a twisty on anything with children, collapsed branches as session state; "＋ New map"
creates INSIDE the open map by default, and right-click moves a map to the top level or under any
map **outside its own subtree**. That cycle guard sits where a cycle would be created, not in the
breadcrumb walk that would hang on one; a map whose parent is deleted returns to the top rather than
vanishing, the same rule boards use for an orphan id. `parent_map_id` had been in the schema from
the start with nothing rendering it and only a picker on a DRAWING able to set it — that picker
("Child map (door)") is gone, because a map's place in the tree is not a property of a polygon). The
sidebar has a single "🗺 Maps" nav row (`openMaps`: opens the LAST USED map / else the first / else
creates one). Last used = `settings.lastMapId`, written by App's `openMap` on every open (all
switches pass through it) → travels with the `.world`. List order is **insertion order** (`listMaps`
→ `ORDER BY id`, not alphabetical; asserted in the db self-check). Drawing isolation is
architectural: `reloadFeatures` draws only `api.getMap(id).features`; every map shows its own
drawings.

<a id="zoombased-visibility-mapviewtsx-16"></a>

## Zoom-based visibility (`MapView.tsx`):

per-pin/label `style.minZoom/maxZoom` (FeatureStyle; no schema change). The user picks the threshold
WITH A SLIDER in the selected pin/label panel (tick the box → starts at the current zoom, fine-tune
with the slider, read as a percentage; `zoomVisControls`/`zoomVisRow`, shared with `hudRange`).
`reloadFeatures` fills the `zoomLimits` ref; `applyYear` applies the `zoomOk(fid)` gate last and
writes non-zoom visibility into the `baseVisible` ref; on zoom (`map.on('zoom zoomend')`) the light
`refreshZoomVis` toggles only features in `zoomLimits`, preserving baseVisible (markers carry no
style → re-adding suffices; before `updateOverlaySizes`). The decluttering answer for crowded maps.

<a id="map-search-pin-filter-mapviewtsx-17"></a>

## Map search + pin filter (`MapView.tsx`):

a search box in the toolbar — the match source is `entity_name` ?? `style.text` over
`worldMap.features`, click/Enter on a result → `focusFeature` (fly + flash), Esc closes; the list is
in `useMemo` (zoom HUD renders must not trigger per-feature JSON.parse). "Pin types" chips in the
layers panel: pins hide by their bound entity's type (the `pinType` ref fid→type, `''` =
entity-less; visibility via `pinHiddenRef` in `applyYear`'s layer gate). The filter is deliberately
session-only (types can be renamed — a persisted record would go stale).

<a id="multiselect-clipboard-mapviewtsx-18"></a>

## Multi-select + clipboard (`MapView.tsx`):

`selected` remains the PRIMARY selection (the panel shows its controls), `extraSel` holds Ctrl+click
additions; `selIds = [primary, ...extra]`. The panel controls are unchanged — `editSelectedStyle`
applies the patch to ALL of `selIds` (each over its own style, ONE undo record: `styleEditRef` is
now `{key, items[]}`), so there is no separate "bulk edit" UI. Del/Backspace also deletes the whole
selection in one undo record (`removeFeature(...fids)`). **The highlight is a CSS class, NOT
setStyle** (`.sel-feature`): a style write would bury the polygon's color while the user edits it in
the panel; **the mark itself is two things and BOTH renderers have to agree on them**, because in a
multi-selection the primary is a Leaflet layer and the rest are WebGL — a 2 screen-px boost to the
drawing's OWN stroke (`SEL_BOOST_PX` / `.leaflet-overlay-pane path.sel-feature`), plus a thin
translucent dark rim (`SEL_HALO_PX`/`_COLOR`/`_ALPHA` / the `.sel-feature` drop-shadow). It was a
5px BLACK drop-shadow for a long time, which around a 3px road is a second and darker road, and then
a wide white glow, which around a polygon erases the neighbouring borders the selection has to be
read against. **Width was the bug both times, not colour** — a selection mark is thin. The boost
carries the signal because it is the drawing's own colour: any single rim colour loses on some
terrain (white over pale ground, a shading over dark), weight loses on none. A weight of 0 is exempt
in both renderers — no outline is a choice, and selecting must not draw a line its author turned
off; `getElement()` works for both SVG paths and divIcons, and since `applyYear` rebuilds layers it
calls `markSelection()` at the end (diff applied, no full scan). **Clipboard (Ctrl+C/V/D):**
`clipboard` is MODULE level (MapView remounts on map switch — as a ref, cross-map pasting would be
impossible; writes go through `setClipboard`, since `react-hooks/immutability` bans writing outer
variables from components). Ctrl+V puts the group's CENTRE under the cursor (the `lastMouse` ref
from `map.on('mousemove')`; never enters React state), Ctrl+D duplicates with a fixed offset and
leaves the clipboard alone. New features are tagged to the active board, one undo record, and the
new copies come back selected. Geometry shifting is `shiftCoords`/`eachPoint` (recursive — no
Point/LineString/Polygon branching).

<a id="a-shape-ends-its-tool-a-pin-or-a-label-does-not-19"></a>

## A SHAPE ends its tool; a pin or a label does not.

A polygon or a path has a definite end — you close the ring and you are done — and leaving the tool
armed meant the next click started a shape nobody asked for. Pins and labels keep `continueDrawing`
(set globally at map setup), because you rarely place exactly one. `pm:create` ends the tool through
**`activateTool`**, not by clearing `toolRef`: geoman has ALREADY re-armed itself by then, so the
draw session has to be disabled as well as the state cleared, and the toolbar button, the
`tool.changed` line and `syncEditMode` all hang off that one door. It is reached through a useLatest
ref (`activateLatest`) because `pm:create` is bound once per map and would otherwise hold the first
render's closure.

<a id="the-context-menu-contextmenutsx-is-one-component-behind-six--20"></a>

## The context menu (`ContextMenu.tsx`) is one component behind six call sites, and what makes it contextual is the SUBJECT, not the items.

`MenuState` carries an optional `header` (colour swatch + name + kind), an optional `swatches` row
(recent colours + the picker's presets, which recolours in one gesture), and `items: MenuEntry[]`
where an entry is a `MenuItem` or the string `'sep'`; leading, trailing and doubled rules are
dropped at RENDER, so a menu built with conditional `push` calls cannot produce a stray one.
`MenuItem.hint` is the shortcut for that exact row and appears **only where it is true from there**
— two places. Past `FILTER_AT` (10) rows the menu grows a filter field and focuses it, which is what
the map tree's one-row-per-map "Move under…" needs; a submenu was rejected, a flyout off a context
menu closes the moment the pointer strays off its parent row. The position is clamped against the
MEASURED box in a layout effect (the old estimate could not survive a header, a swatch row or a long
label, and what a menu loses off the bottom of the screen is its last item, usually Delete).
**Right-clicking a drawing SELECTS it** unless it is already inside a multi-selection — which is
what retired the "Show in panel" item, and what makes the `Del` hint true. **A drawing's menu offers
what that KIND of drawing can be**: "Edit shape" is polygons and paths (a marker has no vertices,
and geoman on one offers only the dragging that "Move" already does), "Change border from this year"
is polygons alone. The four drawing tools in the map's own menu all ARM — placing a pin and a label
at the clicked point was built and taken back out, because two of the four then finished immediately
while the other two waited, and a polygon cannot be placed from a point at all. "Paste here" is the
one item the click position still decides.

<a id="a-draw-session-owns-the-right-button-outright-and-that-takes-21"></a>

## A draw session owns the right button OUTRIGHT, and that takes both handlers.

Right-click takes back the last vertex, and it used to land about half the time. The check sat below
the map handler's "over a feature, let the layer handle it" guard — and while you are drawing that
guard is true most of the time, since geoman's rubber band follows the cursor and a world is mostly
covered in polygons, all of them `leaflet-interactive`. Moving it to the top fixed half. The other
half only appeared by RUNNING it: Leaflet fires `contextmenu` on the layer AND on the map, so over
an existing polygon the vertex came off and the feature menu opened on top of it. **The per-feature
`layer.on('contextmenu')` stands down during a draw session too.** If either handler is touched,
keep both halves.

<a id="other-map-behaviors-22"></a>

## Other map behaviors:

geoman's own "Click to place marker" hints are disabled at map setup (`map.pm.setGlobalOptions({
tooltips: false })`). Del/Backspace deletes the selected feature (not while typing into an input).
**Shift+wheel:** wheel with Shift held adjusts size/thickness instead of zooming — the selected
feature's when one is selected, otherwise the active draw tool's DEFAULT (`drawRef` →
`updateDrawSettings`, adjust before placing). `updateDrawSettings` never re-creates an open draw
session (`inst.enabled()`): geoman's `enable()` spawns the hint marker at
`L.marker(map.getCenter())`, so the preview leapt to the centre on every tick — when open, the icon
applies via `_hintMarker.setIcon` and paths via `_layer.setStyle` (begun vertices survive too). The
shared path is `applyDrawStyle` — both `activateTool` and `updateDrawSettings` call it. The label
preview additionally needs `styleHintLabel`: `labelDivIcon` does not bake size into the html
(fontSize is written externally) and the hint marker is outside the featureGroup so
`updateOverlaySizes` never visited it — size/font changes were invisible until placement; now
written in `applyDrawStyle` and at the end of `updateOverlaySizes` (while the tool is `label`) with
the same `LABEL_BASE × size × 2^zoom` formula — pin/label `size` (±0.25, 0.5–10), path/polygon
`weight` (±1; path 1–12, polygon 1–10). The `e.shiftKey` branch lives in `onWheel`; adjusting goes
through `wheelAdjustRef` (refreshed every render via the useLatest pattern, through
`editSelectedStyle` → one undo + reloadGen, no flicker). (Polygon labels used to be Leaflet tooltips
and were the single biggest cost on the map — `Tooltip._setPosition` reads `offsetWidth` in every
direction branch, a forced synchronous layout per label per frame. They are WebGL now; do not
reintroduce a tooltip for anything that scales with zoom.) Geoman vertex handles are deliberately
screen-fixed (scaling was tried and reverted over reflow lag with hundreds of points; a
transform-based approach could revisit it). **`L.Marker.prototype._setPos` is patched at module
level to place icons with `left/top` instead of Leaflet's `translate3d`** — an element with its own
3D transform gets its own compositing layer, which is invisible at 117 pins and ruinous in edit mode
where geoman puts a draggable element on every vertex plus one between each pair (measured: 426
layers per frame → 5, Commit 625 ms/s → 15, 27 fps → 56–180). **The handles are then SPLIT:** a
geoman handle both shows where a vertex is and can be dragged, and only the second needs a DOM
element — so every vertex and midpoint is drawn as a dot by `ShapeLayer.setHandles` (free), geoman
keeps real handles for just the 20 nearest the cursor (`EDIT_OPTS`, which must be passed at each
`pm.enable()` — `setGlobalOptions` never reaches a per-layer enable), and those are `opacity: 0` in
CSS so everything visible comes from WebGL. Drawing only the *unhandled* vertices was tried and is
what makes it twitch under the cursor; draw them ALL. The dots are read live off the Leaflet layer
and refreshed on `pm:markerdrag` (otherwise a dragged vertex leaves its dot behind), midpoints are
computed per RING, and the handle container is a SIBLING of the shape root since `rebuild()`
destroys everything under it. **Edit mode applies ONLY to the selected feature (`syncEditMode`):**
`enableGlobalEditMode()` spawned vertex markers on every polygon/path (hundreds of points) and
stuttered — removed. Edit now calls `pm.enable()` only on the layers of `selectedRef.current` and
`pm.disable()` elsewhere; called only on state changes (no-op otherwise), heavy marker creation for
one feature. `syncEditMode` is called from: tool switching (`activateTool`), the selection/tool
effect (`[selected, tool]`), the end of `reloadFeatures`, and layer re-adds in
applyYear/refreshZoomVis (guarded by `toolRef==='edit' && selectedRef.current?.id === fid`).
Clicking a feature in edit mode selects it → the effect moves editing there. Weld (Ctrl+drag) is
unaffected: partner vertices are found by coordinate and moved programmatically via `setLatLngs`;
the neighbour need not be in edit mode.

<a id="a-map-with-no-base-image-23"></a>

## A map with no base image

says so in the MIDDLE of the map (`.map-empty`, an `EmptyState` card), not with a button at the end
of the toolbar; the wrapper takes no pointer events so an empty map is still pannable, and it sits
inside the `exporting` guard so it never lands in a PNG. "Work without one" dismisses it for good —
a list of map ids in `settings.hideMapHint`, the shape `mapScales`/`mapBoards` already use, because
someone working without a base image would otherwise dismiss the same invitation every launch.

<a id="sliders-are-the-platforms-24"></a>

## Sliders are the PLATFORM's,

tinted with `accent-color`. The hand-built version (`appearance: none` + a rebuilt track and thumb)
had no FILLED portion, because that is the one part CSS alone cannot rebuild — Chromium has no
slider-progress pseudo-element, and painting it takes the value as a custom property, i.e. JS on
every one of two dozen sliders. Do not reintroduce `appearance: none` without solving the fill.
