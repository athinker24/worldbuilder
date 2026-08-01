// The log's decisions: what level a thing is, whether it is slow, what an error report contains.
//
// Deliberately free of Electron. `node src/main/db.ts` is this project's only test harness and it
// exercises this file directly; anything needing `app` or a window is passed IN (see `Meta` and
// `context`). That is the same reason db.ts keeps its distance from Electron.

import { release } from 'os'
// `type` on the Level import is load-bearing: `node src/main/db.ts` runs this file by stripping
// types, and a type pulled in through a value import has nothing left to resolve at runtime.
import type { Level } from './format.ts'
import { block, clip, eventLine, kv, stamp } from './format.ts'
import * as ring from './ring.ts'
import * as sink from './sink.ts'
import { slowFor } from './thresholds.ts'

/** What main knows about the machine at startup; the renderer adds its own later. */
export type Meta = {
  version: string
  electron?: string
  chrome?: string
  node?: string
  memory?: string
}

let sessionId = ''
let debug = false
let started = ''
/** State only the app can answer for — open file, current map, tool, selection, zoom. */
let context: () => Record<string, unknown> = () => ({})

export const id = (): string => sessionId

export function init(dataDir: string, meta: Meta, ctx: () => Record<string, unknown>): void {
  context = ctx
  ring.clear()
  // A line held from the previous session must not land in this one's file.
  if (coalesceTimer) clearTimeout(coalesceTimer)
  coalesceTimer = null
  pending = null
  // Short and random enough to tell two runs apart; not an identifier of anything or anyone.
  sessionId = Math.random().toString(36).slice(2, 8)
  started = stamp()
  if (!sink.open(`${dataDir}/logs`, sessionId)) return
  sink.write(
    block('SESSION START', [
      ['Time', started],
      ['Session', sessionId],
      ['App', meta.version],
      ['System', kv({ platform: process.platform, arch: process.arch, os: release() })],
      [
        'Runtime',
        kv({
          electron: meta.electron ?? process.versions.electron,
          chrome: meta.chrome ?? process.versions.chrome,
          node: meta.node ?? process.versions.node
        })
      ],
      ['Memory', meta.memory ?? '']
    ]),
    true
  )
}

/** DEBUG is per machine and off by default — see the Developer section in Preferences. */
export const setDebug = (on: boolean): void => {
  if (debug === on) return
  debug = on
  event('INFO', 'log.debug', { enabled: on })
}
export const debugEnabled = (): boolean => debug

/**
 * One event. `scope` is a dotted path — `project.opened`, `map.changed`, `tool.changed` — because
 * a consistent namespace is what lets both a person and a model filter without a legend.
 *
 * Nothing in here may be called per frame. The rule is kept by where calls are placed rather than
 * by filtering: a log that has to defend itself against its own callers has already lost.
 */
export function event(level: Level, scope: string, data: Record<string, unknown> = {}): void {
  if (level === 'DEBUG' && !debug) return
  ring.remember(scope)
  if (level === 'ERROR') {
    // Written through immediately, and never coalesced: the moment a line is worth keeping is the
    // moment the process might not survive to flush it.
    settle()
    sink.write(eventLine(level, scope, data), true)
    return
  }
  hold(level, scope, data)
}

// --- Coalescing -------------------------------------------------------------------------------
//
// The first real session log had sixty `map.reload` lines in three seconds, thirteen of them
// sharing a millisecond. Every one was true — a dragged slider really does rebuild every layer that
// often — but sixty identical lines is the "continuous render updates" this log is supposed not to
// contain, and they buried everything else.
//
// So a repeat of the SAME scope inside a short window is held rather than written, and the run
// leaves one line: `map.reload ×13 took=6-20ms`. The fact survives — you can still see it happened
// thirteen times and what the spread was — while the noise does not. It is general on purpose:
// the next scope to get chatty is already handled.

const COALESCE_MS = 400

type Pending = {
  level: Level
  scope: string
  data: Record<string, unknown>
  at: Date
  n: number
  lo: number
  hi: number
}
let pending: Pending | null = null
let coalesceTimer: ReturnType<typeof setTimeout> | null = null

