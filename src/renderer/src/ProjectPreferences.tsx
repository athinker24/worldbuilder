import { useEffect, useState } from 'react'
import {
  api,
  EntityTemplate,
  getHierConfig,
  HIER_PRESETS,
  getMapModes,
  getTemplates,
  HierConfig,
  MapModes,
  mergeHierConfig,
  saveHierConfig,
  saveMapModes,
  saveTemplates
} from './api'
import { confirmDialog } from './dialog'
import Icon from './icons'
import Select from './Select'
import { useT } from './i18n'
import { logEvent } from './log'
import { IconButton, Section, Tabs } from './ui'

// PROJECT configuration: the systems that define the open world's own structure. All three live
// in the settings table, so they travel inside the .world — that is exactly what separates them
// from Preferences (language/theme), which belong to the application and stay per-machine.
export default function ProjectPreferences(): React.JSX.Element {
  const t = useT()
  const [hierCfg, setHierCfg] = useState<HierConfig>({ govs: [] })
  const [allTags, setAllTags] = useState<string[]>([])
  const [activeGov, setActiveGov] = useState<string | null>(null)
  const [tagInput, setTagInput] = useState('')
  const [govInput, setGovInput] = useState('')
  const [modes, setModes] = useState<MapModes>({ dims: [], colors: {} })
  const [dimInput, setDimInput] = useState('')
  const [tpls, setTpls] = useState<EntityTemplate[]>([])
  const [activeTpl, setActiveTpl] = useState<string | null>(null)
  const [tplInput, setTplInput] = useState('')
  // Which rank is being dragged and which one it is currently over. Session state — an
  // in-progress gesture is not a preference and must not survive the page.
  const [dragTag, setDragTag] = useState<string | null>(null)
  const [overTag, setOverTag] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([getHierConfig(), api.hierarchy(), getMapModes(), getTemplates()]).then(
      ([cfg, h, m, tl]) => {
        const merged = mergeHierConfig(cfg, h.govs)
        setHierCfg(merged)
        setAllTags(h.tags)
        setActiveGov(merged.govs[0]?.name ?? null)
        setModes(m)
        setTpls(tl)
        setActiveTpl(tl[0]?.name ?? null)
      }
    )
  }, [])

  // These two are where the world's STRUCTURE changes — a map-mode dimension, a template — which
  // is the kind of edit that later explains "the map suddenly looks different". Logged by shape,
  // never by content: the dimension names are the user's own vocabulary.
  const updateModes = (next: MapModes): void => {
    setModes(next)
    saveMapModes(next)
    logEvent('INFO', 'settings.changed', { what: 'mapModes', dimensions: next.dims.length })
  }

  const updateTpls = (next: EntityTemplate[]): void => {
    setTpls(next)
    saveTemplates(next)
    logEvent('INFO', 'settings.changed', { what: 'templates', count: next.length })
  }
  const tpl = tpls.find((x) => x.name === activeTpl)
  // Edit the selected template's fields (the whole list is rewritten — the updateModes pattern)
  const patchTpl = (patch: Partial<EntityTemplate>): void =>
    updateTpls(tpls.map((x) => (x.name === activeTpl ? { ...x, ...patch } : x)))

  const updateHier = (next: HierConfig): void => {
    setHierCfg(next)
    saveHierConfig(next)
  }

  const gov = hierCfg.govs.find((g) => g.name === activeGov)

  const updateGovTags = (tags: string[]): void => {
    updateHier({
      ...hierCfg,
      govs: hierCfg.govs.map((g) => (g.name === activeGov ? { ...g, tags } : g))
    })
  }

  const moveTag = (i: number, dir: -1 | 1): void => {
    if (!gov) return
    const j = i + dir
    if (j < 0 || j >= gov.tags.length) return
    const next = [...gov.tags]
    ;[next[i], next[j]] = [next[j], next[i]]
    updateGovTags(next)
  }

  const normalizeTag = (raw: string): string => {
    const t = raw.trim()
    return t && !t.startsWith('#') ? `#${t}` : t
  }

  // Tags that sit on no ladder
  const unassigned = allTags.filter((t) => !hierCfg.govs.some((g) => g.tags.includes(t)))

  return (
    <div className="page">
      <div className="page-head">
        <h2 className="page-title">{t('Project Preferences')}</h2>
      </div>

      <Section title={t('Hierarchy Ranks')}>
        <p className="hint">{t('Each government form has its own ladder, highest rank first.')}</p>
        <div className="field-row" style={{ marginBottom: 8 }}>
          <span className="field-key">{t('Load preset')}</span>
          <Select
            value=""
            title={t('Adds example government forms and ladders (existing ones are kept)')}
            placeholder={t('Add starter ladders…')}
            onChange={(v) => {
              const p = HIER_PRESETS.find((x) => x.name === v)
              if (!p) return
              const existing = new Set(hierCfg.govs.map((g) => g.name))
              const additions = p.govs.filter((g) => !existing.has(g.name))
              if (!additions.length) return
              updateHier({ ...hierCfg, govs: [...hierCfg.govs, ...additions] })
              setActiveGov(additions[0].name)
            }}
            options={HIER_PRESETS.map((p) => ({ value: p.name, label: t(p.name) }))}
          />
        </div>
        {/* Each government form is a whole ladder, and picking one changes which ladder this
            section is editing — a place you go, so a tab strip. As chips they were also carrying
            a delete ×, which put "switch to this" and "destroy this and its ranks" a few pixels
            apart on the same object; the delete now sits beside the ladder it would take. */}
        {hierCfg.govs.length > 0 && (
          <div className="tabs-row">
            <Tabs
              tabs={hierCfg.govs.map((g) => ({ key: g.name, label: g.name }))}
              active={activeGov ?? ''}
              onChange={setActiveGov}
            />
            {gov && (
              <IconButton
                icon="trash"
                label={t('Delete government form')}
                small
                danger
                onClick={async () => {
                  if (
                    !(await confirmDialog(
                      t('Delete government form "{name}" and its rank ladder?', { name: gov.name })
                    ))
                  )
                    return
                  const next = { ...hierCfg, govs: hierCfg.govs.filter((x) => x.name !== gov.name) }
                  updateHier(next)
                  setActiveGov(next.govs[0]?.name ?? null)
                }}
              />
            )}
          </div>
        )}
        {/* Under the strip it feeds, not at the end of the section: down there it would read as
            belonging to the open ladder rather than to the list of ladders. */}
        <form
          className="field-row add"
          onSubmit={(e) => {
            e.preventDefault()
            const name = govInput.trim()
            setGovInput('')
            if (!name || hierCfg.govs.some((g) => g.name === name)) return
            updateHier({ ...hierCfg, govs: [...hierCfg.govs, { name, tags: [] }] })
            setActiveGov(name)
          }}
        >
          <input
            placeholder={t('new government form (feudal, nomadic…)')}
            value={govInput}
            onChange={(e) => setGovInput(e.target.value)}
          />
          <button className="mini" type="submit" title={t('Add')} aria-label={t('Add')}>
            <Icon name="plus" size={12} />
          </button>
        </form>
        {gov && (
          <>
            {/* Drag to reorder — a ladder IS an order, and setting one with two buttons cost a
                click per position per rank: about twenty to lay out eight ranks. The sidebar
                already moves things by dragging them, so this is the same gesture in the one
                other place the app has an ordered list.

                The arrows stay. They are not a fallback nobody uses: dragging is the one
                interaction a keyboard cannot perform at all, and this list had just been made
                reachable by one. Mouse gets the gesture, keyboard keeps the buttons. */}
            {gov.tags.map((tag, i) => (
              <div
                className={`field-row ladder-row ${dragTag === tag ? 'dragging' : ''} ${
                  overTag === tag && dragTag !== tag ? 'over' : ''
                }`}
                key={tag}
                draggable
                onDragStart={() => setDragTag(tag)}
                onDragEnd={() => (setDragTag(null), setOverTag(null))}
                onDragOver={(e) => {
                  e.preventDefault()
                  if (overTag !== tag) setOverTag(tag)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  if (dragTag && dragTag !== tag) {
                    const next = gov.tags.filter((x) => x !== dragTag)
                    next.splice(next.indexOf(tag), 0, dragTag)
                    updateGovTags(next)
                  }
                  setDragTag(null)
                  setOverTag(null)
                }}
              >
                <span className="ladder-grip" aria-hidden>
                  <Icon name="grip" size={13} />
                </span>
                <IconButton
                  icon="chevron-up"
                  label={t('Move up')}
                  small
                  disabled={i === 0}
                  onClick={() => moveTag(i, -1)}
                />
                <IconButton
                  icon="chevron-down"
                  label={t('Move down')}
                  small
                  disabled={i === gov.tags.length - 1}
                  onClick={() => moveTag(i, 1)}
                />
                <span className="side-label">{tag}</span>
                <IconButton
                  icon="x"
                  label={t('Remove')}
                  small
                  danger
                  onClick={() => updateGovTags(gov.tags.filter((x) => x !== tag))}
                />
              </div>
            ))}
            <form
              className="field-row add"
              onSubmit={(e) => {
                e.preventDefault()
                const tag = normalizeTag(tagInput)
                setTagInput('')
                if (tag && !gov.tags.includes(tag)) updateGovTags([...gov.tags, tag])
              }}
            >
              <input
                list="settings-tag-list"
                placeholder={t('add tag to ladder (#county…)')}
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
              />
              <button className="mini" type="submit" title={t('Add')} aria-label={t('Add')}>
                <Icon name="plus" size={12} />
              </button>
            </form>
          </>
        )}

        <datalist id="settings-tag-list">
          {allTags.map((tag) => (
            <option key={tag} value={tag} />
          ))}
        </datalist>
        {unassigned.length > 0 && (
          <p className="hint">{t('Unassigned tags: {list}', { list: unassigned.join(', ') })}</p>
        )}
      </Section>

      <Section title={t('Map Modes')}>
        <p className="hint">
          {t(
            'Religion, language, culture… each becomes a field on entries and a paint mode on the map.'
          )}
        </p>
        <div className="hier-tags">
          {modes.dims.map((d) => (
            <span className="tag-chip" key={d}>
              <Icon name="palette" size={12} /> {d}
              <button
                className="tag-x"
                onClick={() => updateModes({ ...modes, dims: modes.dims.filter((x) => x !== d) })}
              >
                <Icon name="x" size={11} />
              </button>
            </span>
          ))}
          <form
            className="tag-add"
            onSubmit={(e) => {
              e.preventDefault()
              const d = dimInput.trim()
              setDimInput('')
              if (d && !modes.dims.includes(d)) updateModes({ ...modes, dims: [...modes.dims, d] })
            }}
          >
            <input
              placeholder={t('religion, language, culture…')}
              value={dimInput}
              onChange={(e) => setDimInput(e.target.value)}
            />
            <button className="mini" type="submit" title={t('Add')} aria-label={t('Add')}>
              <Icon name="plus" size={12} />
            </button>
          </form>
        </div>
      </Section>

      <Section title={t('Entry Templates')}>
        <p className="hint">
          {t('The fields a new entry starts with. Everything stays editable afterwards.')}
        </p>
        {/* Same as the ladders above: picking a template changes what the fields below
            belong to, which is navigation. The delete moves next to the fields it would take. */}
        {tpls.length > 0 && (
          <div className="tabs-row">
            <Tabs
              tabs={tpls.map((x) => ({ key: x.name, label: x.name, icon: 'template' as const }))}
              active={activeTpl ?? ''}
              onChange={setActiveTpl}
            />
            {tpl && (
              <IconButton
                icon="trash"
                label={t('Delete')}
                small
                danger
                onClick={async () => {
                  if (!(await confirmDialog(t('Delete template "{name}"?', { name: tpl.name }))))
                    return
                  const next = tpls.filter((y) => y.name !== tpl.name)
                  updateTpls(next)
                  setActiveTpl(next[0]?.name ?? null)
                }}
              />
            )}
          </div>
        )}
        <form
          className="field-row add"
          onSubmit={(e) => {
            e.preventDefault()
            const n = tplInput.trim()
            setTplInput('')
            if (!n || tpls.some((x) => x.name === n)) return
            updateTpls([...tpls, { name: n, fields: {} }])
            setActiveTpl(n)
          }}
        >
          <input
            placeholder={t('new template (city, dynasty…)')}
            value={tplInput}
            onChange={(e) => setTplInput(e.target.value)}
          />
          <button className="mini" type="submit" title={t('Add')} aria-label={t('Add')}>
            <Icon name="plus" size={12} />
          </button>
        </form>
        {tpl && (
          <>
            {Object.entries(tpl.fields).map(([k, v]) => (
              <div className="field-row" key={k}>
                <span className="field-key">{k}</span>
                <input
                  defaultValue={v}
                  placeholder={t('default value (optional)')}
                  onBlur={(e) =>
                    e.target.value !== v &&
                    patchTpl({ fields: { ...tpl.fields, [k]: e.target.value } })
                  }
                />
                {/* The same control the rank ladder above uses for the same job — this row
                    was a .mini danger while that one was an IconButton, in one screen. */}
                <IconButton
                  icon="x"
                  label={t('Remove')}
                  small
                  danger
                  onClick={() => {
                    const f = { ...tpl.fields }
                    delete f[k]
                    patchTpl({ fields: f })
                  }}
                />
              </div>
            ))}
            <form
              className="field-row add"
              onSubmit={(e) => {
                e.preventDefault()
                const fd = new FormData(e.currentTarget)
                const k = (fd.get('key') as string).trim()
                if (k && !(k in tpl.fields)) {
                  patchTpl({ fields: { ...tpl.fields, [k]: (fd.get('value') as string) ?? '' } })
                  e.currentTarget.reset()
                }
              }}
            >
              <input name="key" placeholder={t('new field')} />
              <input name="value" placeholder={t('default value (optional)')} />
              <button className="mini" type="submit" title={t('Add')} aria-label={t('Add')}>
                <Icon name="plus" size={12} />
              </button>
            </form>
          </>
        )}
      </Section>
    </div>
  )
}
