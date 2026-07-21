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
          {t(
            'Removing only takes it out of this list; the file stays in your assets folder.'
          )}
        </p>
      )}
    </>
  )
}
