import { useCallback, useEffect, useRef, useState } from 'react'
import { Marked, type Tokens } from 'marked'
import {
  api,
  assetUrl,
  Entity,
  EntityRow,
  EntityTemplate,
  getHierConfig,
  getMapModes,
  getParents,
  getTemplates,
  getYearRecs,
  Hierarchy,
  inferGenders,
  ParentRec,
  RESERVED_FIELDS,
  saveTemplates,
  saveTypes,
  TypeDef
} from './api'
import ContextMenu, { MenuState } from './ContextMenu'
import { confirmDialog } from './dialog'
import { deleteEntityWithUndo } from './entityOps'
import FamilyTree from './FamilyTree'
import { useT } from './i18n'
import { pushUndo } from './undo'

interface Props {
  id: number
  types: TypeDef[]
  compact?: boolean // narrow view inside the map side panel
  onOpen: (id: number) => void
  onChanged: () => void
  onDeleted: () => void
  onLocateFeature?: (mapId: number, featureId: number) => void // jump to a feature from map history
}

// URL schemes allowed in links. marked copies `[click](javascript:…)` into <a href> verbatim;
// clicking it would run code in the renderer context (window.api → the whole database). A
// shared .dunya can carry that, so an allow-list is mandatory.
// '#' is the wiki links' own href; 'world:' is a local image embedded in a note (![x](world://data/…)).
const SAFE_URL = /^(https?:|world:|mailto:|#)/i
const safeHref = (href: string): string => (SAFE_URL.test(href.trim()) ? href : '#')
// Sanitising at PARSER LEVEL: the URL is checked on the token BEFORE any HTML exists. (The
// previous version regexed href="…" in the generated HTML; correct today, but a marked release
// emitting single quotes or another order would have silently defeated it — cut at the source,
// not filter the output.) escapeAttr: the URL lands inside quotes, and we do not trust
// marked's own escaping.
const escapeAttr = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const safeMarked = new Marked({
  renderer: {
    link(this: { parser: { parseInline: (t: Tokens.Generic[]) => string } }, token: Tokens.Link) {
      const t = token.title ? ` title="${escapeAttr(token.title)}"` : ''
      const inner = this.parser.parseInline(token.tokens)
      return `<a href="${escapeAttr(safeHref(token.href))}"${t}>${inner}</a>`
    },
    image(token: Tokens.Image) {
      const t = token.title ? ` title="${escapeAttr(token.title)}"` : ''
      return `<img src="${escapeAttr(safeHref(token.href))}" alt="${escapeAttr(token.text)}"${t}>`
    }
  }
})
// [[Entity Name]] → clickable wiki link (converted before markdown)
// '<' is escaped first: raw HTML typed into a note (<img onerror=...> and such) can never
// run as script — content arriving in a shared world.db stays safe too.
function renderMarkdown(content: string): string {
  const withWiki = content
    .replace(/</g, '&lt;')
    .replace(
      /\[\[([^\]]+)\]\]/g,
      (_, name: string) => `<a href="#" data-wiki="${escapeAttr(name)}">${name}</a>`
    )
  return safeMarked.parse(withWiki, { async: false })
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
  types,
  compact,
  onOpen,
  onChanged,
  onDeleted,
  onLocateFeature
}: Props): React.JSX.Element {
  const t = useT()
  const [entity, setEntity] = useState<Entity | null>(null)
  const [editing, setEditing] = useState(false)
  const [allEntities, setAllEntities] = useState<EntityRow[]>([])
  // all links, to derive spouses (co-parents of a shared child count as spouses)
  const [allLinks, setAllLinks] = useState<{ from_id: number; to_id: number; relation: string }[]>(
    []
  )
  const [linkTarget, setLinkTarget] = useState('')
  const [linkRelation, setLinkRelation] = useState('')
  const [allTags, setAllTags] = useState<string[]>([])
  const [allGovs, setAllGovs] = useState<string[]>([])
  const [tagInput, setTagInput] = useState('')
  const [dims, setDims] = useState<string[]>([])
  const [dimValues, setDimValues] = useState<Record<string, string[]>>({})
  // all entities with fields, to derive "Rules" (states/regions naming this person as ruler)
  const [hierEntities, setHierEntities] = useState<Hierarchy['entities']>([])
  const [parentName, setParentName] = useState('')
  const [parentYear, setParentYear] = useState('')
  // Ruler history (dynasty system): year-based, bound to a person entity
  const [rulerName, setRulerName] = useState('')
  const [rulerYear, setRulerYear] = useState('')
  // Ruling-house history (year-based, same pattern as parent/ruler)
  const [houseName, setHouseName] = useState('')
  const [houseYear, setHouseYear] = useState('')
  const [treeOpen, setTreeOpen] = useState(false)
  // Bottom section tab: one section visible at a time to keep the page uncluttered
  const [section, setSection] = useState<'hier' | 'dynasty' | 'links'>('hier')
  // Notes region: context menu + indices of tabs in edit mode (local, not persisted)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [noteEdit, setNoteEdit] = useState<Set<number>>(new Set())
  // The note textarea's height before a resize (CSS resize: vertical) — so saving happens only
  // on a real drag (mousedown≠mouseup); a bare 'did height change' check also fired on the
  // first click (when n.height did not exist yet).
  const noteResizeStart = useRef<number | null>(null)
  // Map history (the OHM chronology pattern): the entity's features with their year ranges
  const [feats, setFeats] = useState<
    { id: number; map_id: number; style: string; map_name: string }[]
  >([])

  // [[ completion suggestion (used by onNoteInput/applyWiki below)
  // The textarea sits in a REF, not state: held in state, the `el.value = …` write counts as
  // "state mutation after render" (react-hooks/immutability). State carries only position + query.
  const sugEl = useRef<HTMLTextAreaElement | null>(null)
  const [wikiSug, setWikiSug] = useState<{ start: number; q: string; x: number; y: number } | null>(
    null
  )
  const [sugIdx, setSugIdx] = useState(0)

  // Entity templates (settings 'templates') — apply + save this page as a template
  const [tpls, setTpls] = useState<EntityTemplate[]>([])
  const [tplDraft, setTplDraft] = useState<string | null>(null) // the "save as template" name form

  const reload = useCallback(async () => {
    setEntity(await api.getEntity(id))
  }, [id])

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

  if (!entity) return <div className="page">{t('Loading…')}</div>

  const fields = JSON.parse(entity.fields || '{}') as Record<string, string>

  const save = async (patch: Parameters<typeof api.updateEntity>[1]): Promise<void> => {
    const old = Object.fromEntries(Object.keys(patch).map((k) => [k, entity[k as keyof Entity]]))
    pushUndo({ undo: () => api.updateEntity(id, old), redo: () => api.updateEntity(id, patch) })
    await api.updateEntity(id, patch)
    await reload()
    if ('fields' in patch) await refreshHier()
    onChanged()
  }

  const saveFields = (f: Record<string, string>): Promise<void> =>
    save({ fields: JSON.stringify(f) })

  // 📋 Apply template: ADDS missing fields, never OVERWRITES existing values (a starting
  // point, not a constraint). The type is assigned only when the entity has none. Goes through
  // saveFields → undo for free. '_tpl' = the applied template's name (informational — to show
  // the select as chosen; itself deletable/editable); being in RESERVED_FIELDS it never shows
  // in the free-field list.
  const applyTemplate = (tpl: EntityTemplate): void => {
    const f = { ...fields }
    for (const [k, v] of Object.entries(tpl.fields)) if (!(k in f)) f[k] = v
    f['_tpl'] = tpl.name
    const patch: Parameters<typeof api.updateEntity>[1] = { fields: JSON.stringify(f) }
    if (tpl.type && !entity.type) patch.type = tpl.type
    save(patch)
  }

  // 📋 Save as template: takes this entity's FREE fields (excluding ones with their own
  // sections — banner/parent/notes/ruler/house/color/person fields + map-mode dimensions) and its type.
  const saveAsTemplate = async (name: string): Promise<void> => {
    const f: Record<string, string> = {}
    for (const [k, v] of Object.entries(fields))
      if (!RESERVED_FIELDS.includes(k) && !dims.includes(k)) f[k] = v
    const next = tpls.filter((x) => x.name !== name) // update a template of the same name
    const list = [...next, { name, type: entity.type || undefined, fields: f }]
    setTpls(list)
    await saveTemplates(list)
    setTplDraft(null)
  }

  // De-jure parent history: stored as JSON under the "parent" key in fields
  const parents = getParents(entity.fields)
  const saveParents = (next: ParentRec[]): Promise<void> => {
    const f = { ...fields }
    if (next.length) f['parent'] = JSON.stringify(next)
    else delete f['parent']
    return saveFields(f)
  }

  // Note tabs: they go through saveFields, so undo comes for free
  const notes = getNoteTabs(entity.fields)
  const saveNoteTabs = (next: NoteTab[]): Promise<void> => {
    const f = { ...fields }
    if (next.length) f['notes'] = JSON.stringify(next)
    else delete f['notes']
    return saveFields(f)
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

  // Ruler history: fields['ruler'] = [{from, id}] (same pattern as the parent chain)
  const rulers = getYearRecs(entity.fields, 'ruler')
  const saveRulers = (next: ParentRec[]): Promise<void> => {
    const f = { ...fields }
    if (next.length) f['ruler'] = JSON.stringify(next)
    else delete f['ruler']
    return saveFields(f)
  }

  // Ruling-house history: fields['house'] = [{from, id}] — the house is its own entity (not a person)
  const houses = getYearRecs(entity.fields, 'house')
  const saveHouses = (next: ParentRec[]): Promise<void> => {
    const f = { ...fields }
    if (next.length) f['house'] = JSON.stringify(next)
    else delete f['house']
    return saveFields(f)
  }

  // House input: find any entity by name; create (untyped) when missing — not a person
  const findOrCreatePlain = async (name: string): Promise<number | null> => {
    const n = name.trim()
    if (!n) return null
    const found =
      allEntities.find((en) => en.name.toLowerCase() === n.toLowerCase()) ??
      (await api.findEntityByName(n))
    if (found) return found.id
    const { id: newId } = await api.createEntity({ name: n })
    setAllEntities(await api.listEntities())
    onChanged()
    return newId
  }

  // Person types: types marked "Person" in Settings — so family/dynasty fields never bind to
  // a place/state entity even on a name match.
  const personTypeNames = types.filter((ty) => ty.isPerson).map((ty) => ty.name)
  const personEntities = allEntities.filter((en) => personTypeNames.includes(en.type))
  const isPerson = personTypeNames.includes(entity.type)

  // "Rules" on a person: the inverse of the Ruler field — state/region entities naming this
  // person as ruler (fields.ruler), derived (no separate data). Ruler is entered on the place.
  const rules = isPerson
    ? hierEntities.flatMap((e) =>
        getYearRecs(e.fields, 'ruler')
          .filter((r) => r.id === id)
          .map((r) => ({ eid: e.id, name: e.name, from: r.from }))
      )
    : []

  // Find a person entity by name; create when missing (ruler/family inputs live as person
  // entities). When no type is marked "Person", one is set up automatically on first use —
  // every name typed into the dynasty section becomes a person entity with no manual setup.
  const findOrCreate = async (name: string): Promise<number | null> => {
    const n = name.trim()
    if (!n) return null
    const found = personEntities.find((en) => en.name.toLowerCase() === n.toLowerCase())
    if (found) return found.id
    let ptype = personTypeNames[0]
    if (!ptype) {
      ptype = t('Person')
      const existing = types.find((ty) => ty.name === ptype)
      await saveTypes(
        existing
          ? types.map((ty) => (ty.name === ptype ? { ...ty, isPerson: true } : ty))
          : [...types, { name: ptype, color: '#c58af9', isPerson: true }]
      )
    }
    const { id: newId } = await api.createEntity({ name: n, type: ptype })
    setAllEntities(await api.listEntities())
    onChanged()
    return newId
  }

  const childLinks = entity.inLinks.filter(
    (l) => l.relation === 'mother' || l.relation === 'father'
  )

  // Refresh the global graph after editing a family link (gender inference updates live)
  const reloadFamily = async (): Promise<void> => {
    await reload()
    setAllLinks(await api.listLinks())
    await refreshHier()
  }

  // The person's inferred gender: explicit fields.gender > mother/father role > spouse's
  // opposite (inferGenders). The gender box shows it when no explicit value exists
  // ("automatic"); the add-child relation uses it too.
  const inferredGender = inferGenders(hierEntities, allLinks).get(id)
  const genderValue =
    fields['gender'] ?? (inferredGender === 'M' ? 'male' : inferredGender === 'F' ? 'female' : '')
  const genderIsAuto = !fields['gender'] && !!inferredGender

  // Co-parents of a shared child count as spouses (both parents derived even when the child
  // was attached from one side) — a derived chip, not deletable (no linkId)
  const coParents = (): { other: number; name: string }[] => {
    const myChildIds = new Set(childLinks.map((l) => l.from_id))
    const others = new Set<number>()
    for (const l of allLinks) {
      if ((l.relation === 'mother' || l.relation === 'father') && myChildIds.has(l.from_id))
        if (l.to_id !== id) others.add(l.to_id)
    }
    return [...others].map((o) => ({
      other: o,
      name: allEntities.find((e) => e.id === o)?.name ?? '?'
    }))
  }

  // Family ties live in the links table as 'mother'/'father'/'spouse'; the tree is derived from them
  const familyLinks = (rel: string): { linkId?: number; other: number; name: string }[] => {
    const explicit = [
      ...entity.outLinks
        .filter((l) => l.relation === rel)
        .map((l) => ({ linkId: l.id, other: l.to_id, name: l.to_name })),
      // the spouse link is symmetric: show it even when created from the other side
      ...(rel === 'spouse'
        ? entity.inLinks
            .filter((l) => l.relation === rel)
            .map((l) => ({ linkId: l.id, other: l.from_id, name: l.from_name }))
        : [])
    ]
    if (rel !== 'spouse') return explicit
    // add co-parent spouses (skip those who already have an explicit link)
    const have = new Set(explicit.map((e) => e.other))
    return [...explicit, ...coParents().filter((c) => !have.has(c.other))]
  }

  // One family row: existing ties as chips + an add form (unless a singular slot is filled)
  const famRow = (label: string, rel: string, single: boolean): React.JSX.Element => {
    const cur = familyLinks(rel)
    return (
      <div className="tag-row">
        <span className="field-key">{label}</span>
        <span className="chrono-list">
          {cur.map((c) => (
            <span className="tag-chip" key={c.linkId ?? `d${c.other}`}>
              <a href="#" onClick={(e) => (e.preventDefault(), onOpen(c.other))}>
                {c.name}
              </a>
              {c.linkId !== undefined && (
                <button
                  className="tag-x"
                  onClick={async () => {
                    const ref = { id: c.linkId as number }
                    pushUndo({
                      undo: async () => {
                        ref.id = (await api.addLink(id, c.other, rel)).id
                      },
                      redo: () => api.deleteLink(ref.id)
                    })
                    await api.deleteLink(c.linkId as number)
                    reloadFamily()
                  }}
                >
                  ×
                </button>
              )}
            </span>
          ))}
          {(!single || cur.length === 0) && (
            <form
              className="tag-add"
              onSubmit={async (e) => {
                e.preventDefault()
                const form = e.currentTarget
                const nm = (new FormData(form).get('name') as string) ?? ''
                form.reset()
                const target = await findOrCreate(nm)
                if (target === null || target === id) return
                await api.addLink(id, target, rel)
                reloadFamily()
              }}
            >
              <input name="name" list="person-list" placeholder={t('person…')} />
              <button className="mini" type="submit">
                +
              </button>
            </form>
          )}
        </span>
      </div>
    )
  }

  // Hierarchy tags: stored in fields under "hierarchy" as "#tag, #tag"
  const tags = (fields['hierarchy'] ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)

  const saveTags = (next: string[]): Promise<void> => {
    const f = { ...fields }
    if (next.length) f['hierarchy'] = next.join(', ')
    else delete f['hierarchy']
    return saveFields(f)
  }

  const addTag = (): void => {
    let t = tagInput.trim()
    if (!t) return
    if (!t.startsWith('#')) t = '#' + t
    setTagInput('')
    if (!tags.includes(t)) saveTags([...tags, t])
  }

  // --- [[ entity-name completion (the Obsidian pattern) ---
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
    } else if (await confirmDialog(t('No entity named "{name}". Create it?', { name }))) {
      const { id: newId } = await api.createEntity({ name })
      onChanged()
      onOpen(newId)
    }
  }

  const addLink = async (): Promise<void> => {
    const target = allEntities.find((en) => en.name === linkTarget)
    if (!target || !linkRelation) return
    await api.addLink(id, target.id, linkRelation)
    setLinkTarget('')
    setLinkRelation('')
    await reload()
  }

  return (
    <div className={compact ? 'page compact' : 'page'}>
      {fields['banner'] ? (
        <div className="banner">
          <img src={assetUrl(fields['banner'])} alt="" />
          <span className="banner-actions">
            <button className="mini" title={t('Replace banner')} onClick={pickBanner}>
              🖼
            </button>
            <button
              className="mini danger"
              title={t('Remove banner')}
              onClick={() => {
                const f = { ...fields }
                delete f['banner']
                saveFields(f)
              }}
            >
              ×
            </button>
          </span>
        </div>
      ) : (
        <button className="banner-placeholder" onClick={pickBanner}>
          🖼 {t('Add banner')}
        </button>
      )}
      <div className="page-head">
        <input
          className="title-input"
          defaultValue={entity.name}
          key={`name-${entity.id}-${entity.updated_at}`}
          onBlur={(e) =>
            e.target.value !== entity.name &&
            e.target.value.trim() &&
            save({ name: e.target.value.trim() })
          }
        />
        <input
          className="type-input"
          list="type-list"
          placeholder={t('type')}
          defaultValue={entity.type}
          key={`type-${entity.id}-${entity.updated_at}`}
          onBlur={(e) => e.target.value !== entity.type && save({ type: e.target.value })}
          style={{
            borderLeftColor: types.find((ty) => ty.name === entity.type)?.color ?? 'var(--border)'
          }}
        />
        <datalist id="type-list">
          {types.map((ty) => (
            <option key={ty.name} value={ty.name} />
          ))}
        </datalist>
        <button onClick={() => setEditing(!editing)}>{editing ? t('View') : t('Edit')}</button>
        <button
          className="danger"
          onClick={async () => {
            if (await deleteEntityWithUndo(id)) {
              onChanged()
              onDeleted()
            }
          }}
        >
          {t('Delete')}
        </button>
      </div>

      <div className="fields">
        {Object.entries(fields)
          .filter(([k]) => !RESERVED_FIELDS.includes(k) && !dims.includes(k)) // shown in their own sections
          .map(([k, v]) => (
            <div className="field-row" key={k}>
              <span className="field-key">{k}</span>
              <input
                defaultValue={v}
                onBlur={(e) =>
                  e.target.value !== v && saveFields({ ...fields, [k]: e.target.value })
                }
              />
              <button
                className="mini danger"
                onClick={() => {
                  const f = { ...fields }
                  delete f[k]
                  saveFields(f)
                }}
              >
                ×
              </button>
            </div>
          ))}
        <form
          className="field-row add"
          onSubmit={(e) => {
            e.preventDefault()
            const fd = new FormData(e.currentTarget)
            const k = (fd.get('key') as string).trim()
            if (k && !(k in fields)) {
              saveFields({ ...fields, [k]: (fd.get('value') as string) ?? '' })
              e.currentTarget.reset()
            }
          }}
        >
          <input name="key" placeholder={t('new field')} />
          <input name="value" placeholder={t('value')} />
          <button className="mini" type="submit">
            +
          </button>
        </form>
        {/* Template: adds missing fields (never overwrites), undone with Ctrl+Z. The applied
            template's name sits in fields['_tpl'] — so the select shows it as chosen (informational). */}
        <div className="tpl-row">
          {tpls.length > 0 && (
            <select
              value={
                fields['_tpl'] && tpls.some((x) => x.name === fields['_tpl']) ? fields['_tpl'] : ''
              }
              title={t('Apply a template (adds missing fields only)')}
              onChange={(e) => {
                const x = tpls.find((y) => y.name === e.target.value)
                if (x) applyTemplate(x)
              }}
            >
              <option value="">📋 {t('Apply template…')}</option>
              {tpls.map((x) => (
                <option key={x.name} value={x.name}>
                  {x.name}
                </option>
              ))}
            </select>
          )}
          {tplDraft === null ? (
            <button
              className="mini"
              title={t('Save this page’s fields as a reusable template')}
              onClick={() => setTplDraft(entity.type || entity.name)}
            >
              {t('Save as template')}
            </button>
          ) : (
            <form
              className="tpl-save"
              onSubmit={(e) => {
                e.preventDefault()
                const n = tplDraft.trim()
                if (n) saveAsTemplate(n)
              }}
            >
              <input
                autoFocus
                value={tplDraft}
                placeholder={t('template name')}
                onChange={(e) => setTplDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && setTplDraft(null)}
              />
              <button className="mini" type="submit">
                {t('Save')}
              </button>
              <button className="mini" type="button" onClick={() => setTplDraft(null)}>
                {t('Cancel')}
              </button>
            </form>
          )}
        </div>
      </div>

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
          placeholder={t('Markdown content… link to other entities with [[Entity Name]].')}
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
          e.preventDefault()
          e.stopPropagation()
          setMenu({
            x: e.clientX,
            y: e.clientY,
            items: [
              {
                label: t('🗒 New tab'),
                onClick: () => {
                  setNoteEdit((prev) => new Set(prev).add(notes.length)) // a new tab opens in edit mode
                  saveNoteTabs([...notes, { title: t('New note'), content: '', collapsed: false }])
                }
              }
            ]
          })
        }}
      >
        {notes.length === 0 && <p className="hint">{t('Right click → new tab for long notes.')}</p>}
        {notes.map((n, i) => (
          <div className="note-tab" key={i}>
            <div className="note-head">
              <button
                className="mini"
                onClick={() =>
                  saveNoteTabs(
                    notes.map((x, j) => (j === i ? { ...x, collapsed: !x.collapsed } : x))
                  )
                }
              >
                {n.collapsed ? '▸' : '▾'}
              </button>
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
              <button
                className="mini"
                title={noteEdit.has(i) ? t('View') : t('Edit')}
                onClick={() => toggleNoteEdit(i)}
              >
                {noteEdit.has(i) ? '📖' : '✏️'}
              </button>
              <button
                className="mini danger"
                onClick={async () => {
                  if (await confirmDialog(t('Delete note "{name}"?', { name: n.title })))
                    saveNoteTabs(notes.filter((_, j) => j !== i))
                }}
              >
                ×
              </button>
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
                  placeholder={t('Markdown content… link to other entities with [[Entity Name]].')}
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

      <div className="links-section">
        <div className="hier-tabs">
          {(
            [
              ['hier', t('Hierarchy')],
              ['dynasty', t('Dynasty')],
              ['links', t('Relations')]
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              className={`tag-chip clickable ${section === key ? 'active' : ''}`}
              onClick={() => setSection(key)}
            >
              {label}
            </button>
          ))}
        </div>
        {section === 'hier' && (
          <>
            <div className="tag-row">
              {tags.map((tag) => (
                <span className="tag-chip" key={tag}>
                  {tag}
                  <button className="tag-x" onClick={() => saveTags(tags.filter((x) => x !== tag))}>
                    ×
                  </button>
                </span>
              ))}
              <form
                className="tag-add"
                onSubmit={(e) => {
                  e.preventDefault()
                  addTag()
                }}
              >
                <input
                  list="tag-list"
                  placeholder={t('county, religion, language…')}
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                />
                <datalist id="tag-list">
                  {allTags
                    .filter((tag) => !tags.includes(tag))
                    .map((tag) => (
                      <option key={tag} value={tag} />
                    ))}
                </datalist>
                <button className="mini" type="submit">
                  +
                </button>
              </form>
            </div>
            <div className="tag-row">
              <span className="field-key">{t('Government form')}</span>
              <input
                list="gov-list"
                placeholder={t('feudal, nomadic…')}
                defaultValue={fields['government'] ?? ''}
                key={`gov-${entity.id}-${entity.updated_at}`}
                onBlur={(e) => {
                  const v = e.target.value.trim()
                  if (v === (fields['government'] ?? '')) return
                  const f = { ...fields }
                  if (v) f['government'] = v
                  else delete f['government']
                  saveFields(f)
                }}
              />
              <datalist id="gov-list">
                {allGovs.map((g) => (
                  <option key={g} value={g} />
                ))}
              </datalist>
            </div>
            <div className="tag-row">
              <span className="field-key">{t('Parent')}</span>
              <span className="chrono-list">
                {parents.map((p, i) => (
                  <span className="tag-chip" key={i}>
                    {p.from === null ? t('start') : t('year {n}', { n: p.from })} →{' '}
                    {allEntities.find((x) => x.id === p.id)?.name ?? `#${p.id}`}
                    <button
                      className="tag-x"
                      onClick={() => saveParents(parents.filter((_, j) => j !== i))}
                    >
                      ×
                    </button>
                  </span>
                ))}
                <form
                  className="tag-add"
                  onSubmit={(e) => {
                    e.preventDefault()
                    const target = allEntities.find((en) => en.name === parentName.trim())
                    if (!target || target.id === id) return
                    const from = parentYear === '' ? null : Number(parentYear)
                    const next = parents.filter((p) => p.from !== from)
                    next.push({ from, id: target.id })
                    next.sort((a, b) => (a.from ?? -Infinity) - (b.from ?? -Infinity))
                    setParentName('')
                    setParentYear('')
                    saveParents(next)
                  }}
                >
                  <input
                    list="entity-list"
                    placeholder={t('parent entity')}
                    value={parentName}
                    onChange={(e) => setParentName(e.target.value)}
                  />
                  <input
                    type="number"
                    placeholder={t('year (blank=from start)')}
                    style={{ width: 110 }}
                    value={parentYear}
                    onChange={(e) => setParentYear(e.target.value)}
                  />
                  <button className="mini" type="submit">
                    +
                  </button>
                </form>
              </span>
            </div>
            {dims.map((d) => (
              <div className="tag-row" key={d}>
                <span className="field-key">{d}</span>
                <input
                  list={`dim-list-${d}`}
                  placeholder={t('value') + '…'}
                  defaultValue={fields[d] ?? ''}
                  key={`dim-${d}-${entity.id}-${entity.updated_at}`}
                  onBlur={(e) => {
                    const v = e.target.value.trim()
                    if (v === (fields[d] ?? '')) return
                    const f = { ...fields }
                    if (v) f[d] = v
                    else delete f[d]
                    saveFields(f)
                  }}
                />
                <datalist id={`dim-list-${d}`}>
                  {(dimValues[d] ?? []).map((v) => (
                    <option key={v} value={v} />
                  ))}
                </datalist>
              </div>
            ))}
            {!compact && feats.length > 0 && (
              <div className="tag-row">
                <span className="field-key">{t('Map history')}</span>
                <span className="chrono-list">
                  {feats.map((f) => {
                    const s = JSON.parse(f.style || '{}') as { from?: number; to?: number }
                    const range =
                      s.from === undefined && s.to === undefined
                        ? t('always')
                        : `${s.from ?? '…'} – ${s.to ?? '…'}`
                    return (
                      <button
                        className="tag-chip clickable"
                        key={f.id}
                        title={t('Show on map')}
                        onClick={() => onLocateFeature?.(f.map_id, f.id)}
                      >
                        🗺 {f.map_name} ({range})
                      </button>
                    )
                  })}
                </span>
              </div>
            )}
          </>
        )}

        {section === 'dynasty' && (
          <>
            {isPerson && (
              <div className="tag-row">
                <button className="mini" title={t('Family tree')} onClick={() => setTreeOpen(true)}>
                  🌳 {t('Family tree')}
                </button>
              </div>
            )}
            {isPerson ? (
              // Ruler is not entered on a person; the states/regions they rule are derived and listed
              rules.length > 0 && (
                <div className="tag-row">
                  <span className="field-key">{t('Rules')}</span>
                  <span className="chrono-list">
                    {rules.map((r, i) => (
                      <button
                        className="tag-chip clickable"
                        key={i}
                        title={t('📖 Open entity')}
                        onClick={() => onOpen(r.eid)}
                      >
                        {r.from === null ? t('start') : t('year {n}', { n: r.from })} → {r.name}
                      </button>
                    ))}
                  </span>
                </div>
              )
            ) : (
              <div className="tag-row">
                <span className="field-key">{t('Ruler')}</span>
                <span className="chrono-list">
                  {rulers.map((r, i) => (
                    <span className="tag-chip" key={i}>
                      {r.from === null ? t('start') : t('year {n}', { n: r.from })} →{' '}
                      <a
                        href="#"
                        onClick={(e) => (e.preventDefault(), onOpen(r.id))}
                        title={t('📖 Open entity')}
                      >
                        {allEntities.find((x) => x.id === r.id)?.name ?? `#${r.id}`}
                      </a>
                      <button
                        className="tag-x"
                        onClick={() => saveRulers(rulers.filter((_, j) => j !== i))}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  <form
                    className="tag-add"
                    onSubmit={async (e) => {
                      e.preventDefault()
                      const nm = rulerName
                      const from = rulerYear === '' ? null : Number(rulerYear)
                      setRulerName('')
                      setRulerYear('')
                      const target = await findOrCreate(nm)
                      if (target === null || target === id) return
                      const next = rulers.filter((r) => r.from !== from)
                      next.push({ from, id: target })
                      next.sort((a, b) => (a.from ?? -Infinity) - (b.from ?? -Infinity))
                      saveRulers(next)
                    }}
                  >
                    <input
                      list="person-list"
                      placeholder={t('ruler (person)')}
                      value={rulerName}
                      onChange={(e) => setRulerName(e.target.value)}
                    />
                    <input
                      type="number"
                      placeholder={t('year (blank=from start)')}
                      style={{ width: 110 }}
                      value={rulerYear}
                      onChange={(e) => setRulerYear(e.target.value)}
                    />
                    <button className="mini" type="submit">
                      +
                    </button>
                  </form>
                </span>
              </div>
            )}
            {!isPerson && (
              // Ruling house: next to ruler on non-person entities; the house is its own entity
              <div className="tag-row">
                <span className="field-key">{t('Ruling house')}</span>
                <span className="chrono-list">
                  {houses.map((r, i) => (
                    <span className="tag-chip" key={i}>
                      {r.from === null ? t('start') : t('year {n}', { n: r.from })} →{' '}
                      <a
                        href="#"
                        onClick={(e) => (e.preventDefault(), onOpen(r.id))}
                        title={t('📖 Open entity')}
                      >
                        {allEntities.find((x) => x.id === r.id)?.name ?? `#${r.id}`}
                      </a>
                      <button
                        className="tag-x"
                        onClick={() => saveHouses(houses.filter((_, j) => j !== i))}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  <form
                    className="tag-add"
                    onSubmit={async (e) => {
                      e.preventDefault()
                      const nm = houseName
                      const from = houseYear === '' ? null : Number(houseYear)
                      setHouseName('')
                      setHouseYear('')
                      const target = await findOrCreatePlain(nm)
                      if (target === null || target === id) return
                      const next = houses.filter((r) => r.from !== from)
                      next.push({ from, id: target })
                      next.sort((a, b) => (a.from ?? -Infinity) - (b.from ?? -Infinity))
                      saveHouses(next)
                    }}
                  >
                    <input
                      list="entity-list"
                      placeholder={t('ruling house')}
                      value={houseName}
                      onChange={(e) => setHouseName(e.target.value)}
                    />
                    <input
                      type="number"
                      placeholder={t('year (blank=from start)')}
                      style={{ width: 110 }}
                      value={houseYear}
                      onChange={(e) => setHouseYear(e.target.value)}
                    />
                    <button className="mini" type="submit">
                      +
                    </button>
                  </form>
                </span>
              </div>
            )}
            {isPerson && (
              <>
                <div className="tag-row">
                  <span className="field-key">{t('Gender')}</span>
                  <select
                    value={genderValue}
                    onChange={(e) => {
                      const f = { ...fields }
                      if (e.target.value) f['gender'] = e.target.value
                      else delete f['gender']
                      saveFields(f)
                    }}
                  >
                    <option value="">—</option>
                    <option value="male">♂ {t('Male')}</option>
                    <option value="female">♀ {t('Female')}</option>
                  </select>
                  {genderIsAuto && <span className="hint">{t('(auto from relations)')}</span>}
                </div>
                <div className="tag-row">
                  <span className="field-key">{t('Life')}</span>
                  {(['birth', 'death'] as const).map((k) => (
                    <input
                      key={`${k}${fields[k] ?? ''}`}
                      type="number"
                      style={{ width: 110 }}
                      placeholder={k === 'birth' ? t('birth year') : t('death year')}
                      defaultValue={fields[k] ?? ''}
                      onBlur={(e) => {
                        const f = { ...fields }
                        const v = e.target.value.trim()
                        if (v) f[k] = v
                        else delete f[k]
                        if ((fields[k] ?? '') !== v) saveFields(f)
                      }}
                    />
                  ))}
                </div>
                {famRow(t('Mother'), 'mother', true)}
                {famRow(t('Father'), 'father', true)}
                {famRow(t('Spouse'), 'spouse', false)}
                {/* A child = a reversed link (child → this person). The relation becomes
                    mother/father by this person's gender (father assumed when unknown; later
                    ones correct themselves once a gender is set). */}
                <div className="tag-row">
                  <span className="field-key">{t('Children')}</span>
                  <span className="chrono-list">
                    {childLinks.map((l) => (
                      <span className="tag-chip" key={l.id}>
                        <a href="#" onClick={(e) => (e.preventDefault(), onOpen(l.from_id))}>
                          {l.from_name}
                        </a>
                        <button
                          className="tag-x"
                          onClick={async () => {
                            const ref = { id: l.id }
                            pushUndo({
                              undo: async () => {
                                ref.id = (await api.addLink(l.from_id, id, l.relation)).id
                              },
                              redo: () => api.deleteLink(ref.id)
                            })
                            await api.deleteLink(l.id)
                            reloadFamily()
                          }}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                    <form
                      className="tag-add"
                      onSubmit={async (e) => {
                        e.preventDefault()
                        const form = e.currentTarget
                        const nm = (new FormData(form).get('name') as string) ?? ''
                        form.reset()
                        const child = await findOrCreate(nm)
                        if (child === null || child === id) return
                        // Relation by this person's (inferred) gender: female→mother, else father
                        const rel = inferredGender === 'F' ? 'mother' : 'father'
                        await api.addLink(child, id, rel)
                        reloadFamily()
                      }}
                    >
                      <input name="name" list="person-list" placeholder={t('child…')} />
                      <button className="mini" type="submit">
                        +
                      </button>
                    </form>
                  </span>
                </div>
              </>
            )}
          </>
        )}

        {section === 'links' && (
          <>
            {entity.outLinks.map((l) => (
              <div className="link-row" key={l.id}>
                <span className="relation">{l.relation}</span>
                <a href="#" onClick={(e) => (e.preventDefault(), onOpen(l.to_id))}>
                  {l.to_name}
                </a>
                <button
                  className="mini danger"
                  onClick={async () => {
                    const ref = { id: l.id }
                    pushUndo({
                      undo: async () => {
                        ref.id = (await api.addLink(id, l.to_id, l.relation)).id
                      },
                      redo: () => api.deleteLink(ref.id)
                    })
                    await api.deleteLink(l.id)
                    reload()
                  }}
                >
                  ×
                </button>
              </div>
            ))}
            <div className="link-row add">
              <input
                placeholder={t('relation (rules, member of…)')}
                value={linkRelation}
                onChange={(e) => setLinkRelation(e.target.value)}
              />
              <input
                list="entity-list"
                placeholder={t('target entity')}
                value={linkTarget}
                onChange={(e) => setLinkTarget(e.target.value)}
              />
              <button className="mini" onClick={addLink}>
                +
              </button>
            </div>

            {(entity.inLinks.length > 0 || entity.mentions.length > 0) && (
              <h3>{t('Linked from here')}</h3>
            )}
            {entity.inLinks.map((l) => (
              <div className="link-row" key={l.id}>
                <a href="#" onClick={(e) => (e.preventDefault(), onOpen(l.from_id))}>
                  {l.from_name}
                </a>
                <span className="relation">{l.relation}</span>
              </div>
            ))}
            {entity.mentions.map((m) => (
              <div className="link-row" key={`m-${m.id}`}>
                <a href="#" onClick={(e) => (e.preventDefault(), onOpen(m.id))}>
                  {m.name}
                </a>
                <span className="relation">{t('mentions in content')}</span>
              </div>
            ))}
          </>
        )}

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
                {en.type && <span className="wiki-sug-type">{en.type}</span>}
              </button>
            ))}
          </div>
        )}

        {/* The Parent/Ruler/Family/Links forms use this list whichever tab is open */}
        <datalist id="entity-list">
          {allEntities
            .filter((en) => en.id !== id)
            .map((en) => (
              <option key={en.id} value={en.name} />
            ))}
        </datalist>
        <datalist id="person-list">
          {personEntities
            .filter((en) => en.id !== id)
            .map((en) => (
              <option key={en.id} value={en.name} />
            ))}
        </datalist>
      </div>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
      {treeOpen && (
        <FamilyTree rootId={id} onOpenEntity={onOpen} onClose={() => setTreeOpen(false)} />
      )}
    </div>
  )
}
