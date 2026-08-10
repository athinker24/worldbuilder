import React from 'react'
import { useT } from './i18n'

// Keyboard/mouse shortcuts — single source. The app is full of shortcuts and none were visible
// anywhere; this page opens from the sidebar and F1. New shortcuts must add a row here too.
const GROUPS: { title: string; rows: [string, string][] }[] = [
  {
    title: 'General',
    rows: [
      ['Ctrl+K', 'Search everything (palette)'],
      ['M', 'Go to the map (the last one you were on)'],
      ['Tab', 'Hide every panel (Photoshop style)'],
      ['Shift+Tab', 'Hide panels but keep the map tools'],
      ['Ctrl+N', 'New world'],
      ['Ctrl+S / Ctrl+Shift+S', 'Save world / Save as'],
      ['Ctrl+O', 'Open world'],
      ['Ctrl+Z / Ctrl+Y', 'Undo / Redo'],
      ['Alt+← / Alt+→', 'Back / Forward in history'],
      ['F1', 'This page'],
      ['Del', 'Delete selected entries (in the list)']
    ]
  },
  {
    title: 'Map: selection',
    rows: [
      ['Click', 'Select a drawing'],
      ['Alt+click', 'Select what is underneath (repeat to go further down)'],
      ['Ctrl+click', 'Add/remove from selection (edits apply to all)'],
      ['Del / Backspace', 'Delete selected drawings'],
      ['Esc', 'Cancel conquest / measure / route session']
    ]
  },
  {
    title: 'Map: copy',
    rows: [
      ['Ctrl+C', 'Copy selected drawings'],
      ['Ctrl+V', 'Paste under the cursor (also into another map)'],
      ['Ctrl+D', 'Duplicate in place (slightly offset)']
    ]
  },
  {
    title: 'Map: view & drawing',
    rows: [
      ['Wheel', 'Smooth zoom'],
      ['Shift+wheel', 'Size/thickness: of the selection, or of the active tool default'],
      ['Ctrl+drag a vertex', 'Weld: move the neighbouring polygon vertex along with it'],
      ['Right click on a drawing', 'Menu: event, fork border, delete…']
    ]
  },
  {
    title: 'Notes',
    rows: [
      ['[[', 'Suggest entry names: ↑↓ to pick, Enter/Tab to insert'],
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
      <h2 className="page-title">{t('Shortcuts')}</h2>
      {/* A card per group, laid out in as many columns as the window allows. The whole page used
          to be one narrow stack of 3px table rows: nothing separated a group from the next, and a
          full-width window put a single column of pairs against a metre of empty space. */}
      <div className="sc-grid">
        {GROUPS.map((g) => (
          <section className="sc-group" key={g.title}>
            <h3 className="panel-title">{t(g.title)}</h3>
            <dl className="sc-list">
              {g.rows.map(([k, d]) => (
                <div className="sc-row" key={k}>
                  <dt>
                    {/* "Ctrl+Z / Ctrl+Y" is two keys with a word between them, so it is two caps
                        with a slash between them. Only ' / ' splits: everything else here is
                        either one combination ("Ctrl+C") or a phrase ("Right click on a
                        drawing"), and both are one cap. */}
                    {k.split(' / ').map((part, i) => (
                      <React.Fragment key={i}>
                        {i > 0 && <span className="sc-sep">/</span>}
                        <kbd>{part}</kbd>
                      </React.Fragment>
                    ))}
                  </dt>
                  <dd>{t(d)}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </div>
  )
}
