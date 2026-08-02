import { useSyncExternalStore } from 'react'
import { getHistory, goTo, subscribeHistory } from './undo'
import { useT } from './i18n'
import Icon from './icons'

// Photoshop's History palette: the session's edits in order, with a click to jump to any of them.
//
// It reads the undo stacks through a store subscription rather than props, because those stacks are
// module state that anything in the app may push to — the map, an article, the sidebar — and there
// is no component above all of them to hold the list. `useSyncExternalStore` is React's own answer
// to exactly that and needs no dependency.
//
// It lives in the MAP TOOLBAR, next to Layers and Boards. It was an Overview tab first and that was
// wrong: the edits it lists are mostly drawings, so needing to leave the map to step back through
// them is the one place it must not be.

interface Props {
  /** What the app does after a step — refresh the sidebar and reload the map. */
  onApplied: () => void
}

export default function History({ onApplied }: Props): React.JSX.Element {
  const t = useT()
  const { steps, applied } = useSyncExternalStore(subscribeHistory, getHistory)

  const jump = async (target: number): Promise<void> => {
    if (target === applied) return
    await goTo(target)
    onApplied()
  }

  return (
    <div className="hist-list">
      {/* The state before anything was done. Photoshop keeps the same row, and without it there
          is no way to click your way back past the first edit. */}
      <button className={`hist-row${applied === 0 ? ' current' : ''}`} onClick={() => void jump(0)}>
        <span className="hist-mark">
          {applied === 0 ? <Icon name="chevron-right" size={14} /> : null}
        </span>
        <span className="hist-text">{t('Opened')}</span>
      </button>
      {steps.map((s, i) => {
        const isCurrent = applied === i + 1
        return (
          <button
            // The index IS the identity: two identical edits are two different points in time,
            // and a key built from the label would collapse them onto one row.
            key={i}
            className={`hist-row${isCurrent ? ' current' : ''}${i >= applied ? ' undone' : ''}`}
            onClick={() => void jump(i + 1)}
            title={t('Go to this step')}
          >
            <span className="hist-mark">
              {isCurrent ? <Icon name="chevron-right" size={14} /> : null}
            </span>
            <span className="hist-text">{t(s.label, s.params)}</span>
          </button>
        )
      })}
    </div>
  )
}
