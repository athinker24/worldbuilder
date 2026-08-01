// Every number the log system decides anything by, in one place.
//
// They are here rather than beside their uses for one reason: a threshold is a JUDGEMENT, not a
// mechanism. "Slow" and "too much memory" change with the machine, the world size and what we have
// just optimised — three times in the last week — and each change should be one edit in a file
// whose whole content is up for argument, not a hunt through code that works.

/** How long an operation may take before its line is raised from INFO to WARN. */
export const SLOW_MS: Record<string, number> = {
  // The fallback for anything not named below.
  default: 1000,
  'project.load': 3000, // reads the whole world out of SQLite
  'world.unpack': 5000, // copies a file, extracts every embedded image
  'world.pack': 3000,
  'project.save': 2000,
  'map.reload': 800, // rebuilds every layer; the map is unresponsive for the duration
  'notes.export': 4000
}

export const slowFor = (scope: string): number => SLOW_MS[scope] ?? SLOW_MS.default

/** Total across all Electron processes. Past this, say so once rather than every sample. */
export const MEMORY_WARN_MB = 1500
/** A jump this size between samples is worth a line even below the warning level. */
export const MEMORY_STEP_MB = 250
export const MEMORY_SAMPLE_MS = 30_000

/** Frames per second below which a gesture is worth reporting, and for how long. */
export const FPS_FLOOR = 30
export const FPS_SUSTAIN_MS = 2000

/** Retention, applied on launch. Both, because each answers a different runaway. */
export const KEEP_FILES = 200 // a hundred launches in a day
export const KEEP_DAYS = 30 // one launch a month for years

/** One run's file stops growing here. See sink.ts for why it stops rather than rotates. */
export const MAX_BYTES = 1024 * 1024
/** How long a written line may sit in memory before it reaches the disk. ERROR never waits. */
export const FLUSH_MS = 1000
/** How long the renderer may hold events before shipping a batch over IPC. */
export const BATCH_MS = 500
/** Events kept for an error report. */
export const RING_MAX = 50
