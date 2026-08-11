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
import Icon from './icons'
import { useT } from './i18n'
import { IconButton, Segmented, Tabs } from './ui'

// The map's active mode: rank (paint base polygons by their ancestor at that rank — the CK3
// realm view) or paint (color by a dimension like religion/language)
export type ActiveMode = { kind: 'rank' | 'paint'; key: string } | null

interface Props {
  active: ActiveMode
  // Entries this map is about (drawn here, or ruling land drawn here — built in MapView's
  // reloadFeatures). The lists below are filtered to it: the ladder itself is project structure
  // and every rank chip stays pressable, but WHAT IS UNDER one is a question about this map.
  scope: Set<number>
  reloadToken: number // to refresh when tags change (undo included)
  onMode: (m: ActiveMode) => void
  onConquest: () => void // start the ⚔ Conquest flow (visible only in rank mode)
  onOpenEntity: (id: number) => void
  onLocate: (id: number) => void
}

/** CK3-style bottom-right hierarchy panel: government tabs + rank views + map modes. */
export default function HierarchyPanel({
  active,
  scope,
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
        <Icon name="landmark" size={14} /> {t('Hierarchy')}
      </button>
    )

  const gov = cfg.govs.find((g) => g.name === activeGov)
  const rungTag = active?.kind === 'rank' ? active.key : null
  const paintDim = active?.kind === 'paint' ? active.key : null
  // One filter, both lists: the rank list and the paint legend were each showing the whole world,
  // so a religion practised only on another map still took a colour row here.
  const here = hier.entities.filter((e) => scope.has(e.id))
  const list = rungTag ? here.filter((e) => e.tags.includes(rungTag)) : []

  // Paint legend: unique values present in the active dimension
  const dimValues = paintDim
    ? [
        ...new Set(
          here
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
        <IconButton icon="x" label={t('Close')} small onClick={() => setOpen(false)} />
      </div>
      {/* Government forms are places to LOOK, not modes — switching one changes which ladder is
          on screen and nothing about the map. That is navigation, so it is a tab strip. */}
      {cfg.govs.length > 1 && (
        <Tabs
          tabs={cfg.govs.map((g) => ({ key: g.name, label: g.name }))}
          active={activeGov ?? ''}
          onChange={setActiveGov}
        />
      )}
      {/* One state (ActiveMode) shown across two groups, because the two questions are different
          — a ladder is ordered, dimensions are a flat set — while the answer is exclusive. When
          a dimension is painting, nothing in the rank group is pressed, which is true. */}
      <Segmented
        label={t('Rank view')}
        options={[
          { key: '', label: t('All') },
          ...(gov?.tags ?? []).map((tag) => ({ key: tag, label: tag }))
        ]}
        value={active === null ? '' : active.kind === 'rank' ? active.key : null}
        onChange={(key) => onMode(key && key !== rungTag ? { kind: 'rank', key } : null)}
      />
      {cfg.govs.length === 0 && (
        <p className="hint">
          {t(
            'No ladder yet. Write a government form on entries, then order the ranks from Settings.'
          )}
        </p>
      )}
      {modes.dims.length > 0 && (
        <Segmented
          label={t('Paint by')}
          options={modes.dims.map((d) => ({ key: d, label: d, icon: 'palette' as const }))}
          value={paintDim}
          onChange={(key) => onMode(key === paintDim ? null : { kind: 'paint', key })}
        />
      )}
      {rungTag && (
        <>
          {/* An ACTION, and the one thing in this panel that is: it starts a two-step flow that
              takes over the map's clicks. It wore the same chip as the view modes around it. */}
          <button className="mini" onClick={onConquest}>
            <Icon name="conquest" size={12} /> {t('Conquest')}
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
                  <Icon name="map-pin" size={13} />
                </button>
              </div>
            ))}
            {list.length === 0 && <p className="hint">{t('Nothing in this rank on this map.')}</p>}
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
            <p className="hint">{t('No values in this dimension on this map.')}</p>
          )}
        </div>
      )}
    </div>
  )
}
