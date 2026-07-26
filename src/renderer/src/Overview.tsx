import { FolderDef } from './api'
import Atlas from './Atlas'
import Chronology from './Chronology'
import Diplomacy from './Diplomacy'
import { useT } from './i18n'

// The project-wide workspace: views that answer "what does my world look like as a whole?"
// rather than "what is this one article?". They used to be three separate sidebar entries.
// Adding another (Statistics…) is one entry in TABS plus a branch below.
export type OverviewTab = 'atlas' | 'chronology' | 'relations'

const TABS: { key: OverviewTab; label: string }[] = [
  { key: 'atlas', label: '📊 Atlas' },
  { key: 'chronology', label: '📜 Chronology' },
  // "Relations" is this view's user-facing name; the component, its props and the link data
  // model are unchanged (it was called Diplomacy).
  { key: 'relations', label: '🕸 Relations' }
]

interface Props {
  tab: OverviewTab
  onTab: (tab: OverviewTab) => void
  folders: FolderDef[]
  onOpenEntity: (id: number) => void
  onLocateFeature: (mapId: number, featureId: number) => void
}

export default function Overview({
  tab,
  onTab,
  folders,
  onOpenEntity,
  onLocateFeature
}: Props): React.JSX.Element {
  const t = useT()
  // A FRAGMENT, not a wrapper .page: each child renders its own .page, and nesting one inside
  // another would double the padding and hand the scroll to the wrong element. The head is a
  // sibling, so the active page keeps scrolling under a fixed tab bar.
  return (
    <>
      <div className="overview-head">
        <div className="page-head">
          <h2>{t('Overview')}</h2>
        </div>
        {/* Same chip idiom as the entity page's section tabs — no new component, no new styles. */}
        <div className="hier-tabs">
          {TABS.map((x) => (
            <span
              key={x.key}
              className={`tag-chip clickable ${tab === x.key ? 'active' : ''}`}
              onClick={() => onTab(x.key)}
            >
              {t(x.label)}
            </span>
          ))}
        </div>
      </div>
      {tab === 'atlas' && <Atlas onOpenEntity={onOpenEntity} />}
      {tab === 'chronology' && (
        <Chronology onOpenEntity={onOpenEntity} onLocateFeature={onLocateFeature} />
      )}
      {tab === 'relations' && <Diplomacy folders={folders} onOpenEntity={onOpenEntity} />}
    </>
  )
}
