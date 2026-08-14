// The map's arithmetic: ring measurement, centroids, adjacency, the PCA axis derived labels are
// angled on, curve interpolation, and the road graph the route tool walks.
//
// All of it is pure. None of it touches React, a ref, the Leaflet map instance or the module-level
// state MapView keeps — it takes coordinates and returns numbers, which is why it can leave a
// 6,500-line component without any of the risk that moving that component's logic would carry.
// The two Leaflet PROTOTYPE patches near the top of MapView deliberately did not come with it:
// they run for their side effect at import time, and where that happens is part of what they mean.
//
// `L` appears here only for `LatLng` — constructing Leaflet's own value type, not extending it.
//
// Several of these numbers were measured rather than chosen, and docs/map-internals.md records
// what against: ADJ_FRAC because borders that look welded sit 0.039-0.14 apart on a 1024-unit map
// while genuinely separate regions start at 18.8, and ANISO_MIN because a near-square component
// makes atan2 answer 45 degrees from rounding alone. Do not "tidy" either into a round number.
import L from 'leaflet'
// `type`, because they are only ever shapes here — nothing in this file constructs one. It also
// leaves the module loadable with the import elided, which is the same reason src/main/log
// imports `Level` that way. (`L` cannot follow: curvePoints calls `L.latLng`.)
import type { NavLeg, NavRoute } from './mapTypes'

// Map scale: perUnit = real distance / map unit (px). Two methods: a numeric map width
// or measuring a known distance on the map. settings 'mapScales' =
// { [mapId]: {perUnit, unit} }. CRS.Simple is planar, so the math is pure Euclid — no projection.
export const ringLen = (ring: number[][]): number => {
  let s = 0
  for (let i = 1; i < ring.length; i++)
    s += Math.hypot(ring[i][0] - ring[i - 1][0], ring[i][1] - ring[i - 1][1])
  return s
}
// ringArea lives in api.ts (shared with Atlas, pure geometry — no dependency on the heavy
// MapView module). Vertex average — not a shoelace centroid, fine for a label anchor
export const ringCentroid = (ring: number[][]): [number, number] => {
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
export const ringAreaCentroid = (ring: number[][]): [number, number] => {
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
export const ADJ_FRAC = 0.001
// Squared distance from a point to a segment. The T-junction test below runs it per vertex per
// candidate segment, so it stays allocation-free and never takes a square root.
export const segDist2 = (
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
export const ringsTouch = (a: number[][], b: number[][], tol: number): boolean => {
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
export const ANISO_MIN = 0.15
// PCA main axis: long-axis angle (radians) from the vertex cloud's covariance + width along it.
// Cartography proper uses the medial axis; PCA is enough at personal scale.
export const pcaAxis = (verts: number[][]): { theta: number; extent: number } => {
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
export const fmtDist = (v: number): string =>
  v >= 100 ? Math.round(v).toLocaleString() : v >= 10 ? v.toFixed(1) : v.toFixed(2)

// LegendKeeper-style curvature for roads/rivers/borders: a RENDER-ONLY Cardinal spline
// (Hermite). Never touches the raw vertices (geoman's Edit tool still drags the real corners)
// — it only produces a visual overlay (see isCurveControl in reloadFeatures/applyYear).
// curviness 0-100 → tangent strength s (0 = near-straight, 0.5 = classic Catmull-Rom).
export const curvePoints = (coords: number[][], curviness: number): L.LatLng[] => {
  if (coords.length < 3) return coords.map(([x, y]) => L.latLng(y, x))
  const s = (Math.max(0, Math.min(100, curviness)) / 100) * 0.5
  const steps = coords.length > 150 ? 4 : 12 // Fewer subdivisions on very long paths
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
export type NavLine = { fid: number; coords: number[][] }
export type NavPin = { fid: number; xy: number[] }
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
export const projectOnSeg = (
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
export const buildNavGraph = (
  lines: NavLine[],
  pins: NavPin[],
  eps: number
): { nodes: number[][]; adj: NavEdge[][]; pinNode: Map<number, number> } => {
  const nodes: number[][] = []
  const adj: NavEdge[][] = []
  // O(n²) linear scan — a few hundred nodes at personal scale, no spatial index needed
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

// Dijkstra (O(V²) node pick — runs once per route, no heap needed).
// null when no route exists. Consecutive same-fid edges fold into one NavLeg.
export const navRoute = (
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
