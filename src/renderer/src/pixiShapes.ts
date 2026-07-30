import 'pixi.js/unsafe-eval'
import { Application, Container, Graphics, Texture } from 'pixi.js'

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
  const pat = pattern.map((v) => Math.max(v / scale, 1e-6))
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

export class ShapeLayer {
  private app: Application | null = null
  private root = new Container()
  private specs: ShapeSpec[] = []
  private built: Built[] = []
  /** The scale the current stroke widths were computed for. */
  private strokeScale = 1
  private hiddenId: number | null = null
  private disposed = false
  /** url → the loaded texture, or null while it is in flight / after it failed. */
  private textures = new Map<string, Texture | null>()
  private onLoaded: () => void
  readonly ready: Promise<void>

  constructor(canvas: HTMLCanvasElement, onLoaded: () => void = () => {}) {
    this.onLoaded = onLoaded
    const app = new Application()
    this.ready = app
      .init({ canvas, backgroundAlpha: 0, antialias: true, autoStart: false, preference: 'webgl' })
      .then(() => {
        if (this.disposed) {
          app.destroy()
          return
        }
        this.app = app
        app.stage.addChild(this.root)
        this.rebuild()
      })
    this.ready.catch(() => {})
  }

  setShapes(specs: ShapeSpec[]): void {
    this.specs = specs
    this.rebuild()
  }

  /** Hide one shape — the one whose real Leaflet layer is out for editing. Survives a rebuild. */
  setHidden(id: number | null): void {
    this.hiddenId = id
    for (const b of this.built) b.view.visible = b.spec.id !== id
  }

  draw(originX: number, originY: number, scale: number, width: number, height: number): void {
    const app = this.app
    if (!app) return
    if (app.renderer.width !== width || app.renderer.height !== height)
      app.renderer.resize(width, height)
    this.root.scale.set(scale)
    this.root.position.set(-originX, -originY)
    app.renderer.render(app.stage)
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
  }

  destroy(): void {
    this.disposed = true
    this.app?.destroy(false, { children: true })
    this.app = null
  }

  // ---------------------------------------------------------------------------------------

  private rebuild(): void {
    if (!this.app) return
    this.root.removeChildren().forEach((c) => c.destroy({ children: true }))
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
