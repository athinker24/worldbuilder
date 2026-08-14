// The log's decisions: what level a thing is, whether it is slow, what an error report contains.
//
// Deliberately free of Electron. `node tests/db.test.ts` is this project's only test harness and it
// exercises this file directly; anything needing `app` or a window is passed IN (see `Meta` and
// `context`). That is the same reason db.ts keeps its distance from Electron.

import { homedir, release } from 'os'
// `type` on the Level import is load-bearing: `node tests/db.test.ts` runs this file by stripping
// types, and a type pulled in through a value import has nothing left to resolve at runtime.
import type { Level } from './format.ts'
import { block, clip, eventLine, kv, stamp, tag } from './format.ts'
import * as ring from './ring.ts'
import * as sink from './sink.ts'
import { COALESCE_MS, slowFor } from './thresholds.ts'

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

/**
 * The home directory, replaced with `~` in EVERYTHING that reaches the file.
 *
 * It used to be applied to the stack alone, under a comment saying the stack is the one place a
 * real path reaches this file. That was wrong about the most likely failure this app has: a Node
 * filesystem error puts the path in the MESSAGE — `EBUSY: resource busy or locked, open
 * '…\\Documents\\Worldbuilder\\world.db'` — and the message is the report's headline. The
 * app's own startup warning is that exact error, and `edit.*` and `map.baseImage` forward an
 * error string into an ordinary event line too.
 *
 * So it moved to the one door everything goes through, and the five `sink.write` calls became
 * this `write`. A rule applied at four places out of five is a rule that has already failed.
 * `~` keeps the file, the line and the column, which is all a diagnosis ever wanted from a path.
 */
// THREE forms, because one of them is made by this file itself. `kv` quotes any value holding
// whitespace with JSON.stringify, which DOUBLES every backslash — so an fs error message went
// into the line as C:\\Users\\… and a scrub looking for the raw path walked past it.
// The forward-slash form is what a file:// URL in a stack carries. Escaped first: replacing the
// raw path in an already-doubled string would find nothing anyway, but the order says which
// case is the surprising one.
const home = homedir()
// The length guard is not paranoia about the value, it is about what replaceAll would DO with a
// short one: a homedir of `/` on a container or a bare root account would turn every separator
// in the file into a tilde. Nothing real is under four characters.
const homeForms =
  home && home.length >= 4
    ? [JSON.stringify(home).slice(1, -1), home, home.replaceAll('\\', '/')]
    : []
