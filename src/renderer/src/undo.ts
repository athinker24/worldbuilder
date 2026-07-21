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

// Başarısız bir adım (ör. silinmiş bir haritaya çizim geri yüklenmeye çalışılırsa FK hatası)
// yığını BOZMAMALI: kayıt geldiği yığına geri konur, çağırana false döner. Yoksa kayıt yutulur
// ve hata yakalanmamış promise reddi olarak sessizce kaybolurdu.
async function run(
  entry: UndoEntry,
  step: 'undo' | 'redo',
  from: UndoEntry[],
  to: UndoEntry[]
): Promise<boolean> {
  try {
    await entry[step]()
  } catch (err) {
    console.error(`${step} başarısız:`, err)
    from.push(entry)
    return false
  }
  to.push(entry)
  return true
}

/** Son işlemi geri alır; bir şey geri alındıysa true döner. */
export async function undo(): Promise<boolean> {
  const entry = undoStack.pop()
  return entry ? run(entry, 'undo', undoStack, redoStack) : false
}

/** Son geri alınan işlemi yineler; bir şey yinelendiyse true döner. */
export async function redo(): Promise<boolean> {
  const entry = redoStack.pop()
  return entry ? run(entry, 'redo', redoStack, undoStack) : false
}
