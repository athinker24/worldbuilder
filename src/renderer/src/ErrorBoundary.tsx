import { Component, type ReactNode } from 'react'
import { api, getLanguage, type Lang } from './api'
import { translate } from './i18n'

// Açılan .dunya çalışma kopyasının ÜZERİNE yazılır: bozuk/düşman bir dosya render sırasında
// hata fırlatırsa, sınır olmadan ekranda boş beyaz bir pencere kalırdı — üstelik başka dosya
// açacak arayüz de gitmiş olurdu, yani uygulama kurtarılamazdı. Bu sınır her zaman bir çıkış
// yolu bırakır: boş dünya (çalışma kopyası backups/'a paketlenip sıfırlanır) ya da başka dosya aç.
// Sınıf bileşeni ŞART — React'te hata yakalamanın hook karşılığı yok.
interface State {
  error: Error | null
  lang: Lang
}

export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, lang: 'en' }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error): void {
    console.error('Yakalanan render hatası:', error)
    // Dil çalışma kopyasının settings'inde; o da bozuk olabilir → hata yutulur, İngilizce kalır
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
          <button onClick={() => api.openWorld()}>{t('📂 Open…')}</button>
        </div>
        <h4>{t('Details')}</h4>
        <pre className="error-detail">{String(error?.stack ?? error)}</pre>
      </div>
    )
  }
}
