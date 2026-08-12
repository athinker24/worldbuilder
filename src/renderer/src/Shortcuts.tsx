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
      ['Ctrl++ / Ctrl+-', 'Make the interface bigger / smaller'],
      ['Ctrl+0', 'Interface back to 100%'],
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
      // One row, not two: Escape does the innermost of these that is running. A second row under
      // the same key would read as two different bindings.
      ['Esc', 'Leave the active tool; cancel a conquest / measure / route session']
    ]
  },
  {
    // Mnemonics in English so the keys do not move when the interface language does. Scale and
    // Route have none on purpose — a map is calibrated once, a route is asked for now and then,
    // and a key is for what you reach for in a loop.
    title: 'Map: tools',
    rows: [
      // Named as TOOLS, not as actions: "Draw a path" is already an undo label ("Yol çizildi"),
      // and in a scheme where the English text IS the translation key that row would have come
      // out in the past tense.
      ['R', 'Region tool (polygon)'],
      ['P', 'Path tool'],
      ['L', 'Location tool (pin)'],
      ['T', 'Label tool (text)'],
      ['E', 'Edit mode (the vertices of the selected drawing)'],
      ['V', 'Move mode'],
      ['D', 'Delete mode'],
      ['The same key again', 'Puts the tool away — as Esc and the toolbar button do']
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
      ['Right click on a drawing', 'Menu: recolour, edit shape, event, fork border, delete…'],
      ['Right click on the map', 'Menu: pick a drawing tool, or paste at that point']
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
    /* `wide`, like the Overview pages: .page's 900px cap is a MEASURE cap for reading, and this
       page is a table. It also made .sc-grid's own 1100px cap unreachable, so the "as many
       columns as the window gives us" comment below described a grid that could never be more
       than two. */
    <div className="page wide">
      <div className="page-head">
        <h2 className="page-title">{t('Shortcuts')}</h2>
      </div>
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
