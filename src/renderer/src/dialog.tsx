import { useEffect, useRef, useState } from 'react'
import { useT } from './i18n'

// Uygulama-içi confirm/alert — yerli window.confirm/alert yerine.
// Neden: Electron'da art arda yerli diyaloglardan sonra pencere klavye odağı bozulabiliyor
// (diyalogtan sonra input'a tıklansa da yazılamıyor). Bu modal DOM içinde kaldığı için odak kaybolmaz.
interface Req {
  message: string
  confirm: boolean // true = İptal butonu da var; false = yalnız Tamam (alert)
  resolve: (ok: boolean) => void
}

// Bileşen olmayan modüllerden (entityOps.ts) da çağrılabilsin diye modül düzeyinde köprü.
let notify: ((r: Req) => void) | null = null

export function confirmDialog(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (notify) notify({ message, confirm: true, resolve })
    else resolve(window.confirm(message)) // host bağlı değilse yerli diyaloga düş
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
