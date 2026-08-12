import { Component, type ReactNode } from 'react'
import { api, getLanguage, type Lang } from './api'
import Icon from './icons'
import { translate } from './i18n'
import { logCrash } from './log'

// An opened .world is written OVER the working copy: if a corrupt/hostile file throws during
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
    // THE WHOLE BODY IS GUARDED, because a throw in here defeats the boundary itself: React treats
    // an error inside componentDidCatch as unrecoverable and unmounts the tree, which is the blank
    // screen this class exists to prevent.
    //
    // It is not hypothetical. Both calls below go through `window.api`, and the preload THROWS on
    // purpose when context isolation is lost (see preload/index.ts) — so in that failure the
    // bridge is undefined, App's first api call throws during render, this catches it, and then
    // `window.api.invoke` throws SYNCHRONOUSLY here. Not a rejected promise, so the `.catch()`
    // never sees it. The one scenario where the exit screen matters most was the one that removed
    // it. Reporting the crash is worth less than showing the way out.
    try {
      this.report(error, info)
    } catch {
      /* no bridge, no log; the fallback below still renders */
    }
  }

  private report(error: Error, info: { componentStack?: string | null }): void {
    console.error('Caught render error:', error)
    // The component stack is the point of logging here: a render crash's own stack is minified
    // build output, while the component stack names the actual screen that broke.
    logCrash('ErrorBoundary', error.message, error.stack ?? '', {
      // Each raw line already reads "    at Foo (...)" and the stack starts with a blank line —
      // trim + filter before joining, or the printed trail opens with a stray '<' and doubled
      // indentation (seen in the first real crash this caught).
      component: (info.componentStack ?? '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 6)
        .join(' < ')
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
          <button onClick={() => api.newWorld()}>
            <Icon name="plus" size={14} /> {t('New world')}
          </button>
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
