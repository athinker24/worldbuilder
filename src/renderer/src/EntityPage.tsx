import { useCallback, useEffect, useState } from 'react'
import { marked } from 'marked'
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
  compact?: boolean // harita yan panelinde dar görünüm
  onOpen: (id: number) => void
  onChanged: () => void
  onDeleted: () => void
  onLocateFeature?: (mapId: number, featureId: number) => void // harita geçmişinden çizime git
}

// [[Madde Adı]] → tıklanabilir wiki linki (markdown'dan önce dönüştürülür)
// '<' önce kaçırılır: nota yazılan ham HTML (<img onerror=...> gibi) script olarak
// çalışamaz — paylaşılan bir world.db'den gelen içerik de güvenli kalır.
function renderMarkdown(content: string): string {
  const withWiki = content
    .replace(/</g, '&lt;')
    .replace(
      /\[\[([^\]]+)\]\]/g,
      (_, name: string) => `<a href="#" data-wiki="${name.replace(/"/g, '&quot;')}">${name}</a>`
    )
  return marked.parse(withWiki, { async: false })
}

// Sekmeli not bölgesi: fields['notlar'] JSON'unda durur (şema değişikliği yok, fields['üst'] deseni)
interface NoteTab {
  title: string
  content: string
  collapsed: boolean
}

