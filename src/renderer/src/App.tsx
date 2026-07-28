import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  api,
  BoardDef,
  EntityRow,
  FolderDef,
  folderColor,
  getEntityFolders,
  getLanguage,
  getMapBoards,
  getTheme,
  Lang,
  MapRow,
  saveEntityFolders,
  Theme
} from './api'
import ColorPicker from './ColorPicker'
import ContextMenu, { MenuState } from './ContextMenu'
import Icon from './icons'
import Select from './Select'
import { IconButton } from './ui'
import { alertDialog, confirmDialog, DialogHost } from './dialog'
import EntityPage from './EntityPage'
import { deleteEntitiesWithUndo, deleteEntityWithUndo } from './entityOps'
import { LangContext, translate } from './i18n'
import MapView from './MapView'
import Overview, { OverviewTab } from './Overview'
import Palette from './Palette'
import { startPaneResize } from './paneResize'
import Preferences from './Preferences'
import ProjectPreferences from './ProjectPreferences'
import Shortcuts from './Shortcuts'
import { pushUndo, redo, undo } from './undo'

// Workspaces (places you go) vs commands (things you do): the commands all live in the
// application menu now, so every kind here is somewhere the main area can show.
type View =
  | { kind: 'empty' }
  | { kind: 'entity'; id: number }
  | { kind: 'map'; id: number }
  | { kind: 'preferences' } // application preferences (language, theme)
  | { kind: 'projectPrefs' } // the open project's structure (ranks, map modes, templates)
  | { kind: 'overview'; tab: OverviewTab } // Atlas / Chronology / Relations
  | { kind: 'shortcuts' }

