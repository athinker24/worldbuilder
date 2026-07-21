import { useEffect, useMemo, useState } from 'react'
import {
  api,
  autoColor,
  formatYear,
  getTimeline,
  getYearRecs,
  Hierarchy,
  TimelineConfig
} from './api'
import { useT } from './i18n'

interface Props {
  onOpenEntity: (id: number) => void
  onLocateFeature: (mapId: number, featureId: number) => void
}

interface Moment {
  year: number
  text: string
  onClick?: () => void
}

// Map-independent vertical chronology: existing events (timeline.events), named era bands
// (timeline.periods) and every entity's ruler history (fields['ruler']) merged into one
// list. No new data — a view over settings/entities data that already exists.
export default function Kronoloji({ onOpenEntity, onLocateFeature }: Props): React.JSX.Element {
  const t = useT()
  const [cfg, setCfg] = useState<TimelineConfig | null>(null)
  const [ents, setEnts] = useState<Hierarchy['entities']>([])

  // Raw data is fetched once on mount; presentation (translation + clicks) is computed at
  // render — otherwise the effect would depend on `t`, a new function every render →
  // setMoments → infinite loop.
  useEffect(() => {
    let alive = true
    Promise.all([getTimeline(), api.hierarchy()]).then(([c, h]) => {
      if (!alive) return
      setCfg(c)
      setEnts(h.entities)
    })
    return () => {
      alive = false
    }
  }, [])

  const moments: Moment[] = useMemo(() => {
    if (!cfg) return []
    const nameOf = new Map(ents.map((e) => [e.id, e.name]))
    const list: Moment[] = cfg.events.map((e) => ({
      year: e.year,
      text: e.name,
      onClick:
        e.fid !== undefined && e.mid !== undefined
          ? () => onLocateFeature(e.mid!, e.fid!)
          : undefined
    }))
    for (const e of ents) {
      for (const r of getYearRecs(e.fields, 'ruler')) {
        if (r.from === null) continue // indeterminate start — cannot be placed on a timeline
        list.push({
          year: r.from,
          text: t('{ruler} became ruler of {realm}', {
            ruler: nameOf.get(r.id) ?? '?',
            realm: e.name
          }),
          onClick: () => onOpenEntity(r.id)
        })
      }
    }
    return list.sort((a, b) => a.year - b.year)
  }, [cfg, ents, t, onLocateFeature, onOpenEntity])

  if (!cfg) return <div className="page" />

  const periodAt = (year: number): { name: string; from: number; to: number } | undefined =>
    cfg.periods.find((p) => year >= p.from && year <= p.to)

  return (
    <div className="page kron-page">
      <div className="page-head">
        <h2>{t('📜 Chronology')}</h2>
      </div>
      {moments.length === 0 && (
        <p className="hint">
          {t(
            'No events or reigns recorded yet. Add events from the map timeline, or ruler reigns from an entity page.'
          )}
        </p>
      )}
      <div className="kron-list">
        {moments.map((m, i) => {
          const p = periodAt(m.year)
          return (
            <div key={i} className="kron-row">
              <div className="kron-year">{formatYear(m.year, cfg)}</div>
              <div
                className="kron-dot"
                style={{ background: p ? autoColor(p.name) : 'var(--muted)' }}
              />
              <div className={`kron-text ${m.onClick ? 'clickable' : ''}`} onClick={m.onClick}>
                {m.text}
                {p && <span className="kron-period">{p.name}</span>}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
