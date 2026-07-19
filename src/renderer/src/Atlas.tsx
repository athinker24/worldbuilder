import { useEffect, useMemo, useState } from 'react'
import {
  api,
  autoColor,
  formatYear,
  getHierConfig,
  getMapModes,
  getParents,
  getTimeline,
  HierConfig,
  Hierarchy,
  inYearRange,
  lowestRungSet,
  MapModes,
  ringArea,
  rootAtYear,
  TimelineConfig,
  WorldMap
} from './api'
import { MapScale } from './ToolPanel'
import { useT } from './i18n'

interface Props {
  onOpenEntity: (id: number) => void
}

// Bir grubun (devlet / din / dil…) alan payı satırı
interface Row {
  key: string
  label: string
  color: string
  area: number
  eid?: number // devlet satırında tıkla → madde sayfası
}

const fmtArea = (v: number): string =>
  v >= 100 ? Math.round(v).toLocaleString() : v >= 1 ? v.toFixed(1) : v.toFixed(2)

// Atlas: dünyanın sayısal görünümü. Seçilen yılda her haritanın taban poligonları (en alt kademe)
// gerçek alanlarıyla (shoelace × harita ölçeği²) toplanır; devlet (o yılki üst zincirinin tepesi)
// ve her harita modu boyutu (din/dil/kültür) için alan dağılımı renkli çubuklarla gösterilir.
// Yeni veri yok — features geometrisi + fields + mapScales'in salt-okunur bir görünümü.
export default function Atlas({ onOpenEntity }: Props): React.JSX.Element {
  const t = useT()
  const [maps, setMaps] = useState<WorldMap[]>([])
  const [ents, setEnts] = useState<Hierarchy['entities']>([])
  const [cfg, setCfg] = useState<HierConfig>({ govs: [] })
  const [modes, setModes] = useState<MapModes>({ dims: [], colors: {} })
  const [scales, setScales] = useState<Record<string, MapScale>>({})
  const [tl, setTl] = useState<TimelineConfig | null>(null)
  const [year, setYear] = useState<number | null>(null) // null = timeline yılı yüklenene dek

  useEffect(() => {
    let alive = true
    Promise.all([
      api.listMaps().then((ms) => Promise.all(ms.map((m) => api.getMap(m.id)))),
      api.hierarchy(),
      getHierConfig(),
      getMapModes(),
      api.getSetting('mapScales'),
      getTimeline()
    ]).then(([wms, h, hc, mm, sc, tcfg]) => {
      if (!alive) return
      setMaps(wms.filter((w): w is WorldMap => !!w))
      setEnts(h.entities)
      setCfg(hc)
      setModes(mm)
      setScales(JSON.parse(sc || '{}') as Record<string, MapScale>)
      setTl(tcfg)
      setYear(tcfg.year)
    })
    return () => {
      alive = false
    }
  }, [])

  const atlas = useMemo(() => {
    if (year === null) return []
    const byId = new Map(ents.map((e) => [e.id, e]))
    const fieldsOf = new Map(
      ents.map((e) => [e.id, JSON.parse(e.fields || '{}') as Record<string, string>])
    )
    // Taban küme + zincir tepesi: MapView ile ORTAK yardımcılar (tek kaynak — kural değişirse ikisi
    // birden güncellenir). rootAt harita başına değil çağrı başına memo'lu.
    const baseSet = lowestRungSet(cfg, ents)
    const rootMemo = new Map<number, number>()
    const rootAt = (eid: number): number => {
      const hit = rootMemo.get(eid)
      if (hit !== undefined) return hit
      const root = rootAtYear(eid, year, (id) => getParents(byId.get(id)?.fields ?? '{}'))
      rootMemo.set(eid, root)
      return root
    }
    const out: {
      map: WorldMap
      unit: string | null // null = ölçek yok (harita birimi²)
      total: number
      realms: Row[]
      dims: { dim: string; rows: Row[] }[]
    }[] = []
    for (const wm of maps) {
      const sc = scales[wm.id]
      const k = sc ? sc.perUnit * sc.perUnit : 1 // alan çarpanı (birim²)
      const realms = new Map<number, number>()
      const dimAreas = new Map<string, Map<string, number>>()
      for (const d of modes.dims) dimAreas.set(d, new Map())
      let total = 0
      for (const f of wm.features) {
        if (f.entity_id === null || !baseSet.has(f.entity_id)) continue
        if (!f.geometry.includes('"Polygon"')) continue
        const style = JSON.parse(f.style || '{}') as { from?: number; to?: number }
        if (!inYearRange(style.from, style.to, year)) continue
        const geom = JSON.parse(f.geometry) as { type: string; coordinates: number[][][] }
        if (geom.type !== 'Polygon') continue
        const area = ringArea(geom.coordinates[0]) * k
        total += area
        const root = rootAt(f.entity_id)
        realms.set(root, (realms.get(root) ?? 0) + area)
        const ef = fieldsOf.get(f.entity_id) ?? {}
        for (const d of modes.dims) {
          const v = ef[d] || '—'
          const m = dimAreas.get(d)!
          m.set(v, (m.get(v) ?? 0) + area)
        }
      }
      if (total === 0) continue
      const realmRows: Row[] = [...realms]
        .map(([eid, area]) => {
          const e = byId.get(eid)
          const name = e?.name ?? '?'
          return {
            key: `r${eid}`,
            label: name,
            color: fieldsOf.get(eid)?.['renk'] ?? autoColor(name),
            area,
            eid
          }
        })
        .sort((a, b) => b.area - a.area)
      const dimSections = modes.dims
        .map((d) => ({
          dim: d,
          rows: [...dimAreas.get(d)!]
            .map(([v, area]) => ({
              key: `d${d}:${v}`,
              label: v,
              color: v === '—' ? '#666666' : (modes.colors[d]?.[v] ?? autoColor(v)),
              area
            }))
            .sort((a, b) => b.area - a.area)
        }))
        .filter((s) => s.rows.length > 0)
      out.push({ map: wm, unit: sc?.unit ?? null, total, realms: realmRows, dims: dimSections })
    }
    return out
  }, [maps, ents, cfg, modes, scales, year])

  const barList = (rows: Row[], total: number, unit: string | null): React.JSX.Element => (
    <div className="atlas-rows">
      {rows.map((r) => (
        <div key={r.key} className="atlas-row">
          <span
            className={`atlas-name ${r.eid !== undefined ? 'clickable' : ''}`}
            onClick={r.eid !== undefined ? () => onOpenEntity(r.eid!) : undefined}
          >
            <span className="dot" style={{ background: r.color }} />
            {r.label}
          </span>
          <div className="atlas-bar-track">
            <div
              className="atlas-bar"
              style={{ width: `${(100 * r.area) / total}%`, background: r.color }}
            />
          </div>
          <span className="atlas-num">
            {fmtArea(r.area)} {unit ? `${unit}²` : t('mu²')} · {((100 * r.area) / total).toFixed(1)}
            %
          </span>
        </div>
      ))}
    </div>
  )

  return (
    <div className="page">
      <div className="page-head">
        <h2>{t('📊 Atlas')}</h2>
        {tl && year !== null && (
          <label className="atlas-year">
            {t('Year')}
            <input
              type="number"
              value={year}
              min={tl.min}
              max={tl.max}
              onChange={(e) => {
                const v = Number(e.target.value)
                if (Number.isFinite(v)) setYear(v) // '-'/boş → NaN, yıl'ı bozma
              }}
            />
            <span className="hint">{formatYear(year, tl)}</span>
          </label>
        )}
      </div>
      {atlas.length === 0 && (
        <p className="hint">
          {t(
            'No measurable regions yet. Draw base-rank polygons on a map (and set a map scale with the 📏 tool for real areas).'
          )}
        </p>
      )}
      {atlas.map(({ map, unit, total, realms, dims }) => (
        <div key={map.id} className="atlas-map">
          <h3>
            🗺 {map.name}
            <span className="hint">
              {' '}
              — {t('mapped area')}: {fmtArea(total)} {unit ? `${unit}²` : t('mu²')}
              {!unit && ` (${t('no scale set — 📏 tool on the map')})`}
            </span>
          </h3>
          <h4>{t('Realms')}</h4>
          {barList(realms, total, unit)}
          {dims.map(({ dim, rows }) => (
            <div key={dim}>
              <h4>{dim}</h4>
              {barList(rows, total, unit)}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
