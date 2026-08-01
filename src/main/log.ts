// The log's public surface. One import for the rest of the app; the parts live in ./log/.
//
// WHAT THIS IS FOR. Three readers, and only one of them is about errors:
//   1. building the app  — where time goes, what ran, how long it took
//   2. a user's report   — diagnosing from a file they sent, with no machine and no follow-up
//   3. an LLM           — the file pasted into Claude or Codex and analysed directly
// The third is what fixes the format (see ./log/format.ts); the discipline it needs happens to be
// what makes the first two readable too.
//
// THE SPLIT, and why it is a split. Each file answers one question and can be changed without
// reading the others:
//   format.ts      what a line looks like        (pure, no I/O — assertable without a disk)
//   sink.ts        where the text goes           (file naming, retention, buffering, the size cap)
//   ring.ts        what the app was just doing   (the last events, for error reports)
//   logger.ts      what is worth saying          (levels, timings, thresholds, the error report)
//   thresholds.ts  every number worth arguing about
// A second destination — a crash reporter, an uploader — is a sibling of sink.ts and nothing else
// changes. That is the whole reason for the shape.
//
// NO ELECTRON, here or below. `node src/main/db.ts` is this project's only test harness and it
// exercises the logger directly; anything needing `app` or a window is passed in from index.ts.

import type { Level } from './log/format.ts'
import * as logger from './log/logger.ts'
import * as ring from './log/ring.ts'

export type { Level } from './log/format.ts'

/**
 * Start a session. Writes the header immediately — a session log that only sometimes exists cannot
 * be asked for by a user, which is the one thing this has to support.
 *
 * `meta` is optional so the db self-check can call this with nothing but a version.
 */
export function initLog(
  dataDir: string,
  appVersion: string,
  ctx: () => Record<string, unknown>,
  meta: Omit<logger.Meta, 'version'> = {}
): void {
  logger.init(dataDir, { version: appVersion, ...meta }, ctx)
}

/** Report a failure with everything needed to diagnose it. Never throws. */
export const logError = (where: string, err: unknown, extra: Record<string, unknown> = {}): void =>
  logger.error(where, err, extra)

/** One event. `scope` is a dotted path: `project.opened`, `map.changed`, `tool.changed`. */
export const logEvent = (
  level: Level,
  scope: string,
  data: Record<string, unknown> = {},
  // Renderer events carry the time they HAPPENED. Without it a whole 500 ms batch shares one
  // instant, and separate actions read as simultaneous.
  at?: Date
): void => logger.event(level, scope, data, at)

/** Time an operation; the returned function ends it and writes the line. */
export const logTime = logger.time

/** DEBUG on or off, per machine (Preferences ▸ Developer). Off costs one boolean test. */
export const logSetDebug = logger.setDebug
export const logDebugEnabled = logger.debugEnabled

/**
 * Remember an IPC call for the trail an error report ends with. Kept as its own entry point (not
 * `logEvent`) because it is called on EVERY call across the bridge: it must stay a push onto an
 * array, never a line in the file.
 */
export const noteCall = (method: string): void => {
  // Reporting is not something the app was DOING when it broke — without this, the act of logging
  // appears in the trail it is writing.
  if (method.startsWith('log')) return
  ring.remember(method)
}

export const flushLog = logger.flush
export const logPath = (): string => logger.dir()
export const logSessionId = logger.id
