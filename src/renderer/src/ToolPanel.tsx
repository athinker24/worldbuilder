import ColorPicker from './ColorPicker'
import { useT } from './i18n'

export type Tool = 'polygon' | 'line' | 'marker' | 'edit' | 'drag' | 'remove'

export type LineDash = 'solid' | 'dashed' | 'dotted'

export interface DrawSettings {
  marker: { size: number }
  polygon: { color: string; fillOpacity: number; weight: number; font: string }
  line: { color: string; weight: number; opacity: number; dash: LineDash }
}

export const DEFAULT_DRAW: DrawSettings = {
  marker: { size: 1 },
  polygon: { color: '#7bb3ff', fillOpacity: 0.25, weight: 2, font: 'Cinzel' },
  line: { color: '#b08968', weight: 3, opacity: 0.9, dash: 'solid' }
}

// Çizgi desenini Leaflet dashArray'ine çevir (kalınlığa orantılı; dotted + round cap = nokta)
export const lineDashArray = (dash: LineDash | undefined, weight: number): string =>
  dash === 'dashed' ? `${weight * 3} ${weight * 2}` : dash === 'dotted' ? `0 ${weight * 2.5}` : ''

export const LINE_DASHES: LineDash[] = ['solid', 'dashed', 'dotted']
export const DASH_LABELS: Record<LineDash, string> = {
  solid: 'Solid',
  dashed: 'Dashed',
  dotted: 'Dotted'
}

// Etiket fontları (@fontsource ile gömülü, OFL lisanslı)
export const FONTS = ['Cinzel', 'IM Fell English', 'MedievalSharp', 'Uncial Antiqua', 'system-ui']

const TOOLS: { key: Tool; icon: string; name: string; hint?: string }[] = [
  { key: 'polygon', icon: '⬠', name: 'Polygon' },
  { key: 'line', icon: '〰', name: 'Path', hint: 'Draw roads, routes, borders as lines.' },
  { key: 'marker', icon: '📍', name: 'Location' },
  {
    key: 'edit',
    icon: '✏️',
    name: 'Edit',
    hint: 'Drag the corner points of drawings to change their shape.'
  },
  { key: 'drag', icon: '✋', name: 'Move', hint: 'Drag drawings to move them.' },
  {
    key: 'remove',
    icon: '🗑',
    name: 'Delete',
    hint: 'Clicked drawing is deleted (undo with Ctrl+Z).'
  }
]

interface Props {
  active: Tool | null
  settings: DrawSettings
  onTool: (t: Tool) => void
  onSettings: (s: DrawSettings) => void
}

export default function ToolPanel({
  active,
  settings,
  onTool,
  onSettings
}: Props): React.JSX.Element {
  const t = useT()
  const activeDef = TOOLS.find((tool) => tool.key === active)

  return (
    <div className="tool-panel-inner">
      <div className="tool-btns">
        {TOOLS.map((tool) => (
          <button
            key={tool.key}
            className={`tool-btn ${active === tool.key ? 'active' : ''}`}
            title={t(tool.name)}
            onClick={() => onTool(tool.key)}
          >
            <span className="tool-icon">{tool.icon}</span>
            <span>{t(tool.name)}</span>
          </button>
        ))}
      </div>

      <div className="tool-settings">
        {active === 'polygon' && (
          <>
            <label>{t('Color')}</label>
            <ColorPicker
              value={settings.polygon.color}
              onChange={(color) =>
                onSettings({ ...settings, polygon: { ...settings.polygon, color } })
              }
            />
            <label>
              {t('Fill opacity: {val}', { val: settings.polygon.fillOpacity.toFixed(2) })}
            </label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={settings.polygon.fillOpacity}
              onChange={(e) =>
                onSettings({
                  ...settings,
                  polygon: { ...settings.polygon, fillOpacity: Number(e.target.value) }
                })
              }
            />
            <label>{t('Outline thickness: {val}px', { val: settings.polygon.weight })}</label>
            <input
              type="range"
              min={1}
              max={10}
              step={1}
              value={settings.polygon.weight}
              onChange={(e) =>
                onSettings({
                  ...settings,
                  polygon: { ...settings.polygon, weight: Number(e.target.value) }
                })
              }
            />
            <label>{t('Label font')}</label>
            <select
              value={settings.polygon.font}
              style={{ fontFamily: settings.polygon.font }}
              onChange={(e) =>
                onSettings({ ...settings, polygon: { ...settings.polygon, font: e.target.value } })
              }
            >
              {FONTS.map((f) => (
                <option key={f} value={f} style={{ fontFamily: f }}>
                  {f}
                </option>
              ))}
            </select>
          </>
        )}
        {active === 'line' && (
          <>
            <label>{t('Color')}</label>
            <ColorPicker
              value={settings.line.color}
              onChange={(color) => onSettings({ ...settings, line: { ...settings.line, color } })}
            />
            <label>{t('Thickness: {val}px', { val: settings.line.weight })}</label>
            <input
              type="range"
              min={1}
              max={12}
              step={1}
              value={settings.line.weight}
              onChange={(e) =>
                onSettings({
                  ...settings,
                  line: { ...settings.line, weight: Number(e.target.value) }
                })
              }
            />
            <label>{t('Opacity: {val}', { val: settings.line.opacity.toFixed(2) })}</label>
            <input
              type="range"
              min={0.1}
              max={1}
              step={0.05}
              value={settings.line.opacity}
              onChange={(e) =>
                onSettings({
                  ...settings,
                  line: { ...settings.line, opacity: Number(e.target.value) }
                })
              }
            />
            <label>{t('Line style')}</label>
            <select
              value={settings.line.dash}
              onChange={(e) =>
                onSettings({
                  ...settings,
                  line: { ...settings.line, dash: e.target.value as LineDash }
                })
              }
            >
              {LINE_DASHES.map((d) => (
                <option key={d} value={d}>
                  {t(DASH_LABELS[d])}
                </option>
              ))}
            </select>
          </>
        )}
        {active === 'marker' && (
          <>
            <label>{t('Size: ×{val}', { val: settings.marker.size.toFixed(2) })}</label>
            <input
              type="range"
              min={0.5}
              max={3}
              step={0.25}
              value={settings.marker.size}
              onChange={(e) =>
                onSettings({ ...settings, marker: { size: Number(e.target.value) } })
              }
            />
          </>
        )}
        {activeDef?.hint && <p className="hint">{t(activeDef.hint)}</p>}
        {!active && <p className="hint">{t('Select a tool; its settings appear here.')}</p>}
      </div>
    </div>
  )
}
