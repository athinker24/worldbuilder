import 'pixi.js/unsafe-eval'
import { Application, Container, Graphics, ImageSource, Sprite, Texture } from 'pixi.js'
import { GC_IDLE_MS, GC_UNUSED_MS } from './pixiLabels'

// Polygons and paths, drawn in WebGL rather than as SVG.
//
// WHY. The wheel ease scales the map pane with one CSS transform and only rebuilds for real when
// the gesture settles or drifts past COMMIT_SPAN. That made ordinary frames cheap — 2.6 ms of JS
// per frame down to 0.96, Paint 137 ms/s down to 69, 83 fps up to 127 — but every rebuild is still
// Leaflet reprojecting every vertex and rewriting every `d`, and one expensive frame among cheap
// ones is felt as a catch. Widening the span to make them rarer traded the catch for visibly
// stretched polygons, which was worse.
//
// There is no setting that fixes both, because the two costs are the same cost seen from either
// end. A WebGL layer does not have it: geometry is uploaded once and a zoom is a matrix, so there
// is nothing to rebuild and nothing to stretch.
//
// Same conventions as pixiLabels.ts, deliberately: geometry in "layer point at zoom 0" space, the
// container carrying scale = 2^zoom and position = -origin, and no Leaflet import anywhere in the
// file so the renderer-containment rule in CLAUDE.md keeps holding.

/** A polygon (one outer ring plus holes) or an open path, in zoom-0 coordinates. */
export type ShapeSpec = {
  id: number
  /** [ring][point] = [x, y]. A path has exactly one ring and is not closed or filled. */
  rings: number[][][]
  closed: boolean
  fill: number | null
  /**
   * A fill image, as a URL. Stretched over the shape's bounding box and scaled with it, which is
   * what the SVG `<pattern>` this replaces did with objectBoundingBox + preserveAspectRatio=none.
   * Until it has loaded — and if it fails to — `fill` is used, so a polygon is never blank.
   */
  fillImg?: string
  fillAlpha: number
  stroke: number
  strokeAlpha: number
  /** Stroke width in SCREEN pixels — polygons deliberately do not thicken as you zoom in. */
  weight: number
  /** Dash pattern in screen pixels, empty for solid. */
  dash: number[]
  /** Draw a direction arrowhead at the last point (open paths only). */
  arrow?: boolean
  /** Draw the selection halo. Replaces the `.sel-feature` drop-shadow the SVG paths used to wear. */
  selected?: boolean
}

/**
 * Walk a ring, emitting only the "on" spans of a dash pattern.
 *
 * Pixi has no dashed stroke, and the alternative — leaving paths solid — loses the distinction
 * between a road, a border and a route, which the map uses to mean different things. Cutting the
 * geometry is the standard answer and it is cheap here because it happens when shapes are built,
 * not per frame. Lengths are in screen pixels, so they are divided by the scale like stroke widths.
 */
const dashRing = (
  ring: number[][],
  pattern: number[],
  scale: number,
  emit: (a: number[], b: number[]) => void
): void => {
  // The floor is a fraction of the RING, not a constant, and that is a security property rather
  // than a nicety. The pattern comes from lineDashArray(dash, weight), and `weight` is read
  // straight out of a feature's style — i.e. straight out of a `.dunya` someone sent you. With a
  // weight of 1e-9 (or a negative one) every entry lands on the old fixed 1e-6 floor, and this
  // loop then walks a ring thousands of units long in millionths: the renderer hangs the moment
  // the map opens, before anything is drawn to say why.
  //
  // Scaling the floor to the ring bounds the loop by construction — at most MAX_DASH_STEPS
  // segments however small the pattern claims to be — and changes nothing for a real one, where
  // the entries are whole pixels and this floor is orders of magnitude below them.
  const MAX_DASH_STEPS = 4000
  let len = 0
  for (let i = 1; i < ring.length; i++)
    len += Math.hypot(ring[i][0] - ring[i - 1][0], ring[i][1] - ring[i - 1][1])
  const floor = Math.max(len / MAX_DASH_STEPS, 1e-6)
  const pat = pattern.map((v) => Math.max(v / scale, floor))
  let idx = 0
  let left = pat[0]
  let on = true
  for (let i = 1; i < ring.length; i++) {
    let [ax, ay] = ring[i - 1]
    const [bx, by] = ring[i]
    let rest = Math.hypot(bx - ax, by - ay)
    while (rest > left) {
      const t = left / rest
      const mx = ax + (bx - ax) * t
      const my = ay + (by - ay) * t
      if (on) emit([ax, ay], [mx, my])
      ax = mx
      ay = my
      rest -= left
      idx = (idx + 1) % pat.length
      left = pat[idx]
      on = !on
    }
    if (on) emit([ax, ay], [bx, by])
    left -= rest
  }
}

