// The last N things the app did, kept so an error report can say how it got there.
//
// A stack says where the app was standing. This says how it arrived, and in practice it is the
// field that solves reports — a crash inside a save is a different bug depending on whether the
// user had just imported a world or just deleted forty features.
//
// Consecutive repeats collapse into a count. Without that, the trail is the same three polling
// reads over and over and the distinct actions — the part that explains anything — scroll off the
// end. Measured on the first real log this produced: 25 entries carrying 8 events.

import { RING_MAX } from './thresholds.ts'

type Entry = { what: string; n: number }

const entries: Entry[] = []

export const remember = (what: string): void => {
  const last = entries[entries.length - 1]
  if (last && last.what === what) {
    last.n++
    return
  }
  entries.push({ what, n: 1 })
  if (entries.length > RING_MAX) entries.shift()
}

export const trail = (): string =>
  entries.map((e) => (e.n > 1 ? `${e.what} ×${e.n}` : e.what)).join(' → ')

export const clear = (): void => {
  entries.length = 0
}
