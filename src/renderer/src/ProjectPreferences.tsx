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
import { useT } from './i18n'

// PROJECT configuration: the systems that define the open world's own structure. All three live
// in the settings table, so they travel inside the .dunya — that is exactly what separates them
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

  const updateModes = (next: MapModes): void => {
    setModes(next)
    saveMapModes(next)
  }

  const updateTpls = (next: EntityTemplate[]): void => {
    setTpls(next)
    saveTemplates(next)
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
        <h2>{t('Project Preferences')}</h2>
      </div>

      <h2>{t('Hierarchy Ranks')}</h2>
      <p className="hint">
        {t(
          'Each government form has its own rank ladder (top to bottom: empire → county, for example). Government forms appear here as tabs as they are written into the "Government form" field on entity pages.'
        )}
      </p>
      <div className="field-row" style={{ marginBottom: 8 }}>
        <span className="field-key">{t('Load preset')}</span>
        <select
          value=""
          title={t('Adds example government forms and ladders (existing ones are kept)')}
          onChange={(e) => {
            const p = HIER_PRESETS.find((x) => x.name === e.target.value)
            e.currentTarget.value = ''
            if (!p) return
            const existing = new Set(hierCfg.govs.map((g) => g.name))
            const additions = p.govs.filter((g) => !existing.has(g.name))
            if (!additions.length) return
            updateHier({ ...hierCfg, govs: [...hierCfg.govs, ...additions] })
            setActiveGov(additions[0].name)
          }}
        >
          <option value="">{t('Add starter ladders…')}</option>
          {HIER_PRESETS.map((p) => (
            <option key={p.name} value={p.name}>
              {t(p.name)}
            </option>
          ))}
        </select>
      </div>
      <div className="hier-tags" style={{ marginBottom: 8 }}>
        {hierCfg.govs.map((g) => (
          <span
            key={g.name}
            className={`tag-chip clickable ${activeGov === g.name ? 'active' : ''}`}
            onClick={() => setActiveGov(g.name)}
          >
            {g.name}
            <button
              className="tag-x"
              title={t('Delete government form')}
              onClick={async (e) => {
                e.stopPropagation()
                if (
                  !(await confirmDialog(
                    t('Delete government form "{name}" and its rank ladder?', { name: g.name })
                  ))
                )
                  return
                const next = { ...hierCfg, govs: hierCfg.govs.filter((x) => x.name !== g.name) }
                updateHier(next)
                if (activeGov === g.name) setActiveGov(next.govs[0]?.name ?? null)
              }}
            >
              ×
            </button>
          </span>
        ))}
        <form
          className="tag-add"
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
          <button className="mini" type="submit">
            +
          </button>
        </form>
      </div>
      {gov && (
        <>
          {gov.tags.map((tag, i) => (
            <div className="field-row" key={tag}>
              <button className="mini" onClick={() => moveTag(i, -1)} disabled={i === 0}>
                ↑
              </button>
              <button
                className="mini"
                onClick={() => moveTag(i, 1)}
                disabled={i === gov.tags.length - 1}
              >
                ↓
              </button>
              <span className="side-label">{tag}</span>
              <button
                className="mini danger"
                onClick={() => updateGovTags(gov.tags.filter((x) => x !== tag))}
              >
                ×
              </button>
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
            <button className="mini" type="submit">
              +
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

      <h2>{t('Map Modes')}</h2>
      <p className="hint">
        {t(
          'Dimensions like religion, language, culture. Each dimension you add appears as a field on entity pages (e.g. "religion: Islam"); the map is painted by that dimension from the Hierarchy panel.'
        )}
      </p>
      <div className="hier-tags">
        {modes.dims.map((d) => (
          <span className="tag-chip" key={d}>
            🎨 {d}
            <button
              className="tag-x"
              onClick={() => updateModes({ ...modes, dims: modes.dims.filter((x) => x !== d) })}
            >
              ×
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
          <button className="mini" type="submit">
            +
          </button>
        </form>
      </div>

      <h2>{t('Entity Templates')}</h2>
      <p className="hint">
        {t(
          'A starting point, never a constraint: pick a template on a new entity and its fields arrive ready. Leave a value empty for a blank field, or fill it in as a default. Everything stays editable afterwards — on the entity and here.'
        )}
      </p>
      <div className="hier-tags">
        {tpls.map((x) => (
          <span
            className={`tag-chip clickable ${activeTpl === x.name ? 'active' : ''}`}
            key={x.name}
            onClick={() => setActiveTpl(x.name)}
          >
            📋 {x.name}
            <button
              className="tag-x"
              title={t('Delete')}
              onClick={async (e) => {
                e.stopPropagation()
                if (!(await confirmDialog(t('Delete template "{name}"?', { name: x.name })))) return
                const next = tpls.filter((y) => y.name !== x.name)
                updateTpls(next)
                if (activeTpl === x.name) setActiveTpl(next[0]?.name ?? null)
              }}
            >
              ×
            </button>
          </span>
        ))}
        <form
          className="tag-add"
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
          <button className="mini" type="submit">
            +
          </button>
        </form>
      </div>
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
              <button
                className="mini danger"
                onClick={() => {
                  const f = { ...tpl.fields }
                  delete f[k]
                  patchTpl({ fields: f })
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
              if (k && !(k in tpl.fields)) {
                patchTpl({ fields: { ...tpl.fields, [k]: (fd.get('value') as string) ?? '' } })
                e.currentTarget.reset()
              }
            }}
          >
            <input name="key" placeholder={t('new field')} />
            <input name="value" placeholder={t('default value (optional)')} />
            <button className="mini" type="submit">
              +
            </button>
          </form>
        </>
      )}
    </div>
  )
}