type Built = { spec: ShapeSpec; view: Graphics }

/** Would these two lists draw the same picture? See setShapes for why it is worth asking. */
const same = (a: ShapeSpec[], b: ShapeSpec[]): boolean => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (
      x.id !== y.id ||
      x.rings !== y.rings ||
      x.closed !== y.closed ||
      x.fill !== y.fill ||
      x.fillImg !== y.fillImg ||
      x.fillAlpha !== y.fillAlpha ||
      x.stroke !== y.stroke ||
      x.strokeAlpha !== y.strokeAlpha ||
      x.weight !== y.weight ||
      x.arrow !== y.arrow ||
      x.selected !== y.selected ||
      x.dash.length !== y.dash.length ||
      x.dash.some((v, j) => v !== y.dash[j])
    )
      return false
  }
  return true
}

/**
 * A CSS colour string as a number, for Pixi. Only the hex forms the app actually stores are
 * understood; anything else — notably the `url(#pattern)` a polygon fill image resolves to, which
 * has no WebGL equivalent yet — falls back rather than throwing, so an unsupported fill shows in a
 * plain colour instead of taking the map down.
 */
export const hexNum = (css: string | undefined, fallback = 0x888888): number => {
  if (!css || css[0] !== '#') return fallback
  const h = css.slice(1)
  if (h.length === 3) return parseInt(h[0] + h[0] + h[1] + h[1] + h[2] + h[2], 16)
  if (h.length === 6) return parseInt(h, 16)
  return fallback
}

/**
 * How far the zoom may drift before stroke widths are redrawn.
 *
 * Strokes are the one thing that cannot simply ride the container's scale. Their width is in
 * screen pixels by design — a border that fattens as you zoom in reads as a mistake — so it has to
 * be divided by the current scale, which bakes the scale into the geometry. Redrawing on every
 * frame would be the very cost this layer exists to remove, so it happens on the same cadence the
 * map already rebuilds at: strokes stretch a little mid-gesture, exactly as they do today under
 * the CSS transform, and come back true when it settles.
 */
const STROKE_REDRAW_SPAN = 0.35

// Vertex and midpoint dots, in SCREEN pixels, matched to geoman's own handles: a 14 px white
// circle with a blue rim for a vertex, a smaller and fainter one for the midpoint between two.
const HANDLE_R = 6
const MID_R = 4
const MID_ALPHA = 0.7
const HANDLE_FILL = 0xffffff
const HANDLE_RIM = 0x3388ff

export class ShapeLayer {
  private app: Application | null = null
  private root = new Container()
  /** Vertex dots for the shape being edited. Own container so shapes and dots rebuild apart. */
  private handleRoot = new Container()
  private handles: number[][] = []
  private mids: number[][] = []
  /** The last view draw() was given, so setHandles can re-render without one. */
  private last: [number, number, number, number, number] | null = null
  private specs: ShapeSpec[] = []
  private built: Built[] = []
  /** The scale the current stroke widths were computed for. */
  private strokeScale = 1
  private hiddenId: number | null = null
  private disposed = false
  /** url → the loaded texture, or null while it is in flight / after it failed. */
  private textures = new Map<string, Texture | null>()
  /**
   * The base image, as a textured quad.
   *
   * Its own container, added BELOW root, for the same reason handleRoot is a sibling: rebuild()
   * destroys everything under root and this must survive it. Carries the same scale and position,
   * set together in draw().
   */
  private baseRoot = new Container()
  private baseSprite: Sprite | null = null
  private onLoaded: () => void
  private idle: ReturnType<typeof setTimeout> | null = null
  readonly ready: Promise<void>

