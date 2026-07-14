declare global {
  interface Window {
    api: {
      invoke: (method: string, ...args: unknown[]) => Promise<unknown>
    }
  }
}

export {}
