import { contextBridge, ipcRenderer } from 'electron'

// The single gate exposed to the renderer: named calls into the narrow main-process api object
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
