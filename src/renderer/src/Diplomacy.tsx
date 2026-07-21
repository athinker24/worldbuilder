import { useEffect, useMemo, useState } from 'react'
import { api, autoColor, TypeDef } from './api'
import { useT } from './i18n'

interface Props {
  types: TypeDef[]
  onOpenEntity: (id: number) => void
}

// Aile ilişkileri hanedan sistemine ait — diplomasi ağına girmez (şema/durum sabitleri)
const FAMILY = new Set(['mother', 'father', 'spouse'])

// Diplomasi ağı (World Anvil "diplomacy web" deseni): kişi olmayan maddeler bir çember
// üzerinde, aralarındaki linkler ilişki türüne göre renkli kavisli çizgiler. Yeni veri yok —
// mevcut links tablosunun görsel bir görünümü. Yerleşim deterministik dairesel (fizik yok).
export default function Diplomasi({ types, onOpenEntity }: Props): React.JSX.Element {
  const t = useT()
  const [ents, setEnts] = useState<{ id: number; type: string; name: string }[]>([])
  const [links, setLinks] = useState<
    { id: number; from_id: number; to_id: number; relation: string }[]
  >([])
  const [hidden, setHidden] = useState<Set<string>>(new Set()) // gizlenen ilişki türleri

  useEffect(() => {
    Promise.all([api.hierarchy(), api.listLinks()]).then(([h, l]) => {
      setEnts(h.entities)
      setLinks(l)
    })
  }, [])

  const web = useMemo(() => {
    const personTypes = new Set(types.filter((td) => td.isPerson).map((td) => td.name))
    const byId = new Map(ents.map((e) => [e.id, e]))
    const isState = (id: number): boolean => {
      const e = byId.get(id)
      return !!e && !personTypes.has(e.type)
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
  }, [ents, links, types])

  const S = 720 // SVG tasarım alanı (viewBox — responsive ölçeklenir)
  const R = S / 2 - 90 // çember yarıçapı (dışta ad etiketlerine pay)
  const cx = S / 2
  const cy = S / 2
  const pos = useMemo(() => {
    const m = new Map<number, { x: number; y: number; deg: number }>()
    web.nodes.forEach((n, i) => {
      const a = (2 * Math.PI * i) / web.nodes.length - Math.PI / 2 // üstten başla
      m.set(n.id, { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a), deg: (a * 180) / Math.PI })
    })
    return m
  }, [web.nodes, cx, cy, R])

  const relColor = (rel: string): string => autoColor(rel || '—')

  return (
    <div className="page">
      <div className="page-head">
        <h2>{t('🕸 Diplomacy Web')}</h2>
      </div>
      {web.nodes.length === 0 && (
        <p className="hint">
          {t(
            'No relations between entities yet. Add links from the Relations tab of an entity page.'
          )}
        </p>
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
              // Kavis: orta nokta merkeze doğru çekilir; paralel kenarlar üst üste binmesin
              // diye çekme oranı link id'sinden deterministik hafifçe oynar
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
            const right = p.x >= cx // etiket çemberin dışına, yönüne göre hizalı
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
