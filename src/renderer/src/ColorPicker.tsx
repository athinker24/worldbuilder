import { useRef, useState } from 'react'
import { getRecentColors, pushRecentColor } from './api'
import { useT } from './i18n'

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [n >> 16, (n >> 8) & 255, n & 255]
}

function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('')
}

// h: 0-360, s/v: 0-1
function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const f = (n: number): number => {
    const k = (n + h / 60) % 6
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1))
  }
  return [f(5) * 255, f(3) * 255, f(1) * 255]
}

function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  r /= 255
  g /= 255
  b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d) {
    if (max === r) h = 60 * (((g - b) / d) % 6)
    else if (max === g) h = 60 * ((b - r) / d + 2)
    else h = 60 * ((r - g) / d + 4)
  }
  if (h < 0) h += 360
  return { h, s: max ? d / max : 0, v: max }
}

// Presets: six MUTUALLY DISTINCT tones (crimson / blue / green / gold / purple / turquoise).
// Not a theme palette but a starter set that stays readable side by side on a map — hence
// fixed hex, NOT tokens (map content must look the same in both themes, see CLAUDE.md).
// The app's own drawing defaults (pin #c0603a, polygon #7bb3ff) are deliberately in the set.
const PRESETS = ['#c0603a', '#7bb3ff', '#5f9e5f', '#d9a441', '#8e6bbf', '#4fb3a5']

interface Props {
  value: string // hex, e.g. #7bb3ff
  onChange: (hex: string) => void
  /** Sizing for triggers that are not a standalone control (the folder chip in the tree). */
  className?: string
  /** The trigger shows no text, so without this it has no accessible name. */
  title?: string
}

