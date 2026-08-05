import { useEffect, useMemo, useState } from 'react'
import { api, EntityRow, FolderDef, folderColor, MapRow } from './api'
import { useT } from './i18n'

interface Item {
  key: string
  label: string
  badge: string
  color: string
  sub?: string // context snippet of a content match (full-text search)
  open: () => void
}

interface Props {
  entities: EntityRow[]
  maps: MapRow[]
  folders: FolderDef[]
  onOpenEntity: (id: number) => void
  onOpenMap: (id: number) => void
  onClose: () => void
  onChanged: () => void
}

export default function Palette({
  entities,
  maps,
  folders,
  onOpenEntity,
  onOpenMap,
  onClose,
  onChanged
}: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  const t = useT()

  // Full text: content/note hits (light debounce before the IPC call)
  const [contentHits, setContentHits] = useState<
    { id: number; folder: string | null; name: string; snippet: string }[]
  >([])
  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) {
      setContentHits([])
      return
    }
    const timer = setTimeout(() => api.searchContent(q).then(setContentHits), 150)
    return () => clearTimeout(timer)
  }, [query])

  const items = useMemo<Item[]>(() => {
    const q = query.toLocaleLowerCase('tr')
    const ms: Item[] = maps
      .filter((m) => m.name.toLocaleLowerCase('tr').includes(q))
      .map((m) => ({
        key: `m${m.id}`,
        label: m.name,
        badge: t('map'),
        color: 'var(--muted)',
        open: () => onOpenMap(m.id)
      }))
    const es: Item[] = entities
      .filter((e) => e.name.toLocaleLowerCase('tr').includes(q))
      .map((e) => ({
        key: `e${e.id}`,
        label: e.name,
        badge: folders.find((f) => f.id === e.folder)?.name || t('entry'),
        color: folderColor(folders, e.folder ?? null),
        open: () => onOpenEntity(e.id)
      }))
    // Content matches below name matches, with their context snippet
    const cs: Item[] = contentHits.map((h) => ({
      key: `c${h.id}`,
      label: h.name,
      badge: t('in content'),
      color: folderColor(folders, h.folder),
      sub: h.snippet,
      open: () => onOpenEntity(h.id)
    }))
    const list = [...ms, ...es].slice(0, 12).concat(cs.slice(0, 8))
    const exact =
      query.trim() &&
      [...maps, ...entities].some((x) => x.name.toLocaleLowerCase('tr') === q.trim())
    if (query.trim() && !exact) {
      list.push({
        key: 'new',
        label: t('Create new entry named "{query}"', { query: query.trim() }),
        badge: '',
        color: 'transparent',
        open: async () => {
          const { id } = await api.createEntity({ name: query.trim() })
          onChanged()
          onOpenEntity(id)
        }
      })
    }
    return list
  }, [query, entities, maps, folders, contentHits, onOpenEntity, onOpenMap, onChanged, t])

  const pick = (i: Item): void => {
    i.open()
    onClose()
  }

  return (
    <div className="palette-overlay" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          placeholder={t('Search entry or map…')}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setSel(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setSel(Math.min(sel + 1, items.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setSel(Math.max(sel - 1, 0))
            } else if (e.key === 'Enter' && items[sel]) {
              pick(items[sel])
            }
          }}
        />
        <div className="palette-list">
          {items.map((it, i) => (
            <div
              key={it.key}
              className={`palette-item ${i === sel ? 'selected' : ''}`}
              onClick={() => pick(it)}
              onMouseEnter={() => setSel(i)}
            >
              <span className="dot" style={{ background: it.color }} />
              <span className="palette-label">
                {it.label}
                {it.sub && <span className="palette-sub">{it.sub}</span>}
              </span>
              <span className="palette-badge">{it.badge}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