const scrub = (t: string): string => homeForms.reduce((acc, form) => acc.replaceAll(form, '~'), t)
const write = (text: string, now = false, at?: number): void => {
  if (at === undefined) sink.write(scrub(text), now)
  else sink.write(scrub(text), now, at)
}

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
  write(
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
/**
 * How an event reads in the trail: `tool.changed(edit)`, not `tool.changed`.
 *
 * Without the value a trail of three tool changes is three identical words, and the one question
 * it is asked — which tool was live when this broke — is answered on the event lines above and
 * nowhere in the summary that exists to save reading them. The FIRST value is the identifying one
 * by construction: these objects are written subject first (`{tool, from}`, `{map, features}`).
 */
const trailName = (scope: string, data: Record<string, unknown>): string => {
  const v = Object.values(data)[0]
  // A bare `true` says nothing without the key it belonged to — `app.started(false)` is worse
  // than `app.started`.
  if (v === undefined || v === null || v === '' || typeof v === 'boolean') return scope
  const s = String(v)
  // Nothing rather than a value cut mid-word: `renderer.ready(ANGLE (AMD, AMD Rade)` is noise
  // wearing the shape of information. A trail value is an identifier or it is not worth having.
  return s.length > 20 ? scope : `${scope}(${s})`
}

export function event(
  level: Level,
  scope: string,
  data: Record<string, unknown> = {},
  at = new Date()
): void {
  if (level === 'DEBUG' && !debug) return
  ring.remember(trailName(scope, data))
  if (level === 'ERROR') {
    // Written through immediately, and never coalesced: the moment a line is worth keeping is the
    // moment the process might not survive to flush it.
    settle()
    write(eventLine(level, scope, data, at), true, at.getTime())
    return
  }
  hold(level, scope, data, at)
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
//
// The window is in thresholds.ts, beside BATCH_MS, because it has to be LARGER than it — see the
// note there. Renderer events arrive in batches, so a window shorter than the batch can never
// merge two of them.

type Pending = {
  level: Level
  scope: string
  data: Record<string, unknown>
  /** Everything but `took`, so only genuinely identical events merge — see `shape`. */
  shape: string
  at: Date
  /** When the LAST of the run arrived — see `over` in settle(). */
  last: Date
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
  const span = p.last.getTime() - p.at.getTime()
  const data =
    p.n === 1
      ? p.data
      : {
          // Count first: the line reads "twelve of these, taking 5-16ms", which is the order the
          // question is asked in.
          count: `×${p.n}`,
          ...p.data,
          // The spread, not the last value: with a repeat the interesting thing is the range.
          ...(Number.isNaN(p.lo)
            ? {}
            : { took: p.lo === p.hi ? `${p.lo}ms` : `${p.lo}-${p.hi}ms` }),
          // HOW LONG the run lasted. `feature.selected ×6` alone cannot be read: six clicks over
          // four seconds and six fires inside one frame print identically, and they are a user
          // being a user versus a bug. Omitted at 0ms, which is the synchronous-loop case and
          // would just be a column of zeroes.
          ...(span > 0 ? { over: `${span}ms` } : {})
        }
  write(eventLine(p.level, p.scope, data, p.at), false, p.at.getTime())
}

/**
 * Everything but the duration, as a comparable string.
 *
 * Coalescing on the SCOPE alone was wrong and the first log to use it showed why: four tool changes
 * became two lines reading `tool.changed count=×2 tool=polygon from=none`, with two of the four
 * values silently gone. `map.reload features=5` repeated really is the same event; `tool.changed
 * tool=polygon` and `tool.changed tool=line` are two different things that happen to share a name.
 * `took` is excluded because it is the one field expected to differ — that is what the range is for.
 */
const shape = (data: Record<string, unknown>): string =>
  JSON.stringify(Object.entries(data).filter(([k]) => k !== 'took'))

function hold(level: Level, scope: string, data: Record<string, unknown>, at: Date): void {
  const t = tookMs(data)
  if (
    pending &&
    pending.scope === scope &&
    pending.level === level &&
    pending.shape === shape(data)
  ) {
    pending.n++
    pending.last = at
    if (!Number.isNaN(t)) {
      pending.lo = Number.isNaN(pending.lo) ? t : Math.min(pending.lo, t)
      pending.hi = Number.isNaN(pending.hi) ? t : Math.max(pending.hi, t)
    }
  } else {
    settle()
    pending = { level, scope, data, at, last: at, n: 1, lo: t, hi: t, shape: shape(data) }
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
 * The last failure reported, so the same one does not get two blocks.
 *
 * One broken IPC call genuinely produces two reports: main catches it and writes a block, then
 * rethrows so the renderer can show a toast — and the renderer's unhandled rejection reports it
 * again, wrapped (`Error invoking remote method 'api': Error: …`). Both are true; the second one
 * adds a renderer context line and a stack of nothing but the bridge, while doubling the longest
 * part of the file. It gets one line pointing at the block above instead.
 */
const REPEAT_MS = 5000
let lastMsg = ''
let lastAt = 0
let lastWhere = ''

/**
 * A full error report. Everything a diagnosis needs, in one block that can be copied out on its own
 * — the deliberate goal being that a user pastes it into a message and no follow-up question is
 * necessary. `where` is the entry point, not the file: `ipc:updateFeature`, `renderer:onerror`.
 */
export function error(rawWhere: string, err: unknown, extra: Record<string, unknown> = {}): void {
  try {
    // Same treatment as a scope, and for the same reason: `where` arrives from the renderer for
    // every report it files, and it is written raw into the block, into the `error.echo` event
    // line and into the trail. tag() is what keeps all three unforgeable.
    const where = tag(rawWhere)
    const e = err as { message?: string; stack?: string; name?: string }
    const msg = typeof err === 'string' ? err : (e?.message ?? String(err))
    const now = Date.now()
    // One contains the other, because the second report wraps the first rather than repeating it.
    // The length floor keeps a generic "Failed" from swallowing an unrelated failure seconds later.
    const echo =
      lastMsg &&
      now - lastAt < REPEAT_MS &&
      Math.min(msg.length, lastMsg.length) >= 10 &&
      (msg.includes(lastMsg) || lastMsg.includes(msg))
    if (echo) {
      ring.remember(`error:${where}`)
      settle()
      write(eventLine('ERROR', 'error.echo', { where, of: lastWhere }), true, now)
      return
    }
    lastMsg = msg
    lastAt = now
    lastWhere = where
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

    // The frames that are OURS. A React render crash arrives as one useful line followed by nine of
    // react-dom's internals, and the report is read by someone scanning for a file they recognise.
    // Kept whole when filtering would empty it — a stack from inside a library is still a stack.
    const own = body.filter((l) => !l.includes('node_modules'))
    // `component` is the component STACK, which names the screen that broke — the most valuable
    // field a render crash has, and far too long to sit inside the context line.
    const { component, ...rest } = extra
    ring.remember(`error:${where}`)
    settle() // a held line must not surface AFTER the error it came before
    write(
      '\n' +
        block(`ERROR REPORT  ·  session ${sessionId}  ·  ${stamp()}`, [
          ['error', clip(headline, 500)],
          ['where', where],
          ['context', clip(kv({ ...context(), ...rest }), 800)],
          ['screen', component ? scrub(clip(String(component), 500)).replace(/ < /g, '\n< ') : ''],
          ['last', ring.trail()],
          ['stack', (own.length ? own : body).slice(0, 25).map(scrub).join('\n')]
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
export const file = (): string => sink.filePath()
