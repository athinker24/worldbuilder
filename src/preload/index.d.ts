declare global {
  interface Window {
    api: {
      invoke: (method: string, ...args: unknown[]) => Promise<unknown>
      /** Subscribe to application-menu commands. Returns an unsubscribe function. */
      onMenu: (cb: (cmd: string) => void) => () => void
    }
  }
}

export {}
