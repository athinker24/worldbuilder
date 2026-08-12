import { useEffect, useState } from 'react'
import { PinImage } from './api'
import ColorPicker from './ColorPicker'
import Icon, { IconName } from './icons'
import { ImageStrip, PinShape, PinShapePicker } from './pinIcons'
import Select from './Select'
import { useT } from './i18n'
import { Segmented } from './ui'

export type Tool =
  'polygon' | 'line' | 'marker' | 'label' | 'scale' | 'nav' | 'edit' | 'drag' | 'remove'

// Map scale (the shape of MapView's settings 'mapScales' record)
export interface MapScale {
  perUnit: number
  unit: string
}

// Travel mode (settings 'travelModes', global): speed = map units/day
export interface TravelMode {
  name: string
  speed: number
}

// Navigation route (computed in MapView, displayed in the panel)
export interface NavLeg {
  fid: number // -1 = off-road
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
// Path direction arrow: none / at the end (destination — campaign/migration direction)
export type LineArrow = 'none' | 'end'

export interface DrawSettings {
  // img: custom pin image (assets/-relative path); plain colored badge without one
  marker: {
    size: number
    color: string
    shape?: PinShape
    img?: string
    imgFree?: boolean
    imgAR?: number
  }
  // fillImg: fill image (assets/-relative path) — the polygon is tiled via an SVG pattern
  polygon: {
    color: string
    fillOpacity: number
    weight: number
    font: string
    fillImg?: string
  }
  line: {
    color: string
    weight: number
    opacity: number
    dash: LineDash
    arrow: LineArrow
    curviness: number // 0-100; render-only curvature (LegendKeeper path-tool pattern)
  }
  // Serbest metin etiketi (LegendKeeper "Labels" + Wonderdraft curved text)
  label: {
    text: string
    color: string
    font: string
    size: number
    angle: number
    curve: number // -100..100; 0 = straight (SVG textPath arc)
    halo: LabelHalo // paper-coloured behind dark ink, dark behind light text, or none at all
    haloWidth: number // fraction of the font size
    tracking: number // letter spacing, fraction of the font size
    bold: boolean
    italic: boolean
  }
}

export const DEFAULT_DRAW: DrawSettings = {
  marker: { size: 1, color: '#c0603a' },
  polygon: { color: '#7bb3ff', fillOpacity: 0.25, weight: 2, font: 'Cinzel' },
  line: { color: '#b08968', weight: 3, opacity: 0.9, dash: 'solid', arrow: 'none', curviness: 0 },
  label: {
    text: '',
    color: '#ffffff',
    font: 'Cinzel',
    size: 1,
    angle: 0,
    curve: 0,
    halo: 'dark',
    haloWidth: 0.08,
    tracking: 0,
    bold: false,
    italic: false
  }
}

export type LabelHalo = 'none' | 'light' | 'dark'
export const LABEL_HALOS: LabelHalo[] = ['none', 'light', 'dark']
export const HALO_LABELS: Record<LabelHalo, string> = {
  none: 'No halo',
  light: 'Light halo',
  dark: 'Dark halo'
}

export const LINE_ARROWS: LineArrow[] = ['none', 'end']
export const ARROW_LABELS: Record<LineArrow, string> = {
  none: 'No arrow',
  end: 'Arrow at end'
}

// Convert the line pattern to a Leaflet dashArray (proportional to weight; dotted + round cap = dots)
export const lineDashArray = (dash: LineDash | undefined, weight: number): string =>
  dash === 'dashed' ? `${weight * 3} ${weight * 2}` : dash === 'dotted' ? `0 ${weight * 2.5}` : ''

export const LINE_DASHES: LineDash[] = ['solid', 'dashed', 'dotted']
export const DASH_LABELS: Record<LineDash, string> = {
  solid: 'Solid',
  dashed: 'Dashed',
  dotted: 'Dotted'
}

// Distance display (same contract as MapView's fmtDist — that one is module-private)
const fmtNav = (v: number): string =>
  v >= 100 ? Math.round(v).toLocaleString() : v >= 10 ? v.toFixed(1) : v.toFixed(2)

// Label fonts (bundled via @fontsource, OFL-licensed)
export const FONTS = ['Cinzel', 'IM Fell English', 'MedievalSharp', 'Uncial Antiqua', 'system-ui']

// Exported so MapToolbar can show the same icon and name for the subset it displays — one source
// for tool labels, whichever container renders the buttons. Drawing tools carry the icon of the
// SHAPE they produce, so the palette reads as its own output.
export const TOOLS: { key: Tool; icon: IconName; name: string; hint?: string }[] = [
  { key: 'polygon', icon: 'polygon', name: 'Polygon' },
  { key: 'line', icon: 'path', name: 'Path', hint: 'Draw roads, routes, borders as lines.' },
  { key: 'marker', icon: 'map-pin', name: 'Location' },
  {
    key: 'label',
    icon: 'label',
    name: 'Label',
    hint: 'Free text on the map: name seas, mountain ranges, regions.'
  },
  {
    key: 'scale',
    icon: 'ruler',
    name: 'Scale',
    hint: 'Set the map scale; measure distance and area without drawing.'
  },
  {
    key: 'nav',
    icon: 'map',
    name: 'Navigate',
    hint: 'Pick two pins; the route follows your drawn paths.'
  },
  {
    key: 'edit',
    icon: 'pencil',
    name: 'Edit',
    hint: 'Drag the corner points of drawings to change their shape.'
  },
  { key: 'drag', icon: 'maximize', name: 'Move', hint: 'Drag drawings to move them.' },
  {
    key: 'remove',
    icon: 'trash',
    name: 'Delete',
    hint: 'Clicked drawing is deleted (undo with Ctrl+Z).'
  }
]

// Settings surface only — the tool BUTTONS live in MapToolbar (the floating palette).
interface Props {
  active: Tool | null
  settings: DrawSettings
  onSettings: (s: DrawSettings) => void
  // 📏 Scale tool (state lives in MapView; the panel only displays/triggers)
  scale: MapScale | null
  mapWidthPx: number | null // base image width in pixels (Wonderdraft method); null without an image
  measuring: 'dist' | 'area' | null
  onCalibrate: () => void
  onMeasure: (k: 'dist' | 'area') => void
  onScaleSave: (perUnit: number, unit: string) => void
  onScaleClear: () => void
  // 🧭 Navigation tool (session state in MapView; the panel displays/triggers)
  navStep: 'a' | 'b' | 'result' | null
  navResult: { aName: string; bName: string; route: NavRoute | null } | null
  navBlocked: boolean // rank/paint mode active → pins are not rendered, cannot be clicked
  travelModes: TravelMode[]
  travelModeIdx: number
  onNavStart: () => void
  onNavEnd: () => void
  onTravelModes: (list: TravelMode[]) => void
  onTravelModeIdx: (i: number) => void
  // 📍 Custom pin images (library in MapView; the panel displays/triggers)
  pinImages: PinImage[]
  onUploadPinImage: (onPicked: (path: string, ar: number) => void) => void
  onRemovePinImage: (path: string) => void
}

export default function ToolPanel({
  active,
  settings,
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
  // The unit feeds both methods; re-synced when the saved scale changes (e.g. via calibration)
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
      <div className="tool-settings">
        {/* Which tool these settings belong to. The popover floats 62px from a 34px icon-only
            button, so the only thing saying whose panel this was is that button's accent — and
            the hint that explains the tool sat at the BOTTOM, after the controls it explains. */}
        {activeDef && (
          <div className="tool-head">
            <Icon name={activeDef.icon} size={14} />
            <span className="panel-title">{t(activeDef.name)}</span>
          </div>
        )}
        {activeDef?.hint && <p className="hint">{t(activeDef.hint)}</p>}
        {active === 'polygon' && (
          <>
            <label>{t('Color')}</label>
            <ColorPicker
              value={settings.polygon.color}
              onChange={(color) =>
                onSettings({ ...settings, polygon: { ...settings.polygon, color } })
              }
            />
            <label className="cap">
              {t('Fill opacity')}
              <span>{settings.polygon.fillOpacity.toFixed(2)}</span>
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
            {/* 0 = no outline. Only the polygon offers it — a path is nothing but its stroke. */}
            <label className="cap">
              {t('Outline thickness')}
              <span>{settings.polygon.weight}px</span>
            </label>
            <input
              type="range"
              min={0}
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
            <Select
              value={settings.polygon.font}
              style={{ fontFamily: settings.polygon.font }}
              onChange={(v) =>
                onSettings({ ...settings, polygon: { ...settings.polygon, font: v } })
              }
              options={FONTS.map((f) => ({ value: f, label: f, style: { fontFamily: f } }))}
            />
            <label>{t('Fill image')}</label>
            <ImageStrip
              img={settings.polygon.fillImg}
              images={pinImages}
              onImg={(fillImg) =>
                onSettings({
                  ...settings,
                  polygon:
                    settings.polygon.fillImg === fillImg
                      ? { ...settings.polygon, fillImg: undefined }
                      : { ...settings.polygon, fillImg }
                })
              }
              onUpload={() =>
                onUploadPinImage((fillImg) =>
                  onSettings({ ...settings, polygon: { ...settings.polygon, fillImg } })
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
                    polygon: { ...settings.polygon, fillImg: undefined }
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
            <label className="cap">
              {t('Thickness')}
              <span>{settings.line.weight}</span>
            </label>
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
            <label className="cap">
              {t('Opacity')}
              <span>{settings.line.opacity.toFixed(2)}</span>
            </label>
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
            <Select
              value={settings.line.dash}
              onChange={(v) =>
                onSettings({ ...settings, line: { ...settings.line, dash: v as LineDash } })
              }
              options={LINE_DASHES.map((d) => ({ value: d, label: t(DASH_LABELS[d]) }))}
            />
            <label className="cap">
              {t('Curviness')}
              <span>{settings.line.curviness}</span>
            </label>
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
            <Select
              value={settings.line.arrow}
              onChange={(v) =>
                onSettings({ ...settings, line: { ...settings.line, arrow: v as LineArrow } })
              }
              options={LINE_ARROWS.map((a) => ({ value: a, label: t(ARROW_LABELS[a]) }))}
            />
          </>
        )}
        {active === 'marker' && (
          <>
            {/* Free mode has no badge → color has no effect, hide the control */}
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
            {/* A custom image replaces the mark entirely, so the shape row is pointless then */}
            {!settings.marker.img && (
              <>
                <label>{t('Shape')}</label>
                <PinShapePicker
                  shape={settings.marker.shape}
                  color={settings.marker.color}
                  onPick={(shape) =>
                    onSettings({ ...settings, marker: { ...settings.marker, shape } })
                  }
                />
              </>
            )}
            <label>{t('Pin image')}</label>
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
                {/* A pin's image has no Remove button the way a polygon fill does — the strip
                    itself is the toggle. That used to be said inside the caption above, which is
                    how a caption becomes a sentence. */}
                <p className="hint">{t('Click an image again to remove it.')}</p>
                {/* Two exclusive options: a segmented control, which is what this pair of
                    .mini buttons with an `active` class was imitating by hand. */}
                <Segmented
                  label={t('Image style')}
                  options={[
                    { key: 'badge', label: t('Badge') },
                    { key: 'free', label: t('Free') }
                  ]}
                  value={settings.marker.imgFree ? 'free' : 'badge'}
                  onChange={(k) =>
                    onSettings({
                      ...settings,
                      marker: { ...settings.marker, imgFree: k === 'free' }
                    })
                  }
                />
              </>
            )}
            <label className="cap">
              {t('Size')}
              <span>×{settings.marker.size.toFixed(2)}</span>
            </label>
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
            <Select
              value={settings.label.font}
              style={{ fontFamily: settings.label.font }}
              onChange={(v) => onSettings({ ...settings, label: { ...settings.label, font: v } })}
              options={FONTS.map((f) => ({ value: f, label: f, style: { fontFamily: f } }))}
            />
            <label className="cap">
              {t('Size')}
              <span>×{settings.label.size.toFixed(2)}</span>
            </label>
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
            <label className="cap">
              {t('Angle')}
              <span>{settings.label.angle}°</span>
            </label>
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
            <label className="cap">
              {t('Curve')}
              <span>{settings.label.curve}</span>
            </label>
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
            <label>{t('Halo')}</label>
            <Select
              value={settings.label.halo}
              onChange={(v) =>
                onSettings({ ...settings, label: { ...settings.label, halo: v as LabelHalo } })
              }
              options={LABEL_HALOS.map((h) => ({ value: h, label: t(HALO_LABELS[h]) }))}
            />
            {settings.label.halo !== 'none' && (
              <>
                <label className="cap">
                  {t('Halo thickness')}
                  <span>{settings.label.haloWidth.toFixed(2)}</span>
                </label>
                <input
                  type="range"
                  min={0.02}
                  max={0.2}
                  step={0.01}
                  value={settings.label.haloWidth}
                  onChange={(e) =>
                    onSettings({
                      ...settings,
                      label: { ...settings.label, haloWidth: Number(e.target.value) }
                    })
                  }
                />
              </>
            )}
            <label className="cap">
              {t('Letter spacing')}
              <span>{settings.label.tracking.toFixed(2)}</span>
            </label>
            <input
              type="range"
              min={0}
              max={0.5}
              step={0.01}
              value={settings.label.tracking}
              onChange={(e) =>
                onSettings({
                  ...settings,
                  label: { ...settings.label, tracking: Number(e.target.value) }
                })
              }
            />
            <div className="field-row">
              <label>
                <input
                  type="checkbox"
                  checked={settings.label.bold}
                  onChange={(e) =>
                    onSettings({
                      ...settings,
                      label: { ...settings.label, bold: e.target.checked }
                    })
                  }
                />{' '}
                {t('Bold')}
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={settings.label.italic}
                  onChange={(e) =>
                    onSettings({
                      ...settings,
                      label: { ...settings.label, italic: e.target.checked }
                    })
                  }
                />{' '}
                {t('Italic')}
              </label>
            </div>
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
            {/* Method A (Wonderdraft): the map's full width = N units */}
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
              <p className="hint">{t('No base image: measure a known distance instead.')}</p>
            )}
            {/* Method B: measure a known distance on the map */}
            <button className="mini" onClick={onCalibrate}>
              <Icon name="ruler" size={12} /> {t('Measure known distance…')}
            </button>
            {scale && (
              <p className="hint">
                1 px = {+scale.perUnit.toPrecision(3)} {scale.unit}{' '}
                <button className="mini" onClick={onScaleClear}>
                  {t('Remove scale')}
                </button>
              </p>
            )}
            {/* Same pair, same fix — and here the state is genuinely a mode: one of the two is
                running until Esc ends it, which is exactly what a pressed segment means. */}
            <Segmented
              label={t('Measure (not saved)')}
              options={[
                { key: 'dist', label: t('Distance'), icon: 'ruler' },
                { key: 'area', label: t('Area'), icon: 'polygon' }
              ]}
              value={measuring}
              onChange={(k) => onMeasure(k)}
            />
            <p className="hint">{t('Click to add points, Esc to finish. Not saved.')}</p>
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
                    aria-label={t('Delete')}
                    onClick={() => onTravelModes(travelModes.filter((_, j) => j !== i))}
                  >
                    <Icon name="x" size={12} />
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
                <Icon name="map" size={12} /> {navStep ? t('Clear') : t('Pick two pins')}
              </button>
              {navResult &&
                (() => {
                  const r = navResult.route
                  if (!r)
                    return (
                      <p className="hint">
                        {t('No route. Make sure the paths meet at a shared point.')}
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
        {!active && <p className="hint">{t('Select a tool; its settings appear here.')}</p>}
      </div>
    </div>
  )
}
