import { useState } from 'react'
import {
  api,
  Entity,
  EntityRow,
  EntityTemplate,
  folderColor,
  getParents,
  getYearRecs,
  Hierarchy,
  inferGenders,
  ParentRec,
  RESERVED_FIELDS,
  saveTemplates,
  FolderDef,
  personFolderIds,
  saveEntityFolders
} from './api'
import Icon from './icons'
import Select from './Select'
import { useT } from './i18n'
import { randomName } from './names'
import { IconButton, Row, Section } from './ui'
import { pushUndo } from './undo'

// ---------------------------------------------------------------------------
// THE IDENTITY RAIL — everything that answers "what IS this?".
//
// It used to sit at the very bottom of the page behind a three-tab strip, below an arbitrarily
// long prose body: you had to scroll past the article to learn the entity was a duchy, who ruled
// it, or what it belonged to. It is now always visible beside the document.
//
// It is also the ONLY thing the map inspector renders (EntityPage's `compact`). The full page and
// the inspector are two presentations of one object, so they share these sections verbatim rather
// than being styled to resemble each other — which is the reason this is a component at all and
// not a second copy.
//
// SPLIT OUT OF EntityPage ALONG THE DATA, not along the markup. Everything EntityPage fetches in
// its one effect (the entity, the entity list, the link graph, the hierarchy, the templates, the
// map history) stays EntityPage's and arrives here as a prop; what only these forms care about —
// the ten half-typed input values, and whether the family tree is open — lives here. Both
// datalists moved with it because every consumer of both is in this file.
// ---------------------------------------------------------------------------
export interface EntityRailProps {
  id: number
  entity: Entity
  /** entity.fields, already parsed — EntityPage parses it once for both halves. */
  fields: Record<string, string>
  folders: FolderDef[]
  allEntities: EntityRow[]
  setAllEntities: (v: EntityRow[]) => void
  allLinks: { from_id: number; to_id: number; relation: string }[]
  setAllLinks: (v: { from_id: number; to_id: number; relation: string }[]) => void
  hierEntities: Hierarchy['entities']
  allTags: string[]
  allGovs: string[]
  dims: string[]
  dimValues: Record<string, string[]>
  tpls: EntityTemplate[]
  setTpls: (v: EntityTemplate[]) => void
  feats: { id: number; map_id: number; style: string; map_name: string }[]
  /** The shared write path: one undo record per edit, then a reload. EntityPage owns it because
   *  the document half writes through it too. */
  save: (patch: Parameters<typeof api.updateEntity>[1]) => Promise<void>
  saveFields: (f: Record<string, string>) => Promise<void>
  reload: () => Promise<void>
  refreshHier: () => Promise<void>
  onChanged: () => void
  onOpen: (id: number) => void
  onLocateFeature?: (mapId: number, featureId: number) => void
  /** Opens the family tree. The overlay itself stays in EntityPage: it is `position: fixed`,
   *  and moving a fixed element under a different ancestor is how it finds out that ancestor
   *  has a transform. Nothing here needs to own it — the rail only has the button. */
  onOpenTree: () => void
}

