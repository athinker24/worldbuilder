import { useEffect, useMemo, useState } from 'react'
import {
  api,
  autoColor,
  formatYear,
  getHierConfig,
  getMapModes,
  settingObject,
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
import Icon from './icons'
import { useT } from './i18n'
import { EmptyState } from './ui'

interface Props {
  onOpenEntity: (id: number) => void
}

// One group's (state / religion / language…) share-of-area row
interface Row {
  key: string
  label: string
  color: string
  area: number
  eid?: number // on a state row, click → entity page
}

const fmtArea = (v: number): string =>
  v >= 100 ? Math.round(v).toLocaleString() : v >= 1 ? v.toFixed(1) : v.toFixed(2)

// Atlas: the world in numbers. For the chosen year, each map's base polygons (lowest rank)
// are summed with their real areas (shoelace × map scale²); the area distribution is shown
// as colored bars per state (top of that year's parent chain) and per map-mode dimension
// (religion/language/culture). No new data — a read-only view over feature geometry +
// fields + mapScales.
export default function Atlas({ onOpenEntity }: Props): React.JSX.Element {
  const t = useT()
  const [maps, setMaps] = useState<WorldMap[]>([])
  const [ents, setEnts] = useState<Hierarchy['entities']>([])
  const [cfg, setCfg] = useState<HierConfig>({ govs: [] })
  const [modes, setModes] = useState<MapModes>({ dims: [], colors: {} })
  const [scales, setScales] = useState<Record<string, MapScale>>({})
  const [tl, setTl] = useState<TimelineConfig | null>(null)
  const [year, setYear] = useState<number | null>(null) // null = until the timeline year loads

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
      setScales(settingObject<Record<string, MapScale>>(sc, {}))
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
    // Base set + chain top: helpers SHARED with MapView (single source — a rule change
    // updates both). rootAt is memoised per call, not per map.
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
      unit: string | null // null = no scale (map units²)
      total: number
      realms: Row[]
      dims: { dim: string; rows: Row[] }[]
    }[] = []
    for (const wm of maps) {
      const sc = scales[wm.id]
      const k = sc ? sc.perUnit * sc.perUnit : 1 // area multiplier (units²)
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
            color: fieldsOf.get(eid)?.['color'] ?? autoColor(name),
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
          {/* A realm row opens its entry and a religion row does not, and until now the only
              thing saying so was the cursor — and neither could be reached by keyboard. The one
              that acts is a button; the one that does not stays text. */}
          {r.eid !== undefined ? (
            <button className="atlas-name clickable" onClick={() => onOpenEntity(r.eid!)}>
              <span className="dot" style={{ background: r.color }} />
              {r.label}
            </button>
          ) : (
            <span className="atlas-name">
              <span className="dot" style={{ background: r.color }} />
              {r.label}
            </span>
          )}
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
    <div className="page wide">
      {/* No <h2> — Overview's tab bar already names this view. */}
      <div className="page-head">
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
                if (Number.isFinite(v)) setYear(v) // '-'/empty → NaN, don't break the year
              }}
            />
            <span className="hint">{formatYear(year, tl)}</span>
          </label>
        )}
      </div>
      {atlas.length === 0 && (
        <EmptyState
          icon="polygon"
          title={t('Nothing to measure yet')}
          hint={t(
            'Draw base-rank polygons on a map, and set a map scale with the Scale tool to get real areas rather than map units.'
          )}
        />
      )}
      {atlas.map(({ map, unit, total, realms, dims }) => (
        <div key={map.id} className="atlas-map">
          {/* The heading is the map's name. The measurement is a fact ABOUT it and the missing
              scale is a warning, and both were riding inside the <h3> as one long sentence. */}
          <h3>
            <Icon name="map" size={15} /> {map.name}
          </h3>
          <p className="hint atlas-total">
            {t('mapped area')}: <span className="atlas-num">{fmtArea(total)}</span>{' '}
            {unit ? `${unit}²` : t('mu²')}
            {!unit && (
              <>
                {' · '}
                {t('no scale set: use the Scale tool on the map')}
              </>
            )}
          </p>
          {/* Realms and each map-mode dimension side by side rather than stacked: the extra
              width buys comparisons you can make at a glance, which is what an atlas is for.
              Columns reflow to one when the window is narrow. */}
          <div className="atlas-cols">
            <section className="atlas-col">
              <h4>{t('Realms')}</h4>
              {barList(realms, total, unit)}
            </section>
            {dims.map(({ dim, rows }) => (
              <section className="atlas-col" key={dim}>
                <h4>{dim}</h4>
                {barList(rows, total, unit)}
              </section>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
