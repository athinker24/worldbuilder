// Turning values into the log's two shapes. Pure functions, no I/O, no state — so the grammar can
// be reasoned about (and asserted in the db self-check) without a file system.
//
// THE GRAMMAR, and why it is this one. The log has three readers: whoever is building the app,
// whoever is diagnosing a user's problem from a file they were sent, and an LLM being handed the
// file to analyse. The third is the strict one, and satisfying it happens to satisfy the other two:
//
//   time · LEVEL · scope.event · key=value …
//   12:30:14.882  INFO   project.opened      file="Gerçekdünya.dunya" entities=163 maps=4
//
// Fixed columns, a dotted scope, and values that are ALWAYS key=value. One line per event, never
// wrapped, so a model never has to guess where a record ends and grep never lies about a match.
// Errors get a block instead, because a stack cannot be one line and pretending otherwise would
// cost the thing the format is for.

export type Level = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG'

const pad = (n: number, w = 2): string => String(n).padStart(w, '0')

/** Full, unambiguous, with the offset — for headers and error reports. */
export const stamp = (d = new Date()): string => {
  const off = -d.getTimezoneOffset()
  const sign = off < 0 ? '-' : '+'
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ` +
    `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
  )
}

/** Just the clock, to the millisecond — for event lines, where the date is in the header. */
export const clock = (d = new Date()): string =>
  `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`

/** A filename that sorts chronologically as text, so "newest" needs no stat and no date parsing. */
export const fileStamp = (d = new Date()): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
  `_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`

/**
 * Cap a field. Renderer input is untrusted and unbounded, and this file is meant to be sent to
 * someone — a runaway loop must not be able to fill a disk one record at a time.
 */
export const clip = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n)}… [+${s.length - n} chars]` : s

/**
 * `key=value` pairs. A value with a space is quoted so the boundary is never ambiguous, which is
 * the whole reason a model can parse these lines without a schema. Empty values are dropped rather
 * than written as `key=` — an absent field says less than a present-but-empty one, and says it
 * more honestly.
 */
export const kv = (o: Record<string, unknown>): string =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => {
      const s = typeof v === 'string' ? v : String(v)
      return `${k}=${/[\s"]/.test(s) ? JSON.stringify(s) : s}`
    })
    .join(' ')

const SCOPE_W = 22

/** One event, one line. */
export const eventLine = (
  level: Level,
  scope: string,
  data: Record<string, unknown> = {},
  at = new Date()
): string => {
  const body = clip(kv(data), 600)
  return `${clock(at)}  ${level.padEnd(5)}  ${scope.padEnd(SCOPE_W)}${body ? ` ${body}` : ''}`
}

const RULE = '='.repeat(70)

/**
 * A titled block. Used for the session header and for error reports — the two places where the
 * information genuinely does not fit on a line, and where a reader (or a model) benefits from an
 * unmistakable boundary they can copy out on its own.
 */
export const block = (title: string, rows: [string, string][]): string => {
  const out = [RULE, title, RULE]
  for (const [k, v] of rows) {
    if (!v) continue
    // Continuation lines are indented under the field, so a wrapped value is still visibly part of
    // its key rather than looking like a new one.
    const [first, ...rest] = v.split('\n')
    out.push(`${k.padEnd(10)}${first}`)
    for (const line of rest) out.push(' '.repeat(10) + line)
  }
  out.push('')
  return out.join('\n')
}
