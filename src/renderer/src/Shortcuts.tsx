import React from 'react'
import { useT } from './i18n'

// Keyboard/mouse shortcuts — single source. The app is full of shortcuts and none were visible
// anywhere; this page opens from the sidebar and F1. New shortcuts must add a row here too.
const GROUPS: { title: string; rows: [string, string][] }[] = [
  {
    title: 'General',
    rows: [
      ['Ctrl+K', 'Search everything (palette)'],
      ['Tab', 'Hide every panel (Photoshop style)'],
      ['Shift+Tab', 'Hide panels but keep the map tools'],
      ['Ctrl+N', 'New world'],
      ['Ctrl+S / Ctrl+Shift+S', 'Save world / Save as'],
      ['Ctrl+O', 'Open world'],
      ['Ctrl+Z / Ctrl+Y', 'Undo / Redo'],
      ['Alt+← / Alt+→', 'Back / Forward in history'],
      ['F1', 'This page'],
      ['Del', 'Delete selected entities (in the list)']
    ]
  },
  {
    title: 'Map — selection',
    rows: [
      ['Click', 'Select a drawing'],
      ['Ctrl+click', 'Add/remove from selection (edits apply to all)'],
      ['Del / Backspace', 'Delete selected drawings'],
      ['Esc', 'Cancel conquest / measure / route session']
    ]
  },
  {
    title: 'Map — copy',
    rows: [
      ['Ctrl+C', 'Copy selected drawings'],
      ['Ctrl+V', 'Paste under the cursor (also into another map)'],
      ['Ctrl+D', 'Duplicate in place (slightly offset)']
    ]
  },
  {
    title: 'Map — view & drawing',
    rows: [
      ['Wheel', 'Smooth zoom'],
      ['Shift+wheel', 'Size/thickness — of the selection, or of the active tool default'],
      ['Ctrl+drag a vertex', 'Weld: move the neighbouring polygon vertex along with it'],
      ['Right click on a drawing', 'Menu: event, fork border, delete…']
    ]
  },
  {
    title: 'Notes',
    rows: [
      ['[[', 'Suggest entity names — ↑↓ to pick, Enter/Tab to insert'],
      ['Esc', 'Close the suggestion list']
    ]
  },
  {
    title: 'Timeline',
    rows: [
      ['← / →', 'Step one year (while the strip is open)'],
      ['Click the year', 'Type a year by hand']
    ]
  }
]

export default function Shortcuts(): React.JSX.Element {
  const t = useT()
  return (
    <div className="page">
      <h2>{t('⌨ Shortcuts')}</h2>
      {GROUPS.map((g) => (
        <div key={g.title}>
          <h4>{t(g.title)}</h4>
          <table className="shortcut-table">
            <tbody>
              {g.rows.map(([k, d]) => (
                <tr key={k}>
                  <td>
                    <kbd>{k}</kbd>
                  </td>
                  <td>{t(d)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  )
}
