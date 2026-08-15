import { useEffect, useMemo, useRef, useState } from 'react'
import {
  api,
  BoardDef,
  EntityRow,
  FolderDef,
  folderColor,
  getFavorites,
  getMapBoards,
  MapRow,
  saveEntityFolders,
  saveFavorites
} from './api'
import ColorPicker from './ColorPicker'
import { MenuState } from './ContextMenu'
import { confirmDialog } from './dialog'
import { deleteEntityWithUndo } from './entityOps'
import Icon from './icons'
import { useT } from './i18n'
import Select from './Select'
import { pushUndo } from './undo'
import { IconButton } from './ui'
import type { View } from './views'

/**
 * The entity tree: search, the folder tree, the map/board grouping, and the workspace nav.
 *
 * Split out of App, which held it alongside twelve other jobs. The line was drawn at WHERE THE
 * DATA LIVES, not at the component tree: everything App fetches in one `refresh()` stays App's and
 * arrives here as a prop, and everything only this panel cares about — which folders are collapsed,
 * which groups are open, what is being dragged — lives here. That is why `folders` is a prop while
 * `collapsed` is state: `folders` also colours drawings on the map, entity pages and the palette,
 * and `collapsed` has never been anyone else's business.
 *
 * Three things stay App's that look like they belong here, and each for a reason:
 * `selected` (the Del key deletes the selection from anywhere in the app), `search` (it is an
 * argument to `api.listEntities`, so the fetch owns it) and `folders` (four other screens read it).
 */
export interface SidebarProps {
  entities: EntityRow[]
  maps: MapRow[]
  folders: FolderDef[]
  setFolders: (next: FolderDef[]) => void
  /** Which entry is drawn on which map/board — derived from features, never stored on the entry. */
  placements: { entity_id: number; map_id: number; board: string | null }[]
  view: View
  setView: (v: View) => void
  /** The open map, or null before one has been opened — then the tree is the plain folder tree. */
  mapId: number | null
  search: string
  setSearch: (s: string) => void
  /** Multi-select for the bulk bar. App owns it because the Del shortcut is App's. */
  selected: Set<number>
  setSelected: React.Dispatch<React.SetStateAction<Set<number>>>
  deleteSelected: () => void
  refresh: () => Promise<void>
  openEntity: (id: number) => void
  openMaps: () => void
  locateEntity: (id: number) => void
  setMenu: (m: MenuState | null) => void
  width: number
  hidden: boolean
}

