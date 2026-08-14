import { useEffect, useState } from 'react'
import { PinImage } from './api'
import ColorPicker from './ColorPicker'
import Icon from './icons'
import {
  ARROW_LABELS,
  DASH_LABELS,
  DrawSettings,
  FONTS,
  HALO_LABELS,
  LABEL_HALOS,
  LabelHalo,
  LINE_ARROWS,
  LINE_DASHES,
  LineArrow,
  LineDash,
  MapScale,
  NavRoute,
  Tool,
  TOOLS,
  TravelMode
} from './mapTypes'
import { ImageStrip, PinShapePicker } from './pinIcons'
import Select from './Select'
import { useT } from './i18n'
import { Segmented } from './ui'

// Distance display (same contract as MapView's fmtDist — that one is module-private)
const fmtNav = (v: number): string =>
  v >= 100 ? Math.round(v).toLocaleString() : v >= 10 ? v.toFixed(1) : v.toFixed(2)

// Settings surface only — the tool BUTTONS live in MapToolbar (the floating palette).
interface Props {
  active: Tool | null
  settings: DrawSettings
  onSettings: (s: DrawSettings) => void
  // 📏 Scale tool (state lives in MapView; the panel only displays/triggers)
  scale: MapScale | null
  mapWidthPx: number | null // base image width in pixels; null without an image
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
            {/* Method A: the map's full width = N units */}
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
