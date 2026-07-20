import { useCallback, useEffect, useRef, useState } from 'react'
import {
  api,
  EntityRow,
  getLanguage,
  getTheme,
  getTypes,
  Lang,
  MapRow,
  Theme,
  TypeDef,
  typeColor
} from './api'
import Atlas from './Atlas'
import ContextMenu, { MenuState } from './ContextMenu'
import { alertDialog, confirmDialog, DialogHost } from './dialog'
import Diplomasi from './Diplomasi'
import EntityPage from './EntityPage'
import { deleteEntitiesWithUndo, deleteEntityWithUndo } from './entityOps'
import { LangContext, translate } from './i18n'
import Kronoloji from './Kronoloji'
import MapView from './MapView'
import Palette from './Palette'
import Settings from './Settings'
import { pushUndo, redo, undo } from './undo'

type View =
  | { kind: 'empty' }
  | { kind: 'entity'; id: number }
  | { kind: 'map'; id: number }
  | { kind: 'settings' }
  | { kind: 'kronoloji' }
  | { kind: 'diplomasi' }
  | { kind: 'atlas' }

export default function App(): React.JSX.Element {
  const [entities, setEntities] = useState<EntityRow[]>([])
  const [maps, setMaps] = useState<MapRow[]>([])
  const [types, setTypes] = useState<TypeDef[]>([])
  const [search, setSearch] = useState('')
  const [view, setView] = useState<View>({ kind: 'empty' })
  const [newMapName, setNewMapName] = useState<string | null>(null) // null = form kapalı
  const [palette, setPalette] = useState(false)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [focus, setFocus] = useState<{ featureId: number; token: number } | null>(null)
  const [bump, setBump] = useState(0) // undo sonrası açık sayfayı yeniden yüklet
  const [lang, setLang] = useState<Lang>('en')
  const [theme, setTheme] = useState<Theme>('dark')
  const [selected, setSelected] = useState<Set<number>>(new Set()) // çoklu silme seçimi
  const histRef = useRef<{ stack: View[]; idx: number }>({ stack: [], idx: -1 })
  // Del kısayolu için güncel seçim/görünümü stale closure olmadan oku
  const selectedRef = useRef(selected)
  const viewRef = useRef(view)
  useEffect(() => {
    selectedRef.current = selected
    viewRef.current = view
  })
  const t = (s: string, params?: Record<string, string | number>): string =>
    translate(lang, s, params)

  useEffect(() => {
    getLanguage().then(setLang)
    getTheme().then(setTheme)
  }, [])

  // Tema <html data-theme> ile uygulanır — CSS token'ları (main.css) oradan dallanır
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  const refresh = useCallback(async () => {
    const [e, m, t] = await Promise.all([api.listEntities(search), api.listMaps(), getTypes()])
    setEntities(e)
    setMaps(m)
    setTypes(t)
  }, [search])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Gezinme: entity/map görünümleri geçmişe girer, Alt+←/→ ile gezilir
  const navigate = useCallback((v: View): void => {
    setView(v)
    if (v.kind !== 'entity' && v.kind !== 'map') return
    const h = histRef.current
    const top = h.stack[h.idx]
    if (top && top.kind === v.kind && 'id' in top && top.id === v.id) return
    h.stack = h.stack.slice(0, h.idx + 1)
    h.stack.push(v)
    if (h.stack.length > 100) h.stack.shift()
    h.idx = h.stack.length - 1
  }, [])

  const openEntity = useCallback((id: number): void => navigate({ kind: 'entity', id }), [navigate])
  const openMap = useCallback((id: number): void => navigate({ kind: 'map', id }), [navigate])

  // Seçili maddeleri sil (buton + Del kısayolu ortak) — tek onay + tek undo
  const deleteSelected = useCallback(async (): Promise<void> => {
    const sel = selectedRef.current
    if (!sel.size) return
    if (await deleteEntitiesWithUndo([...sel])) {
      const v = viewRef.current
      if (v.kind === 'entity' && sel.has(v.id)) setView({ kind: 'empty' })
      setSelected(new Set())
      refresh()
    }
  }, [refresh])

  // Maddenin haritadaki ilk çizimine git
  const locateEntity = useCallback(
    async (entityId: number): Promise<void> => {
      const feats = await api.featuresByEntity(entityId)
      if (!feats.length) {
        alertDialog(translate(lang, 'This entity is not marked on any map yet.'))
        return
      }
      setFocus({ featureId: feats[0].id, token: Date.now() })
      openMap(feats[0].map_id)
    },
    [openMap, lang]
  )

  // Dünyayı .dunya dosyası olarak kaydet / dosyadan aç (Wonderdraft modeli).
  // Açma çalışma kopyasını ezer → kirliyse önce onay; sonra tam sayfa yeniden yükleme
  // (tüm ref/undo/state temiz başlar).
  const saveWorld = useCallback(
    (as = false): Promise<string | null> => (as ? api.saveWorldAs() : api.saveWorld()),
    []
  )
  const openWorld = useCallback(async (): Promise<void> => {
    const info = await api.worldInfo()
    if (
      info.dirty &&
      !(await confirmDialog(
        translate(lang, 'Opening another world will discard unsaved changes. Continue?')
      ))
    )
      return
    await api.openWorld() // yenilemeyi main yapar (webContents.reload — will-navigate engeline takılmaz)
  }, [lang])

  // Global kısayollar: Ctrl+K palet, Ctrl+S kaydet, Ctrl+O aç, Ctrl+Z geri al, Alt+←/→ geçmiş
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement
      const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable
      if (e.ctrlKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPalette((p) => !p)
      } else if (e.ctrlKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        saveWorld(e.shiftKey)
      } else if (e.ctrlKey && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        openWorld()
      } else if (e.key === 'Escape') {
        setPalette(false)
      } else if (
        e.ctrlKey &&
        (e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'y') &&
        !typing
      ) {
        e.preventDefault()
        const isRedo = e.key.toLowerCase() === 'y' || e.shiftKey
        ;(isRedo ? redo() : undo()).then((did) => {
          if (did) {
            refresh()
            setBump((b) => b + 1)
          }
        })
      } else if (
        (e.key === 'Delete' || e.key === 'Backspace') &&
        !typing &&
        selectedRef.current.size > 0
      ) {
        // Seçili maddeleri Del/Backspace ile sil (haritadaki çizim silme MapView'da ayrı)
        e.preventDefault()
        deleteSelected()
      } else if (e.altKey && e.key === 'ArrowLeft') {
        const h = histRef.current
        if (h.idx > 0) {
          h.idx--
          setView(h.stack[h.idx])
        }
      } else if (e.altKey && e.key === 'ArrowRight') {
        const h = histRef.current
        if (h.idx < h.stack.length - 1) {
          h.idx++
          setView(h.stack[h.idx])
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [refresh, deleteSelected, saveWorld, openWorld])

  // Tipe göre grupla (tipsizler "—" altında)
  const groups = new Map<string, EntityRow[]>()
  for (const e of entities) {
    const key = e.type || '—'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(e)
  }

  // Çoklu seçim: tek madde toggle, grup başlığı tüm alt maddeleri seçer/kaldırır
  const toggleOne = (eid: number): void =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(eid)) next.delete(eid)
      else next.add(eid)
      return next
    })
  const toggleGroup = (ids: number[], check: boolean): void =>
    setSelected((prev) => {
      const next = new Set(prev)
      for (const eid of ids)
        if (check) next.add(eid)
        else next.delete(eid)
      return next
    })

  return (
    <LangContext.Provider value={lang}>
      <div className="app">
        <div className="sidebar">
          <input
            className="search"
            placeholder={t('Search…  (Ctrl+K)')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />

          <div className="side-section">
            <div className="side-head">
              <span>{t('Maps')}</span>
              <button
                className="mini"
                onClick={() => setNewMapName(newMapName === null ? '' : null)}
              >
                +
              </button>
            </div>
            {newMapName !== null && (
              <form
                className="field-row add"
                onSubmit={async (e) => {
                  e.preventDefault()
                  if (!newMapName.trim()) return
                  const { id } = await api.createMap({ name: newMapName.trim() })
                  setNewMapName(null)
                  await refresh()
                  openMap(id)
                }}
              >
                <input
                  autoFocus
                  placeholder={t('map name')}
                  value={newMapName}
                  onChange={(e) => setNewMapName(e.target.value)}
                />
                <button className="mini" type="submit">
                  ✓
                </button>
              </form>
            )}
            {maps.map((m) => (
              <div
                key={m.id}
                className={`side-item ${view.kind === 'map' && view.id === m.id ? 'active' : ''}`}
                style={{ paddingLeft: m.parent_map_id ? 22 : 8 }}
                onClick={() => openMap(m.id)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setMenu({
                    x: e.clientX,
                    y: e.clientY,
                    items: [
                      { label: t('🗺 Open'), onClick: () => openMap(m.id) },
                      {
                        label: t('🗑 Delete'),
                        danger: true,
                        onClick: async () => {
                          if (
                            !(await confirmDialog(
                              t('Delete "{name}" and all drawings on it?', { name: m.name })
                            ))
                          )
                            return
                          // Undo için satır + çizimleri (orijinal id) + alt harita bağlarını yakala
                          const full = await api.getMap(m.id)
                          if (!full) return
                          const mapRow = {
                            id: full.id,
                            name: full.name,
                            parent_map_id: full.parent_map_id,
                            image_path: full.image_path,
                            width: full.width,
                            height: full.height,
                            layers: full.layers
                          }
                          const feats = full.features.map((f) => ({
                            id: f.id,
                            map_id: f.map_id,
                            entity_id: f.entity_id,
                            geometry: f.geometry,
                            style: f.style
                          }))
                          const childIds = maps
                            .filter((x) => x.parent_map_id === m.id)
                            .map((x) => x.id)
                          pushUndo({
                            undo: () => api.restoreMap(mapRow, feats, childIds),
                            redo: () => api.deleteMap(m.id)
                          })
                          await api.deleteMap(m.id)
                          if (view.kind === 'map' && view.id === m.id) setView({ kind: 'empty' })
                          refresh()
                        }
                      }
                    ]
                  })
                }}
              >
                🗺 {m.name}
              </div>
            ))}
          </div>

          <div className="side-section grow">
            <div className="side-head">
              <span>{t('Entities')}</span>
              <button
                className="mini"
                onClick={async () => {
                  const { id } = await api.createEntity({ name: t('New Entity') })
                  await refresh()
                  openEntity(id)
                }}
              >
                +
              </button>
            </div>
            {selected.size > 0 && (
              <div className="bulk-bar">
                <button className="mini danger" onClick={deleteSelected}>
                  🗑 {t('Delete selected ({n})', { n: selected.size })}
                </button>
                <button className="mini" onClick={() => setSelected(new Set())}>
                  {t('Clear')}
                </button>
              </div>
            )}
            {[...groups.entries()].map(([type, list]) => {
              const ids = list.map((e) => e.id)
              const selCount = ids.filter((eid) => selected.has(eid)).length
              return (
                <div key={type}>
                  <div className="group-head">
                    <input
                      type="checkbox"
                      className="sel-box"
                      checked={selCount === ids.length && ids.length > 0}
                      ref={(el) => {
                        if (el) el.indeterminate = selCount > 0 && selCount < ids.length
                      }}
                      onChange={(ev) => toggleGroup(ids, ev.target.checked)}
                    />
                    <span className="dot" style={{ background: typeColor(types, type) }} />
                    {type}
                  </div>
                  {list.map((e) => (
                    <div
                      key={e.id}
                      className={`side-item ${selected.has(e.id) ? 'selected' : ''} ${view.kind === 'entity' && view.id === e.id ? 'active' : ''}`}
                      onClick={() => openEntity(e.id)}
                      onContextMenu={(ev) => {
                        ev.preventDefault()
                        setMenu({
                          x: ev.clientX,
                          y: ev.clientY,
                          items: [
                            { label: t('📖 Open'), onClick: () => openEntity(e.id) },
                            { label: t('📍 Show on map'), onClick: () => locateEntity(e.id) },
                            {
                              label: t('🗑 Delete'),
                              danger: true,
                              onClick: async () => {
                                if (await deleteEntityWithUndo(e.id)) {
                                  if (view.kind === 'entity' && view.id === e.id)
                                    setView({ kind: 'empty' })
                                  refresh()
                                }
                              }
                            }
                          ]
                        })
                      }}
                    >
                      <input
                        type="checkbox"
                        className="sel-box"
                        checked={selected.has(e.id)}
                        onClick={(ev) => ev.stopPropagation()}
                        onChange={() => toggleOne(e.id)}
                      />
                      <span className="side-label">{e.name}</span>
                      <button
                        className="mini locate"
                        title={t('Show on map')}
                        onClick={(ev) => {
                          ev.stopPropagation()
                          locateEntity(e.id)
                        }}
                      >
                        📍
                      </button>
                    </div>
                  ))}
                </div>
              )
            })}
          </div>

          <div className="side-item kron-btn" onClick={() => saveWorld()}>
            💾 {t('Save World')}
          </div>
          <div className="side-item settings-btn" onClick={openWorld}>
            📂 {t('Open World')}
          </div>
          <div
            className={`side-item settings-btn ${view.kind === 'kronoloji' ? 'active' : ''}`}
            onClick={() => setView({ kind: 'kronoloji' })}
          >
            {t('📜 Chronology')}
          </div>
          <div
            className={`side-item settings-btn ${view.kind === 'diplomasi' ? 'active' : ''}`}
            onClick={() => setView({ kind: 'diplomasi' })}
          >
            {t('🕸 Diplomacy')}
          </div>
          <div
            className={`side-item settings-btn ${view.kind === 'atlas' ? 'active' : ''}`}
            onClick={() => setView({ kind: 'atlas' })}
          >
            {t('📊 Atlas')}
          </div>
          <div className="side-item settings-btn" onClick={() => setView({ kind: 'settings' })}>
            {t('⚙ Settings')}
          </div>
        </div>

        <div className="main">
          {view.kind === 'empty' && (
            <div className="empty-state">
              <h2>{t('World')}</h2>
              <p>{t('Select an entity or map from the left, or search with Ctrl+K.')}</p>
            </div>
          )}
          {view.kind === 'entity' && (
            <EntityPage
              key={`e-${view.id}-${bump}`}
              id={view.id}
              types={types}
              onOpen={openEntity}
              onChanged={refresh}
              onDeleted={() => setView({ kind: 'empty' })}
              onLocateFeature={(mapId, featureId) => {
                setFocus({ featureId, token: Date.now() })
                openMap(mapId)
              }}
            />
          )}
          {view.kind === 'map' && (
            <MapView
              key={`m-${view.id}`}
              focus={focus}
              reloadToken={bump}
              id={view.id}
              maps={maps}
              types={types}
              onNavigate={openMap}
              onOpenEntity={openEntity}
              onChanged={refresh}
            />
          )}
          {view.kind === 'settings' && (
            <Settings
              types={types}
              onChanged={refresh}
              lang={lang}
              onLangChange={setLang}
              theme={theme}
              onThemeChange={setTheme}
            />
          )}
          {view.kind === 'kronoloji' && (
            <Kronoloji
              onOpenEntity={openEntity}
              onLocateFeature={(mapId, featureId) => {
                setFocus({ featureId, token: Date.now() })
                openMap(mapId)
              }}
            />
          )}
          {view.kind === 'diplomasi' && <Diplomasi types={types} onOpenEntity={openEntity} />}
          {view.kind === 'atlas' && <Atlas onOpenEntity={openEntity} />}
        </div>

        {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
        {palette && (
          <Palette
            entities={entities}
            maps={maps}
            types={types}
            onOpenEntity={openEntity}
            onOpenMap={openMap}
            onClose={() => setPalette(false)}
            onChanged={refresh}
          />
        )}
        <DialogHost />
      </div>
    </LangContext.Provider>
  )
}
