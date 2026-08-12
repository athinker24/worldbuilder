/**
 * Force-directed graph layout — Fruchterman–Reingold, written here rather than installed.
 *
 * The same reason `navRoute` has its own Dijkstra and `pcaAxis` its own eigenvector: it is a
 * page of arithmetic, it needs no build step, and a graph library arrives with a renderer, a
 * zoom behaviour and a data model that would all have to be argued with.
 *
 * FR rather than a charge/spring simulation because both of its forces are defined against ONE
 * number — `k`, the distance nodes would sit apart if they were spread evenly over the area — so
 * a layout scales with the window and with the size of the world instead of needing its
 * constants retuned every time either changes.
 *
 * It lives in a module and not in the component for a concrete reason: it works by MUTATING the
 * node objects sixty times a second, and this project's lint (React Compiler's immutability
 * rule) is right to refuse that inside a component. Here it is ordinary code that owns its own
 * array, and the component only reads positions out of it.
 */

export interface GraphNode {
  id: number
  x: number
  y: number
  /** Accumulated displacement for the current pass; not meaningful between passes. */
  dx: number
  dy: number
}

export interface GraphEdge {
  from: number
  to: number
}

const COOL = 0.97 // temperature decay per frame — settles in roughly 150
const TEMP_MIN = 0.35 // below this nothing moves visibly, so the loop stops entirely
const CENTER_PULL = 0.01 // enough that a disconnected pair cannot drift away for ever
/** Past this the O(n²) pass IS the frame, so the seeded circle stands and nothing animates. */
export const MAX_SIM_NODES = 400

export class ForceLayout {
  nodes: GraphNode[] = []
  /** The node held under the pointer, if any: it is moved by the caller, not by the forces. */
  pinned: number | null = null
  private edges: GraphEdge[] = []
  private byId = new Map<number, GraphNode>()
  private k = 100
  private temp = 0
  private raf = 0
  private cx = 0
  private cy = 0
  /**
   * Called once per frame: this owns the arithmetic, the caller owns the DOM.
   *
   * Assigned after construction rather than passed in, and that is not a style choice — a
   * constructor argument would have to close over the component's paint function, which means
   * reading a ref while React is rendering, which this project's lint refuses and is right to.
   * Here the instance is built with nothing and an effect hands it the current painter.
   */
  draw: () => void = () => {}
  /**
   * Called once each time the layout comes to rest. The view frames itself on the first of
   * these and never again: a graph settles wherever its shape wants to be — a chain of
   * twenty-four nodes measured 2611px across a 900px canvas — so opening one and finding a
   * corner of it would be the old fixed circle's problem in a new form. Not on LATER settles,
   * because by then the user has panned somewhere on purpose.
   */
  settled: () => void = () => {}

  /**
   * Start from a circle — the layout this view used to BE. A deterministic seed rather than
   * random placement means the same world lays out the same way twice, and the first second
   * reads as the old arrangement relaxing rather than as noise resolving into something.
   */
  seed(ids: number[], edges: GraphEdge[], w: number, h: number): void {
    const n = ids.length
    const r = Math.min(w, h) / 2 - 60
    this.nodes = ids.map((id, i) => {
      const a = (2 * Math.PI * i) / Math.max(1, n) - Math.PI / 2
      return { id, x: w / 2 + r * Math.cos(a), y: h / 2 + r * Math.sin(a), dx: 0, dy: 0 }
    })
    this.byId = new Map(this.nodes.map((p) => [p.id, p]))
    this.edges = edges
    this.resize(w, h)
  }

  /** The host's size decides both the centre and `k`, so a resize changes the target layout. */
  resize(w: number, h: number): void {
    this.cx = w / 2
    this.cy = h / 2
    this.k = Math.sqrt((w * h) / Math.max(1, this.nodes.length)) * 0.55
  }

  at(id: number): GraphNode | undefined {
    return this.byId.get(id)
  }

  /** Warm it back up: after a drag, a resize, or a filter that changed which edges pull. */
  heat(to: number): void {
    if (!this.nodes.length || this.nodes.length > MAX_SIM_NODES) return this.draw()
    this.temp = Math.max(this.temp, to)
    if (!this.raf) this.raf = requestAnimationFrame(this.frame)
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    this.temp = 0
  }

  private frame = (): void => {
    this.step()
    this.draw()
    // Settled: stop. A permanent loop for a view that has stopped moving is the thing the map's
    // on-demand rendering exists to avoid, and the idle drift is a CSS animation instead.
    if (this.temp > TEMP_MIN) {
      this.raf = requestAnimationFrame(this.frame)
    } else {
      this.raf = 0
      this.settled()
    }
  }

  /**
   * One pass. Public only so `check-api.mjs` can drive the layout without a clock — there is no
   * other caller; the frame loop above is the real one.
   */
  step(): void {
    const N = this.nodes
    const k = this.k
    for (const p of N) {
      p.dx = 0
      p.dy = 0
    }
    // Repulsion between every pair: k²/d, the term that spreads a crowd out.
    for (let i = 0; i < N.length; i++) {
      for (let j = i + 1; j < N.length; j++) {
        const a = N[i]
        const b = N[j]
        let ux = a.x - b.x
        let uy = a.y - b.y
        let d = Math.hypot(ux, uy)
        // Two entries can start on the same point; separate them by INDEX rather than at random,
        // so a world still lays out the same way twice.
        if (d < 0.01) {
          ux = ((i % 7) - 3.5) * 0.3
          uy = ((j % 5) - 2.5) * 0.3
          d = Math.max(0.01, Math.hypot(ux, uy))
        }
        const f = (k * k) / (d * d)
        a.dx += ux * f
        a.dy += uy * f
        b.dx -= ux * f
        b.dy -= uy * f
      }
    }
    // Attraction along every edge: d²/k, the term that keeps what is related together.
    for (const e of this.edges) {
      const a = this.byId.get(e.from)
      const b = this.byId.get(e.to)
      if (!a || !b) continue
      const ux = a.x - b.x
      const uy = a.y - b.y
      const d = Math.max(0.01, Math.hypot(ux, uy))
      const f = d / k // (d² / k) / d, the unit vector folded in
      a.dx -= ux * f
      a.dy -= uy * f
      b.dx += ux * f
      b.dy += uy * f
    }
    for (const p of N) {
      if (p.id === this.pinned) continue // held by the pointer; the forces do not get a vote
      p.dx += (this.cx - p.x) * CENTER_PULL
      p.dy += (this.cy - p.y) * CENTER_PULL
      const d = Math.hypot(p.dx, p.dy)
      // Temperature caps the step: large early so it finds its shape, small later so it settles
      // instead of vibrating around the answer.
      if (d > 0.01) {
        const m = Math.min(d, this.temp) / d
        p.x += p.dx * m
        p.y += p.dy * m
      }
    }
    this.temp *= COOL
  }
}
