import { useEffect, useState } from 'react'
import { PinImage } from './api'
import ColorPicker from './ColorPicker'
import { ImageStrip } from './pinIcons'
import { useT } from './i18n'

export type Tool =
  'polygon' | 'line' | 'marker' | 'label' | 'scale' | 'nav' | 'edit' | 'drag' | 'remove'

// Harita ölçeği (MapView'daki settings 'mapScales' kaydının şekli)
export interface MapScale {
  perUnit: number
  unit: string
}

// Seyahat modu (settings 'travelModes', global): hız = harita biriminde/gün
export interface TravelMode {
  name: string
  speed: number
}

// Navigasyon rotası (MapView'da hesaplanır, panelde gösterilir)
export interface NavLeg {
  fid: number // -1 = yol dışı
  name: string | null
  px: number
}
export interface NavRoute {
  totalPx: number
  offRoadPx: number
  legs: NavLeg[]
  pts: number[][]
}

export type LineDash = 'solid' | 'dashed' | 'dotted'
// Yol yön oku: yok / sonda (varış noktası — sefer/göç yönü)
export type LineArrow = 'none' | 'end'

export interface DrawSettings {
  // img: özel pin görseli (assets/ göreli yolu); yoksa düz renkli rozet
  marker: {
    size: number
    color: string
    img?: string
    imgFree?: boolean
    imgAR?: number
  }
  // fillImg: dolgu görseli (assets/ göreli yolu) — poligon SVG pattern ile döşenir
  polygon: {
    color: string
    fillOpacity: number
    weight: number
    font: string
    fillImg?: string
    fillImgAR?: number
  }
  line: {
    color: string
    weight: number
    opacity: number
    dash: LineDash
    arrow: LineArrow
    curviness: number // 0-100; render-only eğrilik (LegendKeeper path tool deseni)
  }
  // Serbest metin etiketi (LegendKeeper "Labels" + Wonderdraft curved text)
  label: {
    text: string
    color: string
    font: string
    size: number
    angle: number
    curve: number // -100..100; 0 = düz (SVG textPath yayı)
  }
}

export const DEFAULT_DRAW: DrawSettings = {
  marker: { size: 1, color: '#c0603a' },
  polygon: { color: '#7bb3ff', fillOpacity: 0.25, weight: 2, font: 'Cinzel' },
  line: { color: '#b08968', weight: 3, opacity: 0.9, dash: 'solid', arrow: 'none', curviness: 0 },
  label: { text: '', color: '#ffffff', font: 'Cinzel', size: 1, angle: 0, curve: 0 }
}

