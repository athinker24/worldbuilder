import { useCallback, useEffect, useRef, useState } from 'react'
import {
  api,
  assetUrl,
  Entity,
  EntityRow,
  EntityTemplate,
  getHierConfig,
  getMapModes,
  getTemplates,
  Hierarchy,
  FolderDef
} from './api'
import ContextMenu, { MenuState } from './ContextMenu'
import { confirmDialog } from './dialog'
import { deleteEntityWithUndo } from './entityOps'
import EntityRail from './EntityRail'
import FamilyTree from './FamilyTree'
import Icon from './icons'
import { useT } from './i18n'
import { renderMarkdown } from './markdown'
import { IconButton } from './ui'
import { pushUndo } from './undo'

interface Props {
  id: number
  /**
   * The article, when the caller already has it.
   *
   * App keys this component by id, so switching articles REMOUNTS it and the state below starts
   * empty — which put a blank page on screen for the length of one IPC round trip, every time.
   * Handing the row in means the first render is already the real page. The map inspector passes
   * nothing and does not need to: it has no key, so its previous article stays up until the next
   * one arrives, which is the same effect by another route.
   */
  initial?: Entity | null
  /**
   * The map-history rows, when the caller already has them. Same reason as `initial`: the block is
   * conditional on having rows, so arriving a tick later made it POP IN and push the page down —
   * the same jump, just one section instead of the whole page.
   */
  initialFeats?: { id: number; map_id: number; style: string; map_name: string }[]
  folders: FolderDef[]
  compact?: boolean // narrow view inside the map side panel
  onOpen: (id: number) => void
  onChanged: () => void
  onDeleted: () => void
  onLocateFeature?: (mapId: number, featureId: number) => void // jump to a feature from map history
}

// Tabbed notes region: lives in the fields['notes'] JSON (no schema change; the fields['parent'] pattern)
interface NoteTab {
  title: string
  content: string
  collapsed: boolean
  height?: number // the textarea's hand-set height (px) — remembering CSS resize: vertical
}

function getNoteTabs(fieldsJson: string): NoteTab[] {
  try {
    const f = JSON.parse(fieldsJson || '{}') as Record<string, string>
    const n = JSON.parse(f['notes'] ?? '[]') as NoteTab[]
    return Array.isArray(n) ? n : []
  } catch {
    return []
  }
}