  constructor(canvas: HTMLCanvasElement, onLoaded: () => void = () => {}) {
    this.onLoaded = onLoaded
    const app = new Application()
    this.ready = app
      .init({
        canvas,
        backgroundAlpha: 0,
        antialias: true,
        autoStart: false,
        preference: 'webgl',
        gcMaxUnusedTime: GC_UNUSED_MS
      })
      .then(() => {
        if (this.disposed) {
          app.destroy()
          return
        }
        this.app = app
        // First child = drawn first = underneath everything else in this layer.
        app.stage.addChild(this.baseRoot)
        app.stage.addChild(this.root)
        // A SIBLING of root, not a child: rebuild() destroys everything under root, and the dots
        // must survive that. It carries the same scale and position, set together in draw().
        app.stage.addChild(this.handleRoot)
        this.rebuild()
      })
    this.ready.catch(() => {})
  }

  /**
   * Hand over the base image, in the same zoom-0 layer points everything here uses.
   *
   * MIPMAPS are the whole point. `ctx.drawImage` from a 4096x4096 source resamples 16.7 million
   * pixels every time the destination size changes — 20-50ms a frame, measured. A texture with
   * generated mip levels is filtered ONCE at upload and the hardware samples the level it needs,
   * so a zoom costs nothing per frame. `null` clears it (a map with no image, or a map switch).
   */
  setBase(bmp: ImageBitmap | null, x: number, y: number, w: number, h: number): void {
    this.baseSprite?.destroy({ texture: true, textureSource: true })
    this.baseSprite = null
    this.baseRoot.removeChildren()
    if (!bmp) return
    const source = new ImageSource({
      resource: bmp,
      autoGenerateMipmaps: true,
      scaleMode: 'linear'
    })
    const sp = new Sprite(new Texture({ source }))
    sp.position.set(x, y)
    sp.width = w
    sp.height = h
    this.baseSprite = sp
    this.baseRoot.addChild(sp)
    // Upload and filter NOW, while the map is still loading. Left to the first frame that draws
    // it, this lands inside the user's first gesture — which is the whole complaint.
    if (this.app && this.last) this.draw(...this.last)
  }

  setShapes(specs: ShapeSpec[]): void {
    // Dragging the year slider calls this on every tick, and a rebuild retriangulates every
    // polygon — but most years change nothing about what is drawn, so most of those rebuilds
    // produce an identical scene. Comparing first is O(n) over ~60 primitives against work
    // measured in milliseconds. Geometry compares by REFERENCE: the ring arrays are built once
    // per reload and handed back unchanged, so a new array means new geometry.
    if (same(this.specs, specs)) return
    this.specs = specs
    this.rebuild()
  }

  /**
   * The vertex dots of the shape currently being edited, in zoom-0 coordinates.
   *
   * A geoman handle does two jobs: it shows where a vertex IS, and it can be dragged. Only the
   * second needs a DOM element, and the DOM element is what costs — hundreds of them was the whole
   * problem. So the showing moves here, where a dot is free, and geoman keeps real handles for
   * only the few nearest the cursor. Nothing disappears from view, which is what made every
   * earlier attempt at "fewer markers" unacceptable.
   */
  setHandles(points: number[][], mids: number[][] = []): void {
    this.handles = points
    this.mids = mids
    this.drawHandles()
    // Re-render with whatever view draw() last used. Dots change on their own schedule — a vertex
    // drag, a selection — none of which line up with the caller's redraw, and asking the caller to
    // follow every setHandles with a draw would only reproduce this here, badly.
    if (this.last) this.draw(...this.last)
  }

  /** Hide one shape — the one whose real Leaflet layer is out for editing. Survives a rebuild. */
  setHidden(id: number | null): void {
    this.hiddenId = id
    for (const b of this.built) b.view.visible = b.spec.id !== id
  }

