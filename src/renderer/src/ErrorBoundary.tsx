import { Component, type ReactNode } from 'react'
import { api, getLanguage, type Lang } from './api'
import Icon from './icons'
import { translate } from './i18n'

// An opened .dunya is written OVER the working copy: if a corrupt/hostile file throws during
// render, without a boundary the window would sit blank — and the UI for opening a different
// file would be gone with it, leaving the app unrecoverable. This boundary always leaves an
// exit: a blank world (the working copy is packed into backups/ and reset) or opening another
// file. A class component is REQUIRED — React has no hook equivalent for error catching.
interface State {
  error: Error | null
  lang: Lang
}

export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, lang: 'en' }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }): void {
    console.error('Caught render error:', error)
    // The component stack is the point of logging here: a render crash's own stack is minified
    // build output, while the component stack names the actual screen that broke.
    void api.logError('ErrorBoundary', error.message, error.stack ?? '', {
      component: (info.componentStack ?? '').split('\n').slice(0, 6).join(' < ').trim()
    })
    // The language lives in the working copy's settings, which may itself be broken →
    // errors are swallowed and English stays
    getLanguage()
      .then((lang) => this.setState({ lang }))
      .catch(() => {})
  }

  render(): ReactNode {
    const { error, lang } = this.state
    if (!error) return this.props.children
    const t = (s: string): string => translate(lang, s)
    return (
      <div className="empty-state start-screen" style={{ margin: 'auto', padding: 24 }}>
        <h2>{t('This world could not be opened')}</h2>
        <p>{t('The file may be corrupt or created by a newer version.')}</p>
        <div className="start-actions">
          <button onClick={() => api.newWorld()}>{t('＋ New world')}</button>
          <button onClick={() => api.openWorld()}>
            <Icon name="folder" size={14} /> {t('Open…')}
          </button>
        </div>
        {/* Collapsed, not removed. A stack trace names internal files and functions, and this
            screen is reached by opening someone else's world — the moment a screenshot is most
            likely to be shared. It still has to be reachable, because this is also the only
            diagnostic the user can send back when a real bug puts them here. */}
        <details className="error-details">
          <summary>{t('Details')}</summary>
          <pre className="error-detail">{String(error?.stack ?? error)}</pre>
        </details>
      </div>
    )
  }
}
