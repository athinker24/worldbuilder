import { useEffect, useRef } from 'react'
import Icon, { IconName } from './icons'

export interface MenuItem {
  label: string
  /** Menu items carried their icon inside the label as an emoji, which made the
      glyph part of the translation key and left the labels un-alignable. */
  icon?: IconName
  danger?: boolean
  onClick: () => void
}

export interface MenuState {
  x: number
  y: number
  items: MenuItem[]
}

interface Props {
  menu: MenuState
  onClose: () => void
}

export default function ContextMenu({ menu, onClose }: Props): React.JSX.Element {
  // Clamp overflow past the screen edge
  const x = Math.min(menu.x, window.innerWidth - 190)
  const y = Math.min(menu.y, window.innerHeight - menu.items.length * 32 - 16)
  const box = useRef<HTMLDivElement>(null)

  /* A menu is the one thing in an interface that has to answer the keyboard, and this one could
     not be reached by it at all: the items were divs. They are buttons now, the first takes focus
     when the menu opens, ↑/↓ walk the list and Escape closes it — none of which is a feature, it
     is what a menu IS. (The CSS has carried a .ctx-item:focus-visible rule the whole time, which
     could never fire.) */
  useEffect(() => {
    box.current?.querySelector('button')?.focus()
  }, [])

  const walk = (e: React.KeyboardEvent, dir: 1 | -1): void => {
    e.preventDefault()
    const items = [...(box.current?.querySelectorAll('button') ?? [])]
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    // Wraps: a menu is a short cycle, and falling off the end of one is only ever annoying.
    items[(at + dir + items.length) % items.length]?.focus()
  }

  return (
    <div
      className="ctx-overlay"
      onMouseDown={onClose}
      onContextMenu={(e) => (e.preventDefault(), onClose())}
    >
      <div
        ref={box}
        className="ctx-menu"
        style={{ left: x, top: y }}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
          else if (e.key === 'ArrowDown') walk(e, 1)
          else if (e.key === 'ArrowUp') walk(e, -1)
        }}
      >
        {menu.items.map((it, i) => (
          <button
            key={i}
            className={`ctx-item ${it.danger ? 'danger' : ''}`}
            onClick={() => {
              it.onClick()
              onClose()
            }}
          >
            {it.icon && <Icon name={it.icon} size={14} />}
            <span>{it.label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