  draw(originX: number, originY: number, scale: number, width: number, height: number): void {
    const app = this.app
    if (!app) return
    this.last = [originX, originY, scale, width, height]
    if (app.renderer.width !== width || app.renderer.height !== height)
      app.renderer.resize(width, height)
    this.baseRoot.scale.set(scale)
    this.baseRoot.position.set(-originX, -originY)
    this.root.scale.set(scale)
    this.root.position.set(-originX, -originY)
    this.handleRoot.scale.set(scale)
    this.handleRoot.position.set(-originX, -originY)
    app.renderer.render(app.stage)
    // Collect once the map stops moving — Pixi only frees in postrender, and a map that renders
    // on demand stops rendering the moment you stop moving. See GC_IDLE_MS in pixiLabels.ts, and
    // collectWhenIdle there for why a frame is rendered first. Geometry, not glyphs, so there is
    // far less to free here than in the label layer; this renderer has its own GC and would
    // otherwise simply never run one.
    if (this.idle) clearTimeout(this.idle)
    this.idle = setTimeout(() => {
      this.idle = null
      if (this.disposed) return
      app.renderer.render(app.stage)
      app.renderer.gc.run()
    }, GC_IDLE_MS)
  }

  /**
   * Tell the layer what zoom it is being shown at. Cheap and idempotent: it only does work when
   * the scale has moved far enough that the stroke widths are visibly wrong (see
   * STROKE_REDRAW_SPAN), so the caller can hand it every frame without thinking about it.
   */
  setScale(scale: number): void {
    if (Math.abs(Math.log2(scale / this.strokeScale)) < STROKE_REDRAW_SPAN) return
    this.strokeScale = scale
    this.rebuild()
    this.drawHandles() // dots are screen-sized too, so they follow the same cadence as strokes
  }

  destroy(): void {
    this.disposed = true
    if (this.idle) clearTimeout(this.idle)
    this.idle = null
    // The base texture is ~67 MB for a 4096x4096 world map and MapView remounts on every map
    // switch, so it is released explicitly rather than left to `children: true` — which destroys
    // display objects but NOT the texture source behind them, the same trap the graphics context
    // and the text style are documented for above.
    this.baseSprite?.destroy({ texture: true, textureSource: true })
    this.baseSprite = null
    this.app?.destroy(false, { children: true })
    this.app = null
  }

  // ---------------------------------------------------------------------------------------

