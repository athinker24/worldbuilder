// Geri al / yinele yığınları. Her işlem {undo, redo} çifti olarak kaydedilir.
// Kimlik kayması (silinen kaydın yeni id ile geri gelmesi) için çağıranlar
// closure'larda ortak bir mutable ref nesnesi kullanır — bkz. MapView pm:remove.
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
  redoStack.length = 0 // yeni işlem ileri dalı geçersiz kılar
}

/** Son işlemi geri alır; bir şey geri alındıysa true döner. */
export async function undo(): Promise<boolean> {
  const entry = undoStack.pop()
  if (!entry) return false
  await entry.undo()
  redoStack.push(entry)
  return true
}

/** Son geri alınan işlemi yineler; bir şey yinelendiyse true döner. */
export async function redo(): Promise<boolean> {
  const entry = redoStack.pop()
  if (!entry) return false
  await entry.redo()
  undoStack.push(entry)
  return true
}
