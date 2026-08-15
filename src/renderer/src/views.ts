import type { OverviewTab } from './Overview'

/**
 * Where the main area currently is.
 *
 * Workspaces (places you go) vs commands (things you do): the commands all live in the
 * application menu, so every kind here is somewhere the main area can show.
 *
 * In its own file rather than App's because the sidebar needs it too, and App imports the
 * sidebar — a type exported from App would be a cycle for the sake of one union.
 */
export type View =
  | { kind: 'empty' }
  | { kind: 'entity'; id: number }
  | { kind: 'map'; id: number }
  | { kind: 'preferences' } // application preferences (language, theme)
  | { kind: 'projectPrefs' } // the open project's structure (ranks, map modes, templates)
  | { kind: 'overview'; tab: OverviewTab } // Atlas / Chronology / Relations
  | { kind: 'shortcuts' }
