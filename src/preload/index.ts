import { contextBridge, ipcRenderer } from 'electron'

// The single gate exposed to the renderer: named calls into the narrow main-process api object,
// plus one receive-only channel for application-menu clicks (main → renderer, the only traffic
// in that direction). Menu commands arrive as opaque id strings; the renderer maps them onto the
// same functions its own UI calls, so a command never grows a second implementation.
const api = {
  invoke: (method: string, ...args: unknown[]): Promise<unknown> =>
    ipcRenderer.invoke('api', method, ...args),
  onMenu: (cb: (cmd: string) => void): (() => void) => {
    const h = (_e: unknown, cmd: string): void => cb(cmd)
    ipcRenderer.on('menu', h)
    return () => void ipcRenderer.off('menu', h)
  }
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
