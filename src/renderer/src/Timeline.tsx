import { useEffect, useRef, useState } from 'react'
import { autoColor, formatYear, getTimeline, saveTimeline, TimelineConfig } from './api'
import { useT } from './i18n'

interface Props {
  changeYears: number[] // çizimlerin başladığı/bittiği/el değiştirdiği yıllar (rayda tik olarak görünür)
  eventsToken: number // MapView haritadan olay ekleyince artar → config yeniden yüklenir
  onYear: (year: number) => void // her yıl değişiminde — DB'siz, yumuşak
  onLocate: (fid: number, mid?: number) => void // olaya tıklanınca bağlı çizime uç + vurgula (mid = çizimin haritası)
}

const SPEEDS = [1, 5, 20] // oynatma hızları (yıl/sn)

/** Haritanın üstünde tarih şeridi: oynatma + slider + dönem bantları + olaylar + ⚙ takvim ayarları. */
export default function Timeline({
  changeYears,
  eventsToken,
  onYear,
  onLocate
}: Props): React.JSX.Element {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [cfgOpen, setCfgOpen] = useState(false)
  const [cfg, setCfg] = useState<TimelineConfig | null>(null)
  // rAF döngüsü ve basılı-tut tekrarı güncel değeri buradan okur (stale closure yok)
  const cfgRef = useRef<TimelineConfig | null>(null)
  const [editingYear, setEditingYear] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(5)
  const speedRef = useRef(5)
  const playRef = useRef<{ raf: number; last: number; acc: number } | null>(null)
  const holdRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [periodName, setPeriodName] = useState('')
  const [periodFrom, setPeriodFrom] = useState('')
  const [periodTo, setPeriodTo] = useState('')
  const [eventName, setEventName] = useState('')
  const [eventYear, setEventYear] = useState('')
  // Slider spam'inde her tikte DB'ye yazmamak için kaydetme gecikmeli
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    getTimeline().then((t) => {
      const first = !cfgRef.current
      // Haritadan olay eklenince yeniden yüklenir; kullanıcının o anki slider konumu korunur
      const next = first ? t : { ...t, year: cfgRef.current!.year }
      setCfg(next)
      cfgRef.current = next
      if (first) onYear(next.year) // kayıtlı konumu haritaya uygula (açılışta)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventsToken])

  const update = (next: TimelineConfig): void => {
    // aralık daralınca yılı içeride tut
    next = { ...next, year: Math.min(next.max, Math.max(next.min, Math.round(next.year))) }
    const prev = cfgRef.current
    setCfg(next)
    cfgRef.current = next
    if (!prev || next.year !== prev.year) onYear(next.year)
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => saveTimeline(next), 400)
  }

  const setYear = (y: number): void => update({ ...cfgRef.current!, year: y })
  const step = (d: number): void => {
    const c = cfgRef.current
    if (c) setYear(c.year + d)
  }

  // ▶ Oynatma: rAF ile yıl akar; applyYear DB'siz olduğu için timelapse akıcıdır
  const stopPlay = (): void => {
    if (playRef.current) cancelAnimationFrame(playRef.current.raf)
    playRef.current = null
    setPlaying(false)
  }
  const startPlay = (): void => {
    const c = cfgRef.current
    if (playRef.current || !c) return
    if (c.year >= c.max) setYear(c.min) // sondaysa baştan oynat
    setPlaying(true)
    const state = { raf: 0, last: performance.now(), acc: 0 }
    playRef.current = state
    const tick = (t: number): void => {
      if (playRef.current !== state) return
      state.acc += ((t - state.last) / 1000) * speedRef.current
      state.last = t
      const whole = Math.floor(state.acc)
      if (whole >= 1) {
        state.acc -= whole
        const cur = cfgRef.current!
        setYear(cur.year + whole)
        if (cur.year + whole >= cur.max) {
          stopPlay()
          return
        }
      }
      state.raf = requestAnimationFrame(tick)
    }
    state.raf = requestAnimationFrame(tick)
  }
  useEffect(() => stopPlay, []) // unmount'ta döngüyü durdur

  // Şerit açıkken ←/→ yıl adımlar (bir girdi alanına yazarken değil)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        // Shift = ±10, Ctrl = ±100 yıl
        const mag = e.ctrlKey ? 100 : e.shiftKey ? 10 : 1
        step(e.key === 'ArrowLeft' ? -mag : mag)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // ⏪/⏩ basılı tutunca tekrarla (400ms gecikme, sonra 120ms aralık)
  const startHold = (d: number): void => {
    step(d)
    const rep = (): void => {
      step(d)
      holdRef.current = setTimeout(rep, 120)
    }
    holdRef.current = setTimeout(rep, 400)
  }
  const endHold = (): void => clearTimeout(holdRef.current)

  if (!cfg) return <></>

  if (!open)
    return (
      <button className="timeline-toggle" onClick={() => setOpen(true)}>
        {t('🕰 Time')}
      </button>
    )

  const period = cfg.periods.find((p) => cfg.year >= p.from && cfg.year <= p.to)
  const range = Math.max(1, cfg.max - cfg.min)
  // Ray tikleri: harita değişim yılları + dönem sınırları (aralık dışındakiler elenir)
  const ticks = [
    ...new Set([...changeYears, ...cfg.periods.flatMap((p) => [p.from, p.to + 1])])
  ].filter((y) => y >= cfg.min && y <= cfg.max)
  const todayEvents = cfg.events.filter((e) => e.year === cfg.year)

  // Olaya atla: yılı ayarla, bağlı çizim varsa haritada uç + vurgula (StoryMap deseni)
  const jumpEvent = (e: { year: number; fid?: number; mid?: number }): void => {
    setYear(e.year)
    if (e.fid !== undefined) onLocate(e.fid, e.mid)
  }

  return (
    <div className="timeline-strip">
      <div className="timeline-row">
        <button
          className="mini"
          title={playing ? t('Pause') : t('Play')}
          onClick={() => (playing ? stopPlay() : startPlay())}
        >
          {playing ? '⏸' : '▶'}
        </button>
        <button
          className="mini"
          title={t('Playback speed: {n} yr/s', { n: speed })}
          onClick={() => {
            const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]
            setSpeed(next)
            speedRef.current = next
          }}
        >
          {speed}×
        </button>
        <button
          className="mini step-jump"
          title={t('-100 years (Ctrl+←)')}
          onMouseDown={() => startHold(-100)}
          onMouseUp={endHold}
          onMouseLeave={endHold}
        >
          −100
        </button>
        <button
          className="mini step-jump"
          title={t('-10 years (Shift+←)')}
          onMouseDown={() => startHold(-10)}
          onMouseUp={endHold}
          onMouseLeave={endHold}
        >
          −10
        </button>
        <button
          className="mini"
          onMouseDown={() => startHold(-1)}
          onMouseUp={endHold}
          onMouseLeave={endHold}
        >
          ⏪
        </button>
        <div className="timeline-rail">
          <div className="timeline-events">
            {cfg.events.map((e, i) => {
              if (e.year < cfg.min || e.year > cfg.max) return null
              return (
                <div
                  key={i}
                  className={`timeline-evdot ${e.year === cfg.year ? 'active' : ''}`}
                  title={`${e.name} (${formatYear(e.year, cfg)})`}
                  style={{ left: `${((e.year - cfg.min) / range) * 100}%` }}
                  onClick={() => jumpEvent(e)}
                />
              )
            })}
          </div>
          <input
            type="range"
            list="year-ticks"
            min={cfg.min}
            max={cfg.max}
            step={1}
            value={cfg.year}
            onChange={(e) => setYear(Number(e.target.value))}
          />
          <datalist id="year-ticks">
            {ticks.map((y) => (
              <option key={y} value={y} />
            ))}
          </datalist>
          <div className="timeline-bands">
            {cfg.periods.map((p, i) => {
              const l = Math.max(0, ((p.from - cfg.min) / range) * 100)
              const r = Math.min(100, ((p.to + 1 - cfg.min) / range) * 100)
              if (r <= 0 || l >= 100) return null
              return (
                <div
                  key={i}
                  className="timeline-band"
                  title={`${p.name} (${formatYear(p.from, cfg)} – ${formatYear(p.to, cfg)})`}
                  style={{
                    left: `${l}%`,
                    width: `${Math.max(0.5, r - l)}%`,
                    background: autoColor(p.name)
                  }}
                  onClick={() => setYear(p.from)}
                />
              )
            })}
          </div>
        </div>
        <button
          className="mini"
          onMouseDown={() => startHold(1)}
          onMouseUp={endHold}
          onMouseLeave={endHold}
        >
          ⏩
        </button>
        <button
          className="mini step-jump"
          title={t('+10 years (Shift+→)')}
          onMouseDown={() => startHold(10)}
          onMouseUp={endHold}
          onMouseLeave={endHold}
        >
          +10
        </button>
        <button
          className="mini step-jump"
          title={t('+100 years (Ctrl+→)')}
          onMouseDown={() => startHold(100)}
          onMouseUp={endHold}
          onMouseLeave={endHold}
        >
          +100
        </button>
        {editingYear ? (
          <input
            className="timeline-year-input"
            type="number"
            autoFocus
            defaultValue={cfg.year}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur()
            }}
            onBlur={(e) => {
              setEditingYear(false)
              if (e.target.value !== '') setYear(Number(e.target.value))
            }}
          />
        ) : (
          <span
            className="timeline-year clickable"
            title={t('Click, type a year (negative = before epoch)')}
            onClick={() => setEditingYear(true)}
          >
            {formatYear(cfg.year, cfg)}
          </span>
        )}
        <button
          className="mini"
          title={t('Calendar settings')}
          onClick={() => setCfgOpen(!cfgOpen)}
        >
          ⚙
        </button>
        <button
          className="mini"
          onClick={() => {
            stopPlay()
            setOpen(false)
          }}
        >
          ×
        </button>
      </div>
      {period && <div className="timeline-period">{period.name}</div>}
      {todayEvents.length > 0 && (
        <div className="timeline-today">
          {todayEvents.map((e, i) => (
            <button className="tag-chip clickable" key={i} onClick={() => jumpEvent(e)}>
              📅 {e.name}
            </button>
          ))}
        </div>
      )}
      {cfgOpen && (
        <div className="timeline-pop">
          <div className="field-row">
            <span className="field-key">{t('Era abbreviations')}</span>
            <input
              value={cfg.before}
              title={t('Before epoch')}
              onChange={(e) => update({ ...cfg, before: e.target.value })}
            />
            <input
              value={cfg.after}
              title={t('After epoch')}
              onChange={(e) => update({ ...cfg, after: e.target.value })}
            />
          </div>
          <div className="field-row">
            <span className="field-key">{t('Year range')}</span>
            {/* onBlur: yazım ortasındaki yarım değerler ('' → 0) aralığı ve yılı bozmasın */}
            <input
              type="number"
              defaultValue={cfg.min}
              key={`min-${cfg.min}`}
              onBlur={(e) => {
                const v = Number(e.target.value)
                if (e.target.value !== '' && v !== cfg.min) update({ ...cfg, min: v })
              }}
            />
            <input
              type="number"
              defaultValue={cfg.max}
              key={`max-${cfg.max}`}
              onBlur={(e) => {
                const v = Number(e.target.value)
                if (e.target.value !== '' && v !== cfg.max) update({ ...cfg, max: v })
              }}
            />
          </div>
          {cfg.periods.map((p, i) => (
            <div className="field-row" key={i}>
              <span className="side-label">
                <span className="dot" style={{ background: autoColor(p.name) }} /> {p.name} (
                {formatYear(p.from, cfg)} – {formatYear(p.to, cfg)})
              </span>
              <button
                className="mini danger"
                onClick={() => update({ ...cfg, periods: cfg.periods.filter((_, j) => j !== i) })}
              >
                ×
              </button>
            </div>
          ))}
          <form
            className="field-row add"
            onSubmit={(e) => {
              e.preventDefault()
              const from = Number(periodFrom)
              const to = Number(periodTo)
              if (!periodName.trim() || periodFrom === '' || periodTo === '' || from > to) return
              update({
                ...cfg,
                periods: [...cfg.periods, { name: periodName.trim(), from, to }]
              })
              setPeriodName('')
              setPeriodFrom('')
              setPeriodTo('')
            }}
          >
            <input
              placeholder={t('period name')}
              value={periodName}
              onChange={(e) => setPeriodName(e.target.value)}
            />
            <input
              type="number"
              placeholder={t('start.')}
              value={periodFrom}
              onChange={(e) => setPeriodFrom(e.target.value)}
            />
            <input
              type="number"
              placeholder={t('end')}
              value={periodTo}
              onChange={(e) => setPeriodTo(e.target.value)}
            />
            <button className="mini" type="submit">
              +
            </button>
          </form>
          {cfg.events.map((e, i) => (
            <div className="field-row" key={`ev-${i}`}>
              <span className="side-label">
                📅 {e.name} ({formatYear(e.year, cfg)}){e.fid !== undefined ? ' 📍' : ''}
              </span>
              {e.fid !== undefined && (
                <button className="mini" title={t('Show on map')} onClick={() => jumpEvent(e)}>
                  →
                </button>
              )}
              <button
                className="mini danger"
                onClick={() => update({ ...cfg, events: cfg.events.filter((_, j) => j !== i) })}
              >
                ×
              </button>
            </div>
          ))}
          <form
            className="field-row add"
            onSubmit={(e) => {
              e.preventDefault()
              if (!eventName.trim() || eventYear === '') return
              update({
                ...cfg,
                events: [...cfg.events, { name: eventName.trim(), year: Number(eventYear) }]
              })
              setEventName('')
              setEventYear('')
            }}
          >
            <input
              placeholder={t('event name (no location)')}
              value={eventName}
              onChange={(e) => setEventName(e.target.value)}
            />
            <input
              type="number"
              placeholder={t('year')}
              value={eventYear}
              onChange={(e) => setEventYear(e.target.value)}
            />
            <button className="mini" type="submit">
              +
            </button>
          </form>
        </div>
      )}
    </div>
  )
}
