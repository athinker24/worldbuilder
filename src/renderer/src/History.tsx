import { useEffect, useRef, useSyncExternalStore } from 'react'
import { getHistory, goTo, subscribeHistory } from './undo'
import { alertDialog } from './dialog'
import { useT } from './i18n'
import Icon from './icons'

// History panel: the session's edits in order, with a click to jump to any of them.
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

  // The current state stays visible; the list grows downward and scrolls itself. Without
  // this the newest edit — the one you almost always want — walks off the bottom while you sit at
  // the top, which is what made the panel feel like it just got longer and longer.
  const here = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    here.current?.scrollIntoView({ block: 'nearest' })
  }, [applied, steps.length])

  const jump = async (target: number): Promise<void> => {
    if (target === applied) return
    // goTo stops at the first step that FAILS; the stacks stay intact, but the world is not where
    // the click asked for. Without saying so the panel just seemed to ignore the click. It reports
    // the reason rather than the distance, because falling short is also what happens when the
    // stacks change underneath an ordinary jump — that is not a fault and must not raise a dialog.
    const { failed } = await goTo(target)
    onApplied()
    if (failed) void alertDialog(t('Stopped here — the next step could not be applied.'))
  }

  return (
    <div className="hist-list">
      {/* The state before anything was done. Without this row there is no way to click your way
          back past the first edit. */}
      <button
        ref={applied === 0 ? here : null}
        className={`hist-row${applied === 0 ? ' current' : ''}`}
        onClick={() => void jump(0)}
      >
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
            ref={isCurrent ? here : null}
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