export default function App(): React.JSX.Element {
  const [entities, setEntities] = useState<EntityRow[]>([])
  const [maps, setMaps] = useState<MapRow[]>([])
  const [search, setSearch] = useState('')
  const [view, setView] = useState<View>({ kind: 'empty' })
  const [palette, setPalette] = useState(false)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [focus, setFocus] = useState<{ featureId: number; token: number } | null>(null)
  const [bump, setBump] = useState(0) // reload the open page after an undo
  const [lang, setLang] = useState<Lang>('en')
  const [theme, setTheme] = useState<Theme>('dark')
  const [selected, setSelected] = useState<Set<number>>(new Set()) // multi-delete selection
  // Sidebar file tree (Obsidian model): folders group articles; membership = each article's
  // fields['folder']. Collapse + rename + drag are view/session state (browsing never dirties).
  const [folders, setFolders] = useState<FolderDef[]>([])
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<'az' | 'za' | 'created' | 'modified'>('az')
  // Which article is drawn on which map/board. Derived from features (see db.entityPlacements),
  // so the sidebar's map grouping needs no field on the entity and cannot fall out of sync.
  const [placements, setPlacements] = useState<
    { entity_id: number; map_id: number; board: string | null }[]
  >([])
  const [boards, setBoards] = useState<BoardDef[]>([])
  // Open/closed accordions, by group key. Session state on purpose: it follows which map you
  // are on, and persisting it would fight that.
  // The two tiers default opposite ways, and that asymmetry IS the difference between them:
  // a map group is somewhere you are NOT (closed unless listed here), while a board is a layer
  // of the map you ARE on, so it only labels its articles (open unless listed in closedBoards).
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set())
  const [closedBoards, setClosedBoards] = useState<Set<string>>(new Set())
  const dragItem = useRef<{ kind: 'entity' | 'folder'; id: number | string } | null>(null)
  const histRef = useRef<{ stack: View[]; idx: number }>({ stack: [], idx: -1 })
  // Read the current selection/view for the Del shortcut without a stale closure
  const selectedRef = useRef(selected)
  const viewRef = useRef(view)
  useEffect(() => {
    selectedRef.current = selected
    viewRef.current = view
  })
  const t = (s: string, params?: Record<string, string | number>): string =>
    translate(lang, s, params)

  // Photoshop's Tab / Shift+Tab: 'all' hides every chrome including the map tool palette,
  // 'panels' keeps the palette so you can still draw. Pressing either key while hidden restores,
  // whichever one hid it — that is how Photoshop behaves.
  // Deliberately NOT persisted (widths are): launching into a chrome-less window would read as a
  // broken app. This is a temporary view mode, not a layout preference.
  // The last map opened stays MOUNTED behind the other workspaces. Unmounting it
  // rebuilt Leaflet, refetched every feature and re-fitted the view on each return,
  // so coming back from an article threw away where you were on the map.
  const [mapId, setMapId] = useState<number | null>(null)
  useEffect(() => {
    if (view.kind === 'map') setMapId(view.id)
  }, [view])
  const [hidden, setHidden] = useState<null | 'panels' | 'all'>(null)
  const [sidebarW, setSidebarW] = useState(260)

  useEffect(() => {
    getLanguage().then(setLang)
    getTheme().then(setTheme)
    api.getPrefs().then((p) => {
      if (p.sidebarWidth) setSidebarW(p.sidebarWidth)
    })
  }, [])

  const togglePanels = useCallback(
    (keepTools: boolean): void => setHidden((h) => (h ? null : keepTools ? 'panels' : 'all')),
    []
  )

  // The theme is applied via <html data-theme> — the CSS tokens (main.css) branch on it
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  const refresh = useCallback(async () => {
    const [e, m, f, p] = await Promise.all([
      api.listEntities(search),
      api.listMaps(),
      getEntityFolders(),
      api.entityPlacements()
    ])
    setEntities(e)
    setMaps(m)
    setFolders(f)
    setPlacements(p)
  }, [search])

  // The open map's boards, for the second grouping tier. Empty list = the map has no boards,
  // and then the tier does not appear at all. Re-read on placements too: a board created in
  // MapView reaches the sidebar when something is drawn on it, which is also the first moment
  // it has anything to group.
  useEffect(() => {
    if (mapId === null) return setBoards([])
    getMapBoards(mapId).then((b) => setBoards(b.list))
  }, [mapId, placements])

  // Landing on a map opens that map's group and closes the rest — the point of the grouping is
  // that the map you are on is the list, and the others are put away.
  useEffect(() => {
    setOpenGroups(new Set(mapId === null ? [] : [`map:${mapId}`]))
  }, [mapId])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Navigation: entity/map views enter the history, browsed with Alt+←/→
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
  // Every map open writes 'lastMapId' (all switches — toolbar menu included — pass through
  // here) → returning to the app/maps reopens the last viewed map. Lives in the settings
  // table, so it travels inside the .dunya.
  const openMap = useCallback(
    (id: number): void => {
      api.setSetting('lastMapId', String(id))
      navigate({ kind: 'map', id })
    },
    [navigate]
  )

  // The sidebar "Maps" entry: open a map (last used, else the first, else create one).
  // Switching between maps happens in the map toolbar's dropdown.
  const openMaps = useCallback(async (): Promise<void> => {
    if (maps.length) {
      const last = Number(await api.getSetting('lastMapId'))
      openMap((maps.find((m) => m.id === last) ?? maps[0]).id)
    } else {
      const { id } = await api.createMap({ name: translate(lang, 'New map') })
      await refresh()
      openMap(id)
    }
  }, [maps, openMap, refresh, lang])

  // Delete the selected entities (button + Del shortcut share this) — one confirm + one undo
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

  // Jump to the entity's first drawing on a map
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

  // Save the world as a .dunya / open one from disk (Wonderdraft model). Opening overwrites
  // the working copy → confirm first when dirty; then a full page reload (all refs/undo/state
  // start clean).
  // Toast (save confirmation) — not modal, disappears on its own. There was no visual proof
  // that Ctrl+S actually wrote; auto-save reports through the same channel.
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const showToast = useCallback((msg: string): void => {
    setToast(msg)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 2200)
  }, [])

  // A command that fails must SAY so. Without this the app answers a failed click with nothing
  // at all — which is how the error log's own test went: the backup threw, the file recorded it
  // in full, and the user was left with no reason to ever go and look. main.tsx keeps its own
  // listener for the RECORD (it works even before React mounts); this one is for the PERSON.
  useEffect(() => {
    const onReject = (e: PromiseRejectionEvent): void => {
      const r = e.reason as { message?: string }
      // Strip Electron's IPC wrapper — the user does not need to read 'invoking remote method'.
      const msg = (r?.message ?? String(e.reason)).replace(
        /^Error invoking remote method '\w+': /,
        ''
      )
      showToast(translate(lang, 'Something went wrong: {msg}', { msg: msg.slice(0, 120) }))
    }
    window.addEventListener('unhandledrejection', onReject)
    return () => window.removeEventListener('unhandledrejection', onReject)
  }, [showToast, lang])

  const saveWorld = useCallback(
    async (as = false): Promise<string | null> => {
      const p = as ? await api.saveWorldAs() : await api.saveWorld()
      if (p) showToast(translate(lang, 'Saved: {name}', { name: p.split(/[\\/]/).pop() ?? '' }))
      return p
    },
    [showToast, lang]
  )

  // Auto-save (Photoshop/Krita pattern): when a .dunya is open and there are changes, pack
  // silently. With NO file, do nothing — popping a save dialog would steal focus (an unsaved
  // session is packed into backups/ on close anyway).
  useEffect(() => {
    const iv = setInterval(
      async () => {
        const info = await api.worldInfo()
        if (!info.dirty || !info.file) return
        await api.saveWorld()
        showToast(translate(lang, 'Auto-saved'))
      },
      3 * 60 * 1000
    )
    return () => clearInterval(iv)
  }, [showToast, lang])
  // The shared gate for every action that overwrites the working copy (open / open recent / new)
  const discardOk = useCallback(async (): Promise<boolean> => {
    const info = await api.worldInfo()
    return (
      !info.dirty ||
      (await confirmDialog(translate(lang, 'This will discard unsaved changes. Continue?')))
    )
  }, [lang])
  const openWorld = useCallback(async (): Promise<void> => {
    if (!(await discardOk())) return
    await api.openWorld() // main does the reload (webContents.reload — immune to the will-navigate block)
  }, [discardOk])

  // Start screen (Photoshop/Krita): recent .dunya files. The list lives in userData — the
  // working copy is reset on every launch, so it cannot live in settings.
  // worldFile: with a world open the start screen is hidden (Photoshop shows "home" only
  // with no document too) — the empty view falls back to a plain hint.
  const [recent, setRecent] = useState<{ path: string; name: string; missing: boolean }[]>([])
  const [worldFile, setWorldFile] = useState<string | null>(null)
  useEffect(() => {
    api.recentWorlds().then(setRecent)
    api.worldInfo().then((w) => setWorldFile(w.file))
  }, [])
  const openRecent = useCallback(
    async (path: string): Promise<void> => {
      if (!(await discardOk())) return
      if (await api.openRecent(path)) return // main reloads
      await alertDialog(translate(lang, 'File not found: {p}', { p: path }))
      setRecent(await api.recentWorlds()) // refresh the 'missing' marks
    },
    [discardOk, lang]
  )
  const forgetRecent = useCallback(async (path: string): Promise<void> => {
    await api.forgetRecent(path)
    setRecent(await api.recentWorlds())
  }, [])
  const newWorld = useCallback(async (): Promise<void> => {
    if (await discardOk()) await api.newWorld() // main resets + reloads
  }, [discardOk])
  const closeWorld = useCallback(async (): Promise<void> => {
    if (await discardOk()) await api.closeWorld() // main resets + reloads → start screen
  }, [discardOk])

  // The live map's PNG exporter, handed up by MapView while it is mounted (see onExportReady).
  // A plain () => void: no Leaflet type crosses the boundary, so the containment rule holds.
  const exportMapRef = useRef<(() => void) | null>(null)
  const handleExportReady = useCallback((fn: (() => void) | null): void => {
    exportMapRef.current = fn
  }, [])

  // Application-menu commands. Each one runs the SAME function the UI already calls — main only
  // forwards the click, so no command grows a second implementation.
  useEffect(() => {
    return window.api.onMenu((cmd) => {
      const recent = cmd.startsWith('file.recent:') ? cmd.slice('file.recent:'.length) : null
      if (recent) return void openRecent(recent)
      const tab = cmd.startsWith('view.overview:') ? cmd.slice('view.overview:'.length) : null
      if (tab) return setView({ kind: 'overview', tab: tab as OverviewTab })
      switch (cmd) {
        case 'file.new':
          return void newWorld()
        case 'file.open':
          return void openWorld()
        case 'file.save':
          return void saveWorld(false)
        case 'file.saveAs':
          return void saveWorld(true)
        case 'file.close':
          return void closeWorld()
        case 'file.exportMap':
          // ponytail: enabled even off a map view — greying it out would mean rebuilding the
          // native menu on every view change. Swap to a menu rebuild if that ever grates.
          return exportMapRef.current && viewRef.current.kind === 'map'
            ? exportMapRef.current()
            : showToast(translate(lang, 'Open a map first.'))
        case 'file.exportNotes':
          return void api
            .exportNotes()
            .then(({ files }) =>
              showToast(
                translate(lang, 'Exported {n} note file(s); opening the folder…', { n: files })
              )
            )
        case 'file.backup':
          return void api
            .backupNow()
            .then((path) => showToast(translate(lang, 'Backed up to {path}', { path })))
        case 'edit.undo':
        case 'edit.redo':
          return void (cmd === 'edit.redo' ? redo() : undo()).then((did) => {
            if (did) {
              refresh()
              setBump((b) => b + 1)
            }
          })
        case 'edit.prefs':
          return setView({ kind: 'preferences' })
        case 'view.maps':
          return void openMaps()
        case 'view.togglePanels':
          return togglePanels(false)
        case 'view.togglePanelsKeepTools':
          return togglePanels(true)
        case 'view.projectPrefs':
          return setView({ kind: 'projectPrefs' })
        case 'help.shortcuts':
          return setView({ kind: 'shortcuts' })
      }
    })
  }, [
    newWorld,
    openWorld,
    openRecent,
    closeWorld,
    saveWorld,
    openMaps,
    refresh,
    showToast,
    togglePanels,
    lang
  ])

  // Global shortcuts: Ctrl+K palette, Ctrl+Z undo, Del, Alt+←/→ history.
  // Ctrl+N/O/S/Shift+S and F1 are NOT here — the menu owns those accelerators, and handling them
  // in both places would fire every command twice. Undo/redo stay here on purpose: the menu
  // advertises Ctrl+Z without registering it, so this typing guard keeps textarea undo working.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement
      const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable
      if (e.ctrlKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPalette((p) => !p)
      } else if (e.key === 'Tab' && !typing && t.tagName !== 'SELECT' && t.tagName !== 'BUTTON') {
        // Photoshop's Tab / Shift+Tab. SELECT and BUTTON are excluded alongside the typing guard
        // so Tab keeps doing its real job — moving focus — whenever a control actually has it.
        e.preventDefault()
        togglePanels(e.shiftKey)
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
        // Delete selected entities with Del/Backspace (map feature deletion is separate, in MapView)
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
  }, [refresh, deleteSelected, togglePanels])

  // Sidebar file tree: articles are grouped under user-made folders (fields['folder']); a folder
  // id that no longer exists resolves to root (like map boards' resolveBoard).
  const folderIds = new Set(folders.map((f) => f.id))
  const entSort = (a: EntityRow, b: EntityRow): number => {
    if (sortKey === 'az') return a.name.localeCompare(b.name, 'tr')
    if (sortKey === 'za') return b.name.localeCompare(a.name, 'tr')
    if (sortKey === 'created') return (a.created_at ?? '').localeCompare(b.created_at ?? '')
    return (b.updated_at ?? '').localeCompare(a.updated_at ?? '') // modified: newest first
  }
  const foldersOf = (parent: string | null): FolderDef[] =>
    folders
      .filter((f) => (f.parent ?? null) === parent)
      .sort((a, b) =>
        sortKey === 'za' ? b.name.localeCompare(a.name, 'tr') : a.name.localeCompare(b.name, 'tr')
      )
  const folderOf = (e: EntityRow): string | null =>
    e.folder && folderIds.has(e.folder) ? e.folder : null // orphan → root
  // allow = the map/board group being drawn (null outside grouping: the whole tree).
  const entitiesOf = (folderId: string | null, allow: Set<number> | null): EntityRow[] =>
    entities.filter((e) => folderOf(e) === folderId && (!allow || allow.has(e.id))).sort(entSort)
  // A folder is drawn in a group only if the group actually holds something inside it —
  // otherwise every group would repeat the entire folder tree with most branches empty.
  const folderShown = (id: string, allow: Set<number> | null): boolean =>
    !allow ||
    entities.some((e) => folderOf(e) === id && allow.has(e.id)) ||
    folders.some((f) => f.parent === id && folderShown(f.id, allow))

  // Which maps each article is drawn on. An article drawn on several maps appears under each,
  // because it genuinely is on all of them — this is a view of the drawings, not an assignment.
  const entityMaps = useMemo(() => {
    const m = new Map<number, Set<number>>()
    for (const p of placements) {
      let s = m.get(p.entity_id)
      if (!s) m.set(p.entity_id, (s = new Set()))
      s.add(p.map_id)
    }
    return m
  }, [placements])

  // The sidebar's top tier once a map is open: this map expanded, the others put away, and
  // everything with no drawing at all in its own group at the bottom. Null before any map has
  // been opened — then the tree is the plain folder tree it has always been.
  const groups = useMemo(() => {
    if (mapId === null) return null
    const onMap = (id: number): Set<number> =>
      new Set(entities.filter((e) => entityMaps.get(e.id)?.has(id)).map((e) => e.id))
    const here = maps.find((m) => m.id === mapId)
    const out = here
      ? [{ key: `map:${here.id}`, name: here.name, kind: 'map' as const, allow: onMap(here.id) }]
      : []
    for (const m of maps) {
      if (m.id === mapId) continue
      const allow = onMap(m.id)
      // A map with nothing drawn on it would be an empty accordion, which is only noise.
      if (allow.size) out.push({ key: `map:${m.id}`, name: m.name, kind: 'map' as const, allow })
    }
    return [
      ...out,
      {
        key: 'unplaced',
        name: '', // labelled at render: keeping t() out of here keeps lang out of the deps
        kind: 'unplaced' as const,
        allow: new Set(entities.filter((e) => !entityMaps.has(e.id)).map((e) => e.id))
      }
    ]
  }, [mapId, maps, entities, entityMaps])

  // Second tier, inside the open map only. Mirrors MapView's resolveBoard: a missing or orphan
  // board id falls to the first board, so a renamed or deleted board never hides an article.
  const boardMembers = useMemo(() => {
    const m = new Map<string, Set<number>>()
    if (mapId === null || !boards.length) return m
    for (const p of placements) {
      if (p.map_id !== mapId) continue
      const b = p.board && boards.some((x) => x.id === p.board) ? p.board : boards[0].id
      let s = m.get(b)
      if (!s) m.set(b, (s = new Set()))
      s.add(p.entity_id)
    }
    return m
  }, [placements, mapId, boards])
  // Every descendant folder id (cycle-guard for moves + promote-children on delete)
  const descendantFolders = (id: string): Set<string> => {
    const out = new Set<string>()
    const walk = (p: string): void => {
      for (const f of folders)
        if (f.parent === p && !out.has(f.id)) {
          out.add(f.id)
          walk(f.id)
        }
    }
    walk(id)
    return out
  }

  // Multi-select: the per-article checkbox toggles one; the bulk bar clears/deletes
  const toggleOne = (eid: number): void =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(eid)) next.delete(eid)
      else next.add(eid)
      return next
    })

  // --- Sidebar folder tree actions ---
  const toggleCollapse = (id: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  // Folders live in settings (like map boards) — write optimistically, no undo (organisation only)
  const writeFolders = (next: FolderDef[]): void => {
    setFolders(next)
    saveEntityFolders(next)
  }
  const addFolder = (parent: string | null = null): void => {
    const id = crypto.randomUUID()
    const order =
      Math.max(0, ...folders.filter((f) => (f.parent ?? null) === parent).map((f) => f.order)) + 1
    writeFolders([...folders, { id, name: t('New folder'), parent, order }])
    if (parent) setCollapsed((prev) => new Set([...prev].filter((x) => x !== parent)))
    setRenamingFolder(id)
  }
  const moveFolder = (id: string, parent: string | null): void => {
    if (id === parent || (parent && descendantFolders(id).has(parent))) return // no cycle
    writeFolders(folders.map((f) => (f.id === id ? { ...f, parent } : f)))
  }
  // Set an article's folder without clobbering its other fields (read-modify-write)
  const setEntityFolder = async (eid: number, folder: string | null): Promise<void> => {
    const ent = await api.getEntity(eid)
    if (!ent) return
    const f = JSON.parse(ent.fields || '{}') as Record<string, string>
    if (folder) f.folder = folder
    else delete f.folder
    await api.updateEntity(eid, { fields: JSON.stringify(f) })
  }
  const moveEntity = async (eid: number, folder: string | null): Promise<void> => {
    const old = entities.find((e) => e.id === eid)?.folder ?? null
    if ((old ?? null) === folder) return
    await setEntityFolder(eid, folder)
    pushUndo({
      undo: async () => {
        await setEntityFolder(eid, old)
        refresh()
      },
      redo: async () => {
        await setEntityFolder(eid, folder)
        refresh()
      }
    })
    refresh()
  }
  // Delete a folder: its direct child folders + articles are promoted to the folder's parent
  const deleteFolder = async (folder: FolderDef): Promise<void> => {
    if (
      !(await confirmDialog(
        t('Delete folder "{name}"? (articles are kept)', { name: folder.name })
      ))
    )
      return
    const parent = folder.parent
    writeFolders(
      folders
        .filter((f) => f.id !== folder.id)
        .map((f) => (f.parent === folder.id ? { ...f, parent } : f))
    )
    for (const e of entities.filter((e) => e.folder === folder.id))
      await setEntityFolder(e.id, parent)
    refresh()
  }
  const addEntity = async (folderId: string | null = null): Promise<void> => {
    const { id } = await api.createEntity({ name: t('New Entity') })
    if (folderId) await setEntityFolder(id, folderId)
    await refresh()
    // A new article has no drawing yet, so it lands in the unplaced group — which is closed by
    // default. Without this it would look like the button did nothing.
    setOpenGroups((prev) => new Set(prev).add('unplaced'))
    openEntity(id)
  }
  const dropOn = (target: string | null): void => {
    const d = dragItem.current
    dragItem.current = null
    if (!d) return
    if (d.kind === 'entity') moveEntity(d.id as number, target)
    else moveFolder(d.id as string, target)
  }
  const folderMenu = (ev: React.MouseEvent, folder: FolderDef): void => {
    ev.preventDefault()
    ev.stopPropagation()
    setMenu({
      x: ev.clientX,
      y: ev.clientY,
      items: [
        { icon: 'file-text', label: t('New Entity'), onClick: () => addEntity(folder.id) },
        { icon: 'folder', label: t('New folder'), onClick: () => addFolder(folder.id) },
        { icon: 'pencil', label: t('Rename'), onClick: () => setRenamingFolder(folder.id) },
        {
          // People live in folders now (the old "Person" entity type): family/dynasty pickers
          // only suggest articles from these, and they cannot be bound to the map.
          // The icon carries the on/off state, so the label stays one stable key.
          icon: folder.isPerson ? 'check' : 'user',
          label: t('Person folder'),
          onClick: () =>
            writeFolders(
              folders.map((f) => (f.id === folder.id ? { ...f, isPerson: !f.isPerson } : f))
            )
        },
        { icon: 'trash', label: t('Delete'), danger: true, onClick: () => deleteFolder(folder) }
      ]
    })
  }

  // --- Sidebar tree render (folders recurse; articles are leaves) ---
  const renderEntityRow = (e: EntityRow, depth: number): React.JSX.Element => (
    <div
      key={e.id}
      className={`side-item ${selected.has(e.id) ? 'selected' : ''} ${view.kind === 'entity' && view.id === e.id ? 'active' : ''}`}
      style={{ paddingLeft: 8 + depth * 12 }}
      draggable
      onDragStart={(ev) => {
        dragItem.current = { kind: 'entity', id: e.id }
        ev.dataTransfer.effectAllowed = 'move'
      }}
      onClick={() => openEntity(e.id)}
      onContextMenu={(ev) => {
        ev.preventDefault()
        setMenu({
          x: ev.clientX,
          y: ev.clientY,
          items: [
            { icon: 'file-text', label: t('Open'), onClick: () => openEntity(e.id) },
            { icon: 'map-pin', label: t('Show on map'), onClick: () => locateEntity(e.id) },
            {
              icon: 'trash',
              label: t('Delete'),
              danger: true,
              onClick: async () => {
                if (await deleteEntityWithUndo(e.id)) {
                  if (view.kind === 'entity' && view.id === e.id) setView({ kind: 'empty' })
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
      {/* The colour is the FOLDER's, which the row's position under its folder already
          states — a dot on every row is noise. In search the list is flat and that
          context is gone, so the dot earns its place there and only there. */}
      {search.trim() && (
        <span
          className="dot"
          style={{ background: folderColor(folders, e.folder ?? null) }}
          title={folders.find((f) => f.id === e.folder)?.name ?? ''}
        />
      )}
      <span className="side-label">{e.name}</span>
      <span className="locate">
        <IconButton
          icon="map-pin"
          label={t('Show on map')}
          small
          onClick={(ev) => {
            ev.stopPropagation()
            locateEntity(e.id)
          }}
        />
      </span>
    </div>
  )
  const renderFolderRow = (
    folder: FolderDef,
    depth: number,
    allow: Set<number> | null
  ): React.JSX.Element => {
    const open = !collapsed.has(folder.id)
    return (
      <div key={`f-${folder.id}`}>
        <div
          className="side-folder"
          style={{ paddingLeft: 6 + depth * 12 }}
          draggable={renamingFolder !== folder.id}
          onDragStart={(ev) => {
            dragItem.current = { kind: 'folder', id: folder.id }
            ev.dataTransfer.effectAllowed = 'move'
          }}
          onDragOver={(ev) => ev.preventDefault()}
          onDrop={(ev) => {
            ev.preventDefault()
            ev.stopPropagation()
            dropOn(folder.id)
          }}
          onClick={() => toggleCollapse(folder.id)}
          onContextMenu={(ev) => folderMenu(ev, folder)}
        >
          <span className="tree-caret">{open ? '▾' : '▸'}</span>
          {/* The folder's color (the old entity-type color, re-homed): also the default color of
              map drawings whose article lives in this folder. */}
          {/* stopPropagation: the row itself toggles the folder open, and the picker sits inside it */}
          <span onClick={(ev) => ev.stopPropagation()}>
            <ColorPicker
              className="folder-color"
              title={t('Folder color')}
              value={folder.color ?? '#7bb3ff'}
              onChange={(hex) =>
                writeFolders(folders.map((f) => (f.id === folder.id ? { ...f, color: hex } : f)))
              }
            />
          </span>
          {renamingFolder === folder.id ? (
            <input
              className="folder-rename"
              autoFocus
              defaultValue={folder.name}
              onClick={(ev) => ev.stopPropagation()}
              onFocus={(ev) => ev.currentTarget.select()}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur()
                else if (ev.key === 'Escape') setRenamingFolder(null)
              }}
              onBlur={(ev) => {
                const v = ev.target.value.trim()
                if (v && v !== folder.name)
                  writeFolders(folders.map((f) => (f.id === folder.id ? { ...f, name: v } : f)))
                setRenamingFolder(null)
              }}
            />
          ) : (
            <span className="side-label" onDoubleClick={() => setRenamingFolder(folder.id)}>
              {folder.name}
            </span>
          )}
        </div>
        {/* Indent guide. The wrapper only draws a line via ::before, so rows keep
            the padding they already compute and nothing shifts. */}
        {open && (
          <div
            className="tree-children"
            style={{ ['--guide']: `${11 + depth * 12}px` } as React.CSSProperties}
          >
            {renderChildren(folder.id, depth + 1, allow)}
          </div>
        )}
      </div>
    )
  }
  const toggle = (set: Set<string>, key: string): Set<string> => {
    const next = new Set(set)
    if (!next.delete(key)) next.add(key)
    return next
  }
  // A board group: the lighter, inner tier. Same shape as a map group, but it starts open and
  // sits one level in, so it reads as a label on articles you can already see.
  const renderBoardGroup = (b: BoardDef, mapAllow: Set<number>): React.JSX.Element => {
    const open = !closedBoards.has(b.id)
    const allow = new Set([...(boardMembers.get(b.id) ?? [])].filter((id) => mapAllow.has(id)))
    return (
      <div className="side-group board" key={b.id}>
        <button
          className="side-group-head"
          onClick={() => setClosedBoards((prev) => toggle(prev, b.id))}
        >
          <span className="tree-caret">{open ? '▾' : '▸'}</span>
          <Icon name="board" size={12} />
          <span className="side-label">{b.name}</span>
          <span className="side-group-count">{allow.size}</span>
        </button>
        {open && <div className="side-group-body">{renderChildren(null, 0, allow)}</div>}
      </div>
    )
  }
  const renderGroup = (g: {
    key: string
    name: string
    kind: 'map' | 'unplaced'
    allow: Set<number>
  }): React.JSX.Element => {
    const open = openGroups.has(g.key)
    // Boards subdivide the map you are on; on the other maps' groups they would be noise.
    const withBoards = g.key === `map:${mapId}` && boards.length > 0
    return (
      <div className="side-group" key={g.key}>
        <button
          className="side-group-head"
          onClick={() => setOpenGroups((prev) => toggle(prev, g.key))}
        >
          <span className="tree-caret">{open ? '▾' : '▸'}</span>
          <Icon name={g.kind === 'map' ? 'map' : 'file-text'} size={13} />
          <span className="side-label">{g.kind === 'map' ? g.name : t('Not on a map')}</span>
          <span className="side-group-count">{g.allow.size}</span>
        </button>
        {open && (
          <div className="side-group-body">
            {g.allow.size === 0 ? (
              <p className="hint">
                {g.kind === 'map'
                  ? t('Nothing drawn on this map yet.')
                  : t('Every article is on a map.')}
              </p>
            ) : withBoards ? (
              boards.map((b) => renderBoardGroup(b, g.allow))
            ) : (
              renderChildren(null, 0, g.allow)
            )}
          </div>
        )}
      </div>
    )
  }
  const renderChildren = (
    parent: string | null,
    depth: number,
    allow: Set<number> | null
  ): React.JSX.Element[] => [
    ...foldersOf(parent)
      .filter((f) => folderShown(f.id, allow))
      .map((f) => renderFolderRow(f, depth, allow)),
    ...entitiesOf(parent, allow).map((e) => renderEntityRow(e, depth))
  ]

  return (
    <LangContext.Provider value={lang}>
      <div className="app">
        {/* Shift+Tab leaves a thin rail as the way back; plain Tab is presentation mode and
            hides even that, exactly like Photoshop. The View menu is the guaranteed way out. */}
        {hidden === 'panels' && (
          <button
            className="sidebar-rail"
            title={t('Show panels (Tab)')}
            aria-label={t('Show panels (Tab)')}
            onClick={() => togglePanels(false)}
          >
            ▸
          </button>
        )}
        {/* Hidden rather than unmounted: collapsing must not throw away the tree's collapsed
            folders, scroll position or current search. */}
        <div
          className="sidebar"
          style={{
            width: sidebarW,
            minWidth: sidebarW,
            display: hidden ? 'none' : undefined
          }}
        >
          <div className="search-field">
            <Icon name="search" size={14} />
            <input
              className="search"
              placeholder={t('Search…  (Ctrl+K)')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <div className="side-section grow">
            <div className="side-head">
              <span>{t('Entities')}</span>
            </div>
            {selected.size > 0 && (
              <div className="bulk-bar">
                <button className="mini danger" onClick={deleteSelected}>
                  <Icon name="trash" size={12} /> {t('Delete selected ({n})', { n: selected.size })}
                </button>
                <button className="mini" onClick={() => setSelected(new Set())}>
                  {t('Clear')}
                </button>
              </div>
            )}
            {/* The file tree. Dropping on empty space moves the dragged item to the root. */}
            <div
              className="side-tree"
              onDragOver={(ev) => ev.preventDefault()}
              onDrop={(ev) => {
                ev.preventDefault()
                dropOn(null)
              }}
            >
              {search.trim()
                ? entities
                    .slice()
                    .sort(entSort)
                    .map((e) => renderEntityRow(e, 0)) // search = flat: grouping would hide hits
                : groups
                  ? groups.map(renderGroup)
                  : renderChildren(null, 0, null)}
            </div>
            {/* Create + sort at the bottom of the column (Obsidian) */}
            <div className="side-foot">
              <button className="mini" title={t('New Entity')} onClick={() => addEntity()}>
                {t('＋ Entity')}
              </button>
              <button className="mini" title={t('New folder')} onClick={() => addFolder()}>
                {t('＋ Folder')}
              </button>
              <span className="side-foot-spacer" />
              <Select
                className="side-sort"
                title={t('Sort')}
                value={sortKey}
                onChange={(v) => setSortKey(v as typeof sortKey)}
                options={[
                  { value: 'az', label: 'A–Z' },
                  { value: 'za', label: 'Z–A' },
                  { value: 'created', label: t('Created') },
                  { value: 'modified', label: t('Modified') }
                ]}
              />
            </div>
          </div>

          {/* Workspaces only. Project commands (save/open/export/backup) live in the File menu,
              application preferences in Edit, and Shortcuts in Help — the sidebar is for places
              you go, not things you do.
              These are a DIFFERENT kind of thing from the article rows above, so they get their
              own block above a real boundary: rendered as plain .side-item they were
              indistinguishable from an entity that happened to start with an emoji. */}
          <nav className="side-nav">
            {/* Written out rather than mapped over a tuple list: the lint rule guarding
                ref access during render false-positives on the `as const` array. */}
            <button
              className={`side-nav-item ${view.kind === 'map' ? 'active' : ''}`}
              onClick={openMaps}
            >
              <Icon name="map" size={14} />
              {t('Maps')}
            </button>
            <button
              className={`side-nav-item ${view.kind === 'overview' ? 'active' : ''}`}
              onClick={() => setView({ kind: 'overview', tab: 'atlas' })}
            >
              <Icon name="landmark" size={14} />
              {t('Overview')}
            </button>
            <button
              className={`side-nav-item ${view.kind === 'projectPrefs' ? 'active' : ''}`}
              onClick={() => setView({ kind: 'projectPrefs' })}
            >
              <Icon name="template" size={14} />
              {t('Project Preferences')}
            </button>
          </nav>
        </div>
        {!hidden && (
          <div
            className="pane-resize"
            title={t('Drag to resize')}
            onMouseDown={(e) =>
              startPaneResize(e, {
                from: sidebarW,
                edge: 'right', // handle on the panel's right: dragging right widens it
                min: 180,
                max: 520,
                onMove: setSidebarW,
                onDone: (w) => api.savePrefs({ sidebarWidth: w }) // persist once, not per pixel
              })
            }
          />
        )}

        <div className="main">
          {view.kind === 'empty' && (
            <div className="empty-state start-screen">
              <h2>{t('World')}</h2>
              {!worldFile && (
                <>
                  <div className="start-actions">
                    <button onClick={newWorld}>{t('＋ New world')}</button>
                    <button onClick={openWorld}>
                      <Icon name="folder" size={14} /> {t('Open…')}
                    </button>
                  </div>
                  <h4>{t('Recent')}</h4>
                  {recent.length === 0 ? (
                    <p>{t('No recent worlds yet — save one with Ctrl+S.')}</p>
                  ) : (
                    <ul className="recent-list">
                      {recent.map((r) => (
                        <li key={r.path} className={r.missing ? 'missing' : undefined}>
                          <button
                            className="recent-open"
                            title={r.path}
                            onClick={() => openRecent(r.path)}
                          >
                            <span className="recent-name">{r.name}</span>
                            <span className="recent-path">
                              {r.missing ? t('file not found') : r.path}
                            </span>
                          </button>
                          <button
                            className="recent-x"
                            title={t('Remove from list')}
                            onClick={() => forgetRecent(r.path)}
                          >
                            ×
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
              <p>{t('Pick an entity or a map from the left, or search with Ctrl+K.')}</p>
            </div>
          )}
          {view.kind === 'entity' && (
            <EntityPage
              key={`e-${view.id}-${bump}`}
              id={view.id}
              folders={folders}
              onOpen={openEntity}
              onChanged={refresh}
              onDeleted={() => setView({ kind: 'empty' })}
              onLocateFeature={(mapId, featureId) => {
                setFocus({ featureId, token: Date.now() })
                openMap(mapId)
              }}
            />
          )}
          {/* display:none, not unmounted — see mapId above. `contents` while visible so
              the wrapper never becomes a layout box of its own. */}
          {mapId !== null && (
            <div style={{ display: view.kind === 'map' ? 'contents' : 'none' }}>
              <MapView
                key={`m-${mapId}`}
                active={view.kind === 'map'}
                focus={focus}
                reloadToken={bump}
                id={mapId}
                maps={maps}
                folders={folders}
                onNavigate={openMap}
                onOpenEntity={openEntity}
                onChanged={refresh}
                onExportReady={handleExportReady}
                hidePanels={hidden !== null}
                hideTools={hidden === 'all'}
              />
            </div>
          )}
          {view.kind === 'preferences' && (
            <Preferences
              lang={lang}
              onLangChange={setLang}
              theme={theme}
              onThemeChange={setTheme}
            />
          )}
          {view.kind === 'projectPrefs' && <ProjectPreferences />}
          {view.kind === 'overview' && (
            <Overview
              tab={view.tab}
              onTab={(tab) => setView({ kind: 'overview', tab })}
              folders={folders}
              onOpenEntity={openEntity}
              onLocateFeature={(mapId, featureId) => {
                setFocus({ featureId, token: Date.now() })
                openMap(mapId)
              }}
            />
          )}
          {view.kind === 'shortcuts' && <Shortcuts />}
        </div>

        {toast && <div className="toast">{toast}</div>}
        {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
        {palette && (
          <Palette
            entities={entities}
            maps={maps}
            folders={folders}
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