/** Swatch: clicking opens a classic color picker (gradient square + hue bar + hex + RGB). */
export default function ColorPicker({
  value,
  onChange,
  className,
  title
}: Props): React.JSX.Element {
  const t = useT()
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const swatchRef = useRef<HTMLButtonElement>(null)
  // The last hex we emitted — re-derive HSV only when a genuinely different color arrives
  // from outside (HSV lives in separate state so hue survives grey/black tones)
  const [lastEmit, setLastEmit] = useState(value.toLowerCase())
  const [hsv, setHsv] = useState(() => {
    const [r, g, b] = hexToRgb(value) ?? [128, 128, 128]
    return rgbToHsv(r, g, b)
  })
  const [hexText, setHexText] = useState(value)
  const [prevValue, setPrevValue] = useState(value)
  if (prevValue !== value) {
    setPrevValue(value)
    setHexText(value)
    if (value.toLowerCase() !== lastEmit) {
      const rgb = hexToRgb(value)
      if (rgb) setHsv(rgbToHsv(...rgb))
    }
  }

  const [r, g, b] = hexToRgb(value) ?? [128, 128, 128]

  const emit = (next: { h: number; s: number; v: number }): void => {
    setHsv(next)
    const hex = rgbToHex(...hsvToRgb(next.h, next.s, next.v))
    setLastEmit(hex)
    onChange(hex)
  }

  const setChannel = (i: number, val: number): void => {
    const rgb: [number, number, number] = [r, g, b]
    rgb[i] = Math.max(0, Math.min(255, val))
    const hex = rgbToHex(...rgb)
    setLastEmit(hex)
    setHsv(rgbToHsv(...rgb))
    onChange(hex)
  }

  // Drive press-and-drag from one place: map every mousemove to a ratio inside the element
  const drag = (
    e: React.MouseEvent,
    apply: (fx: number, fy: number) => void // fx/fy: ratios in 0-1
  ): void => {
    e.preventDefault()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const onAt = (ev: MouseEvent): void =>
      apply(
        Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width)),
        Math.max(0, Math.min(1, (ev.clientY - rect.top) / rect.height))
      )
    onAt(e.nativeEvent)
    const onUp = (): void => {
      window.removeEventListener('mousemove', onAt)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onAt)
    window.addEventListener('mouseup', onUp)
  }

  // Recent colors: recording happens on popup CLOSE — dragging emits every frame, and
  // writing those intermediate colors would fill the strip with noise.
  const [recent, setRecent] = useState<string[]>([])
  const open = (): void => {
    const rect = swatchRef.current!.getBoundingClientRect()
    setPos({
      x: Math.min(rect.left, window.innerWidth - 250),
      y: Math.min(rect.bottom + 4, window.innerHeight - 320)
    })
    getRecentColors().then(setRecent)
  }
  const close = (): void => {
    setPos(null)
    void pushRecentColor(value).then(setRecent)
  }
  // Picking from a strip: same path as hex input (HSV re-derived, hue survives greys)
  const applyHex = (hex: string): void => {
    const rgb = hexToRgb(hex)
    if (!rgb) return
    setLastEmit(hex.toLowerCase())
    setHsv(rgbToHsv(...rgb))
    setHexText(hex)
    onChange(hex)
  }

  const hueColor = rgbToHex(...hsvToRgb(hsv.h, 1, 1))

  return (
    <>
      <button
        ref={swatchRef}
        type="button"
        className={className ? `cp-trigger ${className}` : 'cp-trigger'}
        title={title}
        style={{ background: value }}
        onClick={open}
      />
      {pos && (
        <div className="color-popup-overlay" onMouseDown={close}>
          <div
            className="color-popup"
            style={{ left: pos.x, top: pos.y }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="cp-main">
              <div
                className="cp-sv"
                style={{ backgroundColor: hueColor }}
                onMouseDown={(e) => drag(e, (fx, fy) => emit({ ...hsv, s: fx, v: 1 - fy }))}
              >
                <span
                  className="cp-sv-cursor"
                  style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }}
                />
              </div>
              <div
                className="cp-hue"
                onMouseDown={(e) => drag(e, (_fx, fy) => emit({ ...hsv, h: fy * 360 }))}
              >
                <span className="cp-hue-cursor" style={{ top: `${(hsv.h / 360) * 100}%` }} />
              </div>
            </div>
            <div className="cp-head">
              <span className="cp-swatch" style={{ background: value }} />
              <input
                className="cp-hex"
                value={hexText}
                onChange={(e) => {
                  setHexText(e.target.value)
                  const rgb = hexToRgb(e.target.value)
                  if (rgb) {
                    const hex = e.target.value.startsWith('#')
                      ? e.target.value
                      : `#${e.target.value}`
                    setLastEmit(hex.toLowerCase())
                    setHsv(rgbToHsv(...rgb))
                    onChange(hex)
                  }
                }}
                placeholder="#7bb3ff"
                spellCheck={false}
              />
            </div>
            {/* The two strips are told apart by their labels; they used to differ in shape too,
                which was one distinction too many once every chip took the control radius. */}
            <div className="cp-strip-label">{t('Presets')}</div>
            <div className="cp-recent">
              {PRESETS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`cp-recent-sw${c === value.toLowerCase() ? ' active' : ''}`}
                  style={{ background: c }}
                  title={c}
                  onClick={() => applyHex(c)}
                />
              ))}
            </div>
            {recent.length > 0 && (
              <>
                <div className="cp-strip-label">{t('Recent')}</div>
                <div className="cp-recent">
                  {recent.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className="cp-recent-sw"
                      style={{ background: c }}
                      title={c}
                      onClick={() => applyHex(c)}
                    />
                  ))}
                </div>
              </>
            )}
            {(['R', 'G', 'B'] as const).map((ch, i) => (
              <div className="cp-row" key={ch}>
                <span className="cp-label">{ch}</span>
                <input
                  type="number"
                  min={0}
                  max={255}
                  value={Math.round([r, g, b][i])}
                  onChange={(e) => setChannel(i, Number(e.target.value))}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  )
}