export default function EntityPage({
  id,
  initial,
  initialFeats,
  folders,
  compact,
  onOpen,
  onChanged,
  onDeleted,
  onLocateFeature
}: Props): React.JSX.Element {
  const t = useT()
  const [entity, setEntity] = useState<Entity | null>(initial ?? null)
  const [editing, setEditing] = useState(false)
  const [allEntities, setAllEntities] = useState<EntityRow[]>([])
  // all links, to derive spouses (co-parents of a shared child count as spouses)
  const [allLinks, setAllLinks] = useState<{ from_id: number; to_id: number; relation: string }[]>(
    []
  )
  // The datalists and derivations the rail runs on. Fetched here, with everything else this page
  // asks for in one effect, and handed down — the rail owns the forms, not the data behind them.
  const [allTags, setAllTags] = useState<string[]>([])
  const [allGovs, setAllGovs] = useState<string[]>([])
  const [dims, setDims] = useState<string[]>([])
  const [dimValues, setDimValues] = useState<Record<string, string[]>>({})
  // all entities with fields, to derive "Rules" (states/regions naming this person as ruler)
  const [hierEntities, setHierEntities] = useState<Hierarchy['entities']>([])
  // The family tree is `position: fixed`, so it stays in this component's overlays where it has
  // always been. The rail only opens it — see EntityRail's onOpenTree.
  const [treeOpen, setTreeOpen] = useState(false)
  // Reading mode: one note centered + enlarged over the page (long notes are hard to read in
  // the narrow column). Index of the note, or null.
  const [focusNote, setFocusNote] = useState<number | null>(null)
  // Notes region: context menu + indices of tabs in edit mode (local, not persisted)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [noteEdit, setNoteEdit] = useState<Set<number>>(new Set())
  // The note textarea's height before a resize (CSS resize: vertical) — so saving happens only
  // on a real drag (mousedown≠mouseup); a bare 'did height change' check also fired on the
  // first click (when n.height did not exist yet).
  const noteResizeStart = useRef<number | null>(null)
  // Map history: the entity's features with their year ranges
  const [feats, setFeats] = useState<
    { id: number; map_id: number; style: string; map_name: string }[]
  >(initialFeats ?? [])

  // [[ completion suggestion (used by onNoteInput/applyWiki below)
  // The textarea sits in a REF, not state: held in state, the `el.value = …` write counts as
  // "state mutation after render" (react-hooks/immutability). State carries only position + query.
  const sugEl = useRef<HTMLTextAreaElement | null>(null)
  const [wikiSug, setWikiSug] = useState<{ start: number; q: string; x: number; y: number } | null>(
    null
  )
  const [sugIdx, setSugIdx] = useState(0)

  // Entity templates (settings 'templates') — fetched here with the rest, applied in the rail
  const [tpls, setTpls] = useState<EntityTemplate[]>([])

  const reload = useCallback(async () => {
    setEntity(await api.getEntity(id))
  }, [id])

  // Esc closes the enlarged note
  useEffect(() => {
    if (focusNote === null) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setFocusNote(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focusNote])

  // Refresh the tag/government/dimension datalists (on first load and every fields save)
  const refreshHier = useCallback(async () => {
    const [h, modes, cfg] = await Promise.all([api.hierarchy(), getMapModes(), getHierConfig()])
    setAllTags(h.tags)
    // Forms added in Settings but not yet used on any entity should be suggested too
    setAllGovs([...new Set([...h.govs, ...cfg.govs.map((g) => g.name)])])
    setHierEntities(h.entities)
    setDims(modes.dims)
    const dv: Record<string, string[]> = {}
    for (const d of modes.dims) {
      const vals = h.entities
        .map((e) => (JSON.parse(e.fields || '{}') as Record<string, string>)[d])
        .filter(Boolean)
      dv[d] = [...new Set(vals)].sort((a, b) => a.localeCompare(b, 'tr'))
    }
    setDimValues(dv)
  }, [])

  useEffect(() => {
    reload()
    api.listEntities().then(setAllEntities)
    api.listLinks().then(setAllLinks)
    api.featuresByEntity(id).then(setFeats)
    getTemplates().then(setTpls)
    refreshHier()
  }, [id, reload, refreshHier])

  // Keyed by id in App, so switching articles REMOUNTS this and `entity` starts null again. The
  // text is delayed in CSS rather than removed: on a fast load nothing appears at all, and a slow
  // one still explains itself. See .page-loading, and the scrollbar gutter that stops the page
  // shifting sideways while this one line is all there is.
  if (!entity) return <div className="page page-loading">{t('Loading…')}</div>

  const fields = JSON.parse(entity.fields || '{}') as Record<string, string>

  const save = async (patch: Parameters<typeof api.updateEntity>[1]): Promise<void> => {
    const old = Object.fromEntries(Object.keys(patch).map((k) => [k, entity[k as keyof Entity]]))
    pushUndo({
      label: 'Edit "{name}"',
      params: { name: entity.name },
      undo: () => api.updateEntity(id, old),
      redo: () => api.updateEntity(id, patch)
    })
    await api.updateEntity(id, patch)
    await reload()
    if ('fields' in patch) await refreshHier()
    onChanged()
  }

  const saveFields = (f: Record<string, string>): Promise<void> =>
    save({ fields: JSON.stringify(f) })

  // Note tabs: they go through saveFields, so undo comes for free
  const notes = getNoteTabs(entity.fields)
  const saveNoteTabs = (next: NoteTab[]): Promise<void> => {
    const f = { ...fields }
    if (next.length) f['notes'] = JSON.stringify(next)
    else delete f['notes']
    return saveFields(f)
  }

  // A new tab opens in edit mode — you added it to write in it.
  const addNoteTab = (): void => {
    setNoteEdit((prev) => new Set(prev).add(notes.length))
    saveNoteTabs([...notes, { title: t('New note'), content: '', collapsed: false }])
  }

  const toggleNoteEdit = (i: number): void =>
    setNoteEdit((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })

  // Banner: fields['banner'] = assets/-relative path; the old file stays in assets (like the base image)
  const pickBanner = async (): Promise<void> => {
    const path = await api.pickImage()
    if (path) await saveFields({ ...fields, banner: path })
  }

  // --- [[ entity-name completion ---
  // The textareas are deliberately UNCONTROLLED (defaultValue + save on blur; making them
  // controlled would rewrite the whole note-editing path and height saving) → the insertion is
  // written straight into the DOM. The suggestion box anchors BELOW the textarea: converting
  // the caret to pixels would need a mirror div, and below-the-box is good enough.
  const sugList = wikiSug
    ? allEntities.filter((e) => e.name.toLowerCase().includes(wikiSug.q.toLowerCase())).slice(0, 8)
    : []
  // Nearest "[[" behind the caret — with a "]]" in between the link is already closed, no suggestion
  const onNoteInput = (e: React.FormEvent<HTMLTextAreaElement>): void => {
    const el = e.currentTarget
    const before = el.value.slice(0, el.selectionStart)
    const open = before.lastIndexOf('[[')
    const q = open < 0 ? '' : before.slice(open + 2)
    if (open < 0 || before.includes(']]', open) || q.includes('\n')) {
      setWikiSug(null)
      return
    }
    const r = el.getBoundingClientRect()
    sugEl.current = el
    setSugIdx(0)
    setWikiSug({ start: open, q, x: r.left, y: Math.min(r.bottom, window.innerHeight - 220) })
  }
  const applyWiki = (name: string): void => {
    const s = wikiSug
    const el = sugEl.current
    if (!s || !el) return
    el.value = `${el.value.slice(0, s.start)}[[${name}]]${el.value.slice(el.selectionStart)}`
    const caret = s.start + name.length + 4
    el.setSelectionRange(caret, caret)
    el.focus()
    setWikiSug(null)
  }
  const onNoteKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (!wikiSug) return
    if (e.key === 'Escape') setWikiSug(null)
    else if (!sugList.length) return
    else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSugIdx((i) => (i + 1) % sugList.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSugIdx((i) => (i - 1 + sugList.length) % sugList.length)
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      applyWiki(sugList[Math.min(sugIdx, sugList.length - 1)].name)
    }
  }

  const handleWikiClick = async (e: React.MouseEvent): Promise<void> => {
    const target = (e.target as HTMLElement).closest('a[data-wiki]')
    if (!target) return
    e.preventDefault()
    const name = target.getAttribute('data-wiki')!
    const found = await api.findEntityByName(name)
    if (found) {
      onOpen(found.id)
      // The one confirmation in the app that CREATES rather than destroys — see confirmDialog.
    } else if (await confirmDialog(t('No entry named "{name}". Create it?', { name }), false)) {
      const { id: newId } = await api.createEntity({ name })
      onChanged()
      onOpen(newId)
    }
  }

  // Banner: 140px and it CARRIES the title (see .entity-banner + .entity-head).
  // At 200px it pushed the name and every structural field below the fold.
  const banner = fields['banner'] ? (
    <div className="entity-banner">
      <img src={assetUrl(fields['banner'])} alt="" />
      <span className="banner-actions">
        <IconButton icon="image" label={t('Replace banner')} onClick={pickBanner} />
        <IconButton
          icon="x"
          label={t('Remove banner')}
          danger
          onClick={() => {
            const f = { ...fields }
            delete f['banner']
            saveFields(f)
          }}
        />
      </span>
    </div>
  ) : (
    <button className="banner-add" onClick={pickBanner}>
      <Icon name="image" size={14} />
      {t('Add banner')}
    </button>
  )

  // ---------------------------------------------------------------------------
  // THE IDENTITY RAIL — everything that answers "what IS this?".
  //
  // It used to sit at the very bottom of the page behind a three-tab strip,
  // below an arbitrarily long prose body: you had to scroll past the article to
  // learn the entity was a duchy, who ruled it, or what it belonged to. It is
  // now always visible beside the document.
  //
  // It is also the ONLY thing the map inspector renders. The full page and the
  // inspector are two presentations of one object, so they share these sections
  // verbatim rather than being styled to resemble each other.
  // ---------------------------------------------------------------------------

  // The document column: the entity's own prose, its note tabs, and its links.
  // Deliberately NOT in the inspector — a markdown editor and a stack of note
  // tabs are unusable at 380px, and "Open full page" is one click away.
  const doc = (
    <div className="entity-doc">
      {editing ? (
        <textarea
          className="content-edit"
          defaultValue={entity.content}
          key={`content-${entity.id}`}
          onBlur={(e) => {
            setWikiSug(null) // the suggestion box must not stay open after focus leaves
            if (e.target.value !== entity.content) save({ content: e.target.value })
          }}
          onInput={onNoteInput}
          onKeyDown={onNoteKeyDown}
          placeholder={t('Markdown content… link to other entries with [[Entry Name]].')}
        />
      ) : (
        <div
          className="content-view"
          onClick={handleWikiClick}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(entity.content) }}
        />
      )}

      {/* Notes region: right-click → new tab; each tab collapses + resizes vertically */}
      <div
        className="notes-region"
        onContextMenu={(e) => {
          // Not while the pointer is in an editor or a rendered note: a textarea's own
          // menu (copy, paste, spelling) is worth more there than a shortcut that now
          // has a visible button.
          if ((e.target as HTMLElement).closest('.note-body, .note-body-edit')) return
          e.preventDefault()
          e.stopPropagation()
          setMenu({
            x: e.clientX,
            y: e.clientY,
            items: [{ icon: 'file-text', label: t('New tab'), onClick: addNoteTab }]
          })
        }}
      >
        {/* Right-click was the ONLY way to add a note, on a target that shrinks to a
            sliver once a long note is open — so the action was effectively hidden.
            The header states it; right-click stays as the shortcut. */}
        <div className="notes-head">
          <h4>{t('Notes')}</h4>
          <IconButton icon="plus" label={t('New note tab')} small onClick={addNoteTab} />
        </div>
        {notes.map((n, i) => (
          <div className="note-tab" key={i}>
            <div className="note-head">
              <IconButton
                icon={n.collapsed ? 'chevron-right' : 'chevron-down'}
                label={n.collapsed ? t('Expand') : t('Collapse')}
                small
                onClick={() =>
                  saveNoteTabs(
                    notes.map((x, j) => (j === i ? { ...x, collapsed: !x.collapsed } : x))
                  )
                }
              />
              <input
                className="note-title"
                defaultValue={n.title}
                key={`nt-${i}-${entity.updated_at}`}
                onBlur={(e) => {
                  const v = e.target.value.trim()
                  if (v && v !== n.title)
                    saveNoteTabs(notes.map((x, j) => (j === i ? { ...x, title: v } : x)))
                }}
              />
              <IconButton
                icon="maximize"
                label={t('Enlarge: center it on screen')}
                small
                onClick={() => setFocusNote(i)}
              />
              <IconButton
                icon={noteEdit.has(i) ? 'book-open' : 'pencil'}
                label={noteEdit.has(i) ? t('View') : t('Edit')}
                small
                active={noteEdit.has(i)}
                onClick={() => toggleNoteEdit(i)}
              />
              <IconButton
                icon="trash"
                label={t('Delete')}
                small
                danger
                onClick={async () => {
                  if (await confirmDialog(t('Delete note "{name}"?', { name: n.title })))
                    saveNoteTabs(notes.filter((_, j) => j !== i))
                }}
              />
            </div>
            {!n.collapsed &&
              (noteEdit.has(i) ? (
                <textarea
                  className="note-body-edit"
                  defaultValue={n.content}
                  key={`nb-${i}-${entity.updated_at}`}
                  style={n.height ? { height: n.height } : undefined}
                  onBlur={(e) => {
                    setWikiSug(null) // the suggestion box must not stay open after focus leaves
                    if (e.target.value !== n.content)
                      saveNoteTabs(
                        notes.map((x, j) => (j === i ? { ...x, content: e.target.value } : x))
                      )
                  }}
                  onMouseDown={(e) => {
                    noteResizeStart.current = e.currentTarget.offsetHeight
                  }}
                  onMouseUp={(e) => {
                    // A native resize drag changes the height between mousedown and mouseup;
                    // a plain click (caret placement) never does, so it never saves.
                    const h = e.currentTarget.offsetHeight
                    if (h !== noteResizeStart.current)
                      // Saving the height triggers save→reload→remount; the textarea being
                      // uncontrolled, grab the current text too or unblurred typing would be lost.
                      saveNoteTabs(
                        notes.map((x, j) =>
                          j === i ? { ...x, height: h, content: e.currentTarget.value } : x
                        )
                      )
                    noteResizeStart.current = null
                  }}
                  onInput={onNoteInput}
                  onKeyDown={onNoteKeyDown}
                  placeholder={t('Markdown content… link to other entries with [[Entry Name]].')}
                />
              ) : (
                <div
                  className="note-body content-view"
                  onClick={handleWikiClick}
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(n.content) }}
                />
              ))}
          </div>
        ))}
      </div>
    </div>
  )

  // Shared by both presentations: the completion popup, the datalists every form
  // above reads from, and the three overlays.
  const overlays = (
    <>
      {/* [[ completion suggestions. onMouseDown preventDefault is REQUIRED: if the click
          blurred the textarea, onBlur would save the old text, remount, and undo the insert. */}
      {wikiSug && sugList.length > 0 && (
        <div className="wiki-sug" style={{ left: wikiSug.x, top: wikiSug.y }}>
          {sugList.map((en, i) => (
            <button
              key={en.id}
              type="button"
              className={i === Math.min(sugIdx, sugList.length - 1) ? 'active' : undefined}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => applyWiki(en.name)}
            >
              {en.name}
              {en.folder && (
                <span className="wiki-sug-type">
                  {folders.find((f) => f.id === en.folder)?.name ?? ''}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* The Parent/Ruler/Family/Links forms all read these, whichever is on screen */}
      {/* Both datalists moved to EntityRail with the forms that use them — every consumer of
          either is in that file, and an invisible id-referenced element has no place in a layout. */}
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
      {/* Enlarged note: centered over the page for comfortable reading of long notes.
          Click the backdrop or press Esc to close; editing works the same as inline. */}
      {focusNote !== null &&
        notes[focusNote] &&
        (() => {
          const fi = focusNote
          const n = notes[fi]
          return (
            <div className="note-focus-overlay" onClick={() => setFocusNote(null)}>
              <div className="note-focus" onClick={(e) => e.stopPropagation()}>
                <div className="note-focus-head">
                  <span className="note-focus-title">{n.title}</span>
                  <IconButton
                    icon={noteEdit.has(fi) ? 'book-open' : 'pencil'}
                    label={noteEdit.has(fi) ? t('View') : t('Edit')}
                    active={noteEdit.has(fi)}
                    onClick={() => toggleNoteEdit(fi)}
                  />
                  <IconButton icon="x" label={t('Close')} onClick={() => setFocusNote(null)} />
                </div>
                {noteEdit.has(fi) ? (
                  <textarea
                    className="note-focus-body-edit"
                    defaultValue={n.content}
                    key={`nf-${fi}-${entity.updated_at}`}
                    onBlur={(e) => {
                      setWikiSug(null)
                      if (e.target.value !== n.content)
                        saveNoteTabs(
                          notes.map((x, j) => (j === fi ? { ...x, content: e.target.value } : x))
                        )
                    }}
                    onInput={onNoteInput}
                    onKeyDown={onNoteKeyDown}
                    placeholder={t('Markdown content… link to other entries with [[Entry Name]].')}
                  />
                ) : (
                  <div
                    className="note-focus-body content-view"
                    onClick={handleWikiClick}
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(n.content) }}
                  />
                )}
              </div>
            </div>
          )
        })()}
      {treeOpen && (
        <FamilyTree rootId={id} onOpenEntity={onOpen} onClose={() => setTreeOpen(false)} />
      )}
    </>
  )

  // The inspector presentation: the rail alone. `compact` no longer means "the
  // same page squeezed into 380px" — it means the identity of this object,
  // without its document.
  if (compact)
    return (
      <>
        <div className="entity-compact-head">
          <input
            className="entity-title sm"
            defaultValue={entity.name}
            key={`name-${entity.id}-${entity.updated_at}`}
            onBlur={(e) =>
              e.target.value !== entity.name &&
              e.target.value.trim() &&
              save({ name: e.target.value.trim() })
            }
          />
          <IconButton
            icon="arrow-up-right"
            label={t('Open full page')}
            onClick={() => onOpen(id)}
          />
        </div>
        <EntityRail
          id={id}
          entity={entity}
          fields={fields}
          folders={folders}
          allEntities={allEntities}
          setAllEntities={setAllEntities}
          allLinks={allLinks}
          setAllLinks={setAllLinks}
          hierEntities={hierEntities}
          allTags={allTags}
          allGovs={allGovs}
          dims={dims}
          dimValues={dimValues}
          tpls={tpls}
          setTpls={setTpls}
          feats={feats}
          save={save}
          saveFields={saveFields}
          reload={reload}
          refreshHier={refreshHier}
          onChanged={onChanged}
          onOpen={onOpen}
          onLocateFeature={onLocateFeature}
          onOpenTree={() => setTreeOpen(true)}
        />
        {overlays}
      </>
    )

  return (
    <div className="entity-page">
      {banner}
      <div className="entity-head">
        <input
          className="entity-title"
          defaultValue={entity.name}
          key={`name-${entity.id}-${entity.updated_at}`}
          onBlur={(e) =>
            e.target.value !== entity.name &&
            e.target.value.trim() &&
            save({ name: e.target.value.trim() })
          }
        />
        <IconButton
          icon={editing ? 'book-open' : 'pencil'}
          label={editing ? t('View') : t('Edit')}
          active={editing}
          onClick={() => setEditing(!editing)}
        />
        <IconButton
          icon="trash"
          label={t('Delete')}
          danger
          onClick={async () => {
            if (await deleteEntityWithUndo(id)) {
              onChanged()
              onDeleted()
            }
          }}
        />
      </div>
      <div className="entity-body">
        {doc}
        <EntityRail
          id={id}
          entity={entity}
          fields={fields}
          folders={folders}
          allEntities={allEntities}
          setAllEntities={setAllEntities}
          allLinks={allLinks}
          setAllLinks={setAllLinks}
          hierEntities={hierEntities}
          allTags={allTags}
          allGovs={allGovs}
          dims={dims}
          dimValues={dimValues}
          tpls={tpls}
          setTpls={setTpls}
          feats={feats}
          save={save}
          saveFields={saveFields}
          reload={reload}
          refreshHier={refreshHier}
          onChanged={onChanged}
          onOpen={onOpen}
          onLocateFeature={onLocateFeature}
          onOpenTree={() => setTreeOpen(true)}
        />
      </div>
      {overlays}
    </div>
  )
}
