import { Lang, saveLanguage, saveTheme, Theme } from './api'
import { useT } from './i18n'

// APPLICATION preferences: how the app itself behaves, independent of which world is open.
// These persist in userData/prefs.json, NOT in the .dunya — see api.ts getLanguage/getTheme.
// Anything that describes the open project's structure belongs in ProjectPreferences instead.
interface Props {
  lang: Lang
  onLangChange: (l: Lang) => void
  theme: Theme
  onThemeChange: (th: Theme) => void
}

export default function Preferences({
  lang,
  onLangChange,
  theme,
  onThemeChange
}: Props): React.JSX.Element {
  const t = useT()
  return (
    <div className="page">
      <div className="page-head">
        <h2>{t('Preferences')}</h2>
      </div>

      <h2>{t('Language')}</h2>
      <div className="field-row">
        <span className="field-key">{t('Interface language')}</span>
        <select
          value={lang}
          onChange={(e) => {
            const next = e.target.value as Lang
            onLangChange(next)
            saveLanguage(next)
          }}
        >
          <option value="en">English</option>
          <option value="tr">Turkish</option>
        </select>
      </div>
      <div className="field-row">
        <span className="field-key">{t('Theme')}</span>
        <select
          value={theme}
          onChange={(e) => {
            const next = e.target.value as Theme
            onThemeChange(next)
            saveTheme(next)
          }}
        >
          <option value="dark">{t('Dark')}</option>
          <option value="light">{t('Light')}</option>
        </select>
      </div>

      {/* Backup has nothing to configure — the cadence and retention are fixed. What is left is
          documentation, so it stays here as text; the action moved to File > Back Up Now. */}
      <h2>{t('Backup')}</h2>
      <p className="hint">
        {t(
          'A dated copy of world.db is made automatically once a day (last 30 days kept). Restoring is manual: with the app closed, copy a file from the backups folder over world.db.'
        )}
      </p>
      <p className="hint">{t('Take an extra backup with File ▸ Back Up Now.')}</p>
    </div>
  )
}
