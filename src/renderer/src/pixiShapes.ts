import 'pixi.js/unsafe-eval'
import { Application, Container, Graphics } from 'pixi.js'

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
  fillAlpha: number
  stroke: number
  strokeAlpha: number
  /** Stroke width in SCREEN pixels — polygons deliberately do not thicken as you zoom in. */
  weight: number
  /** Dash pattern in screen pixels, empty for solid. */
  dash: number[]
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
  private disposed = false
  readonly ready: Promise<void>

  constructor(canvas: HTMLCanvasElement) {
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

  /** Hide one shape without rebuilding — used while its real Leaflet layer is out for editing. */
  setHidden(id: number | null): void {
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
    for (const s of this.specs) {
      const g = new Graphics()
      // Holes must be declared before the fill is applied, so every ring goes down first.
      for (const ring of s.rings) {
        if (!ring.length) continue
        g.moveTo(ring[0][0], ring[0][1])
        for (let i = 1; i < ring.length; i++) g.lineTo(ring[i][0], ring[i][1])
        if (s.closed) g.closePath()
      }
      if (s.fill !== null && s.closed) g.fill({ color: s.fill, alpha: s.fillAlpha })
      if (s.weight > 0)
        g.stroke({
          // Divided by the scale because the container multiplies by it — this is what keeps a
          // border the same thickness on screen at every zoom.
          width: s.weight / this.strokeScale,
          color: s.stroke,
          alpha: s.strokeAlpha,
          join: 'round',
          cap: 'round'
        })
      this.root.addChild(g)
      this.built.push({ spec: s, view: g })
    }
  }
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