  private rebuild(): void {
    if (!this.app) return
    // `context: true` is load-bearing, and its absence was a leak of hundreds of MB per minute
    // of zooming. Pixi frees a Graphics' own GraphicsContext — its path, its tessellated geometry,
    // its batch buffers — only when destroy() is called with NO options at all, or with `context`
    // asked for explicitly:
    //
    //     if (this._ownedContext && !options) ... else if (options === true || options?.context)
    //
    // `{ children: true }` satisfies neither branch, so every context was orphaned. This runs on
    // every setScale, which is every 0.35 of a zoom level, so a minute of zooming left thousands
    // behind. The geometry lives in JS, not on the GPU, which is why it showed up as the RENDERER
    // process growing while the GPU process stayed flat.
    this.root.removeChildren().forEach((c) => c.destroy({ children: true, context: true }))
    this.built = []
    // Every pass lays down its OWN path. Sharing one was the bug behind paths ignoring their dash
    // pattern: a line has no fill, so the ring laid down for filling was never consumed, and the
    // dash segments appended to it — leaving stroke() to draw the whole unbroken ring as well as
    // the dashes, which is indistinguishable from solid.
    const trace = (g: Graphics, s: ShapeSpec): void => {
      for (const ring of s.rings) {
        if (!ring.length) continue
        g.moveTo(ring[0][0], ring[0][1])
        for (let i = 1; i < ring.length; i++) g.lineTo(ring[i][0], ring[i][1])
        if (s.closed) g.closePath()
      }
    }
    for (const s of this.specs) {
      const g = new Graphics()
      // Holes have to be declared alongside the outer ring for the fill rule to cut them out.
      if (s.fill !== null && s.closed) {
        trace(g, s)
        const tex = s.fillImg ? this.texture(s.fillImg) : null
        // Pixi's default textureSpace is 'local', which normalises the texture over the path's own
        // bounding box — objectBoundingBox, exactly what the SVG pattern did, so the image
        // stretches with the polygon and rides the container's scale like everything else. Passing
        // a matrix to do that by hand is worse than redundant: Pixi INVERTS it and appends it to
        // the normalisation it already did, which collapsed the whole fill onto one texel.
        if (tex) g.fill({ texture: tex, alpha: s.fillAlpha })
        else g.fill({ color: s.fill, alpha: s.fillAlpha })
      }
      // Divided by the scale because the container multiplies by it — this is what keeps a border
      // the same thickness on screen at every zoom.
      const w = s.weight / this.strokeScale
      // The selection halo goes down FIRST so the feature's own colour draws over the top of it,
      // leaving a rim rather than a repaint. The old SVG did this with a drop-shadow, which is the
      // one thing that must not come back — filters were the single most expensive item on the map.
      if (s.selected) {
        trace(g, s)
        g.stroke({ width: w + 6 / this.strokeScale, color: 0xffffff, alpha: 0.9, join: 'round' })
      }
      if (s.weight > 0 && s.dash.length) {
        for (const ring of s.rings)
          dashRing(s.closed ? [...ring, ring[0]] : ring, s.dash, this.strokeScale, (a, b) => {
            g.moveTo(a[0], a[1])
            g.lineTo(b[0], b[1])
          })
        g.stroke({ width: w, color: s.stroke, alpha: s.strokeAlpha, cap: 'butt' })
      } else if (s.weight > 0) {
        trace(g, s)
        g.stroke({ width: w, color: s.stroke, alpha: s.strokeAlpha, join: 'round', cap: 'round' })
      }
      if (s.arrow && !s.closed) arrowHead(g, s.rings[0], w, s.stroke, s.strokeAlpha)
      // Rebuilding recreates every Graphics, so the hidden one has to be re-hidden here — a
      // setScale() mid-edit was silently bringing the edited shape back and drawing it under the
      // Leaflet layer being dragged, which read as the old outline refusing to let go.
      g.visible = s.id !== this.hiddenId
      this.root.addChild(g)
      this.built.push({ spec: s, view: g })
    }
  }

  /**
   * A circle per vertex and a smaller one per midpoint, sized in screen pixels like the strokes —
   * hence /strokeScale. Midpoints first, so a vertex is never covered by the point beside it.
   *
   * Everything visible comes from here, including the parts geoman also has a real marker for:
   * those are transparent (see main.css). If only the handles WITHOUT a real marker were drawn,
   * the set would change as the cursor moved and the map would twitch under the mouse — which is
   * exactly what it did, and what this removes.
   */
  private drawHandles(): void {
    this.handleRoot.removeChildren().forEach((c) => c.destroy({ children: true, context: true }))
    if (!this.handles.length && !this.mids.length) return
    const w = 1 / this.strokeScale
    const dots = (pts: number[][], r: number, alpha: number): void => {
      if (!pts.length) return
      const g = new Graphics()
      for (const [x, y] of pts) g.circle(x, y, r)
      g.fill({ color: HANDLE_FILL, alpha })
      for (const [x, y] of pts) g.circle(x, y, r)
      g.stroke({ width: w, color: HANDLE_RIM, alpha })
      this.handleRoot.addChild(g)
    }
    dots(this.mids, MID_R / this.strokeScale, MID_ALPHA)
    dots(this.handles, HANDLE_R / this.strokeScale, 1)
  }

