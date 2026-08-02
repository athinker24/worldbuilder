import { FolderDef } from './api'
import Atlas from './Atlas'
import Chronology from './Chronology'
import Diplomacy from './Diplomacy'
import History from './History'
import { useT } from './i18n'
import { Tabs } from './ui'

// The project-wide workspace: views that answer "what does my world look like as a whole?"
// rather than "what is this one article?". They used to be three separate sidebar entries.
// Adding another (Statistics…) is one entry in TABS plus a branch below.
export type OverviewTab = 'atlas' | 'chronology' | 'relations' | 'history'

const TABS: { key: OverviewTab; label: string }[] = [
  { key: 'atlas', label: 'Atlas' },
  { key: 'chronology', label: 'Chronology' },
  // "Relations" is this view's user-facing name; the component, its props and the link data
  // model are unchanged (it was called Diplomacy).
  { key: 'relations', label: 'Relations' },
  // Last on purpose: it is where you go when something went wrong, not part of reading the world.
  { key: 'history', label: 'History' }
]

interface Props {
  tab: OverviewTab
  onTab: (tab: OverviewTab) => void
  folders: FolderDef[]
  onOpenEntity: (id: number) => void
  onLocateFeature: (mapId: number, featureId: number) => void
  /** What the app does after an undo step — see App's afterUndo. */
  onUndone: () => void
}

export default function Overview({
  tab,
  onTab,
  folders,
  onOpenEntity,
  onLocateFeature,
  onUndone
}: Props): React.JSX.Element {
  const t = useT()
  // A FRAGMENT, not a wrapper .page: each child renders its own .page, and nesting one inside
  // another would double the padding and hand the scroll to the wrong element. The head is a
  // sibling, so the active page keeps scrolling under a fixed tab bar.
  return (
    <>
      <div className="overview-head">
        <div className="page-head">
          <h2 className="page-title">{t('Overview')}</h2>
        </div>
        {/* Real tabs, not chips. A chip is DATA; these are navigation, and rendering
            them identically was the main reason nothing in the app distinguished a
            tag from a section switch. */}
        <Tabs tabs={TABS.map((x) => ({ ...x, label: t(x.label) }))} active={tab} onChange={onTab} />
      </div>
      {tab === 'atlas' && <Atlas onOpenEntity={onOpenEntity} />}
      {tab === 'chronology' && (
        <Chronology onOpenEntity={onOpenEntity} onLocateFeature={onLocateFeature} />
      )}
      {tab === 'relations' && <Diplomacy folders={folders} onOpenEntity={onOpenEntity} />}
      {tab === 'history' && <History onApplied={onUndone} />}
    </>
  )
}
