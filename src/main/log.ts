import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'fs'
import { release } from 'os'
import { join } from 'path'

// Error log — written for ONE reader: whoever has to diagnose the fault from the file alone,
// with no access to the machine and no way to ask a follow-up question.
//
// That reader's questions, in the order they get asked, are what the format answers:
//   what broke      -> the message and stack
//   where           -> main/renderer, and the exact entry point (which IPC method, which
//                      component), because "somewhere in the map" is not actionable
//   on what         -> which world file, whether it had unsaved changes
//   doing what      -> the last handful of IPC calls. This is the field that is usually
//                      missing from crash logs and usually the one that solves them: a stack
//                      says where the app was standing, the trail says how it got there.
//   on what build   -> versions, because half of all reports are "fixed three versions ago"
//
// Records are separated by a blank line and start with a line beginning '---', so several
// pasted together stay readable and the boundaries survive copy-paste.
//
// ONE FILE PER RUN, named for when the run started, ten kept. Appending every run to one file is
// the thing that makes a log tiring to use: you open it after a crash and have to work out which
// of a dozen stacked runs is yours, and the only clue is a timestamp you have to read carefully.
// A filename answers that before the file is opened. A run with no errors writes nothing at all,
// so the folder is a list of the runs that had trouble — and if the newest name is not from
// today, today went fine.

let logDir = ''
let sessionId = ''
let sessionLogged = false
let version = 'unknown'
// The run's own file, named on the first error. '' until then — a run that goes well leaves
// nothing behind, so the folder is a list of the runs that had trouble and nothing else.
let file = ''
let capped = false
const MAX_BYTES = 1024 * 1024 // per run; past it the file stops growing and says so
const KEEP = 10 // runs kept, newest first

// The last IPC calls, oldest first. Names only — arguments can hold the user's world content
// and this file is meant to be shareable.
const TRAIL_MAX = 25
const trail: { name: string; n: number }[] = []

/** Context main can answer for itself; the renderer sends its own with each report. */
let context: () => Record<string, unknown> = () => ({})

// appVersion is passed IN rather than read from electron here, so this module stays free of
// Electron imports and can be exercised by the db self-check under plain node — the same reason
// db.ts keeps its distance.
export function initLog(
  dataDir: string,
  appVersion: string,
  ctx: () => Record<string, unknown>
): void {
  logDir = join(dataDir, 'logs')
  version = appVersion
  context = ctx
  // Short and random enough to tell two runs apart; not an identifier of anything.
  sessionId = Math.random().toString(36).slice(2, 8)
  sessionLogged = false
  file = ''
  capped = false
}

/**
 * Name this run's file and clear out old ones. Called once, on the first error.
 *
 * ONE FILE PER RUN, named for when the run started. The alternative — appending every run to one
 * file — is what makes a log tiring to actually use: you open it after a crash and have to work
 * out which of a dozen stacked runs is yours, and the answer is only ever a timestamp you have to
 * read carefully. A filename answers it before the file is open. It is also what the user asked
 * for, having hit exactly that confusion, and what this app already does for backups.
 *
 * Names sort chronologically as text, so "newest" needs no file stats and no date parsing.
 */
function beginFile(): string {
  const names = readdirSync(logDir)
    .filter((n) => /^error-.*\.log$/.test(n))
    .sort()
  // Keep KEEP runs INCLUDING the one about to be written.
  for (const old of names.slice(0, Math.max(0, names.length - (KEEP - 1))))
    rmSync(join(logDir, old), { force: true })
  // Files from the two older naming schemes. Left alone they sit there forever, never updated,
  // looking exactly as current as everything else — the confusion this whole change is about.
  for (const dead of ['error.log', 'error.prev.log', 'error.log.1'])
    rmSync(join(logDir, dead), { force: true })
  const d = new Date()
  const s =
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  // The session id is in the name as well as inside the file. Two launches inside one second
  // would otherwise share a filename and quietly become one file — and it means a record pasted
  // into a message can be traced back to the file it came from.
  return join(logDir, `error-${s}-${sessionId}.log`)
}

