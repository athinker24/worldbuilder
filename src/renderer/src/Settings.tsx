import { useEffect, useState } from 'react'
import {
  api,
  getHierConfig,
  getMapModes,
  HierConfig,
  Lang,
  MapModes,
  mergeHierConfig,
  saveHierConfig,
  saveLanguage,
  saveMapModes,
  saveTypes,
  TypeDef
} from './api'
import { confirmDialog } from './dialog'
import { useT } from './i18n'

interface Props {
  types: TypeDef[]
  onChanged: () => void // tip listesi değişti → App yeniden yüklesin
  lang: Lang
  onLangChange: (l: Lang) => void
}

export default function Settings({
  types,
  onChanged,
  lang,
  onLangChange
}: Props): React.JSX.Element {
  const t = useT()
  const [newName, setNewName] = useState('')
  const [hierCfg, setHierCfg] = useState<HierConfig>({ govs: [] })
  const [allTags, setAllTags] = useState<string[]>([])
  const [activeGov, setActiveGov] = useState<string | null>(null)
  const [tagInput, setTagInput] = useState('')
  const [govInput, setGovInput] = useState('')
  const [modes, setModes] = useState<MapModes>({ dims: [], colors: {} })
  const [dimInput, setDimInput] = useState('')
  const [backupMsg, setBackupMsg] = useState('')

  useEffect(() => {
    Promise.all([getHierConfig(), api.hierarchy(), getMapModes()]).then(([cfg, h, m]) => {
      const merged = mergeHierConfig(cfg, h.govs)
      setHierCfg(merged)
      setAllTags(h.tags)
      setActiveGov(merged.govs[0]?.name ?? null)
      setModes(m)
    })
  }, [])

  const updateModes = (next: MapModes): void => {
    setModes(next)
    saveMapModes(next)
  }

  const update = async (next: TypeDef[]): Promise<void> => {
    await saveTypes(next)
    onChanged()
  }

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

  // Hiçbir merdivende olmayan etiketler
  const unassigned = allTags.filter((t) => !hierCfg.govs.some((g) => g.tags.includes(t)))

  return (
    <div className="page">
      <h2>{t('Language')}</h2>
      <div className="field-row">
        <span className="field-key">{t('Interface language')}</span>
        <select
          value={lang}
          onChange={(e) => {
            const next = e.target.value as Lang
            onLangChange(next)
            saveLanguage(next)
          }}
        >
          <option value="en">English</option>
          <option value="tr">Türkçe</option>
        </select>
      </div>

      <h2>{t('Backup')}</h2>
      <p className="hint">
        {t(
          'A dated copy of world.db is made automatically once a day (last 30 days kept). Restoring is manual: with the app closed, copy a file from the backups folder over world.db.'
        )}
      </p>
      <div className="field-row">
        <button
          className="mini"
          onClick={async () => {
            const path = await api.backupNow()
            setBackupMsg(t('Backed up to {path}', { path }))
          }}
        >
          {t('Back up now')}
        </button>
        {backupMsg && <span className="hint">{backupMsg}</span>}
      </div>

      <h2>{t('Entity Types')}</h2>
      <p className="hint">
        {t(
          'Types are completely free: add, rename, delete. Renaming a type updates all entities of that type.'
        )}
      </p>
      {types.map((ty, i) => (
        <div className="field-row" key={i}>
          <input
            type="color"
            value={ty.color}
            onChange={(e) =>
              update(types.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)))
            }
          />
          <input
            defaultValue={ty.name}
            key={ty.name}
            onBlur={async (e) => {
              const name = e.target.value.trim()
              if (!name || name === ty.name) return
              await api.retypeEntities(ty.name, name)
              update(types.map((x, j) => (j === i ? { ...x, name } : x)))
            }}
          />
          <label
            className="hint"
            title={t(
              'Person entities: family/dynasty pickers only suggest these; they cannot be linked to map polygons.'
            )}
          >
            <input
              type="checkbox"
              checked={!!ty.isPerson}
              onChange={(e) =>
                update(types.map((x, j) => (j === i ? { ...x, isPerson: e.target.checked } : x)))
              }
            />{' '}
            {t('Person')}
          </label>
          <button
            className="mini danger"
            onClick={async () => {
              if (
                await confirmDialog(
                  t(
                    'Delete type "{name}" from the list? (Entities are not deleted, they keep their type)',
                    { name: ty.name }
                  )
                )
              )
                update(types.filter((_, j) => j !== i))
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
          const name = newName.trim()
          if (name && !types.some((ty) => ty.name === name)) {
            update([...types, { name, color: '#7bb3ff' }])
            setNewName('')
          }
        }}
      >
        <input
          placeholder={t('new type (state, dynasty, religion…)')}
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <button className="mini" type="submit">
          +
        </button>
      </form>

      <h2>{t('Hierarchy Ranks')}</h2>
      <p className="hint">
        {t(
          'Each government form has its own rank ladder (top to bottom: empire → county, for example). Government forms appear here as tabs as they are written into the "Government form" field on entity pages.'
        )}
      </p>
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
    </div>
  )
}
