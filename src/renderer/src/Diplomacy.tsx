import { useEffect, useMemo, useState } from 'react'
import { api, autoColor, FolderDef, personFolderIds } from './api'
import { useT } from './i18n'
import { EmptyState } from './ui'

interface Props {
  folders: FolderDef[]
  onOpenEntity: (id: number) => void
}

// Family relations belong to the dynasty system — excluded from the diplomacy web (schema constants)
const FAMILY = new Set(['mother', 'father', 'spouse'])

// Diplomacy web (World Anvil's "diplomacy web" pattern): non-person entities on a circle,
// their links drawn as curved lines colored by relation type. No new data — a visual view
// over the existing links table. Layout is deterministic circular (no physics).
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

  const S = 720 // SVG design space (viewBox — scales responsively)
  const R = S / 2 - 90 // circle radius (margin outside for name labels)
  const cx = S / 2
  const cy = S / 2
  const pos = useMemo(() => {
    const m = new Map<number, { x: number; y: number; deg: number }>()
    web.nodes.forEach((n, i) => {
      const a = (2 * Math.PI * i) / web.nodes.length - Math.PI / 2 // start from the top
      m.set(n.id, { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a), deg: (a * 180) / Math.PI })
    })
    return m
  }, [web.nodes, cx, cy, R])

  const relColor = (rel: string): string => autoColor(rel || '—')

  return (
    <div className="page wide">
      {/* No <h2> — Overview's tab bar already names this view ("Relations"). */}
      {web.nodes.length === 0 && (
        <EmptyState
          icon="link"
          title={t('No relations yet')}
          hint={t(
            'Link two entities from the Relations section of an entity page and the web draws itself.'
          )}
        />
      )}
      {web.relations.length > 0 && (
        <div className="diplo-legend">
          {web.relations.map((rel) => (
            <span
              key={rel}
              className={`diplo-chip ${hidden.has(rel) ? 'off' : ''}`}
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
            </span>
          ))}
        </div>
      )}
      {web.nodes.length > 0 && (
        <svg className="diplo-svg" viewBox={`0 0 ${S} ${S}`}>
          {web.edges
            .filter((l) => !hidden.has(l.relation || '—'))
            .map((l) => {
              const a = pos.get(l.from_id)!
              const b = pos.get(l.to_id)!
              // Curve: the midpoint is pulled toward the center; the pull ratio varies
              // deterministically by link id so parallel edges do not overlap
              const k = 0.35 + ((l.id % 5) - 2) * 0.06
              const qx = (a.x + b.x) / 2 + (cx - (a.x + b.x) / 2) * k
              const qy = (a.y + b.y) / 2 + (cy - (a.y + b.y) / 2) * k
              const from = ents.find((e) => e.id === l.from_id)?.name
              const to = ents.find((e) => e.id === l.to_id)?.name
              return (
                <path
                  key={l.id}
                  className="diplo-edge"
                  d={`M ${a.x},${a.y} Q ${qx},${qy} ${b.x},${b.y}`}
                  stroke={relColor(l.relation)}
                >
                  <title>{`${from} — ${l.relation || '—'} → ${to}`}</title>
                </path>
              )
            })}
          {web.nodes.map((n) => {
            const p = pos.get(n.id)!
            const right = p.x >= cx // label outside the circle, aligned by direction
            const lx = p.x + (right ? 14 : -14)
            return (
              <g key={n.id} className="diplo-node" onClick={() => onOpenEntity(n.id)}>
                <circle cx={p.x} cy={p.y} r={8} fill={autoColor(n.name)} />
                <text x={lx} y={p.y} textAnchor={right ? 'start' : 'end'}>
                  {n.name}
                </text>
              </g>
            )
          })}
        </svg>
      )}
    </div>
  )
}
