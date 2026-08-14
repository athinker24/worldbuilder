import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Icon from './icons'

// A dropdown we actually control.
//
// The native <select> accepts our colours but NOT our shape: Chromium draws the
// popup itself, with square corners and its own border, so on a rounded dark UI it
// always read as a foreign object. There is no CSS for that — the only fix is to
// stop using the native popup.
//
// Positioning follows ColorPicker's proven pattern: a fixed-position list plus a
// full-screen overlay to catch the outside click. Absolute positioning would be
// clipped by the scrolling panels these live in (the map inspector, the tool
// popover), which is exactly where most of them sit.
//
// The list is portaled to document.body, not rendered where the trigger sits in the
// tree. `position: fixed` is only fixed to the VIEWPORT while every ancestor is free
// of a transform, filter or similar — CSS gives any of those a side effect of also
// becoming the containing block for its fixed-position descendants. The conquest
// hint bar centers itself with `transform: translateX(-50%)` (map-internals' own
// note on why: an unknown-width element can't be centered with `left` alone), so a
// Select rendered inside it had `pos.left/top` — computed from
// `getBoundingClientRect()`, which IS viewport-relative — applied against that
// bar's box instead, landing the open list far from the trigger that opened it.
// Portaling out from under any such ancestor is the fix that holds regardless of
// which container a Select ends up inside next.

export interface SelectOption {
  value: string
  label: string
  /** The font pickers preview each face in its own typeface. */
  style?: React.CSSProperties
}

interface Props {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  title?: string
  /** Shown when the value matches no option (the "— none —" case). */
  placeholder?: string
  className?: string
  style?: React.CSSProperties
}

export default function Select({
  value,
  options,
  onChange,
  title,
  placeholder,
  className,
  style
}: Props): React.JSX.Element {
  const btn = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null)
  const [active, setActive] = useState(0)

  const current = options.find((o) => o.value === value)

  const openList = (): void => {
    const r = btn.current?.getBoundingClientRect()
    if (!r) return
    // Flip above the trigger when there is not enough room below.
    const h = Math.min(options.length * 30 + 8, 260)
    const below = window.innerHeight - r.bottom
    setPos({
      left: r.left,
      top: below < h && r.top > h ? r.top - h - 4 : r.bottom + 4,
      width: r.width
    })
    setActive(
      Math.max(
        0,
        options.findIndex((o) => o.value === value)
      )
    )
    setOpen(true)
  }

  // Keep the list glued to the trigger if the panel behind it scrolls.
  useEffect(() => {
    if (!open) return
    const close = (): void => setOpen(false)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [open])

  const pick = (v: string): void => {
    setOpen(false)
    onChange(v)
  }

  return (
    <>
      <button
        ref={btn}
        type="button"
        title={title}
        className={className ? `select-trigger ${className}` : 'select-trigger'}
        style={style}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            if (!open) return openList()
            setActive(
              (i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
            )
          } else if (open && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault()
            if (options[active]) pick(options[active].value)
          } else if (e.key === 'Escape') {
            setOpen(false)
          }
        }}
      >
        <span className="select-value" style={current?.style}>
          {current ? current.label : (placeholder ?? '')}
        </span>
        <Icon name="chevron-down" size={13} />
      </button>
      {open &&
        pos &&
        createPortal(
          <>
            <div className="select-backdrop" onMouseDown={() => setOpen(false)} />
            <div
              className="select-list"
              role="listbox"
              style={{ left: pos.left, top: pos.top, minWidth: pos.width }}
            >
              {options.map((o, i) => (
                <button
                  key={o.value}
                  type="button"
                  role="option"
                  aria-selected={o.value === value}
                  className={`select-option ${o.value === value ? 'selected' : ''} ${
                    i === active ? 'active' : ''
                  }`}
                  style={o.style}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(o.value)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </>,
          document.body
        )}
    </>
  )
}