export const LINE_ARROWS: LineArrow[] = ['none', 'end']
export const ARROW_LABELS: Record<LineArrow, string> = {
  none: 'No arrow',
  end: 'Arrow at end'
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

// Mesafe gösterimi (MapView'daki fmtDist ile aynı sözleşme — orası modül-özel)
const fmtNav = (v: number): string =>
  v >= 100 ? Math.round(v).toLocaleString() : v >= 10 ? v.toFixed(1) : v.toFixed(2)

// Etiket fontları (@fontsource ile gömülü, OFL lisanslı)
export const FONTS = ['Cinzel', 'IM Fell English', 'MedievalSharp', 'Uncial Antiqua', 'system-ui']

const TOOLS: { key: Tool; icon: string; name: string; hint?: string }[] = [
  { key: 'polygon', icon: '⬠', name: 'Polygon' },
  { key: 'line', icon: '〰', name: 'Path', hint: 'Draw roads, routes, borders as lines.' },
  { key: 'marker', icon: '📍', name: 'Location' },
  {
    key: 'label',
    icon: '🏷',
    name: 'Label',
    hint: 'Free text on the map — name seas, mountain ranges, regions.'
  },
  {
    key: 'scale',
    icon: '📏',
    name: 'Scale',
    hint: 'Set the map scale; measure distance and area without drawing.'
  },
  {
    key: 'nav',
    icon: '🧭',
    name: 'Navigate',
    hint: 'Pick two pins; the route follows your drawn paths.'
  },
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
  // 📏 Ölçek aracı (durum MapView'da yaşar; panel yalnız gösterir/tetikler)
  scale: MapScale | null
  mapWidthPx: number | null // zemin görselinin piksel genişliği (Wonderdraft yöntemi); görsel yoksa null
  measuring: 'dist' | 'area' | null
  onCalibrate: () => void
  onMeasure: (k: 'dist' | 'area') => void
  onScaleSave: (perUnit: number, unit: string) => void
  onScaleClear: () => void
  // 🧭 Navigasyon aracı (oturum durumu MapView'da; panel gösterir/tetikler)
  navStep: 'a' | 'b' | 'result' | null
  navResult: { aName: string; bName: string; route: NavRoute | null } | null
  navBlocked: boolean // kademe/boya modu açık → pinler render edilmiyor, tıklanamaz
  travelModes: TravelMode[]
  travelModeIdx: number
  onNavStart: () => void
  onNavEnd: () => void
  onTravelModes: (list: TravelMode[]) => void
  onTravelModeIdx: (i: number) => void
  // 📍 Özel pin görselleri (kütüphane MapView'da; panel gösterir/tetikler)
  pinImages: PinImage[]
  onUploadPinImage: (onPicked: (path: string, ar: number) => void) => void
  onRemovePinImage: (path: string) => void
}

export default function ToolPanel({
  active,
  settings,
  onTool,
  onSettings,
  scale,
  mapWidthPx,
  measuring,
  onCalibrate,
  onMeasure,
  onScaleSave,
  onScaleClear,
  navStep,
  navResult,
  navBlocked,
  travelModes,
  travelModeIdx,
  onNavStart,
  onNavEnd,
  onTravelModes,
  onTravelModeIdx,
  pinImages,
  onUploadPinImage,
  onRemovePinImage
}: Props): React.JSX.Element {
  const t = useT()
  const activeDef = TOOLS.find((tool) => tool.key === active)
  // Birim iki yöntemin ortak girdisi; kayıtlı ölçek değişince (ör. kalibrasyonla) senkronlanır
  const [unit, setUnit] = useState(scale?.unit ?? 'km')
  useEffect(() => {
    if (scale?.unit) setUnit(scale.unit)
  }, [scale?.unit])
  const commitUnit = (): void => {
    const u = unit.trim() || 'km'
    setUnit(u)
    if (scale && u !== scale.unit) onScaleSave(scale.perUnit, u)
  }

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
            <label>{t('Fill image (click again to remove)')}</label>
            <ImageStrip
              img={settings.polygon.fillImg}
              images={pinImages}
              onImg={(fillImg, fillImgAR) =>
                onSettings({
                  ...settings,
                  polygon:
                    settings.polygon.fillImg === fillImg
                      ? { ...settings.polygon, fillImg: undefined, fillImgAR: undefined }
                      : { ...settings.polygon, fillImg, fillImgAR }
                })
              }
              onUpload={() =>
                onUploadPinImage((fillImg, fillImgAR) =>
                  onSettings({ ...settings, polygon: { ...settings.polygon, fillImg, fillImgAR } })
                )
              }
              onRemoveImg={onRemovePinImage}
            />
            {settings.polygon.fillImg && (
              <button
                className="mini"
                onClick={() =>
                  onSettings({
                    ...settings,
                    polygon: { ...settings.polygon, fillImg: undefined, fillImgAR: undefined }
                  })
                }
              >
                {t('Remove fill image')}
              </button>
            )}
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
            <label>{t('Curviness: {val}', { val: settings.line.curviness })}</label>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={settings.line.curviness}
              onChange={(e) =>
                onSettings({
                  ...settings,
                  line: { ...settings.line, curviness: Number(e.target.value) }
                })
              }
            />
            <p className="hint">
              {t('Curve appears after drawing; the live preview stays straight.')}
            </p>
            <label>{t('Direction arrow')}</label>
            <select
              value={settings.line.arrow}
              onChange={(e) =>
                onSettings({
                  ...settings,
                  line: { ...settings.line, arrow: e.target.value as LineArrow }
                })
              }
            >
              {LINE_ARROWS.map((a) => (
                <option key={a} value={a}>
                  {t(ARROW_LABELS[a])}
                </option>
              ))}
            </select>
          </>
        )}
        {active === 'marker' && (
          <>
            {/* Serbest modda rozet yok → rengin bir etkisi olmaz, kontrolü gösterme */}
            {!(settings.marker.img && settings.marker.imgFree) && (
              <>
                <label>{t('Color')}</label>
                <ColorPicker
                  value={settings.marker.color}
                  onChange={(color) =>
                    onSettings({ ...settings, marker: { ...settings.marker, color } })
                  }
                />
              </>
            )}
            <label>{t('Pin image (click again to remove)')}</label>
            <ImageStrip
              img={settings.marker.img}
              images={pinImages}
              onImg={(img, imgAR) =>
                onSettings({
                  ...settings,
                  marker:
                    settings.marker.img === img
                      ? { ...settings.marker, img: undefined, imgAR: undefined }
                      : { ...settings.marker, img, imgAR }
                })
              }
              onUpload={() =>
                onUploadPinImage((img, imgAR) =>
                  onSettings({ ...settings, marker: { ...settings.marker, img, imgAR } })
                )
              }
              onRemoveImg={onRemovePinImage}
            />
            {settings.marker.img && (
              <>
                <label>{t('Image style')}</label>
                <div className="measure-btns">
                  <button
                    className={`mini ${!settings.marker.imgFree ? 'active' : ''}`}
                    onClick={() =>
                      onSettings({ ...settings, marker: { ...settings.marker, imgFree: false } })
                    }
                  >
                    {t('Badge')}
                  </button>
                  <button
                    className={`mini ${settings.marker.imgFree ? 'active' : ''}`}
                    onClick={() =>
                      onSettings({ ...settings, marker: { ...settings.marker, imgFree: true } })
                    }
                  >
                    {t('Free')}
                  </button>
                </div>
              </>
            )}
            <label>{t('Size: ×{val}', { val: settings.marker.size.toFixed(2) })}</label>
            <input
              type="range"
              min={0.5}
              max={3}
              step={0.25}
              value={settings.marker.size}
              onChange={(e) =>
                onSettings({
                  ...settings,
                  marker: { ...settings.marker, size: Number(e.target.value) }
                })
              }
            />
          </>
        )}
        {active === 'label' && (
          <>
            <label>{t('Text')}</label>
            <input
              value={settings.label.text}
              placeholder={t('sea, mountain range…')}
              onChange={(e) =>
                onSettings({ ...settings, label: { ...settings.label, text: e.target.value } })
              }
            />
            <label>{t('Color')}</label>
            <ColorPicker
              value={settings.label.color}
              onChange={(color) => onSettings({ ...settings, label: { ...settings.label, color } })}
            />
            <label>{t('Label font')}</label>
            <select
              value={settings.label.font}
              style={{ fontFamily: settings.label.font }}
              onChange={(e) =>
                onSettings({ ...settings, label: { ...settings.label, font: e.target.value } })
              }
            >
              {FONTS.map((f) => (
                <option key={f} value={f} style={{ fontFamily: f }}>
                  {f}
                </option>
              ))}
            </select>
            <label>{t('Size: ×{val}', { val: settings.label.size.toFixed(2) })}</label>
            <input
              type="range"
              min={0.5}
              max={10}
              step={0.25}
              value={settings.label.size}
              onChange={(e) =>
                onSettings({
                  ...settings,
                  label: { ...settings.label, size: Number(e.target.value) }
                })
              }
            />
            <label>{t('Angle: {val}°', { val: settings.label.angle })}</label>
            <input
              type="range"
              min={-90}
              max={90}
              step={5}
              value={settings.label.angle}
              onChange={(e) =>
                onSettings({
                  ...settings,
                  label: { ...settings.label, angle: Number(e.target.value) }
                })
              }
            />
            <label>{t('Curve: {val}', { val: settings.label.curve })}</label>
            <input
              type="range"
              min={-100}
              max={100}
              step={5}
              value={settings.label.curve}
              onChange={(e) =>
                onSettings({
                  ...settings,
                  label: { ...settings.label, curve: Number(e.target.value) }
                })
              }
            />
            <p className="hint">{t('Gentle curves read best; sharp ones crowd the letters.')}</p>
          </>
        )}
        {active === 'scale' && (
          <>
            <label>{t('Unit')}</label>
            <input
              value={unit}
              placeholder={t('km, miles, leagues…')}
              onChange={(e) => setUnit(e.target.value)}
              onBlur={commitUnit}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
            {/* Yöntem A (Wonderdraft): haritanın tüm genişliği = N birim */}
            <label>{t('Map width ({unit})', { unit: unit.trim() || 'km' })}</label>
            {mapWidthPx ? (
              <input
                type="number"
                step="any"
                min={0}
                key={`w-${scale?.perUnit ?? 0}-${mapWidthPx}`}
                defaultValue={scale ? +(mapWidthPx * scale.perUnit).toFixed(1) : ''}
                placeholder={t('e.g. 3000')}
                onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                onBlur={(e) => {
                  const v = Number(e.target.value)
                  if (v > 0) onScaleSave(v / mapWidthPx, unit.trim() || 'km')
                }}
              />
            ) : (
              <p className="hint">{t('No base image — measure a known distance instead.')}</p>
            )}
            {/* Yöntem B: haritada bilinen mesafeyi ölç */}
            <button className="mini" onClick={onCalibrate}>
              📏 {t('Measure known distance…')}
            </button>
            {scale && (
              <p className="hint">
                1 px = {+scale.perUnit.toPrecision(3)} {scale.unit}{' '}
                <button className="mini" onClick={onScaleClear}>
                  {t('Remove scale')}
                </button>
              </p>
            )}
            <label>{t('Measure (not saved)')}</label>
            <div className="measure-btns">
              <button
                className={`mini ${measuring === 'dist' ? 'active' : ''}`}
                onClick={() => onMeasure('dist')}
              >
                📏 {t('Distance')}
              </button>
              <button
                className={`mini ${measuring === 'area' ? 'active' : ''}`}
                onClick={() => onMeasure('area')}
              >
                📐 {t('Area')}
              </button>
            </div>
            <p className="hint">
              {t('Click to add points; Esc to finish. Measurements are not saved.')}
            </p>
          </>
        )}
        {active === 'nav' &&
          (navBlocked ? (
            <p className="hint">
              {t('Navigation needs the default map view (turn off the rank/paint mode).')}
            </p>
          ) : (
            <>
              <label>{t('Travel modes')}</label>
              {travelModes.map((m, i) => (
                <div key={i} className="nav-mode-row">
                  <input
                    type="radio"
                    name="travel-mode"
                    checked={travelModeIdx === i}
                    onChange={() => onTravelModeIdx(i)}
                  />
                  <span className="nav-mode-name">{m.name}</span>
                  <span className="nav-mode-speed">
                    {m.speed} {scale?.unit ?? 'px'}/{t('day')}
                  </span>
                  <button
                    className="mini"
                    title={t('Delete')}
                    onClick={() => onTravelModes(travelModes.filter((_, j) => j !== i))}
                  >
                    ×
                  </button>
                </div>
              ))}
              <form
                className="nav-mode-add"
                onSubmit={(e) => {
                  e.preventDefault()
                  const fd = new FormData(e.currentTarget)
                  const name = String(fd.get('name') ?? '').trim()
                  const speed = Number(fd.get('speed'))
                  if (!name || !(speed > 0)) return
                  onTravelModes([...travelModes, { name, speed }])
                  e.currentTarget.reset()
                }}
              >
                <input name="name" placeholder={t('on foot')} />
                <input name="speed" type="number" step="any" min={0} placeholder="30" />
                <button className="mini" type="submit">
                  {t('Add')}
                </button>
              </form>
              <button
                className={`mini ${navStep && navStep !== 'result' ? 'active' : ''}`}
                onClick={navStep ? onNavEnd : onNavStart}
              >
                🧭 {navStep ? t('Clear') : t('Pick two pins')}
              </button>
              {navResult &&
                (() => {
                  const r = navResult.route
                  if (!r)
                    return (
                      <p className="hint">
                        {t('No route — make sure the paths meet at a shared point.')}
                      </p>
                    )
                  const k = scale?.perUnit ?? 1
                  const unit = scale?.unit ?? 'px'
                  const mode = travelModes[travelModeIdx]
                  const dist = r.totalPx * k
                  return (
                    <div className="nav-result">
                      <div className="nav-route-head">
                        {t('Route: {a} → {b}', { a: navResult.aName, b: navResult.bName })}
                      </div>
                      <div className="nav-total">
                        {fmtNav(dist)} {unit}
                        {scale && mode && mode.speed > 0 && (
                          <span className="nav-days">
                            {' · '}
                            {t('{val} days', { val: (dist / mode.speed).toFixed(1) })}
                            {` (${mode.name})`}
                          </span>
                        )}
                      </div>
                      <div className="nav-legs">
                        {r.legs.map((l, i) => (
                          <div key={i} className="nav-leg">
                            <span className="nav-leg-name">
                              {l.fid === -1 ? t('(off-road)') : (l.name ?? t('(unnamed path)'))}
                            </span>
                            <span className="nav-leg-px">
                              {fmtNav(l.px * k)} {unit}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                })()}
            </>
          ))}
        {activeDef?.hint && <p className="hint">{t(activeDef.hint)}</p>}
        {!active && <p className="hint">{t('Select a tool; its settings appear here.')}</p>}
      </div>
    </div>
  )
}
