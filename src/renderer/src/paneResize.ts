import type { MouseEvent } from 'react'

interface Opts {
  from: number // width when the drag started
  edge: 'left' | 'right' // which side of the panel the handle sits on
  min: number
  max: number
  onMove: (w: number) => void
  onDone?: (w: number) => void // fires once on mouseup — persist here, not per pixel
}

/**
 * Drag-to-resize for a docked side panel. Shared by the left sidebar and the map inspector so
 * both feel identical and the clamping lives in one place.
 *
 * `edge: 'left'` means the handle is on the panel's LEFT (a right-docked panel like the map
 * inspector) — dragging left widens it. `edge: 'right'` is the mirror, for a left-docked panel.
 */
export function startPaneResize(e: MouseEvent, opts: Opts): void {
  e.preventDefault()
  const startX = e.clientX
  let last = opts.from
  const move = (ev: MouseEvent | globalThis.MouseEvent): void => {
    const delta = opts.edge === 'left' ? startX - ev.clientX : ev.clientX - startX
    last = Math.min(opts.max, Math.max(opts.min, opts.from + delta))
    opts.onMove(last)
  }
  const up = (): void => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
    opts.onDone?.(last)
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}
