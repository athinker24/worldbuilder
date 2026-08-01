import { api } from './api'

// The renderer's end of the session log. Events go to main over the one IPC channel and land in
// the same file as everything else — one file per session is the whole point, and two files that
// have to be read side by side would give that up.
//
// BATCHED, not one call per event. The bridge is a round trip; a log that makes an IPC call every
// time the user picks a tool would be a source of the very stutter it exists to find. Lines are
// held for BATCH_MS and shipped together — except errors, which do not come through here at all
// (main.tsx reports those directly, unbatched, because the process may not survive to flush).
//
// NOTHING HERE MAY BE CALLED PER FRAME. The one exception is `frame()`, which is a single integer
// increment and never touches the queue; see below for why that matters more than it sounds.

type Level = 'INFO' | 'WARN' | 'DEBUG'
/**
 * `at` is stamped HERE, when the event happens, and travels with it.
 *
 * Without it main stamps events as it writes them, so everything in one batch shares a
 * millisecond — and a log where three separate keypresses read as simultaneous is worse than no
 * timestamps at all. It cost a false bug report the first time this file was read: three ordinary
 * undos looked like one keystroke firing three times.
 */
type Entry = { level: Level; scope: string; data?: Record<string, unknown>; at: number }

const BATCH_MS = 500
let queue: Entry[] = []
let timer: ReturnType<typeof setTimeout> | null = null
let debug = false

/** Kept in step with Preferences ▸ Developer, so a DEBUG line costs one boolean test when off. */
export const setDebugLog = (on: boolean): void => {
  debug = on
}

const ship = (): void => {
  timer = null
  if (!queue.length) return
  const batch = queue
  queue = []
  void api.logEvents(batch)
}

/**
 * One event. `scope` is a dotted path — `map.changed`, `tool.changed`, `polygon.selected` — so both
 * a person and a model can filter without being told the vocabulary.
 */
export function logEvent(level: Level, scope: string, data?: Record<string, unknown>): void {
  if (level === 'DEBUG' && !debug) return
  queue.push({ level, scope, data, at: Date.now() })
  // A burst that outgrows the batch window ships early rather than growing without bound.
  if (queue.length >= 100) return ship()
  if (!timer) timer = setTimeout(ship, BATCH_MS)
}

/**
 * Time an operation. The threshold that decides INFO from WARN lives in main (thresholds.ts) —
 * one place for every number, whichever process measured it.
 */
export function logTime(
  scope: string,
  data?: Record<string, unknown>
): (extra?: Record<string, unknown>) => void {
  const t0 = performance.now()
  // The extra argument is for what is only known at the END — how many features were loaded, how
  // many files were written. Those are the numbers that make a duration mean something.
  return (extra?: Record<string, unknown>) =>
    logEvent('INFO', scope, {
      ...data,
      ...extra,
      took: `${Math.round(performance.now() - t0)}ms`
    })
}

// --- Frame rate ------------------------------------------------------------------------------
//
// Counted from the draw calls the map ALREADY makes, never from a loop of our own. A permanent
// requestAnimationFrame would undo the thing the whole map is built on: rendering happens on
// demand, and when nothing moves nothing runs — which is also what lets Pixi's idle collection
// settle. So `frame()` is an increment on a path that is already executing, and the verdict is
// reached when the gesture ends, which is the only time frame rate means anything anyway.

let frames = 0
let since = 0
let lowSince = 0

export const frame = (): void => {
  if (!since) since = performance.now()
  frames++
}

/** Called when a gesture settles. Silent unless the rate was genuinely poor for long enough. */
export function endFrames(what: string): void {
  if (!since || frames < 10) {
    frames = 0
    since = 0
    return
  }
  const ms = performance.now() - since
  const fps = Math.round((frames * 1000) / ms)
  frames = 0
  since = 0
  if (fps >= 30) {
    lowSince = 0
    return
  }
  // One line per sustained slowdown, not one per gesture: a single slow flick is not news, and a
  // log that cries every time is one nobody reads.
  const now = performance.now()
  if (!lowSince) lowSince = now
  if (now - lowSince < 2000) return
  lowSince = 0
  logEvent('WARN', 'render.slow', { during: what, fps, over: `${Math.round(ms)}ms` })
}

/** Ship whatever is queued. Called when the window is going away. */
export const flushEvents = (): void => ship()
