// Where the text goes: this run's file, and the housekeeping around it.
//
// ONE FILE PER SESSION, named for when the session started. Appending every run to one file is what
// makes a log tiring to actually use — you open it after a crash and have to work out which of a
// dozen stacked runs is yours, with a timestamp as the only clue. A filename answers that before
// the file is open, and it is what this app already does for backups.
//
// Names sort chronologically as text, so pruning needs no `stat` and no date parsing.

import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { fileStamp } from './format.ts'
import { FLUSH_MS, KEEP_DAYS, KEEP_FILES, MAX_BYTES } from './thresholds.ts'

const NAME = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_.*\.log$/
/** Files from the error-only scheme this replaced. Removed so they stop looking current. */
const LEGACY = /^error[-.]/

let dir = ''
let file = ''
let queue: string[] = []
let timer: ReturnType<typeof setTimeout> | null = null
let capped = false

/**
 * Buffered rather than written straight through.
 *
 * The error-only logger wrote synchronously because errors are rare and losing one to a crash is
 * unacceptable. Events are neither: they arrive in bursts and a synchronous write per event would
 * put a disk round trip in the path of ordinary work. So lines queue and flush on a timer — and
 * ERROR flushes immediately (see logger.ts), which means the case where losing a line would matter
 * is exactly the case that never waits.
 */
const schedule = (): void => {
  if (timer) return
  timer = setTimeout(flush, FLUSH_MS)
}

export const flush = (): void => {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  if (!file || !queue.length) return
  const text = queue.join('\r\n') + '\r\n'
  queue = []
  try {
    appendFileSync(file, text, 'utf8')
  } catch {
    /* a logger that throws while reporting is worse than no logger */
  }
}

export const write = (text: string, now = false): void => {
  if (!file || capped) return
  queue.push(text)
  if (now) flush()
  else schedule()
  // Checked after writing, so the line that crossed the limit is kept whole rather than half.
  // STOPPING beats rotating within a run: rotating would discard the START of the session, which
  // is where the first, uncaused failure is — the one worth reading. Say so, because a truncation
  // that goes quiet reads as "nothing else happened".
  try {
    if (!queue.length && statSync(file).size > MAX_BYTES) {
      capped = true
      appendFileSync(file, '--- log capped, later lines dropped\r\n', 'utf8')
    }
  } catch {
    /* ignore */
  }
}

/** Delete what is too old and what is too plentiful. Called once, when a session file is opened. */
const prune = (): void => {
  const cutoff = Date.now() - KEEP_DAYS * 86_400_000
  const names = readdirSync(dir).sort()
  for (const n of names) {
    if (LEGACY.test(n)) {
      rmSync(join(dir, n), { force: true })
      continue
    }
    if (!NAME.test(n)) continue
    try {
      if (statSync(join(dir, n)).mtimeMs < cutoff) rmSync(join(dir, n), { force: true })
    } catch {
      /* ignore */
    }
  }
  // By count, after by age: the age pass is what usually empties the folder, and doing it first
  // means this rarely has anything left to do.
  const left = readdirSync(dir)
    .filter((n) => NAME.test(n))
    .sort()
  for (const old of left.slice(0, Math.max(0, left.length - (KEEP_FILES - 1))))
    rmSync(join(dir, old), { force: true })
}

/** Start this session's file. Returns false when the folder cannot be written — never throws. */
export const open = (logDir: string, sessionId: string): boolean => {
  try {
    dir = logDir
    queue = []
    capped = false
    mkdirSync(dir, { recursive: true })
    prune()
    // The session id is in the name as well as inside the file: two launches in one second would
    // otherwise share a filename and quietly become one file, and it lets a record pasted into a
    // message be traced back to the file it came from.
    file = join(dir, `${fileStamp()}_${sessionId}_session.log`)
    return true
  } catch {
    file = ''
    return false
  }
}

export const close = (): void => flush()

export const path = (): string => dir
export const filePath = (): string => file
export const isOpen = (): boolean => file !== '' && existsSync(dir)