export default function EntityRail({
  id,
  entity,
  fields,
  folders,
  allEntities,
  setAllEntities,
  allLinks,
  setAllLinks,
  hierEntities,
  allTags,
  allGovs,
  dims,
  dimValues,
  tpls,
  setTpls,
  feats,
  save,
  saveFields,
  reload,
  refreshHier,
  onChanged,
  onOpen,
  onLocateFeature,
  onOpenTree
}: EntityRailProps): React.JSX.Element {
  const t = useT()
  const [linkTarget, setLinkTarget] = useState('')
  const [linkRelation, setLinkRelation] = useState('')
  const [tagInput, setTagInput] = useState('')
  const [parentName, setParentName] = useState('')
  const [parentYear, setParentYear] = useState('')
  // Ruler history (dynasty system): year-based, bound to a person entity
  const [rulerName, setRulerName] = useState('')
  const [rulerYear, setRulerYear] = useState('')
  // Ruling-house history (year-based, same pattern as parent/ruler)
  const [houseName, setHouseName] = useState('')
  const [houseYear, setHouseYear] = useState('')
  const [tplDraft, setTplDraft] = useState<string | null>(null) // the "save as template" name form

  // 📋 Apply template: ADDS missing fields, never OVERWRITES existing values (a starting
  // point, not a constraint). The type is assigned only when the entity has none. Goes through
  // saveFields → undo for free. '_tpl' = the applied template's name (informational — to show
  // the select as chosen; itself deletable/editable); being in RESERVED_FIELDS it never shows
  // in the free-field list.
  const applyTemplate = (tpl: EntityTemplate): void => {
    const f = { ...fields }
    for (const [k, v] of Object.entries(tpl.fields)) if (!(k in f)) f[k] = v
    f['_tpl'] = tpl.name
    save({ fields: JSON.stringify(f) })
  }

  // 📋 Save as template: takes this entity's FREE fields (excluding ones with their own
  // sections — banner/parent/notes/ruler/house/color/person fields + map-mode dimensions).
  const saveAsTemplate = async (name: string): Promise<void> => {
    const f: Record<string, string> = {}
    for (const [k, v] of Object.entries(fields))
      if (!RESERVED_FIELDS.includes(k) && !dims.includes(k)) f[k] = v
    const next = tpls.filter((x) => x.name !== name) // update a template of the same name
    const list = [...next, { name, fields: f }]
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

  // People live in sidebar folders flagged "Person" — so family/dynasty fields never bind to
  // a place/state article even on a name match.
  const personFolders = personFolderIds(folders)
  const personEntities = allEntities.filter((en) => !!en.folder && personFolders.has(en.folder))
  const myFolder = (JSON.parse(entity.fields || '{}') as Record<string, string>)['folder']
  const isPerson = !!myFolder && personFolders.has(myFolder)

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
  /**
   * Who this name refers to — an id when the person exists, a DESCRIPTION when they do not.
   *
   * It does not write, and that is the whole point: creating the person and attaching them is one
   * user action, so the creation has to travel WITH the attachment into a single transaction
   * (api.addRelation). Writing here first was what left a person in the Person folder attached to
   * nobody whenever the second write failed.
   *
   * The Person folder is still made here when there is none, because that is a settings write
   * about the sidebar rather than part of the relation, and it is idempotent.
   */
  const resolvePerson = async (
    name: string
  ): Promise<number | { name: string; fields: string } | null> => {
    const n = name.trim()
    if (!n) return null
    const found = personEntities.find((en) => en.name.toLowerCase() === n.toLowerCase())
    if (found) return found.id
    // No Person folder yet? Create one on first use — typing a name into the dynasty section
    // is all the setup there is (the old auto-created "Person" type, re-homed onto folders).
    let pf = [...personFolders][0]
    if (!pf) {
      pf = crypto.randomUUID()
      await saveEntityFolders([
        ...folders,
        {
          id: pf,
          name: t('Person'),
          parent: null,
          order: folders.length + 1,
          color: '#c58af9',
          isPerson: true
        }
      ])
    }
    // The folder rides along in `fields` (createEntity has always taken it), so there is never a
    // moment where the person exists outside their folder.
    return { name: n, fields: JSON.stringify({ folder: pf }) }
  }
  /** The ruler form still needs an id in hand: its second write is a field on THIS entry whose
   *  CONTENT depends on the new person's id, so it cannot travel inside addRelation. One call
   *  when the person exists, two when they do not — the remaining non-atomic pair, knowingly. */
  const findOrCreate = async (name: string): Promise<number | null> => {
    const who = await resolvePerson(name)
    if (who === null || typeof who === 'number') return who
    const { id: newId } = await api.createEntity(who)
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
  // Random-name buttons next to a person input. `put` fills a controlled input; without it
  // the name goes straight into the sibling <input name="name"> of the same form.
  // gen null = gender unknown here, so offer both — and then the two buttons are identical
  // except for which name they make, so the gender is the one thing the glyph has to carry.
  // It does it in colour, with the same two tokens the family tree's badges use.
  const dice = (gen: 'M' | 'F' | null, put?: (n: string) => void): React.JSX.Element => (
    <>
      {(gen ? [gen] : (['M', 'F'] as const)).map((g) => (
        <button
          key={g}
          type="button"
          className={`mini dice-${g === 'F' ? 'f' : 'm'}`}
          title={g === 'F' ? t('Random female name') : t('Random male name')}
          aria-label={g === 'F' ? t('Random female name') : t('Random male name')}
          onClick={(e) => {
            const nm = randomName(g)
            if (put) put(nm)
            else {
              const inp = e.currentTarget.form?.elements.namedItem('name')
              if (inp instanceof HTMLInputElement) inp.value = nm
            }
          }}
        >
          <Icon name="dice" size={13} />
        </button>
      ))}
    </>
  )

  const famRow = (
    label: string,
    rel: string,
    single: boolean,
    gen: 'M' | 'F' | null
  ): React.JSX.Element => {
    const cur = familyLinks(rel)
    return (
      <Row label={label}>
        {cur.map((c) => (
          <span className="tag-chip" key={c.linkId ?? `d${c.other}`}>
            <a href="#" onClick={(e) => (e.preventDefault(), onOpen(c.other))}>
              {c.name}
            </a>
            {c.linkId !== undefined && (
              <button
                className="tag-x"
                title={t('Remove')}
                onClick={async () => {
                  const ref = { id: c.linkId as number }
                  pushUndo({
                    label: 'Remove relation',
                    params: { name: rel },
                    undo: async () => {
                      ref.id = (await api.addLink(id, c.other, rel)).id
                    },
                    redo: () => api.deleteLink(ref.id)
                  })
                  await api.deleteLink(c.linkId as number)
                  reloadFamily()
                }}
              >
                <Icon name="x" size={11} />
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
              const who = await resolvePerson(nm)
              if (who === null || who === id) return
              // ONE transaction and ONE history step: the person and the tie appear together, or
              // neither does. Adding a relation used to leave no undo entry at all.
              const r = await api.addRelation(id, who, rel)
              // Identity drift: a redo that had to invent the person again gets a NEW row id, so
              // the ref carries what the NEXT undo must delete — never the id from the first run.
              const ref = { linkId: r.linkId, created: r.created }
              pushUndo({
                label: 'Add relation',
                params: { name: rel },
                undo: () => api.deleteRelation(ref.linkId, ref.created).then(reloadFamily),
                redo: async () => {
                  // `who` again, not the old id: if it was a description the person was deleted
                  // with the link and has to be made afresh; if it was an id they were never ours.
                  const again = await api.addRelation(id, who, rel)
                  ref.linkId = again.linkId
                  ref.created = again.created
                  await reloadFamily()
                }
              })
              await reloadFamily()
            }}
          >
            <input name="name" list="person-list" placeholder={t('person…')} />
            {dice(gen)}
            <button className="mini" type="submit" title={t('Add')}>
              <Icon name="plus" size={12} />
            </button>
          </form>
        )}
      </Row>
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

  const addLink = async (): Promise<void> => {
    const target = allEntities.find((en) => en.name === linkTarget)
    if (!target || !linkRelation) return
    await api.addLink(id, target.id, linkRelation)
    setLinkTarget('')
    setLinkRelation('')
    await reload()
  }

  const rail = (
    <div className="entity-rail">
      <Section title={t('Identity')} icon="landmark">
        {myFolder && (
          <Row label={t('Folder')}>
            <span className="tag-chip">
              <span className="dot" style={{ background: folderColor(folders, myFolder) }} />
              {folders.find((f) => f.id === myFolder)?.name ?? ''}
            </span>
          </Row>
        )}
        <Row label={t('Ranks')}>
          {tags.map((tag) => (
            <span className="tag-chip" key={tag}>
              {tag}
              <button
                className="tag-x"
                title={t('Remove')}
                onClick={() => saveTags(tags.filter((x) => x !== tag))}
              >
                <Icon name="x" size={11} />
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
              placeholder={t('county, duchy, kingdom…')}
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
            <button className="mini" type="submit" title={t('Add')}>
              <Icon name="plus" size={12} />
            </button>
          </form>
        </Row>
        <Row label={t('Government form')}>
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
        </Row>
        {/* Map-mode dimensions (religion, language, culture…) are SYSTEM fields:
            they paint the map, so they live here rather than among free metadata. */}
        {dims.map((d) => (
          <Row label={d} key={d}>
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
          </Row>
        ))}
      </Section>

      {/* De-jure chain. The year is the row LABEL because this is a sequence in
          time (barony → county → duchy), not a bag of tags. */}
      {!isPerson && (
        <Section title={t('Belongs to')} icon="map">
          {parents.length === 0 && <p className="hint">{t('Independent: no realm above it.')}</p>}
          {parents.map((p, i) => (
            <Row
              key={i}
              label={p.from === null ? t('start') : String(p.from)}
              action={
                <IconButton
                  icon="x"
                  label={t('Remove')}
                  small
                  onClick={() => saveParents(parents.filter((_, j) => j !== i))}
                />
              }
            >
              <a href="#" onClick={(e) => (e.preventDefault(), onOpen(p.id))}>
                {allEntities.find((x) => x.id === p.id)?.name ?? `#${p.id}`}
              </a>
            </Row>
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
              placeholder={t('belongs to…')}
              value={parentName}
              onChange={(e) => setParentName(e.target.value)}
            />
            <input
              type="number"
              placeholder={t('year')}
              title={t('year (blank=from start)')}
              style={{ width: 72 }}
              value={parentYear}
              onChange={(e) => setParentYear(e.target.value)}
            />
            <button className="mini" type="submit" title={t('Add')}>
              <Icon name="plus" size={12} />
            </button>
          </form>
        </Section>
      )}

      {!isPerson && (
        <Section title={t('Rulers')} icon="crown">
          {rulers.map((r, i) => (
            <Row
              key={i}
              label={r.from === null ? t('start') : String(r.from)}
              action={
                <IconButton
                  icon="x"
                  label={t('Remove')}
                  small
                  onClick={() => saveRulers(rulers.filter((_, j) => j !== i))}
                />
              }
            >
              <a
                href="#"
                onClick={(e) => (e.preventDefault(), onOpen(r.id))}
                title={t('Open entry')}
              >
                {allEntities.find((x) => x.id === r.id)?.name ?? `#${r.id}`}
              </a>
            </Row>
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
            {dice(null, setRulerName)}
            <input
              type="number"
              placeholder={t('year')}
              title={t('year (blank=from start)')}
              style={{ width: 72 }}
              value={rulerYear}
              onChange={(e) => setRulerYear(e.target.value)}
            />
            <button className="mini" type="submit" title={t('Add')}>
              <Icon name="plus" size={12} />
            </button>
          </form>
          {/* The ruling house is the same question one level up — who holds this realm, as a
              family rather than as a person. It was a section of its own, which put a fold
              between two halves of one answer. */}
          <div className="panel-title">{t('Ruling house')}</div>
          {houses.map((r, i) => (
            <Row
              key={i}
              label={r.from === null ? t('start') : String(r.from)}
              action={
                <IconButton
                  icon="x"
                  label={t('Remove')}
                  small
                  onClick={() => saveHouses(houses.filter((_, j) => j !== i))}
                />
              }
            >
              <a
                href="#"
                onClick={(e) => (e.preventDefault(), onOpen(r.id))}
                title={t('Open entry')}
              >
                {allEntities.find((x) => x.id === r.id)?.name ?? `#${r.id}`}
              </a>
            </Row>
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
              placeholder={t('year')}
              title={t('year (blank=from start)')}
              style={{ width: 72 }}
              value={houseYear}
              onChange={(e) => setHouseYear(e.target.value)}
            />
            <button className="mini" type="submit" title={t('Add')}>
              <Icon name="plus" size={12} />
            </button>
          </form>
        </Section>
      )}

      {/* On a person the ruler relation is DERIVED (entered on the realm), so it
          is read-only here — the inverse of fields.ruler. */}
      {isPerson && rules.length > 0 && (
        <Section title={t('Rules')} icon="crown">
          {rules.map((r, i) => (
            <Row key={i} label={r.from === null ? t('start') : String(r.from)}>
              <a
                href="#"
                onClick={(e) => (e.preventDefault(), onOpen(r.eid))}
                title={t('Open entry')}
              >
                {r.name}
              </a>
            </Row>
          ))}
        </Section>
      )}

      {isPerson && (
        <Section title={t('Life')} icon="calendar">
          <Row label={t('Gender')}>
            <Select
              value={genderValue}
              placeholder="—"
              onChange={(v) => {
                const f = { ...fields }
                if (v) f['gender'] = v
                else delete f['gender']
                saveFields(f)
              }}
              options={[
                { value: '', label: '—' },
                { value: 'male', label: `♂ ${t('Male')}` },
                { value: 'female', label: `♀ ${t('Female')}` }
              ]}
            />
            {genderIsAuto && <span className="hint">{t('(auto from relations)')}</span>}
          </Row>
          {(['birth', 'death'] as const).map((k) => (
            <Row label={k === 'birth' ? t('Born') : t('Died')} key={k}>
              <input
                key={`${k}${fields[k] ?? ''}`}
                type="number"
                placeholder={t('year')}
                defaultValue={fields[k] ?? ''}
                onBlur={(e) => {
                  const f = { ...fields }
                  const v = e.target.value.trim()
                  if (v) f[k] = v
                  else delete f[k]
                  if ((fields[k] ?? '') !== v) saveFields(f)
                }}
              />
            </Row>
          ))}
        </Section>
      )}

      {isPerson && (
        <Section
          title={t('Family')}
          icon="users"
          action={
            <IconButton icon="family-tree" label={t('Family tree')} small onClick={onOpenTree} />
          }
        >
          {famRow(t('Mother'), 'mother', true, 'F')}
          {famRow(t('Father'), 'father', true, 'M')}
          {/* a spouse is assumed to be of the opposite gender; unknown → offer both */}
          {famRow(
            t('Spouse'),
            'spouse',
            false,
            inferredGender === 'F' ? 'M' : inferredGender === 'M' ? 'F' : null
          )}
          {/* A child = a reversed link (child → this person). The relation becomes
              mother/father by this person's gender (father assumed when unknown;
              later ones correct themselves once a gender is set). */}
          <Row label={t('Children')}>
            {childLinks.map((l) => (
              <span className="tag-chip" key={l.id}>
                <a href="#" onClick={(e) => (e.preventDefault(), onOpen(l.from_id))}>
                  {l.from_name}
                </a>
                <button
                  className="tag-x"
                  title={t('Remove')}
                  onClick={async () => {
                    const ref = { id: l.id }
                    pushUndo({
                      label: 'Remove relation',
                      params: { name: l.relation },
                      undo: async () => {
                        ref.id = (await api.addLink(l.from_id, id, l.relation)).id
                      },
                      redo: () => api.deleteLink(ref.id)
                    })
                    await api.deleteLink(l.id)
                    reloadFamily()
                  }}
                >
                  <Icon name="x" size={11} />
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
                const who = await resolvePerson(nm)
                if (who === null || who === id) return
                const rel = inferredGender === 'F' ? 'mother' : 'father'
                // Reversed direction, same guarantee: the child points at this entry.
                const r = await api.addRelation(who, id, rel)
                const ref = { linkId: r.linkId, created: r.created }
                pushUndo({
                  label: 'Add relation',
                  params: { name: rel },
                  undo: () => api.deleteRelation(ref.linkId, ref.created).then(reloadFamily),
                  redo: async () => {
                    const again = await api.addRelation(who, id, rel)
                    ref.linkId = again.linkId
                    ref.created = again.created
                    await reloadFamily()
                  }
                })
                await reloadFamily()
              }}
            >
              <input name="name" list="person-list" placeholder={t('child…')} />
              {dice(null)}
              <button className="mini" type="submit" title={t('Add')}>
                <Icon name="plus" size={12} />
              </button>
            </form>
          </Row>
        </Section>
      )}

      {/* Relations. The old chain-of-rows read as a list of unrelated links; a
          relation is a DIRECTED statement, so each item leads with the direction,
          names the relation quietly and gives the entity the weight. Incoming and
          mentions are the same shape pointing the other way. */}
      <Section
        title={t('Relations')}
        icon="link"
        defaultOpen={entity.outLinks.length + entity.inLinks.length > 0}
      >
        {entity.outLinks.map((l) => (
          <div className="rel-item" key={l.id}>
            <Icon name="arrow-right" size={13} className="rel-dir out" />
            <span className="rel-text">
              <span className="rel-verb">{l.relation}</span>
              <a href="#" onClick={(e) => (e.preventDefault(), onOpen(l.to_id))}>
                {l.to_name}
              </a>
            </span>
            <span className="rel-action">
              <IconButton
                icon="unlink"
                label={t('Remove')}
                small
                danger
                onClick={async () => {
                  const ref = { id: l.id }
                  pushUndo({
                    label: 'Remove relation',
                    params: { name: l.relation },
                    undo: async () => {
                      ref.id = (await api.addLink(id, l.to_id, l.relation)).id
                    },
                    redo: () => api.deleteLink(ref.id)
                  })
                  await api.deleteLink(l.id)
                  reload()
                }}
              />
            </span>
          </div>
        ))}
        {entity.inLinks.map((l) => (
          <div className="rel-item" key={`in-${l.id}`}>
            <Icon name="arrow-left" size={13} className="rel-dir" />
            <span className="rel-text">
              <span className="rel-verb">{l.relation}</span>
              <a href="#" onClick={(e) => (e.preventDefault(), onOpen(l.from_id))}>
                {l.from_name}
              </a>
            </span>
          </div>
        ))}
        {entity.mentions.map((m) => (
          <div className="rel-item" key={`m-${m.id}`}>
            <Icon name="file-text" size={13} className="rel-dir" />
            <span className="rel-text">
              <span className="rel-verb">{t('mentions in content')}</span>
              <a href="#" onClick={(e) => (e.preventDefault(), onOpen(m.id))}>
                {m.name}
              </a>
            </span>
          </div>
        ))}
        <form
          className="tag-add"
          onSubmit={(e) => {
            e.preventDefault()
            addLink()
          }}
        >
          <input
            placeholder={t('relation (rules, member of…)')}
            value={linkRelation}
            onChange={(e) => setLinkRelation(e.target.value)}
          />
          <input
            list="entity-list"
            placeholder={t('target entry')}
            value={linkTarget}
            onChange={(e) => setLinkTarget(e.target.value)}
          />
          <button className="mini" type="submit" title={t('Add')}>
            <Icon name="plus" size={12} />
          </button>
        </form>
      </Section>

      {/* Chronology: where this entity is drawn, and when.
          Needs a host that can actually navigate to a map. */}
      {onLocateFeature && feats.length > 0 && (
        <Section title={t('Map history')} icon="map-pin">
          <div className="chrono-list">
            {feats.map((f) => {
              const s = JSON.parse(f.style || '{}') as { from?: number; to?: number }
              const range =
                s.from === undefined && s.to === undefined
                  ? t('always')
                  : `${s.from ?? '…'} – ${s.to ?? '…'}`
              return (
                /* A place you can GO, not a tag on this entry — it takes you to another map. */
                <button
                  className="mini"
                  key={f.id}
                  title={t('Show on map')}
                  onClick={() => onLocateFeature(f.map_id, f.id)}
                >
                  <Icon name="map" size={12} />
                  {f.map_name} <span className="rail-year">({range})</span>
                </button>
              )
            })}
          </div>
        </Section>
      )}

      {/* The user's OWN structured properties — height, skin colour, real-world
          parallel. "Fields" described the storage, not what the user puts there. */}
      <Section
        title={t('Attributes')}
        icon="file-text"
        defaultOpen={Object.keys(fields).some(
          (k) => !RESERVED_FIELDS.includes(k) && !dims.includes(k)
        )}
      >
        {Object.entries(fields)
          .filter(([k]) => !RESERVED_FIELDS.includes(k) && !dims.includes(k))
          .map(([k, v]) => (
            <Row
              key={k}
              label={k}
              action={
                <IconButton
                  icon="x"
                  label={t('Delete attribute')}
                  small
                  danger
                  onClick={() => {
                    const f = { ...fields }
                    delete f[k]
                    saveFields(f)
                  }}
                />
              }
            >
              <input
                defaultValue={v}
                onBlur={(e) =>
                  e.target.value !== v && saveFields({ ...fields, [k]: e.target.value })
                }
              />
            </Row>
          ))}
        <form
          className="tag-add"
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
          <input name="key" placeholder={t('new attribute')} />
          <input name="value" placeholder={t('value')} />
          <button className="mini" type="submit" title={t('Add')}>
            <Icon name="plus" size={12} />
          </button>
        </form>
        {/* Template: ADDS missing fields, never overwrites; undone with Ctrl+Z.
            The applied name sits in fields['_tpl'] so the select shows it chosen. */}
        <div className="tpl-row">
          {tpls.length > 0 && (
            <Select
              value={
                fields['_tpl'] && tpls.some((x) => x.name === fields['_tpl']) ? fields['_tpl'] : ''
              }
              title={t('Apply a template (adds missing fields only)')}
              onChange={(v) => {
                const x = tpls.find((y) => y.name === v)
                if (x) applyTemplate(x)
              }}
              options={[
                { value: '', label: t('Apply template…') },
                ...tpls.map((x) => ({ value: x.name, label: x.name }))
              ]}
            />
          )}
          {tplDraft === null ? (
            <IconButton
              icon="template"
              label={t('Save this page’s fields as a reusable template')}
              onClick={() => setTplDraft(entity.name)}
            />
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
      </Section>
    </div>
  )

  return (
    <>
      {rail}
      {/* Both lists sit OUTSIDE every section, because every section's forms use them — and they
          moved here with the forms, since every consumer of either is in this file. A datalist is
          invisible and referenced by id, so where it sits in the tree is not a layout question. */}
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
    </>
  )
}
