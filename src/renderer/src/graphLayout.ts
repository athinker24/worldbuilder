/**
 * Force-directed graph layout — a velocity simulation, in the shape d3-force uses and Obsidian's
 * graph view is built on. Written here rather than installed for the same reason `navRoute` has
 * its own Dijkstra and `pcaAxis` its own eigenvector: it is a page of arithmetic, and a graph
 * library arrives with a renderer, a zoom behaviour and a data model that would all have to be
 * argued with.
 *
 * IT HAS VELOCITY, and that is the whole design. The first version of this file was
 * Fruchterman–Reingold, where each pass computes a displacement and applies it capped by a
 * falling "temperature" — nodes jump toward where the forces point and stop dead. It lays out
 * correctly and feels like nothing: no momentum, no overshoot, and when you drag a node its
 * neighbours arrive stiffly rather than being towed. Here every node carries a velocity that
 * forces ACCELERATE and friction bleeds away, which is what makes the whole thing behave like
 * objects suspended in a fluid — the settling drift, the lag as a cluster follows the node you
 * are pulling, the way it comes to rest instead of stopping.
 *
 * It lives in a module and not in the component because it works by MUTATING its nodes sixty
 * times a second, and this project's lint (React Compiler's immutability rule) is right to
 * refuse that inside one.
 */

export interface GraphNode {
  id: number
  x: number
  y: number
  /** Velocity, in units per tick. Friction takes a fixed share of it every tick. */
  vx: number
  vy: number
  /** Held position while dragged: the forces do not get a vote, but the node still pulls others. */
  fx: number | null
  fy: number | null
  /** How many edges meet here — links pull a well-connected node less than a lonely one. */
  deg: number
}

export interface GraphEdge {
  from: number
  to: number
}

/* The numbers, and what each one is FOR. Tuned against check-api's fixtures rather than by eye —
   the harness reports the closest pair and the overall spread, which is what "readable" means
   here. */
const ALPHA_MIN = 0.0015 // below this the picture has stopped changing, so the loop stops
const ALPHA_DECAY = 0.0225 // ≈300 ticks from a cold start to rest, which is about five seconds
const ALPHA_DRAG = 0.35 // held while dragging, so the web stays live under your hand
const FRICTION = 0.42 // share of velocity lost per tick — the "fluid" the nodes are suspended in
/* × k². Swept against the fixtures rather than guessed: at 0.9 a dense sixty-node graph settled
   with pairs 27px apart, at 3.0 it spread past the canvas. 2.2 leaves gaps of 85px on a chain,
   59 around a hub and 37 in a dense mesh, with the whole graph between 380 and 680px wide — the
   range that fits the view without the names touching. */
const REPEL = 2.2
const LINK_PULL = 0.09 // spring stiffness toward the ideal spacing
const CENTER_PULL = 0.0006 // barely there: enough that a lone pair cannot leave the canvas
/** Past this the O(n²) pass IS the frame, so the seeded circle stands and nothing animates. */
export const MAX_SIM_NODES = 400

export class ForceLayout {
  nodes: GraphNode[] = []
  /** Called once per frame: this owns the arithmetic, the caller owns the DOM. */
  draw: () => void = () => {}
  /** Called each time the layout comes to rest — the view frames itself on the first one. */
  settled: () => void = () => {}

  private edges: GraphEdge[] = []
  private byId = new Map<number, GraphNode>()
  private k = 100
  private alpha = 0
  private alphaTarget = 0
  private raf = 0
  private cx = 0
  private cy = 0

  /**
   * Start from a circle — the layout this view used to BE. Deterministic rather than random, so
   * the same world lays out the same way twice and the first seconds read as the old
   * arrangement relaxing rather than as noise resolving into something.
   */
  seed(ids: number[], edges: GraphEdge[], w: number, h: number): void {
    const n = ids.length
    const r = Math.min(w, h) / 2 - 60
    this.nodes = ids.map((id, i) => {
      const a = (2 * Math.PI * i) / Math.max(1, n) - Math.PI / 2
      return {
        id,
        x: w / 2 + r * Math.cos(a),
        y: h / 2 + r * Math.sin(a),
        vx: 0,
        vy: 0,
        fx: null,
        fy: null,
        deg: 0
      }
    })
    this.byId = new Map(this.nodes.map((p) => [p.id, p]))
    this.edges = edges
    for (const e of edges) {
      const a = this.byId.get(e.from)
      const b = this.byId.get(e.to)
      if (a) a.deg++
      if (b) b.deg++
    }
    this.resize(w, h)
  }

  /** The host's size decides the centre and `k`, so a resize changes the layout it is aiming at. */
  resize(w: number, h: number): void {
    this.cx = w / 2
    this.cy = h / 2
    // k = the spacing nodes would have if they were spread evenly over the area. Every force
    // above is expressed against it, which is what keeps the constants independent of both the
    // window size and how big the world has grown.
    this.k = Math.sqrt((w * h) / Math.max(1, this.nodes.length)) * 0.5
  }

  at(id: number): GraphNode | undefined {
    return this.byId.get(id)
  }

