import { logEvent } from './log'

// Undo / redo stacks. Every operation is recorded as an {undo, redo} pair.
// For identity drift (a deleted row returning under a new id) callers share a mutable
// ref object across the closures — see MapView pm:remove.
export interface UndoEntry {
  undo: () => Promise<unknown>
  redo: () => Promise<unknown>
}

const undoStack: UndoEntry[] = []
const redoStack: UndoEntry[] = []
const MAX = 50

export function pushUndo(entry: UndoEntry): void {
  undoStack.push(entry)
  if (undoStack.length > MAX) undoStack.shift()
  redoStack.length = 0 // a new operation invalidates the forward branch
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
    return false
  }
  to.push(entry)
  logEvent('INFO', `edit.${step}`, { undo: undoStack.length, redo: redoStack.length })
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
