import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, autoColor, FolderDef, personFolderIds } from './api'
import { ForceLayout } from './graphLayout'
import { useT } from './i18n'
import { EmptyState, IconButton } from './ui'

interface Props {
  folders: FolderDef[]
  onOpenEntity: (id: number) => void
}

// Family relations belong to the dynasty system — excluded from the diplomacy web (schema constants)
const FAMILY = new Set(['mother', 'father', 'spouse'])
const NODE_R = 8

// Diplomacy web (World Anvil's "diplomacy web" pattern): non-person entries and the links between
// them. It used to drop them on a fixed circle, which is readable at eight entries and a cat's
// cradle at forty — the names on the outside ran into each other and there was no way to look
// closer. It behaves like a map now: force-directed layout (graphLayout.ts), wheel to zoom, drag
// the background to pan, drag a node to pull it and its neighbours around. Still no new data —
// a view over the links table.
export default function Diplomasi({ folders, onOpenEntity }: Props): React.JSX.Element {
  const t = useT()
  const [ents, setEnts] = useState<{ id: number; name: string; fields: string }[]>([])
  const [links, setLinks] = useState<
    { id: number; from_id: number; to_id: number; relation: string }[]
  >([])
  const [hidden, setHidden] = useState<Set<string>>(new Set()) // hidden relation types

  useEffect(() => {
    Promise.all([api.hierarchy(), api.listLinks()]).then(([h, l]) => {
      setEnts(h.entities)
      setLinks(l)
    })
  }, [])

  const web = useMemo(() => {
    // People live in folders flagged isPerson — the diplomacy web shows only non-people
    const personIds = personFolderIds(folders)
    const folderOf = (fieldsJson: string): string | null => {
      try {
        return (JSON.parse(fieldsJson || '{}') as Record<string, string>)['folder'] ?? null
      } catch {
        return null
      }
    }
    const byId = new Map(ents.map((e) => [e.id, e]))
    const isState = (id: number): boolean => {
      const e = byId.get(id)
      if (!e) return false
      const f = folderOf(e.fields)
      return !f || !personIds.has(f)
    }
    const edges = links.filter(
      (l) =>
        !FAMILY.has(l.relation) && l.from_id !== l.to_id && isState(l.from_id) && isState(l.to_id)
    )
    const nodeIds = [...new Set(edges.flatMap((l) => [l.from_id, l.to_id]))]
    const nodes = nodeIds
      .map((id) => byId.get(id)!)
      .sort((a, b) => a.name.localeCompare(b.name, 'tr'))
    const relations = [...new Set(edges.map((l) => l.relation || '—'))].sort((a, b) =>
      a.localeCompare(b, 'tr')
    )
    return { nodes, edges, relations }
  }, [ents, links, folders])

  const hostRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const rootRef = useRef<SVGGElement>(null)
  // Positions are written to the DOM as attributes and never through state: a hundred nodes
  // re-rendered sixty times a second is the one thing that would make this unusable, and it is
  // the same call `updateOverlaySizes` makes on the map for the same reason.
  const nodeEls = useRef(new Map<number, SVGGElement>())
  const edgeEls = useRef(new Map<number, SVGPathElement>())
  const drag = useRef<{ id: number; dx: number; dy: number } | null>(null)
  const view = useRef({ x: 0, y: 0, k: 1 })
  const shown = useMemo(
    () => web.edges.filter((l) => !hidden.has(l.relation || '—')),
    [web.edges, hidden]
  )
  const shownRef = useRef(shown)
  useEffect(() => {
    shownRef.current = shown
  })

  /* The simulation is a ref, and every part of that sentence was argued with by the linter
     before it settled here. It cannot be state — the component MUTATES it sixty times a second
     and state is immutable. It cannot be assigned during render, because a render can be thrown
     away. And its painter cannot be passed to the constructor, because that closure would read
     a ref while React is rendering. So: a ref holding an instance, and an effect below hands it
     the current paint(). */
  const layoutRef = useRef(new ForceLayout())

  const paint = useCallback((): void => {
    const g = layoutRef.current
    rootRef.current?.setAttribute(
      'transform',
      `translate(${view.current.x} ${view.current.y}) scale(${view.current.k})`
    )
    for (const p of g.nodes) {
      nodeEls.current.get(p.id)?.setAttribute('transform', `translate(${p.x} ${p.y})`)
    }
    for (const l of shownRef.current) {
      const a = g.at(l.from_id)
      const b = g.at(l.to_id)
      const el = edgeEls.current.get(l.id)
      if (!a || !b || !el) continue
      // The midpoint is pushed aside PERPENDICULAR to the line by a ratio that varies with the
      // link id, so two relations between the same pair do not draw as one line.
      const bow = ((l.id % 5) - 2) * 0.12
      const mx = (a.x + b.x) / 2 - (b.y - a.y) * bow
      const my = (a.y + b.y) / 2 + (b.x - a.x) * bow
      el.setAttribute('d', `M ${a.x},${a.y} Q ${mx},${my} ${b.x},${b.y}`)
    }
  }, [])

  // Framed once per fresh set of nodes, and the flag is what keeps it to once.
  const framed = useRef(false)

  // Seed whenever the SET of nodes changes. Not on every filter change: hiding a relation type
  // should dim the web, not rearrange the world under the cursor.
  useEffect(() => {
    const host = hostRef.current
    const g = layoutRef.current
    const w = host?.clientWidth || 800
    const h = host?.clientHeight || 600
    g.seed(
      web.nodes.map((n) => n.id),
      web.edges.map((l) => ({ from: l.from_id, to: l.to_id })),
      w,
      h
    )
    view.current = { x: 0, y: 0, k: 1 }
    framed.current = false
    // Opening temperature scales with the host, so a big window spreads as confidently as a
    // small one rather than crawling.
    g.heat(Math.min(w, h) / 12)
    return () => g.stop()
  }, [web.nodes, web.edges])

  // The layout is in the host's own pixels, so a resize moves the centre it pulls toward.
  useEffect(() => {
    const host = hostRef.current
    const g = layoutRef.current
    if (!host) return
    const ro = new ResizeObserver(() => {
      g.resize(host.clientWidth, host.clientHeight)
      g.heat(2)
    })
    ro.observe(host)
    return () => ro.disconnect()
  }, [])

  const toWorld = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const r = svgRef.current?.getBoundingClientRect()
    if (!r) return { x: 0, y: 0 }
    return {
      x: (e.clientX - r.left - view.current.x) / view.current.k,
      y: (e.clientY - r.top - view.current.y) / view.current.k
    }
  }

  /** One gesture, two meanings: with a node grabbed it drags that node, otherwise it pans. */
  const startGesture = (e: React.PointerEvent): void => {
    const el = svgRef.current
    if (!el) return
    const from = { x: e.clientX, y: e.clientY, vx: view.current.x, vy: view.current.y }
    el.setPointerCapture(e.pointerId)
    const move = (m: PointerEvent): void => {
      const held = drag.current
      if (held) {
        const p = toWorld(m)
        const n = layoutRef.current.at(held.id)
        if (n) {
          n.x = p.x + held.dx
          n.y = p.y + held.dy
        }
        // Re-heat so the neighbours follow what you pull. This is the whole feel of the thing.
        layoutRef.current.heat(6)
      } else {
        view.current.x = from.vx + (m.clientX - from.x)
        view.current.y = from.vy + (m.clientY - from.y)
        paint()
      }
    }
    const end = (): void => {
      drag.current = null
      layoutRef.current.pinned = null
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', end)
      el.removeEventListener('pointercancel', end)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', end)
    el.addEventListener('pointercancel', end)
  }

  const onWheel = (e: React.WheelEvent): void => {
    const r = svgRef.current?.getBoundingClientRect()
    if (!r) return
    const px = e.clientX - r.left
    const py = e.clientY - r.top
    const v = view.current
    const next = Math.min(4, Math.max(0.2, v.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12)))
    // Keep whatever is under the cursor under the cursor — the same rule the map's wheel handler
    // follows, and the only zoom that does not feel like the picture jumping away from you.
    v.x = px - ((px - v.x) / v.k) * next
    v.y = py - ((py - v.y) / v.k) * next
    v.k = next
    paint()
  }

  /** Frame everything at whatever zoom fits: the way back after a drag has thrown the web off. */
  const fit = (): void => {
    const N = layoutRef.current.nodes
    const host = hostRef.current
    if (!N.length || !host) return
    const x0 = Math.min(...N.map((n) => n.x))
    const x1 = Math.max(...N.map((n) => n.x))
    const y0 = Math.min(...N.map((n) => n.y))
    const y1 = Math.max(...N.map((n) => n.y))
    const pad = 90 // room for the names, which hang off the right of their node
    const k = Math.min(
      2,
      Math.max(
        0.2,
        Math.min(host.clientWidth / (x1 - x0 + pad * 2), host.clientHeight / (y1 - y0 + pad * 2))
      )
    )
    view.current = {
      k,
      x: host.clientWidth / 2 - ((x0 + x1) / 2) * k,
      y: host.clientHeight / 2 - ((y0 + y1) / 2) * k
    }
    paint()
  }

  // The layout draws through whatever paint() is current and frames itself the FIRST time a
  // fresh set of nodes comes to rest. Both are assigned after commit, never during render (see
  // ForceLayout.draw), and this sits below fit() so it can simply call it.
  useEffect(() => {
    const g = layoutRef.current
    g.draw = paint
    g.settled = () => {
      if (framed.current) return
      framed.current = true
      fit()
    }
  })

  const relColor = (rel: string): string => autoColor(rel || '—')
  const nameOf = (id: number): string => web.nodes.find((n) => n.id === id)?.name ?? ''

  return (
    <div className="page wide">
      {/* No <h2> — Overview's tab bar already names this view ("Relations"). */}
      {web.nodes.length === 0 && (
        <EmptyState
          icon="link"
          title={t('No relations yet')}
          hint={t(
            'Link two entries from the Relations section of an entry page and the web draws itself.'
          )}
        />
      )}
      {web.relations.length > 0 && (
        <div className="diplo-legend">
          {web.relations.map((rel) => (
            // A legend entry that filters the graph is a toggle, so it says so: a button with
            // aria-pressed rather than a span you have to discover is clickable.
            <button
              key={rel}
              className={`diplo-chip ${hidden.has(rel) ? 'off' : ''}`}
              aria-pressed={!hidden.has(rel)}
              style={{ borderColor: relColor(rel) }}
              onClick={() =>
                setHidden((prev) => {
                  const next = new Set(prev)
                  if (next.has(rel)) next.delete(rel)
                  else next.add(rel)
                  return next
                })
              }
            >
              <span className="dot" style={{ background: relColor(rel) }} />
              {rel}
            </button>
          ))}
          <span className="diplo-tools">
            <IconButton icon="maximize" label={t('Fit to view')} small onClick={fit} />
          </span>
        </div>
      )}
      {web.nodes.length > 0 && (
        <div className="diplo-host" ref={hostRef}>
          <svg className="diplo-svg" ref={svgRef} onPointerDown={startGesture} onWheel={onWheel}>
            <g ref={rootRef}>
              {shown.map((l) => (
                <path
                  key={l.id}
                  className="diplo-edge"
                  ref={(el) => {
                    if (el) edgeEls.current.set(l.id, el)
                    else edgeEls.current.delete(l.id)
                  }}
                  stroke={relColor(l.relation)}
                >
                  <title>{`${nameOf(l.from_id)} — ${l.relation || '—'} → ${nameOf(l.to_id)}`}</title>
                </path>
              ))}
              {web.nodes.map((n, i) => (
                <g
                  key={n.id}
                  className="diplo-node"
                  ref={(el) => {
                    if (el) nodeEls.current.set(n.id, el)
                    else nodeEls.current.delete(n.id)
                  }}
                  onPointerDown={(e) => {
                    const p = toWorld(e)
                    const me = layoutRef.current.at(n.id)
                    if (!me) return
                    // Grab it where it was grabbed, so it does not jump to the cursor.
                    drag.current = { id: n.id, dx: me.x - p.x, dy: me.y - p.y }
                    layoutRef.current.pinned = n.id
                    startGesture(e)
                  }}
                  onClick={() => onOpenEntity(n.id)}
                >
                  {/* The drift lives on an INNER group: the outer one carries the position the
                      simulation writes, and a CSS animation on the same element would overwrite
                      it. CSS rather than more physics, so a settled graph costs no frames — and
                      so prefers-reduced-motion switches it off along with everything else. */}
                  <g className="diplo-bob" style={{ animationDelay: `${(i % 7) * 0.7}s` }}>
                    <circle r={NODE_R} fill={autoColor(n.name)} />
                    <text x={NODE_R + 6} y={4}>
                      {n.name}
                    </text>
                  </g>
                </g>
              ))}
            </g>
          </svg>
        </div>
      )}
    </div>
  )
}
