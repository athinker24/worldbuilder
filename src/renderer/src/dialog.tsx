import { useEffect, useRef, useState } from 'react'
import { useT } from './i18n'

// In-app confirm/alert — replaces native window.confirm/alert.
// Why: in Electron, keyboard focus can break after consecutive native dialogs (clicking an
// input after a dialog and still not being able to type). This modal stays in the DOM, so
// focus is never lost.
interface Req {
  message: string
  confirm: boolean // true = has a Cancel button too; false = OK only (alert)
  resolve: (ok: boolean) => void
}

// Module-level bridge so non-component modules (entityOps.ts) can call it too.
let notify: ((r: Req) => void) | null = null

export function confirmDialog(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (notify) notify({ message, confirm: true, resolve })
    else resolve(window.confirm(message)) // fall back to the native dialog when no host is mounted
  })
}

export function alertDialog(message: string): Promise<void> {
  return new Promise((resolve) => {
    if (notify) notify({ message, confirm: false, resolve: () => resolve() })
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
          <button ref={okRef} className="mini danger" onClick={() => close(true)}>
            {t('OK')}
          </button>
        </div>
      </div>
    </div>
  )
}
