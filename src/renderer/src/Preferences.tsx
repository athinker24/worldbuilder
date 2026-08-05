import { useEffect, useState } from 'react'
import { api, getDebugLog, Lang, saveDebugLog, saveLanguage, saveTheme, Theme } from './api'
import Select from './Select'
import { useT } from './i18n'
import { logEvent, setDebugLog } from './log'
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
  const [debug, setDebug] = useState(false)
  useEffect(() => {
    void getDebugLog().then((on) => {
      setDebug(on)
      setDebugLog(on) // the renderer's own filter, so a DEBUG line costs a boolean test when off
    })
  }, [])
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
              logEvent('INFO', 'settings.changed', { what: 'language', value: next })
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
              logEvent('INFO', 'settings.changed', { what: 'theme', value: next })
            }}
            options={[
              { value: 'dark', label: t('Dark') },
              { value: 'light', label: t('Light') },
              // The teal-tinted dark theme this app had before the greys. Kept because it was
              // someone's taste, not a mistake — and it costs eight token overrides.
              { value: 'teal', label: t('Dark Teal') }
            ]}
          />
        </Row>
      </Section>

      {/* Backup has nothing to configure — the cadence and retention are fixed. What is left is
          documentation, so it stays here as text; the action moved to File > Back Up Now. */}
      <Section title={t('Backup')}>
        <p className="hint">
          {t(
            'A dated copy is kept daily, for 30 days. To restore, close the app and copy one over world.db.'
          )}
        </p>
      </Section>

      {/* Every session already writes a log; this only decides how much detail goes into it.
          Off by default because DEBUG is for diagnosing the app, not for using it — and a chatty
          log is one nobody reads when it finally matters. */}
      <Section title={t('Developer')}>
        <Row label={t('Detailed logging')}>
          <Select
            value={debug ? 'on' : 'off'}
            onChange={(v) => {
              const on = v === 'on'
              setDebug(on)
              setDebugLog(on)
              void saveDebugLog(on)
            }}
            options={[
              { value: 'off', label: t('Off') },
              { value: 'on', label: t('On') }
            ]}
          />
        </Row>
        <p className="hint">
          {t('Adds timings and internal detail to the log, for reporting a problem.')}
        </p>
        <button className="mini" onClick={() => void api.openLogFolder()}>
          {t('Open Log Folder')}
        </button>
      </Section>
    </div>
  )
}