export default function Sidebar({
  entities,
  maps,
  folders,
  setFolders,
  placements,
  view,
  setView,
  mapId,
  search,
  setSearch,
  selected,
  setSelected,
  deleteSelected,
  refresh,
  openEntity,
  openMaps,
  locateEntity,
  setMenu,
  width,
  hidden
}: SidebarProps): React.JSX.Element {
  const t = useT()
  // Collapse + rename + drag are view/session state (browsing never dirties the world).
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<'az' | 'za' | 'created' | 'modified'>('az')
  const [boards, setBoards] = useState<BoardDef[]>([])
  // Open/closed accordions, by group key. Session state on purpose: it follows which map you
  // are on, and persisting it would fight that.
  // The two tiers default opposite ways, and that asymmetry IS the difference between them:
  // a map group is somewhere you are NOT (closed unless listed here), while a board is a layer
  // of the map you ARE on, so it only labels its articles (open unless listed in closedBoards).
  // Favourites, in settings (so they travel with the world). The group is seeded OPEN here for
  // the same reason boards are: a map group is somewhere you are not, while the things you
  // starred are the ones you want in reach — closed by default would defeat the feature.
  const [favorites, setFavorites] = useState<Set<number>>(new Set())
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set(['fav']))
  const [closedBoards, setClosedBoards] = useState<Set<string>>(new Set())
  const dragItem = useRef<{ kind: 'entity' | 'folder'; id: number | string } | null>(null)

  useEffect(() => {
    getFavorites().then((ids) => setFavorites(new Set(ids)))
  }, [])

  // The open map's boards, for the second grouping tier. Empty list = the map has no boards,
  // and then the tier does not appear at all. Re-read on placements too: a board created in
  // MapView reaches the sidebar when something is drawn on it, which is also the first moment
  // it has anything to group.
  //
  // Keeping the SAME array when the list is unchanged is what makes this cheap, and it is the
  // reason the updater form is used rather than a plain setBoards(b.list). `placements` is a
  // fresh array out of refresh() every time, so this effect re-runs after every onChanged();
  // writing a new (equal) boards array there re-rendered the whole entity tree A SECOND TIME.
  // Measured in a DevTools trace before the fix: every long task came in a pair, the second
  // starting exactly when the first ended (204 ms task at 424.24 s → 125 ms task at 424.46 s),
  // ~440 ms of frozen UI after every draw/create/rename/undo. Returning `prev` unchanged makes
  // React bail out of that second render entirely. Boards lists are a handful of rows, so
  // stringify is cheaper than the render it prevents by orders of magnitude.
  useEffect(() => {
    if (mapId === null) return setBoards((prev) => (prev.length ? [] : prev))
    getMapBoards(mapId).then((b) =>
      setBoards((prev) => (JSON.stringify(prev) === JSON.stringify(b.list) ? prev : b.list))
    )
  }, [mapId, placements])

  // Landing on a map opens that map's group and closes the rest — the point of the grouping is
  // that the map you are on is the list, and the others are put away.
  useEffect(() => {
    setOpenGroups(new Set(mapId === null ? [] : [`map:${mapId}`]))
  }, [mapId])

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

  // Starring is not an edit to the world's content, so it takes no undo entry: nothing is
  // written to the article, and un-starring is the same one click that made it.
  const toggleFavorite = (id: number): void => {
    setFavorites((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      void saveFavorites([...next])
      return next
    })
  }

  // The starred articles, as a group — but only the ones that still EXIST. A deleted article
  // leaves its id behind in settings and this is where that stops mattering; nothing has to
  // reach into the favourites list when something is deleted.
  const favAllow = useMemo(
    () => new Set(entities.filter((e) => favorites.has(e.id)).map((e) => e.id)),
    [entities, favorites]
  )

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
      label: 'Move to a folder',
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
      !(await confirmDialog(t('Delete folder "{name}"? (entries are kept)', { name: folder.name })))
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
    const { id } = await api.createEntity({ name: t('New Entry') })
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
      header: { name: folder.name, color: folderColor(folders, folder.id) },
      items: [
        { icon: 'file-text', label: t('New Entry'), onClick: () => addEntity(folder.id) },
        { icon: 'folder', label: t('New folder'), onClick: () => addFolder(folder.id) },
        'sep',
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
        'sep',
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
          header: { name: e.name, color: folderColor(folders, e.folder ?? null) },
          items: [
            { icon: 'file-text', label: t('Open'), onClick: () => openEntity(e.id) },
            { icon: 'map-pin', label: t('Show on map'), onClick: () => locateEntity(e.id) },
            'sep',
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
      {/* The LABEL is the button, not the row. A row wrapping a checkbox, a star and a locate
          button cannot itself be a button — that is a button inside a button — and role=button
          on the div would only claim otherwise. This way the mouse keeps the whole row and the
          keyboard gets a real target, with the row's own controls following it in tab order. */}
      <button className="side-label" onClick={() => openEntity(e.id)}>
        {e.name}
      </button>
      {/* Outside `.locate`: that group hides when the pointer leaves, and a star that is ON has
          to keep saying so. `.on` is the whole difference — same button, two states. */}
      <span className={`fav-star ${favorites.has(e.id) ? 'on' : ''}`}>
        <IconButton
          icon="star"
          filled={favorites.has(e.id)}
          label={favorites.has(e.id) ? t('Remove from favorites') : t('Add to favorites')}
          small
          onClick={(ev) => {
            ev.stopPropagation()
            toggleFavorite(e.id)
          }}
        />
      </span>
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
          <span className={`tree-caret ${open ? 'open' : ''}`}>
            <Icon name="chevron-right" size={12} />
          </span>
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
            <button
              className="side-label"
              aria-expanded={open}
              onClick={() => toggleCollapse(folder.id)}
              onDoubleClick={() => setRenamingFolder(folder.id)}
            >
              {folder.name}
            </button>
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
          <span className={`tree-caret ${open ? 'open' : ''}`}>
            <Icon name="chevron-right" size={12} />
          </span>
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
    kind: 'map' | 'unplaced' | 'fav'
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
          <span className={`tree-caret ${open ? 'open' : ''}`}>
            <Icon name="chevron-right" size={12} />
          </span>
          <Icon
            name={g.kind === 'map' ? 'map' : g.kind === 'fav' ? 'star' : 'file-text'}
            size={13}
            filled={g.kind === 'fav'}
          />
          <span className="side-label">
            {g.kind === 'map' ? g.name : g.kind === 'fav' ? t('Favorites') : t('Not on a map')}
          </span>
          <span className="side-group-count">{g.allow.size}</span>
        </button>
        {open && (
          <div className="side-group-body">
            {g.allow.size === 0 ? (
              <p className="hint">
                {g.kind === 'map'
                  ? t('Nothing drawn on this map yet.')
                  : t('Every entry is on a map.')}
              </p>
            ) : withBoards ? (
              boards.map((b) => renderBoardGroup(b, g.allow))
            ) : g.kind === 'fav' ? (
              // FLAT, unlike every other group: a handful of hand-picked articles put back
              // behind two levels of folder would be the same walk they were starred to avoid.
              entities
                .filter((e) => g.allow.has(e.id))
                .sort(entSort)
                .map((e) => renderEntityRow(e, 0))
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
    /* Hidden rather than unmounted: collapsing must not throw away the tree's collapsed
       folders, scroll position or current search. */
    <div
      className="sidebar"
      style={{ width, minWidth: width, display: hidden ? 'none' : undefined }}
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
        {/* The count is the one thing this heading can say that the list does not already
            show — it was a word on its own line doing nothing. */}
        <div className="side-head">
          <span>{t('Entries')}</span>
          <span className="side-group-count">{entities.length}</span>
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
          {search.trim() ? (
            entities
              .slice()
              .sort(entSort)
              .map((e) => renderEntityRow(e, 0)) // search = flat: grouping would hide hits
          ) : (
            <>
              {/* Above the maps, and only when something is starred — an empty box at the
                  top of the tree would cost every user the space to say nothing. */}
              {favAllow.size > 0 &&
                renderGroup({ key: 'fav', name: '', kind: 'fav', allow: favAllow })}
              {groups ? groups.map(renderGroup) : renderChildren(null, 0, null)}
            </>
          )}
        </div>
        {/* Create + sort at the bottom of the column.
            Icon-only, and that is a width decision rather than a style one: this is the
            tightest row in the app — two labelled buttons plus the sort control already
            overflowed a sidebar dragged down to its 180px minimum, and the Turkish labels
            are longer still. The name lives in the tooltip, as it does on the map toolbar. */}
        <div className="side-foot">
          <IconButton icon="plus" label={t('New Entry')} onClick={() => addEntity()} />
          <IconButton icon="folder" label={t('New folder')} onClick={() => addFolder()} />
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
  )
}
