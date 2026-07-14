import { contextBridge, ipcRenderer } from 'electron'

// Renderer'a açılan tek kapı: main process'teki dar api nesnesine isimle çağrı
const api = {
  invoke: (method: string, ...args: unknown[]): Promise<unknown> =>
    ipcRenderer.invoke('api', method, ...args)
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.api = api
}
