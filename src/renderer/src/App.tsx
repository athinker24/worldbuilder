import { useCallback, useEffect, useRef, useState } from 'react'
import {
  api,
  Entity,
  EntityRow,
  FolderDef,
  getEntityFolders,
  getLanguage,
  getTheme,
  Lang,
  MapRow,
  saveEntityFolders,
  Theme
} from './api'
import ContextMenu, { MenuState } from './ContextMenu'
import Icon from './icons'
import { EmptyState } from './ui'
import { alertDialog, confirmDialog, DialogHost } from './dialog'
import EntityPage from './EntityPage'
import { deleteEntitiesWithUndo } from './entityOps'
import { LangContext, translate } from './i18n'
import MapView from './MapView'
import Overview, { OverviewTab } from './Overview'
import Palette from './Palette'
import { startPaneResize } from './paneResize'
import Preferences from './Preferences'
import ProjectPreferences from './ProjectPreferences'
import Shortcuts from './Shortcuts'
import Sidebar from './Sidebar'
import { redo, type StepResult, undo } from './undo'
import { logEvent, setDebugLog } from './log'
import type { View } from './views'

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
  // Multi-select, in two sets because the two kinds of row have two kinds of id. Both live here
  // rather than in the sidebar that draws the checkboxes, because the Del shortcut below deletes
  // them from anywhere in the app. Checking a folder puts its whole contents in BOTH — see
  // Sidebar's toggleFolderSel — so what is deleted is exactly what is ticked.
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [selectedFolders, setSelectedFolders] = useState<Set<string>>(new Set())
  // Folders group articles (membership = each article's fields['folder']). Owned here because
  // four screens read them — the sidebar, the entity page, the map and the palette all colour by
  // folder; the sidebar's own state (collapse, rename, drag) is the sidebar's.
  const [folders, setFolders] = useState<FolderDef[]>([])
  // Which article is drawn on which map/board. Derived from features (see db.entityPlacements),
  // so the sidebar's map grouping needs no field on the entity and cannot fall out of sync.
  const [placements, setPlacements] = useState<
    { entity_id: number; map_id: number; board: string | null }[]
  >([])
  const histRef = useRef<{ stack: View[]; idx: number }>({ stack: [], idx: -1 })
  // What the Del shortcut needs, without a stale closure — and without putting any of it in
  // deleteSelected's dependency list, which the keydown effect below depends on in turn: `folders`
  // is a fresh array out of every refresh(), so a dependency on it would re-register the window
  // listener after every edit in the app.
  const selectedRef = useRef(selected)
  const selectedFoldersRef = useRef(selectedFolders)
  const foldersRef = useRef(folders)
  const langRef = useRef(lang)
  const viewRef = useRef(view)
  useEffect(() => {
    selectedRef.current = selected
    selectedFoldersRef.current = selectedFolders
    foldersRef.current = folders
    langRef.current = lang
    viewRef.current = view
  })
  const t = (s: string, params?: Record<string, string | number>): string =>
    translate(lang, s, params)

  // Tab / Shift+Tab: 'all' hides every chrome including the map tool palette,
  // 'panels' keeps the palette so you can still draw. Pressing either key while hidden restores,
  // whichever one hid it.
  // Deliberately NOT persisted (widths are): launching into a chrome-less window would read as a
  // broken app. This is a temporary view mode, not a layout preference.
  // The last map opened stays MOUNTED behind the other workspaces. Unmounting it
  // rebuilt Leaflet, refetched every feature and re-fitted the view on each return,
  // so coming back from an article threw away where you were on the map.
  const [mapId, setMapId] = useState<number | null>(null)
  // Which map is already open, for callbacks that must not rebuild when it changes (openMap).
  const mapIdRef = useRef<number | null>(null)
  useEffect(() => {
    if (view.kind === 'map') setMapId(view.id)
  }, [view])
  /**
   * Mount the map as soon as a world has one, WITHOUT going to it.
   *
   * Returning to the map from an article has always been instant, and the reason is the line
   * above plus the `display:none` wrapper further down: once `mapId` is set the map view stays
   * mounted behind whatever else is on screen. The first visit was the only slow one, because
   * that is when Leaflet, the drawings, the WebGL layers and a 4096x4096 png all arrive at once —
   * about 600 ms of it, watched. Setting `mapId` here makes the first visit the same kind of
   * event as every later one: the work happens while the world is opening and pressing Maps is a
   * `display` flip.
   *
   * `setMapId`, deliberately NOT `openMap`. This must not navigate, write `lastMapId`, or put a
   * `map.changed` line in the log — nobody has opened anything yet. The target is chosen by the
   * same rule `openMaps` uses, so the map that mounts is the map that Maps would show.
   *
   * ONCE, and the guard on `mapId` is what makes it once: `maps` is a fresh array after every
   * refresh(), and without it this would re-read the setting on every edit.
   *
   * "WITHOUT going to it" describes THIS effect only — the one below decides whether to navigate,
   * for the one case that should: a genuinely blank session.
   */
  useEffect(() => {
    if (mapId !== null || !maps.length) return
    let off = false
    void (async () => {
      const last = Number(await api.getSetting('lastMapId'))
      const target = maps.find((m) => m.id === last) ?? maps[0]
      if (off) return
      // Its own event, and not optional. `map.changed` is what tells a reader which map an error
      // happened on, and openMap only writes that line when the id actually CHANGES — which, now
      // that the id is set here, is no longer true of the first visit. Without this the first map
      // of a session would never be named in the log at all. It is not `map.changed` because
      // nobody navigated: this is the map arriving, not the user going to it.
      logEvent('INFO', 'map.mounted', { map: target.name || target.id })
      setMapId(target.id)
    })()
    return () => {
      off = true
    }
  }, [maps, mapId])
  /**
   * Land on the map directly, but only the FIRST time this app has ever been opened — nothing
   * saved yet, nothing to come back to. Every launch after that keeps showing the start screen
   * (Recent Projects / Open Project), because by then there is very likely a real project to
   * return to, and defaulting into a throwaway blank map would bury it. Main still seeds a blank
   * map into every blank session either way (see the mount effect above), so Maps in the sidebar
   * is always one click away regardless of which case this is.
   *
   * Waits on `mapId` rather than re-deriving a target: the mount effect above already picked one
   * with the same "last used, else first" rule, so this reuses that instead of a second read of
   * `lastMapId` that would only ever miss on a freshly reset world anyway (the setting is wiped
   * along with everything else).
   *
   * Both `worldInfo()` and `recentWorlds()` are read FRESH here rather than through the `worldFile`
   * / `recent` state below — those are fetched by their own effect and start out as `null`/`[]`,
   * indistinguishable at this point from "genuinely none", which would auto-navigate on every
   * opened file and every returning user until that fetch happened to resolve first.
   *
   * ONCE per renderer: without the ref this would fire again on a later `mapId` change (switching
   * maps from the toolbar) and yank the user's `view` back to a workspace they had already left.
   */
  const navigatedBlank = useRef(false)
  useEffect(() => {
    if (navigatedBlank.current || view.kind !== 'empty' || mapId === null) return
    navigatedBlank.current = true
    void Promise.all([api.worldInfo(), api.recentWorlds()]).then(([w, r]) => {
      if (!w.file && r.length === 0) setView({ kind: 'map', id: mapId })
    })
  }, [mapId, view.kind])
  useEffect(() => {
    mapIdRef.current = mapId
  }, [mapId])
  const [hidden, setHidden] = useState<null | 'panels' | 'all'>(null)
  const [sidebarW, setSidebarW] = useState(260)

  useEffect(() => {
    getLanguage().then(setLang)
    getTheme().then(setTheme)
    api.getPrefs().then((p) => {
      if (p.sidebarWidth) setSidebarW(p.sidebarWidth)
      // The renderer keeps its own copy of the DEBUG switch so a suppressed line costs one boolean
      // test instead of a trip across the bridge. It was only ever set from the Preferences screen,
      // which means it started false every launch and stayed false unless you happened to open
      // that page: main said `log.debug enabled=true` and the renderer sent nothing. Here, with the
      // other preferences, is where it belongs.
      setDebugLog(p.debugLog === true)
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

  // The map and article lists for callbacks that must not rebuild when they change — both are only
  // read to put a NAME in a log line, and taking either as a dependency would rebuild the callback
  // (and every effect holding it) on each sidebar refresh.
  const mapsRef = useRef<MapRow[]>([])
  const entitiesRef = useRef<EntityRow[]>([])
  useEffect(() => {
    mapsRef.current = maps
    entitiesRef.current = entities
  }, [maps, entities])

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

  /**
   * Open an article — after fetching it, not before.
   *
   * EntityPage is keyed by id, so a switch remounts it with no data and the page went blank for
   * the length of one IPC round trip: a black flash on every click in the sidebar. Reading the row
   * FIRST costs the same few milliseconds, but they are spent with the previous article still on
   * screen, and the new one arrives complete. The stash is checked against the id at render, so a
   * remount from anything else (an undo bumps the key) cannot be handed the wrong article.
   *
   * State rather than a ref, because it is READ during render — and a ref read there is both a
   * lint error in this codebase and the bug the rule exists for. Set in the same tick as the
   * navigation, so React batches the two into one render.
   */
  const [preloaded, setPreloaded] = useState<{
    id: number
    entity: Entity | null
    feats: Awaited<ReturnType<typeof api.featuresByEntity>>
  } | null>(null)
  const openEntity = useCallback(
    (id: number): void => {
      // Both reads, not just the article: the map-history block is the one section that appears
      // only when it has rows, so fetching it a tick later pushed the page down after it was
      // already on screen. One round trip for the pair.
      void Promise.all([api.getEntity(id), api.featuresByEntity(id)]).then(([entity, feats]) => {
        setPreloaded({ id, entity, feats })
        navigate({ kind: 'entity', id })
      })
    },
    [navigate]
  )
  // Every map open writes 'lastMapId' (all switches — toolbar menu included — pass through
  // here) → returning to the app/maps reopens the last viewed map. Lives in the settings
  // table, so it travels inside the .world.
  // Every switch between maps goes through here, which is why the log line does too.
  const openMap = useCallback(
    (id: number): void => {
      // Only when the map ACTUALLY changes. Locating eleven articles that all live on one map used
      // to write eleven `map.changed` lines, and anyone reading that file — a person or a model —
      // would conclude the user had switched maps eleven times. A log that is merely incomplete
      // costs you a question; one that is wrong costs you the investigation.
      // It also stopped the document being marked unsaved by looking at it: `setSetting` matches
      // main's dirty-flag regex, so re-writing the same value flagged the world and woke auto-save.
      if (mapIdRef.current !== id) {
        api.setSetting('lastMapId', String(id))
        // The NAME, falling back to the id. `map=1` is the answer to a question nobody asks; this
        // line's whole job is to say which map an error happened on. Read through a ref because
        // taking `maps` as a dependency would rebuild openMap — and every effect holding it — each
        // time the sidebar refreshes.
        logEvent('INFO', 'map.changed', {
          map: mapsRef.current.find((m) => m.id === id)?.name ?? id
        })
      }
      // Always: you may be on an article, and going back to the map is the point of the click.
      navigate({ kind: 'map', id })
    },
    [navigate]
  )

  // What has to happen after the world moves under the UI: the sidebar re-reads and the open page
  // reloads without remounting. Written once because there are now THREE callers — the Edit menu,
  // Ctrl+Z, and the History panel's jump — and the first two already had it copied.
  const afterUndo = useCallback((): void => {
    refresh()
    setBump((b) => b + 1)
  }, [refresh])

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
  /**
   * The bulk bar and the Del key: delete everything ticked, entries and folders together.
   *
   * ONE dialog for both, which is why the message is built here and handed to
   * deleteEntitiesWithUndo rather than left to its own. Two confirms for one keypress is worse
   * than either of the things it is asking about.
   *
   * The message says the undo is partial because it is, and that is a consequence of folders
   * being organisation rather than content: entry deletion is undoable and folder deletion is
   * not, so Ctrl+Z brings the entries back and leaves them at the root. Better said in the
   * dialog than discovered afterwards.
   *
   * Folders go only after the entries have actually been deleted — a cancelled or failed entry
   * delete must not take the folders with it.
   */
  const deleteSelected = useCallback(async (): Promise<void> => {
    const sel = selectedRef.current
    const fsel = selectedFoldersRef.current
    if (!sel.size && !fsel.size) return
    const tr = (s: string, p?: Record<string, string | number>): string =>
      translate(langRef.current, s, p)
    const msg = fsel.size
      ? tr('Delete {n} entries and {f} folders? Deleting a folder cannot be undone.', {
          n: sel.size,
          f: fsel.size
        })
      : undefined
    if (sel.size && !(await deleteEntitiesWithUndo([...sel], msg))) return
    // Only folders ticked: nothing above asked, so this asks.
    if (!sel.size && !(await confirmDialog(msg!))) return
    if (fsel.size) {
      const next = foldersRef.current.filter((f) => !fsel.has(f.id))
      setFolders(next)
      saveEntityFolders(next)
    }
    const v = viewRef.current
    if (v.kind === 'entity' && sel.has(v.id)) setView({ kind: 'empty' })
    setSelected(new Set())
    setSelectedFolders(new Set())
    refresh()
  }, [refresh])

  // Jump to the entity's first drawing on a map
  const locateEntity = useCallback(
    async (entityId: number): Promise<void> => {
      const all = await api.featuresByEntity(entityId)
      // An entry drawn on two maps used to send you to whichever drawing came back first, so
      // locating from the hierarchy panel could throw you off the map you were reading. The one
      // in front of you wins; anywhere else, the old behaviour (its first drawing) stands.
      const here = all.filter((f) => f.map_id === mapIdRef.current)
      const feats = here.length ? here : all
      // The action itself, which had no line of its own — so eleven of these read as eleven map
      // switches, and with map.changed now silent on an unchanged map they would have read as
      // nothing at all. This is the one that says what the user actually did, and the one the
      // `feature.locate found=false` warning in MapView needs beside it to mean anything.
      // With the NAME, like every other line that has one: `entity=21 feature=19` says nothing in
      // a file someone sent us, and which article was being looked for is the whole question. The
      // map name comes free with the query and answers the other half — "it took me somewhere
      // wrong" starts by asking whether it went to the map you expected.
      logEvent('INFO', 'entity.located', {
        entity: entityId,
        name: entitiesRef.current.find((e) => e.id === entityId)?.name,
        feature: feats[0]?.id,
        map: feats[0]?.map_name,
        // The entry's whole count, not the filtered one: "it went to the wrong map" is answered by
        // knowing how many drawings there were to choose between.
        drawings: all.length
      })
      if (!feats.length) {
        alertDialog(translate(lang, 'This entry is not marked on any map yet.'))
        return
      }
      setFocus({ featureId: feats[0].id, token: Date.now() })
      openMap(feats[0].map_id)
    },
    [openMap, lang]
  )

  // Save the world as a .world / open one from disk. Opening overwrites
  // the working copy → confirm first when dirty; then a full page reload (all refs/undo/state
  // start clean).
  // Toast (save confirmation) — not modal, disappears on its own. There was no visual proof
  // that Ctrl+S actually wrote; auto-save reports through the same channel.
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // There is one toast slot, so two messages in the same few seconds means one of them is lost.
  // Which one matters: auto-save fires on a three-minute timer and does not know what is on
  // screen, so "Auto-saved" could quietly replace the error that had just told you something
  // went wrong — and the error is the one carrying the click that opens the log. An error is
  // therefore not overwritten by an ordinary message; anything may replace an ordinary one, and
  // an error may replace an error.
  const toastErr = useRef(false)
  const showToast = useCallback((msg: string, ms = 2200, err = false): void => {
    if (toastErr.current && !err) return
    toastErr.current = err
    setToast({ msg, err })
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => {
      toastErr.current = false
      setToast(null)
    }, ms)
  }, [])

  // What to do after an undo or a redo. A step that THREW is a fault and this app's rule is that a
  // fault says so; an empty stack is not a fault and must stay silent. Both used to arrive as the
  // same `false`, so a failed undo did nothing visible at all — Ctrl+Z simply had no effect, with
  // a WARN in a log nobody had a reason to open. See StepResult in undo.ts.
  const afterStep = useCallback(
    (r: StepResult): void => {
      if (r === 'ok') afterUndo()
      else if (r === 'failed')
        showToast(translate(lang, 'That could not be undone — see the error log.'), 5000, true)
    },
    [afterUndo, showToast, lang]
  )

  // A fault must SAY so. Without this the app answers a failure with nothing at all — and the
  // cost of that is not hypothetical: a WebGL texture upload was failing on every polygon fill
  // image, the log named the exact cause in one line, and three rounds of guessing went by
  // because nothing on screen ever suggested there was a log to read.
  //
  // BOTH kinds are caught here. Only rejections used to be, so anything that threw synchronously
  // — an event handler, a render loop, which is most of the map — was recorded silently. That
  // WebGL error was exactly that kind. main.tsx keeps its own listeners for the RECORD (they work
  // even before React mounts); these are for the PERSON.
  useEffect(() => {
    let lastMsg = ''
    let lastAt = 0
    const say = (raw: string): void => {
      // Strip Electron's IPC wrapper — the user does not need to read 'invoking remote method'.
      const msg = raw.replace(/^(Uncaught )?Error invoking remote method '\w+': /, '')
      // Same guard as main.tsx's, for the same reason: a fault inside the map's animation loop
      // fires every frame, and re-rendering the toast 144 times a second helps nobody read it.
      const now = Date.now()
      if (msg === lastMsg && now - lastAt < 5000) return
      lastMsg = msg
      lastAt = now
      showToast(
        translate(lang, 'Something went wrong: {msg}', { msg: msg.slice(0, 120) }) +
          ' ' +
          translate(lang, 'Click to open the error log.'),
        8000,
        true
      )
    }
    const onReject = (e: PromiseRejectionEvent): void =>
      say((e.reason as { message?: string })?.message ?? String(e.reason))
    const onError = (e: ErrorEvent): void => say(e.message)
    window.addEventListener('unhandledrejection', onReject)
    window.addEventListener('error', onError)
    return () => {
      window.removeEventListener('unhandledrejection', onReject)
      window.removeEventListener('error', onError)
    }
  }, [showToast, lang])

  const saveWorld = useCallback(
    async (as = false): Promise<string | null> => {
      const p = as ? await api.saveWorldAs() : await api.saveWorld()
      if (p) showToast(translate(lang, 'Saved: {name}', { name: p.split(/[\\/]/).pop() ?? '' }))
      return p
    },
    [showToast, lang]
  )

  // Auto-save: when a .world is open and there are changes, pack
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

  // Start screen: recent .world files. The list lives in userData — the
  // working copy is reset on every launch, so it cannot live in settings.
  // worldFile: with a world open the start screen is hidden — a cover screen is for when
  // there is no document — and the empty view falls back to a plain hint.
  const [recent, setRecent] = useState<{ path: string; name: string; missing: boolean }[]>([])
  const [worldFile, setWorldFile] = useState<string | null>(null)
  // The most recent session closed without saving — its own start-screen section, separate from
  // recentWorlds() on purpose (see api.ts): a system snapshot, not a file the user named.
  const [prevSession, setPrevSession] = useState<{ path: string; name: string } | null>(null)
  useEffect(() => {
    api.recentWorlds().then(setRecent)
    api.worldInfo().then((w) => setWorldFile(w.file))
    api.previousSession().then(setPrevSession)
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
  const openPreviousSession = useCallback(async (): Promise<void> => {
    if (!(await discardOk())) return
    if (await api.openPreviousSession()) return // main reloads
    setPrevSession(await api.previousSession()) // it vanished between listing and clicking
  }, [discardOk])
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
  // A plain (scale: number) => void: no Leaflet type crosses the boundary, so the containment
  // rule holds. `scale` is 1 for the screen-resolution export and 2 for the hi-res one.
  const exportMapRef = useRef<((scale: number) => void) | null>(null)
  const handleExportReady = useCallback((fn: ((scale: number) => void) | null): void => {
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
        case 'file.exportMap2x':
          // Enabled even off a map view — greying it out would mean rebuilding the
          // native menu on every view change. Swap to a menu rebuild if that ever grates.
          return exportMapRef.current && viewRef.current.kind === 'map'
            ? exportMapRef.current(cmd === 'file.exportMap2x' ? 2 : 1)
            : showToast(translate(lang, 'Open a map first.'))
        case 'file.exportNotes':
          return void api.exportNotes().then(({ files, skipped }) => {
            logEvent('INFO', 'notes.export', { files, skipped })
            // An entry whose path the filesystem refused is skipped rather than allowed to abort
            // the export (see exportNotes). Said out loud: a silent shortfall in a folder of
            // hundreds of files is one nobody would ever notice.
            showToast(
              skipped
                ? translate(lang, 'Exported {n} note file(s); {s} entry(s) could not be written.', {
                    n: files,
                    s: skipped
                  })
                : translate(lang, 'Exported {n} note file(s); opening the folder…', { n: files })
            )
          })
        case 'file.backup':
          return void api.backupNow().then((path) => {
            logEvent('INFO', 'project.backup', { file: path.split(/[\\/]/).pop() })
            showToast(translate(lang, 'Backed up to {path}', { path }))
          })
        case 'edit.undo':
        case 'edit.redo':
          return void (cmd === 'edit.redo' ? redo() : undo()).then(afterStep)
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
    afterStep,
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

  // Global shortcuts: Ctrl+K palette, M map, Ctrl+Z undo, Del, Alt+←/→ history.
  // Ctrl+N/O/S/Shift+S and F1 are NOT here — the menu owns those accelerators, and handling them
  // in both places would fire every command twice. Undo/redo stay here on purpose: the menu
  // advertises Ctrl+Z without registering it, so this typing guard keeps textarea undo working.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement
      const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable
      // `e.key` is a string on every keydown the spec describes, and one arrived without it —
      // twice, while typing into a field, taking down the whole handler with a TypeError. Reading
      // it safely costs nothing; the WARN is there because the next occurrence should tell us what
      // the event WAS instead of leaving us to guess again.
      const key = e.key ?? ''
      if (!e.key)
        logEvent('WARN', 'key.unknown', {
          type: e.type,
          code: e.code || '(none)',
          trusted: e.isTrusted,
          target: t.tagName
        })
      if (e.ctrlKey && key.toLowerCase() === 'k') {
        e.preventDefault()
        setPalette((p) => !p)
      } else if (e.key === 'Tab' && !typing && t.tagName !== 'SELECT' && t.tagName !== 'BUTTON') {
        // Tab / Shift+Tab hide the panels. SELECT and BUTTON are excluded alongside the typing guard
        // so Tab keeps doing its real job — moving focus — whenever a control actually has it.
        e.preventDefault()
        togglePanels(e.shiftKey)
      } else if (e.key === 'Escape') {
        setPalette(false)
      } else if (
        key.toLowerCase() === 'm' &&
        !typing &&
        t.tagName !== 'SELECT' &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.metaKey
      ) {
        // Jump to the map. A bare letter, so the modifier check is the whole guard: Ctrl+M and
        // friends belong to whoever else wants them. Same function as the sidebar's Maps row —
        // the map you were last on, else the first, else a new one. SELECT is excluded next to the
        // typing guard, as it is for Tab: a letter in a dropdown is its type-ahead, not a shortcut.
        e.preventDefault()
        openMaps()
      } else if (e.ctrlKey && (key.toLowerCase() === 'z' || key.toLowerCase() === 'y') && !typing) {
        e.preventDefault()
        const isRedo = key.toLowerCase() === 'y' || e.shiftKey
        ;(isRedo ? redo() : undo()).then(afterStep)
      } else if (
        (e.key === 'Delete' || e.key === 'Backspace') &&
        !typing &&
        (selectedRef.current.size > 0 || selectedFoldersRef.current.size > 0)
      ) {
        // Delete the selection with Del/Backspace (map feature deletion is separate, in MapView)
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
  }, [afterStep, deleteSelected, togglePanels, openMaps])

  return (
    <LangContext.Provider value={lang}>
      <div className="app">
        {/* Shift+Tab leaves a thin rail as the way back; plain Tab is presentation mode and
            hides even that. The View menu is the guaranteed way out. */}
        {hidden === 'panels' && (
          <button
            className="sidebar-rail"
            title={t('Show panels (Tab)')}
            aria-label={t('Show panels (Tab)')}
            onClick={() => togglePanels(false)}
          >
            <Icon name="chevron-right" size={12} />
          </button>
        )}
        <Sidebar
          entities={entities}
          maps={maps}
          folders={folders}
          setFolders={setFolders}
          placements={placements}
          view={view}
          setView={setView}
          mapId={mapId}
          search={search}
          setSearch={setSearch}
          selected={selected}
          setSelected={setSelected}
          selectedFolders={selectedFolders}
          setSelectedFolders={setSelectedFolders}
          deleteSelected={deleteSelected}
          refresh={refresh}
          openEntity={openEntity}
          openMaps={openMaps}
          locateEntity={locateEntity}
          setMenu={setMenu}
          width={sidebarW}
          hidden={hidden !== null}
        />
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
          {/* Two different screens wearing one class until now. With NO document this is the
              app's cover, and the only screen that says the app's
              name. With a document open it is not a start screen at all, it is "nothing is
              selected", which is what EmptyState exists for and is where the user lands after
              deleting the entry they were reading. As one component the second case was a
              heading reading "World" and a single grey sentence. */}
          {view.kind === 'empty' &&
            (worldFile ? (
              <div className="empty-state">
                <EmptyState
                  icon="book-open"
                  title={t('Nothing open')}
                  hint={t('Pick an entry or a map from the left, or search with Ctrl+K.')}
                />
              </div>
            ) : (
              <div className="empty-state start-screen">
                {/* The app's own name, in the display face, once — this is the one screen that
                    is allowed to be a cover. Not a translation key: it is a proper noun. */}
                <h2 className="page-title">Worldbuilder</h2>
                {/* No "+ New world" here: a normal launch already IS a new, blank world (main
                    resets the working copy), so the button offered to do something that had
                    already happened. Starting genuinely from scratch is still one click away — Maps in the
                    sidebar, or File ▸ New Project — for the rare case a returning user wants a
                    fresh document instead of picking one up from here.
                    The one action of this screen, so it carries the one primary fill. */}
                <div className="start-actions">
                  <button className="primary" onClick={openWorld}>
                    <Icon name="folder" size={14} /> {t('Open…')}
                  </button>
                </div>
                {/* Its own heading, above Recent — see api.ts/previousSession: mixing a system
                    snapshot into the worlds the user actually saved read as clutter, whatever its
                    label said. Reuses .recent-list's markup so it still looks like it belongs. */}
                {prevSession && (
                  <>
                    <h4>{t('Previous session')}</h4>
                    <ul className="recent-list">
                      <li>
                        <button
                          className="recent-open"
                          title={prevSession.path}
                          onClick={openPreviousSession}
                        >
                          <span className="recent-name">{prevSession.name}</span>
                        </button>
                      </li>
                    </ul>
                  </>
                )}
                <h4>{t('Recent')}</h4>
                {recent.length === 0 ? (
                  <p>{t('No recent worlds yet. Save one with Ctrl+S.')}</p>
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
                          aria-label={t('Remove from list')}
                          onClick={() => forgetRecent(r.path)}
                        >
                          <Icon name="x" size={14} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          {view.kind === 'entity' && (
            <EntityPage
              key={`e-${view.id}-${bump}`}
              id={view.id}
              initial={preloaded?.id === view.id ? preloaded.entity : null}
              initialFeats={preloaded?.id === view.id ? preloaded.feats : undefined}
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
                onUndone={afterUndo}
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

        {/* An error toast is CLICKABLE and opens the log folder. Telling someone a log exists is
            not the same as getting them to it — the folder is four levels deep in Documents. */}
        {toast && (
          <div
            className={toast.err ? 'toast toast-error' : 'toast'}
            onClick={toast.err ? () => void api.openLogFolder() : undefined}
          >
            {toast.msg}
          </div>
        )}
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