  /** Neighbours of a node, for the caller that wants to know what a drag is about to tow. */
  neighbours(id: number): number[] {
    const out: number[] = []
    for (const e of this.edges) {
      if (e.from === id) out.push(e.to)
      else if (e.to === id) out.push(e.from)
    }
    return out
  }

  /** Warm it up: a fresh layout, a resize, or a filter that changed which edges pull. */
  heat(to = 1): void {
    if (!this.nodes.length || this.nodes.length > MAX_SIM_NODES) return this.draw()
    this.alpha = Math.max(this.alpha, to)
    this.run()
  }

  /**
   * Hold a node where the pointer put it and keep the simulation awake while it is there.
   *
   * The `alphaTarget` is what makes a drag feel connected rather than like moving one dot: alpha
   * decays TOWARD it, so while it is 0.35 the forces never fade, every spring attached to the
   * held node keeps pulling, and the cluster it belongs to swims along behind — with the lag its
   * own velocity and friction give it. Releasing sets the target back to 0 and everything coasts
   * to rest. This is exactly the trick d3's drag behaviour uses.
   */
  hold(id: number, x: number, y: number): void {
    const n = this.byId.get(id)
    if (!n) return
    n.fx = x
    n.fy = y
    this.alphaTarget = ALPHA_DRAG
    this.run()
  }

  release(): void {
    for (const n of this.nodes) {
      n.fx = null
      n.fy = null
    }
    this.alphaTarget = 0
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    this.alpha = 0
    this.alphaTarget = 0
  }

  private run(): void {
    if (!this.raf) this.raf = requestAnimationFrame(this.frame)
  }

  private frame = (): void => {
    this.tick()
    this.draw()
    // Stop when it has come to rest. A permanent loop for a picture that is not changing is what
    // the map's on-demand rendering exists to avoid; the idle drift is a CSS animation instead.
    if (this.alpha > ALPHA_MIN || this.alphaTarget > 0) {
      this.raf = requestAnimationFrame(this.frame)
    } else {
      this.raf = 0
      this.settled()
    }
  }

  tick(): void {
    const N = this.nodes
    if (!N.length) return
    this.alpha += (this.alphaTarget - this.alpha) * ALPHA_DECAY
    const a = this.alpha
    const k = this.k
    const repel = REPEL * k * k

    // Repulsion between every pair — the force that keeps a crowd legible. O(n²), which is why
    // MAX_SIM_NODES exists: a quadtree would buy nothing at the sizes a hand-built world reaches.
    for (let i = 0; i < N.length; i++) {
      for (let j = i + 1; j < N.length; j++) {
        const p = N[i]
        const q = N[j]
        let dx = p.x - q.x
        let dy = p.y - q.y
        let d2 = dx * dx + dy * dy
        // Two nodes exactly on top of each other have no direction to separate along. Pick one
        // by INDEX rather than at random, so a world still lays out the same way twice.
        if (d2 < 1) {
          dx = ((i % 7) - 3.5) * 0.3
          dy = ((j % 5) - 2.5) * 0.3
          d2 = dx * dx + dy * dy
        }
        const f = (repel * a) / (d2 * Math.sqrt(d2)) // /d² for the force, /d to normalise
        p.vx += dx * f
        p.vy += dy * f
        q.vx -= dx * f
        q.vy -= dy * f
      }
    }

    // Springs along the edges, pulling toward the ideal spacing. Biased by degree, as d3 does: a
    // hub with twelve links should not be dragged about by each of them as hard as a leaf with
    // one, or every well-connected node would jitter in the middle of its own neighbours.
    for (const e of this.edges) {
      const p = this.byId.get(e.from)
      const q = this.byId.get(e.to)
      if (!p || !q) continue
      const dx = q.x - p.x
      const dy = q.y - p.y
      const d = Math.max(0.01, Math.hypot(dx, dy))
      // Stiffness DIVIDED by the smaller degree, which is d3's rule and not a refinement of it:
      // without it a node's total pull grows with its number of links, so a dense graph collapses
      // into a knot — measured, sixty nodes came to rest inside 138px with pairs 14px apart. The
      // bias below only decides which END moves; this decides how hard the spring pulls at all.
      const f = ((d - k) / d) * (LINK_PULL / Math.max(1, Math.min(p.deg, q.deg))) * a
      const bias = q.deg / Math.max(1, p.deg + q.deg)
      p.vx += dx * f * bias
      p.vy += dy * f * bias
      q.vx -= dx * f * (1 - bias)
      q.vy -= dy * f * (1 - bias)
    }

    for (const n of N) {
      if (n.fx !== null && n.fy !== null) {
        // Held: it goes where the pointer says and carries no momentum of its own, but its
        // springs are still in the loop above, which is what tows the rest.
        n.x = n.fx
        n.y = n.fy
        n.vx = 0
        n.vy = 0
        continue
      }
      n.vx += (this.cx - n.x) * CENTER_PULL * a
      n.vy += (this.cy - n.y) * CENTER_PULL * a
      // Friction, then integrate. Velocity surviving between ticks is what gives the motion its
      // weight: a node overshoots slightly, is pulled back, and coasts in — rather than arriving.
      n.vx *= 1 - FRICTION
      n.vy *= 1 - FRICTION
      n.x += n.vx
      n.y += n.vy
    }
  }
}
