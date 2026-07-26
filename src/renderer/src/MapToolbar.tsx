import { useT } from './i18n'
import { Tool, TOOLS } from './ToolPanel'

// The floating map toolbar: CREATION tools only. Modifying an existing drawing (edit vertices,
// move, delete) is a contextual action and lives in the feature's right-click menu instead.
// Pure presentation — no Leaflet, no api, no state; MapView owns the active tool.
// Groups are rendered with a divider between them; extending is one entry in GROUPS.
const GROUPS: Tool[][] = [
  ['polygon', 'line', 'marker', 'label'],
  ['scale', 'nav']
]

interface Props {
  active: Tool | null
  onTool: (t: Tool) => void
}

export default function MapToolbar({ active, onTool }: Props): React.JSX.Element {
  const t = useT()
  return (
    <div className="map-toolbar-float">
      {GROUPS.map((group, i) => (
        <div key={i} className="map-toolbar-group">
          {i > 0 && <div className="map-toolbar-sep" />}
          {group.map((key) => {
            const def = TOOLS.find((x) => x.key === key)
            if (!def) return null
            return (
              <button
                key={key}
                className={`tool-fbtn ${active === key ? 'active' : ''}`}
                // Icon-only: the name is the tooltip. Same source as the old panel buttons.
                title={t(def.name)}
                aria-label={t(def.name)}
                aria-pressed={active === key}
                onClick={() => onTool(key)}
              >
                {def.icon}
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}
