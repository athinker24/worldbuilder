import { useEffect, useState } from 'react'
import {
  api,
  autoColor,
  getHierConfig,
  getMapModes,
  Hierarchy,
  HierConfig,
  MapModes,
  mergeHierConfig,
  saveMapModes
} from './api'
import ColorPicker from './ColorPicker'
import { useT } from './i18n'

// The map's active mode: rank (paint base polygons by their ancestor at that rank — the CK3
// realm view) or paint (color by a dimension like religion/language)
export type ActiveMode = { kind: 'rank' | 'paint'; key: string } | null

interface Props {
  active: ActiveMode
  reloadToken: number // to refresh when tags change (undo included)
  onMode: (m: ActiveMode) => void
  onConquest: () => void // start the ⚔ Conquest flow (visible only in rank mode)
  onOpenEntity: (id: number) => void
  onLocate: (id: number) => void
}

/** CK3-style bottom-right hierarchy panel: government tabs + rank views + map modes. */
export default function HierarchyPanel({
  active,
  reloadToken,
  onMode,
  onConquest,
  onOpenEntity,
  onLocate
}: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [hier, setHier] = useState<Hierarchy>({ tags: [], govs: [], entities: [] })
  const [cfg, setCfg] = useState<HierConfig>({ govs: [] })
  const [modes, setModes] = useState<MapModes>({ dims: [], colors: {} })
  const [activeGov, setActiveGov] = useState<string | null>(null)
  const t = useT()

  const refresh = (): Promise<void> =>
    Promise.all([api.hierarchy(), getHierConfig(), getMapModes()]).then(([h, c, m]) => {
      const merged = mergeHierConfig(c, h.govs)
      setHier(h)
      setCfg(merged)
      setModes(m)
      setActiveGov((cur) => cur ?? merged.govs[0]?.name ?? null)
    })

  useEffect(() => {
    if (open) refresh()
  }, [open, reloadToken])

  if (!open)
    return (
      <button className="hier-toggle" onClick={() => setOpen(true)}>
        🏛 {t('Hierarchy')}
      </button>
    )

  const gov = cfg.govs.find((g) => g.name === activeGov)
  const rungTag = active?.kind === 'rank' ? active.key : null
  const paintDim = active?.kind === 'paint' ? active.key : null
  const list = rungTag ? hier.entities.filter((e) => e.tags.includes(rungTag)) : []

  // Paint legend: unique values present in the active dimension
  const dimValues = paintDim
    ? [
        ...new Set(
          hier.entities
            .map((e) => (JSON.parse(e.fields || '{}') as Record<string, string>)[paintDim])
            .filter(Boolean)
        )
      ].sort((a, b) => a.localeCompare(b, 'tr'))
    : []

  // Write the value's color into mapModes and re-trigger the mode to repaint the map
  const setDimColor = async (value: string, hex: string): Promise<void> => {
    if (!paintDim) return
    const next: MapModes = {
      ...modes,
      colors: { ...modes.colors, [paintDim]: { ...modes.colors[paintDim], [value]: hex } }
    }
    setModes(next)
    await saveMapModes(next)
    onMode(active)
  }

  // Write the rank entity's color into fields.color (rank painting reads it from there)
  const setEntityColor = async (eid: number, hex: string): Promise<void> => {
    const e = await api.getEntity(eid)
    if (!e) return
    const f = JSON.parse(e.fields || '{}') as Record<string, string>
    f['color'] = hex
    await api.updateEntity(eid, { fields: JSON.stringify(f) })
    await refresh()
    onMode(active)
  }

  const entityColor = (e: { fields: string; name: string }): string =>
    (JSON.parse(e.fields || '{}') as Record<string, string>)['color'] ?? autoColor(e.name)

  return (
    <div className="hier-panel">
      <div className="hier-head">
        <b>{t('Hierarchy')}</b>
        <button className="mini" onClick={() => setOpen(false)}>
          ×
        </button>
      </div>
      {cfg.govs.length > 1 && (
        <div className="hier-tabs">
          {cfg.govs.map((g) => (
            <button
              key={g.name}
              className={`tag-chip clickable ${activeGov === g.name ? 'active' : ''}`}
              onClick={() => setActiveGov(g.name)}
            >
              {g.name}
            </button>
          ))}
        </div>
      )}
      <div className="hier-tags">
        <button
          className={`tag-chip clickable ${active === null ? 'active' : ''}`}
          onClick={() => onMode(null)}
        >
          {t('All')}
        </button>
        {(gov?.tags ?? []).map((tag) => (
          <button
            key={tag}
            className={`tag-chip clickable ${rungTag === tag ? 'active' : ''}`}
            onClick={() => onMode(tag === rungTag ? null : { kind: 'rank', key: tag })}
          >
            {tag}
          </button>
        ))}
        {cfg.govs.length === 0 && (
          <p className="hint">
            {t(
              'No ladder yet. Write a government form on entities, then order the ranks from Settings.'
            )}
          </p>
        )}
      </div>
      {modes.dims.length > 0 && (
        <div className="hier-tags hier-modes">
          {modes.dims.map((d) => (
            <button
              key={d}
              className={`tag-chip clickable ${paintDim === d ? 'active' : ''}`}
              onClick={() => onMode(d === paintDim ? null : { kind: 'paint', key: d })}
            >
              🎨 {d}
            </button>
          ))}
        </div>
      )}
      {rungTag && (
        <>
          <button className="tag-chip clickable" onClick={onConquest}>
            ⚔ {t('Conquest')}
          </button>
          <div className="hier-list">
            {list.map((e) => (
              <div className="side-item" key={e.id} onClick={() => onOpenEntity(e.id)}>
                <span onClick={(ev) => ev.stopPropagation()}>
                  <ColorPicker
                    value={entityColor(e)}
                    onChange={(hex) => setEntityColor(e.id, hex)}
                  />
                </span>
                <span className="side-label">{e.name}</span>
                <button
                  className="locate"
                  title={t('Show on map')}
                  onClick={(ev) => {
                    ev.stopPropagation()
                    onLocate(e.id)
                  }}
                >
                  📍
                </button>
              </div>
            ))}
            {list.length === 0 && <p className="hint">{t('No entities in this rank.')}</p>}
          </div>
        </>
      )}
      {paintDim && (
        <div className="hier-list">
          {dimValues.map((v) => (
            <div className="side-item" key={v}>
              <span onClick={(ev) => ev.stopPropagation()}>
                <ColorPicker
                  value={modes.colors[paintDim]?.[v] ?? autoColor(v)}
                  onChange={(hex) => setDimColor(v, hex)}
                />
              </span>
              <span className="side-label">{v}</span>
            </div>
          ))}
          {dimValues.length === 0 && (
            <p className="hint">
              {t('No values in this dimension. Write a "{dim}" field on entities.', {
                dim: paintDim
              })}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
