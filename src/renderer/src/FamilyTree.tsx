import { useEffect, useMemo, useState } from 'react'
import { api, EntityRow } from './api'
import { useT } from './i18n'

// Hanedan ağacı: ayrı veri yapısı yok — kişi maddeleri arasındaki 'anne'/'baba'/'eş' bağlarından
// türetilir (World Anvil deseni). Tıklanan kişi merkez olur, ağaç onun soyundan yeniden kurulur.
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
  const [entities, setEntities] = useState<EntityRow[]>([])
  const [links, setLinks] = useState<Link[]>([])

  useEffect(() => {
    api.listEntities().then(setEntities)
    api.listLinks().then(setLinks)
  }, [])

  // Esc ile kapat
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const { names, parentsOf, childrenOf, spousesOf } = useMemo(() => {
    const names = new Map(entities.map((e) => [e.id, e.name]))
    const parentsOf = new Map<number, number[]>()
    const childrenOf = new Map<number, number[]>()
    const spousesOf = new Map<number, number[]>()
    const push = (m: Map<number, number[]>, k: number, v: number): void => {
      const arr = m.get(k) ?? []
      if (!arr.includes(v)) arr.push(v)
      m.set(k, arr)
    }
    for (const l of links) {
      if (l.relation === 'anne' || l.relation === 'baba') {
        push(parentsOf, l.from_id, l.to_id)
        push(childrenOf, l.to_id, l.from_id)
      } else if (l.relation === 'eş') {
        push(spousesOf, l.from_id, l.to_id)
        push(spousesOf, l.to_id, l.from_id)
      }
    }
    return { names, parentsOf, childrenOf, spousesOf }
  }, [entities, links])

  // Merkez kişiden ata zincirini tırman (ilk ebeveyn tercih edilir, döngü korumalı) → hanedan kökü
  const treeRoot = useMemo(() => {
    let cur = centerId
    const seen = new Set<number>()
    while (!seen.has(cur)) {
      seen.add(cur)
      const ps = parentsOf.get(cur) ?? []
      if (!ps.length) break
      cur = ps[0]
    }
    return cur
  }, [centerId, parentsOf])

  const chip = (pid: number, isSpouse = false): React.JSX.Element => (
    <span
      className={`tree-chip ${pid === centerId ? 'center' : ''} ${isSpouse ? 'spouse' : ''}`}
      key={pid}
      title={t('Click: center the tree on this person')}
      onClick={() => setCenterId(pid)}
    >
      {names.get(pid) ?? `#${pid}`}
      <button
        className="mini"
        title={t('📖 Open entity')}
        onClick={(e) => {
          e.stopPropagation()
          onClose()
          onOpenEntity(pid)
        }}
      >
        📖
      </button>
    </span>
  )

  // ponytail: kişi başına tek görünüm — hanedanlar arası evlilikte ikinci geçiş atlanır (seen),
  // çok eşli kişilerin tüm çocukları tek grup altında toplanır. Karmaşık soyağacı gerekirse
  // çift-bazlı (couple node) yerleşime geçilir.
  const renderNode = (pid: number, seen: Set<number>): React.JSX.Element => {
    const kids = (childrenOf.get(pid) ?? []).filter((k) => !seen.has(k))
    for (const k of kids) seen.add(k)
    // Partnerler = resmi 'eş' bağları + çocukların diğer ebeveyni (co-parent). Kök tek ata
    // zincirinden tırmanıldığı için baba/anne tarafı ancak co-parent olarak eklenince görünür.
    const coParents: number[] = []
    for (const k of kids)
      for (const p of parentsOf.get(k) ?? [])
        if (p !== pid && !seen.has(p) && !coParents.includes(p)) coParents.push(p)
    const spouses = (spousesOf.get(pid) ?? []).filter((s) => !seen.has(s) && !coParents.includes(s))
    const partners = [...coParents, ...spouses]
    for (const s of partners) seen.add(s)
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
            🌳 {t('Family tree')} — {names.get(centerId) ?? ''}
          </b>
          <button className="mini" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="tree-scroll">
          <ul className="tree">{renderNode(treeRoot, new Set([treeRoot]))}</ul>
        </div>
      </div>
    </div>
  )
}
