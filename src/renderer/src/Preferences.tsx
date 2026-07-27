import { Lang, saveLanguage, saveTheme, Theme } from './api'
import Select from './Select'
import { useT } from './i18n'
import { Row, Section } from './ui'

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
        <h2 className="page-title">{t('Preferences')}</h2>
      </div>

      <Section title={t('Language')}>
        <Row label={t('Interface language')}>
          <Select
            value={lang}
            onChange={(v) => {
              const next = v as Lang
              onLangChange(next)
              saveLanguage(next)
            }}
            options={[
              { value: 'en', label: 'English' },
              { value: 'tr', label: 'Turkish' }
            ]}
          />
        </Row>
        <Row label={t('Theme')}>
          <Select
            value={theme}
            onChange={(v) => {
              const next = v as Theme
              onThemeChange(next)
              saveTheme(next)
            }}
            options={[
              { value: 'dark', label: t('Dark') },
              { value: 'light', label: t('Light') }
            ]}
          />
        </Row>
      </Section>

      {/* Backup has nothing to configure — the cadence and retention are fixed. What is left is
          documentation, so it stays here as text; the action moved to File > Back Up Now. */}
      <Section title={t('Backup')}>
        <p className="hint">
          {t(
            'A dated copy of world.db is made automatically once a day (last 30 days kept). Restoring is manual: with the app closed, copy a file from the backups folder over world.db.'
          )}
        </p>
        <p className="hint">{t('Take an extra backup with File ▸ Back Up Now.')}</p>
      </Section>
    </div>
  )
}