function getNoteTabs(fieldsJson: string): NoteTab[] {
  try {
    const f = JSON.parse(fieldsJson || '{}') as Record<string, string>
    const n = JSON.parse(f['notlar'] ?? '[]') as NoteTab[]
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
  // eş türetmek için tüm bağlar (ortak çocuğu olanlar birbirinin eşi sayılır)
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
  // "Yönettiği" türetmek için tüm maddeler fields'lı (bu kişiyi yönetici yazan devlet/bölgeler)
  const [hierEntities, setHierEntities] = useState<Hierarchy['entities']>([])
  const [üstName, setÜstName] = useState('')
  const [üstYear, setÜstYear] = useState('')
  // Yönetici geçmişi (hanedan sistemi): yıl bazlı, kişi maddesine bağlı
  const [rulerName, setRulerName] = useState('')
  const [rulerYear, setRulerYear] = useState('')
  // Yöneten hane geçmişi (yıl bazlı, üst/yönetici ile aynı desen)
  const [houseName, setHouseName] = useState('')
  const [houseYear, setHouseYear] = useState('')
  const [treeOpen, setTreeOpen] = useState(false)
  // Alt bölüm sekmesi: sayfa kalabalığını önlemek için aynı anda tek bölüm görünür
  const [section, setSection] = useState<'hier' | 'dynasty' | 'links'>('hier')
  // Not bölgesi: sağ tık menüsü + düzenleme modundaki sekmelerin indeksleri (yerel, kalıcı değil)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [noteEdit, setNoteEdit] = useState<Set<number>>(new Set())
  // Harita geçmişi (OHM chronology deseni): maddenin çizimleri yıl aralıklarıyla
  const [feats, setFeats] = useState<
    { id: number; map_id: number; style: string; map_name: string }[]
  >([])

  // Madde şablonları (settings 'templates') — uygula + bu sayfayı şablon olarak kaydet
  const [tpls, setTpls] = useState<EntityTemplate[]>([])
  const [tplDraft, setTplDraft] = useState<string | null>(null) // "şablon olarak kaydet" adı formu

  const reload = useCallback(async () => {
    setEntity(await api.getEntity(id))
  }, [id])

  // Etiket/yönetim/boyut datalist'lerini tazele (ilk açılışta ve her fields kaydında)
  const refreshHier = useCallback(async () => {
    const [h, modes, cfg] = await Promise.all([api.hierarchy(), getMapModes(), getHierConfig()])
    setAllTags(h.tags)
    // Ayarlar'dan eklenmiş ama henüz hiçbir maddede kullanılmamış biçimler de önerilsin
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

  // 📋 Şablon uygula: eksik alanları EKLER, mevcut değerlerin üstüne YAZMAZ (dayatma değil,
  // başlangıç noktası). Tip yalnız madde tipsizken atanır. saveFields yolundan geçer → undo bedava.
  // '_tpl' = uygulanan şablonun adı (salt bilgi — seçili göstermek için, kendisi de silinebilir/
  // değiştirilebilir); RESERVED_FIELDS'te olduğu için serbest alan listesinde görünmez.
  const applyTemplate = (tpl: EntityTemplate): void => {
    const f = { ...fields }
    for (const [k, v] of Object.entries(tpl.fields)) if (!(k in f)) f[k] = v
    f['_tpl'] = tpl.name
    const patch: Parameters<typeof api.updateEntity>[1] = { fields: JSON.stringify(f) }
    if (tpl.type && !entity.type) patch.type = tpl.type
    save(patch)
  }

  // 📋 Şablon olarak kaydet: bu maddenin SERBEST alanlarını (kendi bölümü olanlar hariç —
  // sancak/üst/notlar/yönetici/hane/renk/kişi alanları + harita modu boyutları) ve tipini alır.
  const saveAsTemplate = async (name: string): Promise<void> => {
    const f: Record<string, string> = {}
    for (const [k, v] of Object.entries(fields))
      if (!RESERVED_FIELDS.includes(k) && !dims.includes(k)) f[k] = v
    const next = tpls.filter((x) => x.name !== name) // aynı adlı şablonu güncelle
    const list = [...next, { name, type: entity.type || undefined, fields: f }]
    setTpls(list)
    await saveTemplates(list)
    setTplDraft(null)
  }

  // De-jure üst geçmişi: fields'daki "üst" anahtarında JSON olarak durur
  const parents = getParents(entity.fields)
  const saveParents = (next: ParentRec[]): Promise<void> => {
    const f = { ...fields }
    if (next.length) f['üst'] = JSON.stringify(next)
    else delete f['üst']
    return saveFields(f)
  }

  // Not sekmeleri: saveFields yolundan geçtiği için undo bedavaya gelir
  const notes = getNoteTabs(entity.fields)
  const saveNoteTabs = (next: NoteTab[]): Promise<void> => {
    const f = { ...fields }
    if (next.length) f['notlar'] = JSON.stringify(next)
    else delete f['notlar']
    return saveFields(f)
  }

  const toggleNoteEdit = (i: number): void =>
    setNoteEdit((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })

  // Sancak: fields['sancak'] = assets/ göreli yolu; eski dosya assets'te kalır (zemin görseliyle aynı)
  const pickBanner = async (): Promise<void> => {
    const path = await api.pickImage()
    if (path) await saveFields({ ...fields, sancak: path })
  }

  // Yönetici geçmişi: fields['yönetici'] = [{from, id}] (üst zinciriyle aynı desen)
  const rulers = getYearRecs(entity.fields, 'yönetici')
  const saveRulers = (next: ParentRec[]): Promise<void> => {
    const f = { ...fields }
    if (next.length) f['yönetici'] = JSON.stringify(next)
    else delete f['yönetici']
    return saveFields(f)
  }

  // Yöneten hane geçmişi: fields['hane'] = [{from, id}] — hane ayrı bir madde (kişi değil)
  const houses = getYearRecs(entity.fields, 'hane')
  const saveHouses = (next: ParentRec[]): Promise<void> => {
    const f = { ...fields }
    if (next.length) f['hane'] = JSON.stringify(next)
    else delete f['hane']
    return saveFields(f)
  }

  // Hane girişi: ada göre herhangi bir maddeyi bul; yoksa (tipsiz) oluştur — kişi değil
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

  // Kişi tipleri: Ayarlar'da "Kişi" işaretlenmiş tipler — aile/hanedan alanları yer/devlet gibi
  // maddelerle karışmasın diye ismi eşleşse bile başka tipteki bir maddeye bağlanmaz.
  const personTypeNames = types.filter((ty) => ty.isPerson).map((ty) => ty.name)
  const personEntities = allEntities.filter((en) => personTypeNames.includes(en.type))
  const isPerson = personTypeNames.includes(entity.type)

  // Kişide "Yönettiği": Ruler alanının tersi — bu kişiyi yönetici (fields.yönetici) olarak
  // yazan devlet/bölge maddeleri, türetilir (ayrı veri yok). Ruler yer/devlette girilir.
  const rules = isPerson
    ? hierEntities.flatMap((e) =>
        getYearRecs(e.fields, 'yönetici')
          .filter((r) => r.id === id)
          .map((r) => ({ eid: e.id, name: e.name, from: r.from }))
      )
    : []

  // Ada göre kişi maddesi bul; yoksa oluştur (yönetici/aile girişleri kişi maddesi olarak yaşar).
  // Hiçbir tip "Kişi" işaretli değilse ilk kullanımda kendiliğinden bir kişi tipi kurulur —
  // hanedan bölümüne yazılan her isim elle ayar gerekmeden kişi maddesi olur.
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

  const childLinks = entity.inLinks.filter((l) => l.relation === 'anne' || l.relation === 'baba')

  // Aile bağı düzenlemesinden sonra global grafiği de tazele (cinsiyet çıkarımı canlı güncellensin)
  const reloadFamily = async (): Promise<void> => {
    await reload()
    setAllLinks(await api.listLinks())
    await refreshHier()
  }

  // Kişinin çıkarılan cinsiyeti: açık fields.cinsiyet > anne/baba rolü > eşin tersi (inferGenders).
  // Cinsiyet kutusu açık değer yoksa bunu gösterir ("otomatik"); çocuk-ekleme ilişkisi de bunu kullanır.
  const inferredGender = inferGenders(hierEntities, allLinks).get(id)
  const genderValue =
    fields['cinsiyet'] ?? (inferredGender === 'M' ? 'erkek' : inferredGender === 'F' ? 'kadın' : '')
  const genderIsAuto = !fields['cinsiyet'] && !!inferredGender

  // Ortak çocuğu olanlar birbirinin eşi sayılır (çocuk tek yandan yapıştırılsa bile
  // iki ebeveyn de eş olarak türetilir) — türetilmiş chip, silinmez (linkId yok)
  const coParents = (): { other: number; name: string }[] => {
    const myChildIds = new Set(childLinks.map((l) => l.from_id))
    const others = new Set<number>()
    for (const l of allLinks) {
      if ((l.relation === 'anne' || l.relation === 'baba') && myChildIds.has(l.from_id))
        if (l.to_id !== id) others.add(l.to_id)
    }
    return [...others].map((o) => ({
      other: o,
      name: allEntities.find((e) => e.id === o)?.name ?? '?'
    }))
  }

  // Aile bağları: 'anne'/'baba'/'eş' ilişki adlarıyla links tablosunda durur; ağaç bunlardan türetilir
  const familyLinks = (rel: string): { linkId?: number; other: number; name: string }[] => {
    const explicit = [
      ...entity.outLinks
        .filter((l) => l.relation === rel)
        .map((l) => ({ linkId: l.id, other: l.to_id, name: l.to_name })),
      // eş bağı simetrik: karşı taraftan kurulmuşsa da göster
      ...(rel === 'eş'
        ? entity.inLinks
            .filter((l) => l.relation === rel)
            .map((l) => ({ linkId: l.id, other: l.from_id, name: l.from_name }))
        : [])
    ]
    if (rel !== 'eş') return explicit
    // ortak-çocuk eşlerini ekle (zaten açık bağı olanları tekrarlama)
    const have = new Set(explicit.map((e) => e.other))
    return [...explicit, ...coParents().filter((c) => !have.has(c.other))]
  }

  // Tek aile satırı: mevcut bağlar chip olarak + (tekil dolu değilse) ekleme formu
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

  // Hiyerarşi etiketleri: fields'daki "hiyerarşi" anahtarında "#etiket, #etiket" olarak durur
  const tags = (fields['hiyerarşi'] ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)

  const saveTags = (next: string[]): Promise<void> => {
    const f = { ...fields }
    if (next.length) f['hiyerarşi'] = next.join(', ')
    else delete f['hiyerarşi']
    return saveFields(f)
  }

  const addTag = (): void => {
    let t = tagInput.trim()
    if (!t) return
    if (!t.startsWith('#')) t = '#' + t
    setTagInput('')
    if (!tags.includes(t)) saveTags([...tags, t])
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
      {fields['sancak'] ? (
        <div className="banner">
          <img src={assetUrl(fields['sancak'])} alt="" />
          <span className="banner-actions">
            <button className="mini" title={t('Replace banner')} onClick={pickBanner}>
              🖼
            </button>
            <button
              className="mini danger"
              title={t('Remove banner')}
              onClick={() => {
                const f = { ...fields }
                delete f['sancak']
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
          style={{ borderLeftColor: types.find((ty) => ty.name === entity.type)?.color ?? '#555' }}
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
          .filter(([k]) => !RESERVED_FIELDS.includes(k) && !dims.includes(k)) // kendi bölümlerinde gösterilir
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
        {/* Şablon: eksik alanları ekler (mevcutların üstüne yazmaz), Ctrl+Z ile geri alınır.
            Uygulanan şablonun adı fields['_tpl']'de — select seçili göstersin diye (salt bilgi). */}
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
          onBlur={(e) => e.target.value !== entity.content && save({ content: e.target.value })}
          placeholder={t('Markdown content… link to other entities with [[Entity Name]].')}
        />
      ) : (
        <div
          className="content-view"
          onClick={handleWikiClick}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(entity.content) }}
        />
      )}

      {/* Not bölgesi: sağ tık → yeni sekme; her sekme aç/kapa + dikey yeniden boyutlanabilir */}
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
                  setNoteEdit((prev) => new Set(prev).add(notes.length)) // yeni sekme düzenlemede açılır
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
                  onBlur={(e) => {
                    if (e.target.value !== n.content)
                      saveNoteTabs(
                        notes.map((x, j) => (j === i ? { ...x, content: e.target.value } : x))
                      )
                  }}
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
                defaultValue={fields['yönetim'] ?? ''}
                key={`gov-${entity.id}-${entity.updated_at}`}
                onBlur={(e) => {
                  const v = e.target.value.trim()
                  if (v === (fields['yönetim'] ?? '')) return
                  const f = { ...fields }
                  if (v) f['yönetim'] = v
                  else delete f['yönetim']
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
                    const target = allEntities.find((en) => en.name === üstName.trim())
                    if (!target || target.id === id) return
                    const from = üstYear === '' ? null : Number(üstYear)
                    const next = parents.filter((p) => p.from !== from)
                    next.push({ from, id: target.id })
                    next.sort((a, b) => (a.from ?? -Infinity) - (b.from ?? -Infinity))
                    setÜstName('')
                    setÜstYear('')
                    saveParents(next)
                  }}
                >
                  <input
                    list="entity-list"
                    placeholder={t('parent entity')}
                    value={üstName}
                    onChange={(e) => setÜstName(e.target.value)}
                  />
                  <input
                    type="number"
                    placeholder={t('year (blank=from start)')}
                    style={{ width: 110 }}
                    value={üstYear}
                    onChange={(e) => setÜstYear(e.target.value)}
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
              // Kişide Ruler girilmez; yönettiği devlet/bölgeler türetilerek listelenir
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
              // Yöneten hane: kişi olmayan maddede yönetici yanında; hane ayrı bir madde
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
                      if (e.target.value) f['cinsiyet'] = e.target.value
                      else delete f['cinsiyet']
                      saveFields(f)
                    }}
                  >
                    <option value="">—</option>
                    <option value="erkek">♂ {t('Male')}</option>
                    <option value="kadın">♀ {t('Female')}</option>
                  </select>
                  {genderIsAuto && <span className="hint">{t('(auto from relations)')}</span>}
                </div>
                <div className="tag-row">
                  <span className="field-key">{t('Life')}</span>
                  {(['doğum', 'ölüm'] as const).map((k) => (
                    <input
                      key={`${k}${fields[k] ?? ''}`}
                      type="number"
                      style={{ width: 110 }}
                      placeholder={k === 'doğum' ? t('birth year') : t('death year')}
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
                {famRow(t('Mother'), 'anne', true)}
                {famRow(t('Father'), 'baba', true)}
                {famRow(t('Spouse'), 'eş', false)}
                {/* Çocuk = ters yönlü bağ (çocuk → bu kişi). İlişki bu kişinin cinsiyetine göre
                    anne/baba olur (belirsizse baba varsayılır, cinsiyet atanınca sonrakiler düzelir). */}
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
                        // İlişki bu kişinin (çıkarılan) cinsiyetine göre: kadın→anne, değilse baba
                        const rel = inferredGender === 'F' ? 'anne' : 'baba'
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

        {/* Üst/Yönetici/Aile/İlişkiler formları hangi sekme açık olursa olsun bu listeyi kullanır */}
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
