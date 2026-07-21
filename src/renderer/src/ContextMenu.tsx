export interface MenuItem {
  label: string
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

  return (
    <div
      className="ctx-overlay"
      onMouseDown={onClose}
      onContextMenu={(e) => (e.preventDefault(), onClose())}
    >
      <div
        className="ctx-menu"
        style={{ left: x, top: y }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {menu.items.map((it, i) => (
          <div
            key={i}
            className={`ctx-item ${it.danger ? 'danger' : ''}`}
            onClick={() => {
              it.onClick()
              onClose()
            }}
          >
            {it.label}
          </div>
        ))}
      </div>
    </div>
  )
}
