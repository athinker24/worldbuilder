import { assetUrl, PinImage } from './api'
import { useT } from './i18n'

// Image library strip (settings 'pinImages' — shared by pins and polygon fills):
// preview buttons + a hover × that removes from the library + an upload button.
export function ImageStrip({
  img,
  images,
  onImg,
  onUpload,
  onRemoveImg
}: {
  img?: string
  images: PinImage[]
  onImg: (path: string, ar: number) => void
  onUpload: () => void
  onRemoveImg: (path: string) => void
}): React.JSX.Element {
  const t = useT()
  return (
    <>
      <div className="pin-picker-grid">
        {images.map((p) => (
          <div key={p.path} className="pin-img-opt">
            <button
              type="button"
              className={`pin-opt ${img === p.path ? 'selected' : ''}`}
              onClick={() => onImg(p.path, p.ar)}
            >
              <img src={assetUrl(p.path)} alt="" />
            </button>
            <button
              type="button"
              className="pin-img-x"
              title={t('Remove from library')}
              onClick={() => onRemoveImg(p.path)}
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          className="pin-opt pin-upload"
          title={t('Upload image')}
          onClick={onUpload}
        >
          +
        </button>
      </div>
      {images.length > 0 && (
        <p className="hint">
          {t('Removing only takes it out of this list; the file stays in your assets folder.')}
        </p>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Pin shapes.
//
// A glyph set lived here once and was removed on request, because it was a set of
// PICTURES — keeps, towers, temples — and every picture argues for a period and a
// culture. This world has neither settled yet, so the icons were making a claim the
// worldbuilding had not made. These are deliberately the opposite: abstract marks with
// no referent. A ring means whatever the map says it means, and it will still mean it
// after the setting changes. Meaning stays in the article; the pin only has to be
// findable and telling apart from its neighbour.
//
// Rules the set follows, so additions stay consistent:
//  - one 24×24 viewBox, every mark bbox-centred on (12,12) so swapping shape never
//    moves the pin off its point;
//  - fill/stroke via currentColor, and the ONLY thing MapView interpolates is one
//    escaped `color:` on the svg — no user data ever reaches this markup;
//  - the white edge and the drop shadow are map content, so they are fixed in both
//    themes (see the theme note in main.css) and are not tokens;
//  - solid vs hollow is the main way two marks tell apart at map size; detail is not.
//    Nothing here should need more than three primitives.
export type PinShape =
  'disc' | 'ring' | 'dot' | 'star' | 'diamond' | 'square' | 'triangle' | 'cross'

const EDGE = 'rgba(255,255,255,0.9)'
// Hollow marks: a coloured annulus with a white hairline on both of its edges, so the
// map shows through the middle. Drawing it as one stroked circle plus two hairlines is
// simpler than an even-odd path and renders identically at these sizes.
const ANNULUS =
  `<circle cx="12" cy="12" r="6.75" fill="none" stroke="currentColor" stroke-width="4.3"/>` +
  `<circle cx="12" cy="12" r="8.9" fill="none" stroke="${EDGE}" stroke-width="1.4"/>` +
  `<circle cx="12" cy="12" r="4.6" fill="none" stroke="${EDGE}" stroke-width="1.4"/>`
const solid = (d: string): string =>
  `<path d="${d}" fill="currentColor" stroke="${EDGE}" stroke-width="1.5" stroke-linejoin="round"/>`

export const PIN_SHAPES: { id: PinShape; label: string; body: string }[] = [
  {
    id: 'disc',
    label: 'Disc',
    body: `<circle cx="12" cy="12" r="8.9" fill="currentColor" stroke="${EDGE}" stroke-width="1.5"/>`
  },
  { id: 'ring', label: 'Ring', body: ANNULUS },
  {
    id: 'dot',
    label: 'Ringed dot',
    body: `${ANNULUS}<circle cx="12" cy="12" r="2.7" fill="currentColor" stroke="${EDGE}" stroke-width="1.2"/>`
  },
  {
    id: 'star',
    label: 'Star',
    // The star is cut out of the disc in white rather than drawn beside it: at map size a
    // second coloured shape inside the first turns to mush, a white hole stays legible.
    body:
      `<circle cx="12" cy="12" r="8.9" fill="currentColor" stroke="${EDGE}" stroke-width="1.5"/>` +
      `<path d="M12.00 6.30 13.44 10.02 17.42 10.24 14.33 12.76 15.35 16.61 12.00 14.45 8.65 16.61 9.67 12.76 6.58 10.24 10.56 10.02Z" fill="${EDGE}"/>`
  },
  { id: 'diamond', label: 'Diamond', body: solid('M12 3.1 20.9 12 12 20.9 3.1 12Z') },
  { id: 'square', label: 'Square', body: solid('M4.6 4.6 19.4 4.6 19.4 19.4 4.6 19.4Z') },
  // Circumradius 10, then shifted down 2.5 so the bounding box — not the centroid — sits on
  // the point; otherwise a triangle reads as hanging above its own location.
  { id: 'triangle', label: 'Triangle', body: solid('M12 4.5 20.66 19.5 3.34 19.5Z') },
  {
    id: 'cross',
    label: 'Cross',
    body: solid('M9 3.1 15 3.1 15 9 20.9 9 20.9 15 15 15 15 20.9 9 20.9 9 15 3.1 15 3.1 9 9 9Z')
  }
]

export const pinShapeBody = (shape?: PinShape): string =>
  (PIN_SHAPES.find((s) => s.id === shape) ?? PIN_SHAPES[0]).body

/** The shape row in the tool panel and the selected-pin panel. */
export function PinShapePicker({
  shape,
  color,
  onPick
}: {
  shape?: PinShape
  color: string
  onPick: (s: PinShape) => void
}): React.JSX.Element {
  const t = useT()
  return (
    <div className="pin-shape-row">
      {PIN_SHAPES.map((s) => (
        <button
          key={s.id}
          type="button"
          title={t(s.label)}
          aria-label={t(s.label)}
          className={`pin-shape-opt ${(shape ?? 'disc') === s.id ? 'selected' : ''}`}
          onClick={() => onPick(s.id)}
        >
          <svg viewBox="0 0 24 24" style={{ color }} dangerouslySetInnerHTML={{ __html: s.body }} />
        </button>
      ))}
    </div>
  )
}
