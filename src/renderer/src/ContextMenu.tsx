import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import Icon, { IconName } from './icons'
import { useT } from './i18n'

/** Above this many rows a menu grows a filter field. See `filtered` below. */
const FILTER_AT = 10

export interface MenuItem {
  label: string
  /** Menu items carried their icon inside the label as an emoji, which made the
      glyph part of the translation key and left the labels un-alignable. */
  icon?: IconName
  /** The keyboard shortcut for this exact command, right-aligned and dim.
      ONLY where it is true: a hint is a promise that the key does this, from here. */
  hint?: string
  danger?: boolean
  onClick: () => void
}

/** A rule between two groups. A menu built with `push` cannot know if it is the last thing in
    its group, so leading, trailing and doubled rules are dropped at render instead. */
export type MenuEntry = MenuItem | 'sep'

export interface MenuState {
  x: number
  y: number
  /** What was right-clicked. A menu over a map says which of the overlapping borders it caught. */
  header?: { name: string; color?: string; note?: string }
  /** One row of colours acting directly on the subject — the menu doing something, not listing it. */
  swatches?: { colors: string[]; onPick: (hex: string) => void }
  items: MenuEntry[]
}

interface Props {
  menu: MenuState
  onClose: () => void
}

export default function ContextMenu({ menu, onClose }: Props): React.JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const t = useT()

  /* Clamped against the MEASURED box. The estimate this replaces (a fixed 190px wide, 32px per
     item) could not survive a header, a swatch row or a rule, and was already wrong for a long
     label — a menu that runs off the bottom of the screen loses its last item, which is usually
     Delete. A layout effect, so the correction happens before the paint rather than as a jump. */
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const r = el.getBoundingClientRect()
    el.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - r.width - 8))}px`
    el.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - r.height - 8))}px`
  }, [menu])

  /* A menu is the one thing in an interface that has to answer the keyboard, and this one could
     not be reached by it at all: the items were divs. They are buttons now, the first takes focus
     when the menu opens, ↑/↓ walk the list and Escape closes it — none of which is a feature, it
     is what a menu IS. (The CSS has carried a .ctx-item:focus-visible rule the whole time, which
     could never fire.)
     `.ctx-item`, not `button`: the swatch row is buttons too, and stepping through eight colours
     one arrow-press at a time is not walking the menu. They keep their place in the tab order. */
  const rows = (): HTMLButtonElement[] => [
    ...(box.current?.querySelectorAll<HTMLButtonElement>('.ctx-item') ?? [])
  ]
  useEffect(() => {
    // The field first when there is one: past a certain length you are looking for a name, and
    // the answer to that is typing it, not arrowing past forty rows.
    const el = box.current
    ;(
      el?.querySelector<HTMLInputElement>('.ctx-filter') ??
      el?.querySelector<HTMLButtonElement>('.ctx-item')
    )?.focus()
  }, [])

  const walk = (e: React.KeyboardEvent, dir: 1 | -1): void => {
    e.preventDefault()
    const items = rows()
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    // Wraps: a menu is a short cycle, and falling off the end of one is only ever annoying.
    // From the filter field `at` is -1, so ↓ lands on the first row and ↑ on the last.
    items[(at + dir + items.length) % items.length]?.focus()
  }

  /* Long menus filter themselves. The map tree's "move under…" menu is one row PER MAP, so it is
     a picker wearing a menu's clothes — twenty maps make twenty rows and the useful answer is the
     one you can name. A submenu was the obvious fix and is the wrong one: every guideline says a
     flyout off a context menu closes the moment the pointer strays off the parent row.
     The threshold lives here rather than at the call sites, because the menus that can grow are
     not the ones anybody remembers to mark. */
  const [q, setQ] = useState('')
  const filtered = menu.items.length > FILTER_AT
  const hit = (it: MenuEntry): boolean =>
    it !== 'sep' && it.label.toLowerCase().includes(q.trim().toLowerCase())

  // Rules are dropped while filtering: they separate groups, and a filtered list has none.
  // Otherwise: drop a rule that has nothing on one side of it — see MenuEntry.
  const entries = q.trim()
    ? menu.items.filter(hit)
    : menu.items.filter(
        (it, i, all) =>
          it !== 'sep' ||
          (i > 0 &&
            i < all.length - 1 &&
            all[i - 1] !== 'sep' &&
            all.slice(i + 1).some((x) => x !== 'sep'))
      )

  return (
    <div
      className="ctx-overlay"
      onMouseDown={onClose}
      onContextMenu={(e) => (e.preventDefault(), onClose())}
    >
      <div
        ref={box}
        className="ctx-menu"
        style={{ left: menu.x, top: menu.y }}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
          else if (e.key === 'ArrowDown') walk(e, 1)
          else if (e.key === 'ArrowUp') walk(e, -1)
        }}
      >
        {menu.header && (
          <div className="ctx-head">
            {menu.header.color && (
              <span className="ctx-swatch" style={{ background: menu.header.color }} />
            )}
            <span className="ctx-head-name">{menu.header.name}</span>
            {menu.header.note && <span className="ctx-head-note">{menu.header.note}</span>}
          </div>
        )}
        {filtered && (
          <input
            className="ctx-filter"
            value={q}
            placeholder={t('Filter')}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              // Enter takes the first row that survived, which is the whole point of typing.
              if (e.key === 'Enter') {
                e.preventDefault()
                rows()[0]?.click()
              }
            }}
          />
        )}
        {menu.swatches && menu.swatches.colors.length > 0 && (
          <div className="ctx-colors">
            {menu.swatches.colors.map((c) => (
              <button
                key={c}
                className="ctx-color"
                style={{ background: c }}
                title={c}
                onClick={() => {
                  menu.swatches?.onPick(c)
                  onClose()
                }}
              />
            ))}
          </div>
        )}
        {entries.map((it, i) =>
          it === 'sep' ? (
            <div key={i} className="ctx-sep" />
          ) : (
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
              {it.hint && <kbd className="ctx-hint">{it.hint}</kbd>}
            </button>
          )
        )}
      </div>
    </div>
  )
}