/** ms out of a `took=123ms` field, or NaN when there is none. */
const tookMs = (data: Record<string, unknown>): number => parseInt(String(data.took ?? ''), 10)

/** Write whatever is being held. Called before any other line, so order is never disturbed. */
function settle(): void {
  if (coalesceTimer) {
    clearTimeout(coalesceTimer)
    coalesceTimer = null
  }
  const p = pending
  if (!p) return
  pending = null
  const data =
    p.n === 1
      ? p.data
      : {
          // Count first: the line reads "twelve of these, taking 5-16ms", which is the order the
          // question is asked in.
          count: `×${p.n}`,
          ...p.data,
          // The spread, not the last value: with a repeat the interesting thing is the range.
          ...(Number.isNaN(p.lo) ? {} : { took: p.lo === p.hi ? `${p.lo}ms` : `${p.lo}-${p.hi}ms` })
        }
  sink.write(eventLine(p.level, p.scope, data, p.at))
}

function hold(level: Level, scope: string, data: Record<string, unknown>): void {
  if (pending && pending.scope === scope && pending.level === level) {
    const t = tookMs(data)
    pending.n++
    if (!Number.isNaN(t)) {
      pending.lo = Number.isNaN(pending.lo) ? t : Math.min(pending.lo, t)
      pending.hi = Number.isNaN(pending.hi) ? t : Math.max(pending.hi, t)
    }
  } else {
    settle()
    const t = tookMs(data)
    pending = { level, scope, data, at: new Date(), n: 1, lo: t, hi: t }
  }
  if (coalesceTimer) clearTimeout(coalesceTimer)
  coalesceTimer = setTimeout(settle, COALESCE_MS)
}

/**
 * Time an operation. Returns the stop function; the duration is one INFO line, or a WARN when it
 * runs past what that operation is allowed (see thresholds.ts).
 *
 *     const done = time('project.load')
 *     …
 *     done({ entities: 163 })
 */
export function time(
  scope: string,
  data: Record<string, unknown> = {}
): (extra?: Record<string, unknown>) => number {
  const t0 = Date.now()
  return (extra: Record<string, unknown> = {}) => {
    const took = Date.now() - t0
    const limit = slowFor(scope)
    event(took > limit ? 'WARN' : 'INFO', scope, {
      ...data,
      ...extra,
      took: `${took}ms`,
      ...(took > limit ? { threshold: `${limit}ms` } : {})
    })
    return took
  }
}

/**
 * A full error report. Everything a diagnosis needs, in one block that can be copied out on its own
 * — the deliberate goal being that a user pastes it into a message and no follow-up question is
 * necessary. `where` is the entry point, not the file: `ipc:updateFeature`, `renderer:onerror`.
 */
export function error(where: string, err: unknown, extra: Record<string, unknown> = {}): void {
  try {
    const e = err as { message?: string; stack?: string; name?: string }
    const msg = typeof err === 'string' ? err : (e?.message ?? String(err))
    const stackLines = e?.stack
      ? clip(e.stack, 4000)
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
      : []
    // V8's first stack line is always "Name: message". An error rebuilt from IPC has lost its
    // `name`, so that line is the only place the TYPE survives — read it back rather than lose it.
    const name = e?.name ?? stackLines[0]?.match(/^(\w+Error):/)?.[1]
    const headline = `${name ? `${name}: ` : ''}${msg}`
    const body = stackLines[0] === headline ? stackLines.slice(1) : stackLines

    ring.remember(`error:${where}`)
    settle() // a held line must not surface AFTER the error it came before
    sink.write(
      '\n' +
        block(`ERROR REPORT  ·  session ${sessionId}  ·  ${stamp()}`, [
          ['error', clip(headline, 500)],
          ['where', where],
          ['context', clip(kv({ ...context(), ...extra }), 800)],
          ['last', ring.trail()],
          ['stack', body.slice(0, 25).join('\n')]
        ]),
      true
    )
  } catch {
    /* logging must never become the failure it is reporting */
  }
}

/** Settle first: a held line that never reached the sink would not be flushed by flushing it. */
export const flush = (): void => {
  settle()
  sink.flush()
}
export const dir = (): string => sink.path()
