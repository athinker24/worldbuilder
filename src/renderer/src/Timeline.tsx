import { useEffect, useRef, useState } from 'react'
import {
  autoColor,
  formatYear,
  getMapYear,
  getTimeline,
  saveMapYear,
  saveTimeline,
  TimelineConfig
} from './api'
import Icon from './icons'
import { useT } from './i18n'

interface Props {
  mapId: number // the year the slider stands at is this map's (settings 'mapYears'); the calendar is the world's
  changeYears: number[] // years features start/end/change hands (shown as ticks on the rail)
  eventsToken: number // bumped when MapView adds an event from the map → config reloads
  onYear: (year: number) => void // on every year change — DB-free, smooth
  onLocate: (fid: number, mid?: number) => void // clicking an event flies to + flashes its feature (mid = its map)
}

const SPEEDS = [1, 5, 20] // playback speeds (years/sec)

/** Date strip above the map: playback + slider + era bands + events + ⚙ calendar settings. */
export default function Timeline({
  mapId,
  changeYears,
  eventsToken,
  onYear,
  onLocate
}: Props): React.JSX.Element {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [cfgOpen, setCfgOpen] = useState(false)
  const [cfg, setCfg] = useState<TimelineConfig | null>(null)
  // The rAF loop and hold-to-repeat read the current value from here (no stale closures)
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
  // Saving is debounced so slider spam does not hit the DB every tick
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    // The calendar is the world's, the position on it is this map's — so two reads, and only the
    // first time. MapView remounts on a map switch, which is what makes this the whole of the
    // per-map wiring: a switch re-runs this effect against the new id.
    Promise.all([getTimeline(), getMapYear(mapId)]).then(([t, mine]) => {
      const first = !cfgRef.current
      // Reloaded when an event is added from the map; the user's slider position is kept
      const next = first ? { ...t, year: mine ?? t.year } : { ...t, year: cfgRef.current!.year }
      setCfg(next)
      cfgRef.current = next
      if (first) onYear(next.year) // apply the saved position to the map (on startup)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventsToken])

  const update = (next: TimelineConfig): void => {
    // keep the year inside when the range shrinks
    next = { ...next, year: Math.min(next.max, Math.max(next.min, Math.round(next.year))) }
    const prev = cfgRef.current
    setCfg(next)
    cfgRef.current = next
    if (!prev || next.year !== prev.year) onYear(next.year)
    clearTimeout(saveTimer.current)
    // Both writes are debounced together: dragging the slider changes the year, and the calendar
    // around it is unchanged in that case, but they arrive through the same door. `timeline.year`
    // is still written and is what a map with no entry of its own opens at — see getMapYear.
    saveTimer.current = setTimeout(() => {
      saveTimeline(next)
      saveMapYear(mapId, next.year)
    }, 400)
  }

  const setYear = (y: number): void => update({ ...cfgRef.current!, year: y })
  const step = (d: number): void => {
    const c = cfgRef.current
    if (c) setYear(c.year + d)
  }

  // ▶ Playback: years flow via rAF; applyYear is DB-free so the timelapse stays smooth
  const stopPlay = (): void => {
    if (playRef.current) cancelAnimationFrame(playRef.current.raf)
    playRef.current = null
    setPlaying(false)
  }
  const startPlay = (): void => {
    const c = cfgRef.current
    if (playRef.current || !c) return
    if (c.year >= c.max) setYear(c.min) // at the end, play from the start
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
  useEffect(() => stopPlay, []) // stop the loop on unmount

  // Persist the slider position on unmount (map switch, navigation, reload) so a remount restores
  // the user's year instead of snapping back to the last debounced save — or the default 0, which
  // made BC-year drawings appear to vanish.
  useEffect(
    () => () => {
      clearTimeout(saveTimer.current)
      if (cfgRef.current) saveTimeline(cfgRef.current)
    },
    []
  )

  // With the strip open, ←/→ steps years (not while typing in an input)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        // Shift = ±10, Ctrl = ±100 years
        const mag = e.ctrlKey ? 100 : e.shiftKey ? 10 : 1
        step(e.key === 'ArrowLeft' ? -mag : mag)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // ⏪/⏩ repeat while held (400ms delay, then 120ms interval)
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
        <>
          <Icon name="clock" size={13} /> {t('Time')}
        </>
      </button>
    )

  const period = cfg.periods.find((p) => cfg.year >= p.from && cfg.year <= p.to)
  const range = Math.max(1, cfg.max - cfg.min)
  // Rail ticks: map change years + era boundaries (out-of-range ones dropped)
  const ticks = [
    ...new Set([...changeYears, ...cfg.periods.flatMap((p) => [p.from, p.to + 1])])
  ].filter((y) => y >= cfg.min && y <= cfg.max)
  // Everything ON the strip — the rail dots and the "this year" chips — is this map's events plus
  // the ones with no place at all (added from the ⚙ panel: they belong to the world's history, not
  // to a drawing). An event pinned to a drawing on another map is still in the ⚙ list below, which
  // is the editor and deliberately shows all of them.
  const railEvents = cfg.events.filter((e) => e.mid === undefined || e.mid === mapId)
  const todayEvents = railEvents.filter((e) => e.year === cfg.year)

  // Jump to an event: set the year; with a linked feature, fly + flash on the map (StoryMap pattern)
  const jumpEvent = (e: { year: number; fid?: number; mid?: number }): void => {
    setYear(e.year)
    if (e.fid !== undefined) onLocate(e.fid, e.mid)
  }

  return (
    <div className="timeline-strip">
      {/* Controls and rail on SEPARATE rows: on one row the 11 controls ate ~400px and, the
          strip's width being content-driven, the flex:1 rail was left a few pixels (unusably
          narrow). The rail now gets the strip's full width. */}
      <div className="timeline-row">
        <div className="tl-group">
          <button
            className="mini"
            title={playing ? t('Pause') : t('Play')}
            onClick={() => (playing ? stopPlay() : startPlay())}
          >
            <Icon name={playing ? 'pause' : 'play'} size={13} filled={!playing} />
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
        </div>
        <div className="tl-group tl-mid">
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
            <Icon name="rewind" size={13} filled />
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
            onMouseDown={() => startHold(1)}
            onMouseUp={endHold}
            onMouseLeave={endHold}
          >
            <Icon name="forward" size={13} filled />
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
        </div>
        <div className="tl-group">
          <button
            className="mini"
            title={t('Calendar settings')}
            onClick={() => setCfgOpen(!cfgOpen)}
          >
            <Icon name="settings" size={13} />
          </button>
          <button
            className="mini"
            title={t('Close')}
            aria-label={t('Close')}
            onClick={() => {
              stopPlay()
              setOpen(false)
            }}
          >
            <Icon name="x" size={13} />
          </button>
        </div>
      </div>
      <div className="timeline-rail">
        <div className="timeline-events">
          {railEvents.map((e, i) => {
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
      {period && <div className="timeline-period">{period.name}</div>}
      {todayEvents.length > 0 && (
        <div className="timeline-today">
          {todayEvents.map((e, i) => (
            <button className="tag-chip clickable" key={i} onClick={() => jumpEvent(e)}>
              <Icon name="calendar" size={12} /> {e.name}
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
            {/* onBlur: half-typed values ('' → 0) must not corrupt the range or the year */}
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
                title={t('Remove')}
                aria-label={t('Remove')}
                onClick={() => update({ ...cfg, periods: cfg.periods.filter((_, j) => j !== i) })}
              >
                <Icon name="x" size={12} />
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
              placeholder={t('start')}
              value={periodFrom}
              onChange={(e) => setPeriodFrom(e.target.value)}
            />
            <input
              type="number"
              placeholder={t('end')}
              value={periodTo}
              onChange={(e) => setPeriodTo(e.target.value)}
            />
            <button className="mini" type="submit" title={t('Add')} aria-label={t('Add')}>
              <Icon name="plus" size={12} />
            </button>
          </form>
          {cfg.events.map((e, i) => (
            <div className="field-row" key={`ev-${i}`}>
              <span className="side-label">
                <Icon name="calendar" size={12} /> {e.name} ({formatYear(e.year, cfg)})
                {e.fid !== undefined && <Icon name="map-pin" size={11} />}
              </span>
              {e.fid !== undefined && (
                <button className="mini" title={t('Show on map')} onClick={() => jumpEvent(e)}>
                  <Icon name="arrow-right" size={12} />
                </button>
              )}
              <button
                className="mini danger"
                title={t('Remove')}
                aria-label={t('Remove')}
                onClick={() => update({ ...cfg, events: cfg.events.filter((_, j) => j !== i) })}
              >
                <Icon name="x" size={12} />
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
            <button className="mini" type="submit" title={t('Add')} aria-label={t('Add')}>
              <Icon name="plus" size={12} />
            </button>
          </form>
        </div>
      )}
    </div>
  )
}