export function noteCall(method: string): void {
  // Reporting an error is not something the app was DOING when it broke — without this the act
  // of logging appears in the trail it is writing.
  if (method === 'logRendererError') return
  // Collapse repeats into a count. The renderer polls, so a raw trail is the same handful of
  // reads three times over and the distinct actions — the part that explains anything — scroll
  // off the end. Measured on the first real log this produced: 25 entries carrying 8 events.
  const last = trail[trail.length - 1]
  if (last && last.name === method) {
    last.n++
    return
  }
  trail.push({ name: method, n: 1 })
  if (trail.length > TRAIL_MAX) trail.shift()
}

const pad = (n: number): string => String(n).padStart(2, '0')
const stamp = (): string => {
  const d = new Date()
  const off = -d.getTimezoneOffset()
  const sign = off < 0 ? '-' : '+'
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ` +
    `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
  )
}

const kv = (o: Record<string, unknown>): string =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${typeof v === 'string' && v.includes(' ') ? JSON.stringify(v) : v}`)
    .join(' ')

/** Report an error. `where` is the entry point, not the file — 'ipc:updateFeature',
 *  'renderer:ErrorBoundary', 'main:uncaught'. Never throws: a logger that can fail while
 *  reporting a failure is worse than no logger. */
export function logError(where: string, err: unknown, extra: Record<string, unknown> = {}): void {
  try {
    if (!logDir || capped) return
    mkdirSync(logDir, { recursive: true })
    if (!file) file = beginFile()
    // A runaway loop must not fill the disk one record at a time. Stopping is better than
    // rotating within a run: rotation would throw away the START of the run, which is where the
    // first, uncaused failure is — the one worth reading. Say so in the file rather than just
    // going quiet, or the truncation reads as "nothing else happened".
    if (existsSync(file) && statSync(file).size > MAX_BYTES) {
      capped = true
      appendFileSync(file, `--- ${stamp()} ${sessionId} log capped, later errors dropped\r\n`)
      return
    }

    const lines: string[] = []
    if (!sessionLogged) {
      sessionLogged = true
      lines.push(
        `--- session ${sessionId} started ${stamp()}`,
        `    app     ${kv({
          version,
          electron: process.versions.electron,
          chrome: process.versions.chrome,
          node: process.versions.node
        })}`,
        `    system  ${kv({ platform: process.platform, arch: process.arch, os: release() })}`,
        ''
      )
    }
    const e = err as { message?: string; stack?: string; name?: string }
    const msg = typeof err === 'string' ? err : (e?.message ?? String(err))
    const stackLines = e?.stack
      ? clip(e.stack, 4000)
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
      : []
    // V8's own first stack line is always "Name: message". A hand-built error (renderer IPC
    // failures arrive as {message, stack}, name lost crossing the bridge) has no e.name, so
    // that line is the only place the TYPE survives — read it from there rather than lose it.
    const name = e?.name ?? stackLines[0]?.match(/^(\w+Error):/)?.[1]
    const headline = `${name ? name + ': ' : ''}${msg}`
    lines.push(`--- ${stamp()} ${sessionId} ${where}`)
    lines.push(`    error   ${clip(headline, 500)}`)
    const ctx = kv({ ...context(), ...extra })
    if (ctx) lines.push(`    state   ${clip(ctx, 800)}`)
    if (trail.length)
      lines.push(
        `    doing   ${trail.map((c) => (c.n > 1 ? `${c.name} ×${c.n}` : c.name)).join(' → ')}`
      )
    if (stackLines.length) {
      lines.push('    stack')
      // Drop the first line only once it is CONFIRMED redundant with what `error` already
      // printed — otherwise a stack shaped differently than V8's would silently lose its
      // first frame.
      const body = stackLines[0] === headline ? stackLines.slice(1) : stackLines
      for (const l of body.slice(0, 25)) lines.push('      ' + l)
    }
    lines.push('')
    appendFileSync(file, lines.join('\r\n') + '\r\n', 'utf8')
  } catch {
    /* logging must never become the failure it is reporting */
  }
}

/** Renderer input is untrusted and unbounded — cap every field that reaches the file so a
 *  runaway loop cannot fill the disk one report at a time. */
const clip = (s: string, n: number): string =>
  s.length > n ? s.slice(0, n) + `… [+${s.length - n} chars]` : s

export const logPath = (): string => logDir
