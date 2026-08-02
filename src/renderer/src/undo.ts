import { logEvent } from './log'

// Undo / redo stacks. Every operation is recorded as an {undo, redo} pair.
// For identity drift (a deleted row returning under a new id) callers share a mutable
// ref object across the closures — see MapView pm:remove.
export interface UndoEntry {
  undo: () => Promise<unknown>
  redo: () => Promise<unknown>
  /**
   * What the user did, for the History panel.
   *
   * The ENGLISH TEXT IS THE KEY, exactly as everywhere else in this app (see i18n.tsx) — the
   * panel translates at render time. Storing the translated string instead would freeze each
   * entry in whatever language was active when it happened, so a list read after switching
   * languages would be half Turkish.
   */
  label: string
  params?: Record<string, string | number>
}

const undoStack: UndoEntry[] = []
const redoStack: UndoEntry[] = []
const MAX = 50

// --- Subscription, for the History panel -------------------------------------------------------
//
// These are two plain arrays that anything may push to, so React cannot see a change happen. The
// store pattern (subscribe + a cached snapshot) is what `useSyncExternalStore` wants and needs no
// dependency. The snapshot MUST be cached and only replaced when something actually changes:
// returning a fresh object each call re-renders forever.

export type HistoryStep = { label: string; params?: Record<string, string | number> }
export type History = {
  /** Oldest first: everything done, then everything undone but still redoable. */
  steps: HistoryStep[]
  /** How many of them are currently applied — so `steps[i]` is applied iff `i < applied`. */
  applied: number
}

const listeners = new Set<() => void>()
let snapshot: History = { steps: [], applied: 0 }

const rebuild = (): void => {
  const step = (e: UndoEntry): HistoryStep => ({ label: e.label, params: e.params })
  snapshot = {
    // redoStack is a STACK — its last element is the next redo, so the chronological order of the
    // undone tail is that array reversed.
    steps: [...undoStack.map(step), ...[...redoStack].reverse().map(step)],
    applied: undoStack.length
  }
  for (const fn of listeners) fn()
}

export const subscribeHistory = (fn: () => void): (() => void) => {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
export const getHistory = (): History => snapshot

export function pushUndo(entry: UndoEntry): void {
  undoStack.push(entry)
  if (undoStack.length > MAX) undoStack.shift()
  redoStack.length = 0 // a new operation invalidates the forward branch
  rebuild()
}

// A failing step (e.g. an FK error restoring a feature onto a deleted map) must NOT corrupt
// the stack: the entry is pushed back where it came from and the caller gets false. Otherwise
// the entry was swallowed and the error vanished as an unhandled promise rejection.
async function run(
  entry: UndoEntry,
  step: 'undo' | 'redo',
  from: UndoEntry[],
  to: UndoEntry[]
): Promise<boolean> {
  try {
    await entry[step]()
  } catch (err) {
    console.error(`${step} failed:`, err)
    // Logged HERE rather than at the two callers (the menu and the keyboard branch) so the record
    // exists once however it was triggered — and a failed undo is exactly the kind of quiet
    // half-success that is impossible to reconstruct afterwards without one.
    logEvent('WARN', `edit.${step}`, { ok: false, error: String(err).slice(0, 120) })
    from.push(entry)
    rebuild()
    return false
  }
  to.push(entry)
  logEvent('INFO', `edit.${step}`, { undo: undoStack.length, redo: redoStack.length })
  rebuild()
  return true
}

/** Undo the last operation; returns true when something was undone. */
export async function undo(): Promise<boolean> {
  const entry = undoStack.pop()
  return entry ? run(entry, 'undo', undoStack, redoStack) : false
}

/** Redo the last undone operation; returns true when something was redone. */
export async function redo(): Promise<boolean> {
  const entry = redoStack.pop()
  return entry ? run(entry, 'redo', redoStack, undoStack) : false
}

/**
 * Jump to a point in the history: apply exactly `target` steps, undoing or redoing as needed.
 *
 * Repeated single steps rather than a shortcut, because every entry's closures assume the state
 * the step before it left behind — and identity drift (a deleted row returning under a NEW id,
 * carried in a shared ref object) means they must run in order or they mend the wrong row.
 *
 * Stops at the first failure and reports how far it got: `run` has already put the failed entry
 * back, so the stacks are intact and the app is at a real point in its own history, just not the
 * one that was asked for.
 */
export async function goTo(target: number): Promise<number> {
  while (undoStack.length > target) if (!(await undo())) break
  while (undoStack.length < target && redoStack.length) if (!(await redo())) break
  return undoStack.length
}
