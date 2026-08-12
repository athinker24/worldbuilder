import { useEffect, useRef, useState } from 'react'
import { useT } from './i18n'

// In-app confirm/alert — replaces native window.confirm/alert.
// Why: in Electron, keyboard focus can break after consecutive native dialogs (clicking an
// input after a dialog and still not being able to type). This modal stays in the DOM, so
// focus is never lost.
interface Req {
  message: string
  confirm: boolean // true = has a Cancel button too; false = OK only (alert)
  danger: boolean // the confirming button is destructive
  resolve: (ok: boolean) => void
}

// Module-level bridge so non-component modules (entityOps.ts) can call it too.
let notify: ((r: Req) => void) | null = null

/**
 * @param danger whether saying yes DESTROYS something. Defaults to true because eight of this
 * app's nine confirmations do (delete an entry, a folder, a map, a note, a template, a government
 * form; discard unsaved changes) — and the one that does not passes `false`. An alert never does:
 * it has one button and nothing to lose, and it was wearing the same red until now, so "are you
 * sure you want to delete this world" and "this entry is not on a map" arrived looking identical.
 */
export function confirmDialog(message: string, danger = true): Promise<boolean> {
  return new Promise((resolve) => {
    if (notify) notify({ message, confirm: true, danger, resolve })
    else resolve(window.confirm(message)) // fall back to the native dialog when no host is mounted
  })
}

export function alertDialog(message: string): Promise<void> {
  return new Promise((resolve) => {
    if (notify) notify({ message, confirm: false, danger: false, resolve: () => resolve() })
    else {
      window.alert(message)
      resolve()
    }
  })
}

export function DialogHost(): React.JSX.Element | null {
  const t = useT()
  const [req, setReq] = useState<Req | null>(null)
  const okRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    notify = setReq
    return () => {
      notify = null
    }
  }, [])

  useEffect(() => {
    if (req) okRef.current?.focus()
  }, [req])

  if (!req) return null

  const close = (ok: boolean): void => {
    req.resolve(ok)
    setReq(null)
  }

  return (
    <div className="dialog-overlay" onMouseDown={() => close(false)}>
      <div
        className="dialog-box"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close(false)
          else if (e.key === 'Enter') close(true)
        }}
      >
        <p className="dialog-msg">{req.message}</p>
        <div className="dialog-actions">
          {req.confirm && (
            <button className="mini" onClick={() => close(false)}>
              {t('Cancel')}
            </button>
          )}
          {/* The one action of this view, so it carries the emphasis — red only when saying yes
              actually destroys something. */}
          <button
            ref={okRef}
            className={req.danger ? 'mini danger' : 'mini primary'}
            onClick={() => close(true)}
          >
            {t('OK')}
          </button>
        </div>
      </div>
    </div>
  )
}
