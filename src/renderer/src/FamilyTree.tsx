import { useEffect, useMemo, useState } from 'react'
import {
  api,
  assetUrl,
  formatYear,
  getTimeline,
  getYearRecs,
  Hierarchy,
  inferGenders,
  TimelineConfig
} from './api'
import Icon from './icons'
import { useT } from './i18n'

// Dynasty tree (CK3 house-tree style): no separate data structure — derived from the
// 'mother'/'father'/'spouse' links between person entities. Climb to the founder preferring
// fathers, then descend the whole line (couple-nodes). Clicking a person recenters the tree.
interface Props {
  rootId: number
  onOpenEntity: (id: number) => void
  onClose: () => void
}

interface Link {
  id: number
  from_id: number
  to_id: number
  relation: string
}

export default function FamilyTree({ rootId, onOpenEntity, onClose }: Props): React.JSX.Element {
  const t = useT()
  const [centerId, setCenterId] = useState(rootId)
  const [entities, setEntities] = useState<Hierarchy['entities']>([])
  const [links, setLinks] = useState<Link[]>([])
  const [tl, setTl] = useState<TimelineConfig | null>(null) // to format birth/death years

  useEffect(() => {
    // hierarchy() returns both id+name and raw fields (the ruler set comes from fields.ruler)
    api.hierarchy().then((h) => setEntities(h.entities))
    api.listLinks().then(setLinks)
    getTimeline().then(setTl)
  }, [])

  // Close with Esc
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const { names, parentsOf, childrenOf, spousesOf, fatherOf, motherOf, rulerOf, genderOf, infoOf } =
    useMemo(() => {
      const names = new Map(entities.map((e) => [e.id, e.name]))
      const parentsOf = new Map<number, number[]>()
      const childrenOf = new Map<number, number[]>()
      const spousesOf = new Map<number, number[]>()
      const fatherOf = new Map<number, number>() // child → father (patrilineal climb)
      const motherOf = new Map<number, number>() // child → mother (fallback without a father)
      const push = (m: Map<number, number[]>, k: number, v: number): void => {
        const arr = m.get(k) ?? []
        if (!arr.includes(v)) arr.push(v)
        m.set(k, arr)
      }
      for (const l of links) {
        if (l.relation === 'mother' || l.relation === 'father') {
          push(parentsOf, l.from_id, l.to_id)
          push(childrenOf, l.to_id, l.from_id)
          if (l.relation === 'father') fatherOf.set(l.from_id, l.to_id)
          else motherOf.set(l.from_id, l.to_id)
        } else if (l.relation === 'spouse') {
          push(spousesOf, l.from_id, l.to_id)
          push(spousesOf, l.to_id, l.from_id)
        }
      }
      // Gender inference (explicit field > mother/father role > spouse's opposite) — shared helper
      const genderOf = inferGenders(entities, links)
      // Ruler set: any person appearing in any entity's fields.ruler is a ruler
      const rulerOf = new Map<number, string[]>() // person → names of entities they rule
      for (const e of entities)
        for (const rec of getYearRecs(e.fields, 'ruler')) {
          const arr = rulerOf.get(rec.id) ?? []
          if (!arr.includes(e.name)) arr.push(e.name)
          rulerOf.set(rec.id, arr)
        }
      // Card info: portrait (banner), birth/death years — from the person's fields
      const infoOf = new Map<number, { banner?: string; birth?: number; death?: number }>()
      for (const e of entities) {
        const f = JSON.parse(e.fields || '{}') as Record<string, string>
        const birth = f['birth'] ? Number(f['birth']) : undefined
        const death = f['death'] ? Number(f['death']) : undefined
        if (f['banner'] || birth !== undefined || death !== undefined)
          infoOf.set(e.id, { banner: f['banner'], birth, death })
      }
      return {
        names,
        parentsOf,
        childrenOf,
        spousesOf,
        fatherOf,
        motherOf,
        rulerOf,
        genderOf,
        infoOf
      }
    }, [entities, links])

  // Climb from the centred person to the founder preferring fathers (mother as fallback; cycle-guarded)
  const treeRoot = useMemo(() => {
    let cur = centerId
    const seen = new Set<number>()
    while (!seen.has(cur)) {
      seen.add(cur)
      const next = fatherOf.get(cur) ?? motherOf.get(cur)
      if (next === undefined) break
      cur = next
    }
    return cur
  }, [centerId, fatherOf, motherOf])

  const chip = (pid: number, isSpouse = false): React.JSX.Element => {
    const ruled = rulerOf.get(pid)
    const g = genderOf.get(pid)
    const info = infoOf.get(pid)
    // Bottom line: birth–death years (formatted) · primary title (first place they rule)
    const years =
      tl && info && (info.birth !== undefined || info.death !== undefined)
        ? `${info.birth !== undefined ? formatYear(info.birth, tl) : ''}–${
            info.death !== undefined ? formatYear(info.death, tl) : ''
          }`
        : ''
    const sub = [years, ruled?.[0]].filter(Boolean).join(' · ')
    return (
      <span
        className={`tree-chip ${pid === centerId ? 'center' : ''} ${isSpouse ? 'spouse' : ''} ${
          ruled ? 'ruler' : ''
        } ${g === 'M' ? 'male' : g === 'F' ? 'female' : ''}`}
        key={pid}
        title={
          ruled
            ? t('Ruled: {list}', { list: ruled.join(', ') })
            : t('Click: center the tree on this person')
        }
        onClick={() => setCenterId(pid)}
      >
        {info?.banner ? (
          <img
            className="tree-portrait"
            src={assetUrl(info.banner)}
            alt=""
            onError={(e) => {
              // Fall back to the placeholder when the image fails (cards always show a portrait slot)
              e.currentTarget.style.display = 'none'
              e.currentTarget.nextElementSibling?.removeAttribute('hidden')
            }}
          />
        ) : null}
        <span
          className={`tree-portrait placeholder ${g === 'M' ? 'male' : g === 'F' ? 'female' : ''}`}
          hidden={!!info?.banner}
        >
          <Icon name="user" size={22} />
        </span>
        <span className="tree-card-text">
          <span className="tree-card-name">
            {g && <span className="gender-badge">{g === 'M' ? '♂' : '♀'}</span>}
            {ruled && (
              <span className="ruler-badge">
                <Icon name="crown" size={11} />
              </span>
            )}
            {names.get(pid) ?? `#${pid}`}
          </span>
          {sub && <span className="tree-card-sub">{sub}</span>}
        </span>
        <button
          className="mini"
          title={t('Open entry')}
          onClick={(e) => {
            e.stopPropagation()
            onClose()
            onOpenEntity(pid)
          }}
        >
          <Icon name="file-text" size={13} />
        </button>
      </span>
    )
  }

  // Couple-node: each node is one blood member + their spouse(s); children come ONLY from the
  // member's childrenOf (the house flows along the bloodline). Spouses are decoration, never
  // descended into. seen prevents cycles and double renders (cousin/inter-dynasty marriages).
  // With multiple spouses all children sit in one group.
  const renderNode = (pid: number, seen: Set<number>): React.JSX.Element => {
    seen.add(pid)
    // Partners = co-parents of shared children + formal 'spouse' links (those not in seen)
    const kids = (childrenOf.get(pid) ?? []).filter((k) => !seen.has(k))
    const coParents: number[] = []
    for (const k of kids)
      for (const p of parentsOf.get(k) ?? [])
        if (p !== pid && !seen.has(p) && !coParents.includes(p)) coParents.push(p)
    const spouses = (spousesOf.get(pid) ?? []).filter((s) => !seen.has(s) && !coParents.includes(s))
    const partners = [...coParents, ...spouses]
    for (const s of partners) seen.add(s)
    for (const k of kids) seen.add(k)
    return (
      <li key={pid}>
        <div className="tree-couple">
          {chip(pid)}
          {partners.map((s) => (
            <span className="tree-marriage" key={s}>
              ⚭ {chip(s, true)}
            </span>
          ))}
        </div>
        {kids.length > 0 && <ul>{kids.map((k) => renderNode(k, seen))}</ul>}
      </li>
    )
  }

  return (
    <div className="tree-overlay" onMouseDown={onClose}>
      <div className="tree-panel" onMouseDown={(e) => e.stopPropagation()}>
        <div className="tree-head">
          <b>
            <Icon name="family-tree" size={15} /> {t('Family tree')} — {names.get(centerId) ?? ''}
          </b>
          <button className="mini" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="tree-scroll">
          <ul className="tree">{renderNode(treeRoot, new Set())}</ul>
        </div>
      </div>
    </div>
  )
}
