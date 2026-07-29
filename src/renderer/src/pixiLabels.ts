import { Application, Container, Text, TextStyle } from 'pixi.js'

// Map labels, drawn in WebGL rather than as DOM elements.
//
// WHY THIS EXISTS. Labels were measured at 93-96 % of all rasterisation on a realistic map:
// toggling the layer off mid-recording, same viewport and same wheel gesture in each half, took
// rasterisation from 920 ms/s to 41 and the frame rate from 24 fps to 80. Pins were 2-4 %; every
// polygon and the base image together were the remainder. Seven attempts to fix it inside the DOM
// were each measured and each failed: a stroke halo instead of drop-shadows, a thinner halo,
// will-change on the labels, plain <text> instead of a textPath, hiding them during the gesture,
// easing the zoom with a pane transform, and will-change on the pane. The reason none of them
// worked is that the cost is not in how the text is drawn — it is that a browser re-rasterises
// scaled content at every new device scale, and these labels scale continuously with the map.
//
// WebGL does not have that cost. A glyph run is rasterised once into a texture and scaling it is
// a matrix multiply, so a zoom frame costs one draw call instead of forty re-rasterisations.
//
// COORDINATE SPACE. Everything here is in "layer point at zoom 0" — the space Leaflet's
// project(latlng, 0) returns, which for CRS.Simple is just map units. The container carries
// scale = 2^zoom and position = -pixelOrigin, so a zoom changes two numbers on one object and
// nothing per label. Font sizes are in the same space, which is also how the DOM version worked
// (a base size in map units, multiplied by 2^zoom at render time).
//
// This module deliberately knows nothing about Leaflet — the renderer-containment rule in
// CLAUDE.md applies to it exactly as it does to everything outside MapView.tsx. It takes plain
// numbers in and draws; MapView owns the translation.

export type LabelSpec = {
  id: number
  /** zoom-0 layer coordinates */
  x: number
  y: number
  text: string
  color: string
  font: string
  /** font size in zoom-0 units — the same `basePx` the DOM icons used */
  size: number
  /** degrees, clockwise */
  angle: number
  /** arc bend, in the same units labelDivIcon used: 0 is straight, +/- bends up/down */
  curve: number
}

/** Screen-space box of a drawn label, for hit testing (see LabelLayer.hitTest). */
type Placed = { spec: LabelSpec; halfW: number; halfH: number }

const HALO = 0.16 // stroke width as a fraction of font size — matches the CSS halo it replaces

/**
 * Text resolution is what keeps glyphs crisp: a texture rasterised for zoom 0 and then scaled up
 * eight times is a blurry mess. It is re-rendered when the zoom SETTLES, never during a gesture —
 * re-rasterising per frame is the exact cost this whole module exists to remove. Between settles
 * the GPU scales what is already there, which is how every web map behaves while you are moving.
 */
const MIN_RES = 0.25
const MAX_RES = 8

export class LabelLayer {
  private app: Application | null = null
  private root = new Container()
  private specs: LabelSpec[] = []
  private placed: Placed[] = []
  private res = 1
  private disposed = false
  /** Resolves once WebGL is up; every public method is safe to call before then. */
  readonly ready: Promise<void>

  constructor(canvas: HTMLCanvasElement) {
    const app = new Application()
    this.ready = app
      .init({
        canvas,
        backgroundAlpha: 0,
        antialias: true,
        // The map drives its own redraws — a ticker would render frames nobody asked for.
        autoStart: false,
        // Electron is not going to hand us a fallback-worthy GPU-less context; if WebGL is
        // genuinely unavailable the caller falls back to DOM labels rather than limping.
        preference: 'webgl'
      })
      .then(() => {
        if (this.disposed) {
          app.destroy()
          return
        }
        this.app = app
        app.stage.addChild(this.root)
        this.rebuild()
      })
    // A rejected init must not become an unhandled rejection; the caller inspects `ready`.
    this.ready.catch(() => {})
  }

  /** Replace the whole label set. Cheap enough to call on every reload — see rebuild(). */
  setLabels(specs: LabelSpec[]): void {
    this.specs = specs
    this.rebuild()
  }

  /**
   * Position the world and draw one frame. `scale` is 2^zoom and `originX/Y` is Leaflet's pixel
   * origin — the same two numbers that turn a zoom-0 point into a container point.
   */
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
   * Re-rasterise glyphs for the given zoom scale. Call ONLY when the zoom has settled: this is
   * the expensive path, and calling it per frame would reintroduce the problem being solved.
   */
  setResolution(scale: number): void {
    const res = Math.min(MAX_RES, Math.max(MIN_RES, scale))
    // Texture memory is not free and the eye cannot see a 4 % sharpness step — only re-render
    // when the change is worth the work.
    if (Math.abs(Math.log2(res / this.res)) < 0.25) return
    this.res = res
    this.rebuild()
  }

