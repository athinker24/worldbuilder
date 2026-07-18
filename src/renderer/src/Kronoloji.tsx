import { useEffect, useState } from 'react'
import { api, autoColor, formatYear, getTimeline, getYearRecs, TimelineConfig } from './api'
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

// Haritadan bağımsız dikey zaman çizelgesi: mevcut olaylar (timeline.events), isimli dönem
// bantları (timeline.periods) ve her maddenin yönetici geçmişi (fields['yönetici']) tek listede
// birleştirilir. Yeni veri yok — hepsi zaten var olan settings/entities verisinin görünümü.
export default function Kronoloji({ onOpenEntity, onLocateFeature }: Props): React.JSX.Element {
  const t = useT()
  const [cfg, setCfg] = useState<TimelineConfig | null>(null)
  const [moments, setMoments] = useState<Moment[]>([])

  useEffect(() => {
    let alive = true
    Promise.all([getTimeline(), api.hierarchy()]).then(([c, h]) => {
      if (!alive) return
      setCfg(c)
      const nameOf = new Map(h.entities.map((e) => [e.id, e.name]))
      const list: Moment[] = c.events.map((e) => ({
        year: e.year,
        text: e.name,
        onClick:
          e.fid !== undefined && e.mid !== undefined
            ? () => onLocateFeature(e.mid!, e.fid!)
            : undefined
      }))
      for (const e of h.entities) {
        for (const r of getYearRecs(e.fields, 'yönetici')) {
          if (r.from === null) continue // belirsiz başlangıç — zaman çizgisinde gösterilemez
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
      list.sort((a, b) => a.year - b.year)
      setMoments(list)
    })
    return () => {
      alive = false
    }
  }, [onLocateFeature, onOpenEntity, t])

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
