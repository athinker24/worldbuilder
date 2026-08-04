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

// The template this started from also carried an `else` that assigned `window.api = api` when
// context isolation was off. That branch has never run — the window is created with
// `sandbox: true` and isolation on — and it is the wrong thing to keep as a fallback: it would
// let the app keep working, silently, with the whole main-process api hanging off the global
// object of a page that renders content from a shared `.dunya`. If isolation is ever lost, this
// should fail loudly instead. A throw here surfaces as `preload-error`, which main logs.
if (!process.contextIsolated) throw new Error('context isolation is required')
contextBridge.exposeInMainWorld('api', api)