  /**
   * The texture for a fill image, or null if it is not here yet. Loads once per url and rebuilds
   * when it lands — a polygon shows its flat colour for the moment in between rather than nothing.
   */
  private texture(url: string): Texture | null {
    const hit = this.textures.get(url)
    if (hit !== undefined) return hit
    this.textures.set(url, null) // claim it first: rebuild() runs often and must not re-request
    // A plain Image, NOT Assets.load: these are `world://` urls from the app's own protocol, and
    // Pixi's resolver only recognises http(s) as absolute — it treated them as relative paths and
    // every load quietly failed, which showed up as an image-filled polygon staying flat. The
    // browser has no such trouble, and this is how the rest of the app loads assets anyway.
    const img = new Image()
    // Required, and it has to be set before src: `world://` is a different origin from the
    // renderer, and WebGL refuses to upload an image fetched without CORS. Without it the texture
    // loads, uploads black, and the polygon shows a black fill — which is what happened.
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      if (this.disposed) return
      this.textures.set(url, Texture.from(img))
      this.rebuild()
      this.onLoaded()
    }
    img.src = url // a missing asset keeps the flat colour; nothing else to do about it
    return null
  }
}

/**
 * The direction arrowhead at the end of a path, in the proportions the SVG `worldArrow` marker
 * had — the same drawing, since a marker element means nothing outside SVG.
 *
 * Geometry in units of the stroke width w: a triangle 3w long and 3w across the base, tip landing
 * 1.2w past the last point and the base 1.8w behind it. Both numbers are load-bearing (they were
 * measured against the round line cap, which pokes through a head seated any closer), so they are
 * carried over rather than re-picked.
 */
const arrowHead = (
  g: Graphics,
  ring: number[][],
  w: number,
  color: number,
  alpha: number
): void => {
  const end = ring[ring.length - 1]
  // The previous DISTINCT point: a repeated last vertex would give a zero-length direction.
  let prev: number[] | undefined
  for (let i = ring.length - 2; i >= 0; i--) {
    if (ring[i][0] !== end[0] || ring[i][1] !== end[1]) {
      prev = ring[i]
      break
    }
  }
  if (!prev) return
  const len = Math.hypot(end[0] - prev[0], end[1] - prev[1])
  const dx = (end[0] - prev[0]) / len
  const dy = (end[1] - prev[1]) / len
  const tip = [end[0] + dx * 1.2 * w, end[1] + dy * 1.2 * w]
  const back = [end[0] - dx * 1.8 * w, end[1] - dy * 1.8 * w]
  const hx = -dy * 1.5 * w // half the base, perpendicular to the direction
  const hy = dx * 1.5 * w
  g.moveTo(tip[0], tip[1])
  g.lineTo(back[0] + hx, back[1] + hy)
  g.lineTo(back[0] - hx, back[1] - hy)
  g.closePath()
  g.fill({ color, alpha })
}

/**
 * Which shape is at this zoom-0 point, or null — the topmost one wins, matching what the eye sees.
 *
 * Leaflet did this for free while the polygons were SVG in the DOM. They are not any more, so
 * selection, the conquest picker and the context menu all come through here instead. Even/odd
 * crossing count, which handles holes without a special case.
 */
export const shapeAt = (specs: ShapeSpec[], x: number, y: number): number | null => {
  for (let i = specs.length - 1; i >= 0; i--) {
    const s = specs[i]
    if (!s.closed) continue
    let inside = false
    for (const ring of s.rings) {
      for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
        const [ax, ay] = ring[a]
        const [bx, by] = ring[b]
        if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside
      }
    }
    if (inside) return s.id
  }
  return null
}

/**
 * Which open path passes within `tol` of this point, or null. Paths have no interior to test, so
 * they are picked by distance to their segments instead.
 */
export const pathAt = (specs: ShapeSpec[], x: number, y: number, tol: number): number | null => {
  let best: number | null = null
  let bestD = tol * tol
  for (const s of specs) {
    if (s.closed) continue
    for (const ring of s.rings) {
      for (let i = 1; i < ring.length; i++) {
        const [ax, ay] = ring[i - 1]
        const [bx, by] = ring[i]
        const dx = bx - ax
        const dy = by - ay
        const len = dx * dx + dy * dy
        const t = len ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len)) : 0
        const px = ax + t * dx - x
        const py = ay + t * dy - y
        const d = px * px + py * py
        if (d < bestD) {
          bestD = d
          best = s.id
        }
      }
    }
  }
  return best
}