  /**
   * Which label is under a container point, or null. Labels left the DOM, so their click targets
   * left with them; MapView calls this before falling back to Leaflet's own hit testing.
   * Later entries win, matching the draw order the user sees.
   */
  hitTest(x: number, y: number, originX: number, originY: number, scale: number): number | null {
    for (let i = this.placed.length - 1; i >= 0; i--) {
      const p = this.placed[i]
      const cx = p.spec.x * scale - originX
      const cy = p.spec.y * scale - originY
      // Unrotate the point rather than rotate the box — one angle, cheaper and exact.
      const a = (-p.spec.angle * Math.PI) / 180
      const dx = x - cx
      const dy = y - cy
      const lx = dx * Math.cos(a) - dy * Math.sin(a)
      const ly = dx * Math.sin(a) + dy * Math.cos(a)
      if (Math.abs(lx) <= p.halfW * scale && Math.abs(ly) <= p.halfH * scale) return p.spec.id
    }
    return null
  }

  destroy(): void {
    this.disposed = true
    this.app?.destroy(false, { children: true })
    this.app = null
  }

  // ---------------------------------------------------------------------------------------

  private styleFor(s: LabelSpec): TextStyle {
    return new TextStyle({
      fontFamily: [s.font, 'serif'],
      fontSize: s.size,
      fill: s.color,
      // The halo, same technique and proportion as the CSS `paint-order: stroke` it replaces —
      // and in WebGL it really is free, drawn in the same pass as the glyph.
      stroke: { color: '#000000', width: s.size * HALO, join: 'round' },
      align: 'center'
    })
  }

  private rebuild(): void {
    if (!this.app) return
    this.root.removeChildren().forEach((c) => c.destroy({ children: true }))
    this.placed = []
    for (const s of this.specs) {
      const node = s.curve === 0 ? this.straight(s) : this.curved(s)
      if (!node) continue
      this.root.addChild(node.view)
      this.placed.push({ spec: s, halfW: node.halfW, halfH: node.halfH })
    }
  }

  private straight(s: LabelSpec): { view: Container; halfW: number; halfH: number } | null {
    const t = new Text({ text: s.text, style: this.styleFor(s), resolution: this.res })
    t.anchor.set(0.5)
    t.position.set(s.x, s.y)
    t.rotation = (s.angle * Math.PI) / 180
    return { view: t, halfW: t.width / 2, halfH: t.height / 2 }
  }

  /**
   * Curved text — one Text per glyph, placed along the same quadratic the DOM textPath used, so
   * derived region labels keep their arc. Sampled into a cumulative-length table first: stepping
   * the Bézier by its parameter would bunch letters up where the curve is tight.
   */
  private curved(s: LabelSpec): { view: Container; halfW: number; halfH: number } | null {
    const style = this.styleFor(s)
    const chars = [...s.text]
    if (!chars.length) return null
    const widths = chars.map((c) => {
      const m = new Text({ text: c, style })
      const w = m.width
      m.destroy()
      return w
    })
    const total = widths.reduce((a, b) => a + b, 0)
    // Same geometry as labelDivIcon: a chord of the text's own width, bent by `curve`.
    const sag = (s.curve / 100) * total * 0.3
    const x0 = -total / 2
    const x1 = total / 2
    const at = (u: number): { x: number; y: number } => ({
      x: (1 - u) * (1 - u) * x0 + 2 * (1 - u) * u * 0 + u * u * x1,
      y: (1 - u) * (1 - u) * 0 + 2 * (1 - u) * u * -2 * sag + u * u * 0
    })
    const N = 64
    const pts: { x: number; y: number }[] = []
    const cum: number[] = [0]
    for (let i = 0; i <= N; i++) pts.push(at(i / N))
    for (let i = 1; i <= N; i++)
      cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y))
    const arc = cum[N]
    const along = (d: number): { x: number; y: number; a: number } => {
      const target = Math.min(Math.max(d, 0), arc)
      let i = 1
      while (i < N && cum[i] < target) i++
      const seg = cum[i] - cum[i - 1] || 1
      const u = (target - cum[i - 1]) / seg
      const p = pts[i - 1]
      const q = pts[i]
      return {
        x: p.x + (q.x - p.x) * u,
        y: p.y + (q.y - p.y) * u,
        a: Math.atan2(q.y - p.y, q.x - p.x)
      }
    }
    const group = new Container()
    let d = (arc - total) / 2 // centre the run on the arc
    for (let i = 0; i < chars.length; i++) {
      const p = along(d + widths[i] / 2)
      const g = new Text({ text: chars[i], style, resolution: this.res })
      g.anchor.set(0.5)
      g.position.set(p.x, p.y)
      g.rotation = p.a
      group.addChild(g)
      d += widths[i]
    }
    group.position.set(s.x, s.y)
    group.rotation = (s.angle * Math.PI) / 180
    return { view: group, halfW: total / 2, halfH: (s.size + Math.abs(sag)) / 2 }
  }
}
