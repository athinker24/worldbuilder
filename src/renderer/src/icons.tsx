// SVG icon system, replacing the emoji that stood in for UI iconography.
//
// Why a local path map instead of `npm i lucide-react`: only the icons actually
// used ship, there is no new dependency, and the handful of icons this app needs
// that no generic set has (a BOARD that is visibly not LAYERS, a rank ladder, a
// conquest mark) live beside the stock ones under the same grammar.
//
// The whole family is one system, not a pile of files:
//   · 24×24 design grid, every glyph drawn to the same optical weight
//   · stroke only, `currentColor`, round caps and joins
//   · no fills, no per-icon colour — an icon takes the colour of its context,
//     which is what makes hover/active/disabled a single shared CSS rule
//   · circles are written as arc subpaths so every entry is one `d` string
//
// No emoji in the interface at all any more. The exception this note used to
// carve out — the random-name buttons, "a playful affordance rather than chrome"
// — outlived the rest of them, and one of a kind is worse than a rule: a single
// emoji among 33 icons reads as something nobody got round to. It is `dice` now,
// tinted by gender. Map CONTENT is a different matter and still user data.

export type IconName =
  // structure / navigation
  | 'chevron-right'
  | 'chevron-down'
  | 'chevron-up'
  | 'arrow-up-right'
  | 'arrow-right'
  | 'arrow-left'
  | 'search'
  | 'folder'
  | 'file-text'
  // actions
  | 'plus'
  | 'x'
  | 'trash'
  | 'pencil'
  | 'book-open'
  | 'maximize'
  | 'image'
  | 'star'
  // world concepts
  | 'map'
  | 'map-pin'
  | 'crown'
  | 'users'
  | 'user'
  | 'family-tree'
  | 'link'
  | 'unlink'
  | 'tag'
  | 'landmark'
  | 'calendar'
  | 'clock'
  | 'template'
  // map / drawing
  | 'polygon'
  | 'path'
  | 'label'
  | 'board'
  | 'eye'
  | 'eye-off'
  | 'ruler'
  | 'palette'
  | 'play'
  | 'pause'
  | 'rewind'
  | 'forward'
  | 'settings'
  | 'conquest'
  | 'check'
  | 'grip'
  | 'dice'

// One `d` per icon. Circles are arc pairs: M{cx+r} {cy} a{r} {r} 0 1 1 {-2r} 0 …
const PATHS: Record<IconName, string> = {
  'chevron-right': 'M9 18l6-6-6-6',
  'chevron-down': 'M6 9l6 6 6-6',
  'chevron-up': 'M18 15l-6-6-6 6',
  'arrow-up-right': 'M7 7h10v10M7 17L17 7',
  'arrow-right': 'M5 12h14M13 6l6 6-6 6',
  'arrow-left': 'M19 12H5M11 18l-6-6 6-6',
  search: 'M19 11a8 8 0 1 1-16 0 8 8 0 1 1 16 0M21 21l-4.3-4.3',
  folder:
    'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z',
  'file-text':
    'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7zM14 2v4a2 2 0 0 0 2 2h4M9 13h6M9 17h6',

  plus: 'M5 12h14M12 5v14',
  x: 'M18 6L6 18M6 6l12 12',
  trash:
    'M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6',
  pencil: 'M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z',
  'book-open':
    'M12 7v14M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z',
  maximize:
    'M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3',
  image:
    'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM16.5 8.5a.5.5 0 1 1-1 0 .5.5 0 1 1 1 0M3 16l5-5c.93-.89 2.07-.89 3 0l5 5M14 14l1-1c.93-.89 2.07-.89 3 0l3 3',
  // Drawn to the same optical weight as the rest, so it can be FILLED (the `filled` prop) to say
  // "this one is a favourite" without also changing colour — a hollow and a solid star are the
  // same object in two states, which is what the toggle is.
  star: 'M12 3.4l2.7 5.5 6 .9-4.35 4.2 1.03 6-5.38-2.83L6.6 20l1.03-6L3.28 9.8l6-.9z',

  map: 'M9 3L3 6v15l6-3 6 3 6-3V3l-6 3-6-3zM9 3v15M15 6v15',
  'map-pin':
    'M20 10c0 5-6.4 10.7-7.4 11.5a1 1 0 0 1-1.2 0C10.4 20.7 4 15 4 10a8 8 0 0 1 16 0M15 10a3 3 0 1 1-6 0 3 3 0 1 1 6 0',
  crown: 'M2.5 6.5L7 10l5-6.5L17 10l4.5-3.5L19 18H5zM5 21h14',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M16 7a4 4 0 1 1-8 0 4 4 0 1 1 8 0',
  users:
    'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M13 7a4 4 0 1 1-8 0 4 4 0 1 1 8 0M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  // Custom: a lineage, not a generic org chart — one root branching to two heirs.
  'family-tree':
    'M14 4a2 2 0 1 1-4 0 2 2 0 1 1 4 0M8 20a2 2 0 1 1-4 0 2 2 0 1 1 4 0M20 20a2 2 0 1 1-4 0 2 2 0 1 1 4 0M12 6v4M6 18v-2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2',
  link: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
  unlink:
    'M18.84 12.25l1.72-1.71a5 5 0 0 0-7.07-7.07l-1.72 1.71M5.17 11.75l-1.71 1.71a5 5 0 0 0 7.07 7.07l1.71-1.71M8 2v3M2 8h3M16 19v3M19 16h3',
  tag: 'M12.59 2.59A2 2 0 0 0 11.17 2H4a2 2 0 0 0-2 2v7.17a2 2 0 0 0 .59 1.42l8.7 8.7a2.43 2.43 0 0 0 3.42 0l6.58-6.58a2.43 2.43 0 0 0 0-3.42zM8 7.5a.5.5 0 1 1-1 0 .5.5 0 1 1 1 0',
  landmark:
    'M3 22h18M6 18v-7M10 18v-7M14 18v-7M18 18v-7M11.12 2.2a2 2 0 0 1 1.76 0l7.87 3.85c.47.23.3.95-.23.95H3.48c-.53 0-.7-.72-.22-.95z',
  calendar:
    'M8 2v4M16 2v4M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM3 10h18',
  clock: 'M22 12a10 10 0 1 1-20 0 10 10 0 1 1 20 0M12 6v6l4 2',
  template:
    'M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M9 2h6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM8 12h8M8 16h5',

  // Drawing tools — the shapes they produce, so the toolbar reads as its output.
  polygon:
    'M10.83 2.38a2 2 0 0 1 2.34 0l8 5.74a2 2 0 0 1 .73 2.25l-3.04 9.26a2 2 0 0 1-1.9 1.37H6.04a2 2 0 0 1-1.9-1.37L1.1 10.37a2 2 0 0 1 .73-2.25z',
  path: 'M21 5a2 2 0 1 1-4 0 2 2 0 1 1 4 0M7 19a2 2 0 1 1-4 0 2 2 0 1 1 4 0M5 17A12 12 0 0 1 17 5',
  label: 'M4 7V5h16v2M12 5v14M9 19h6',
  // Custom: BOARD must be visibly not LAYERS — sheets of content over one map,
  // so the base sheet is a map corner and the stack sits on top of it.
  board: 'M3 8l6-3 6 3 6-3v8M3 8v8l6-3 6 3 6-3M9 5v8M15 8v8',
  eye: 'M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0M15 12a3 3 0 1 1-6 0 3 3 0 1 1 6 0',
  // The same eye with the lid drawn down and a stroke through it: "something is hidden".
  'eye-off':
    'M10.7 5.1A10.6 10.6 0 0 1 12 5c5 0 8.7 3.3 9.9 6.6a1 1 0 0 1 0 .7 12.4 12.4 0 0 1-2.5 3.7M6.6 6.6A12.4 12.4 0 0 0 2.1 11.6a1 1 0 0 0 0 .7C3.3 15.7 7 19 12 19a10.9 10.9 0 0 0 4.5-1M9.9 9.9a3 3 0 0 0 4.2 4.2M3 3l18 18',
  ruler:
    'M21.3 8.7L8.7 21.3a1 1 0 0 1-1.4 0l-4.6-4.6a1 1 0 0 1 0-1.4L15.3 2.7a1 1 0 0 1 1.4 0l4.6 4.6a1 1 0 0 1 0 1.4zM7.5 10.5l2 2M10.5 7.5l2 2M13.5 4.5l2 2M4.5 13.5l2 2',
  // Playback: solid-looking triangles built from strokes so they keep the family's
  // weight instead of reading as filled shapes among outlines.
  play: 'M7 4.5v15l13-7.5z',
  pause: 'M9 4v16M15 4v16',
  rewind: 'M20 5v14l-9-7zM11 5v14l-9-7z',
  forward: 'M4 5v14l9-7zM13 5v14l9-7z',
  settings:
    'M15 12a3 3 0 1 1-6 0 3 3 0 1 1 6 0M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6h.08A1.65 1.65 0 0 0 10 3.09V3a2 2 0 0 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.08a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
  // Custom: crossed blades — conquest is this app's own concept.
  conquest:
    'M14.5 17.5L3 6V3h3l11.5 11.5M13 19l6-6M16 16l4 4M19 21l2-2M14.5 6.5L18 3h3v3l-3.5 3.5M9 11L5 15M8 16l-4 4M5 21l-2-2',
  check: 'M20 6L9 17l-5-5',
  // Two columns of dots: the universal "hold here and drag me", drawn with the dot idiom.
  grip: 'M10 6a.5.5 0 1 1-1 0 .5.5 0 1 1 1 0M10 12a.5.5 0 1 1-1 0 .5.5 0 1 1 1 0M10 18a.5.5 0 1 1-1 0 .5.5 0 1 1 1 0M16 6a.5.5 0 1 1-1 0 .5.5 0 1 1 1 0M16 12a.5.5 0 1 1-1 0 .5.5 0 1 1 1 0M16 18a.5.5 0 1 1-1 0 .5.5 0 1 1 1 0',
  palette:
    'M12 22a10 10 0 1 1 10-10 4 4 0 0 1-4 4h-1.5a2 2 0 0 0-1.5 3.3 2 2 0 0 1-1.5 3.3zM8 8.5a.5.5 0 1 1-1 0 .5.5 0 1 1 1 0M12 6.5a.5.5 0 1 1-1 0 .5.5 0 1 1 1 0M16.5 9.5a.5.5 0 1 1-1 0 .5.5 0 1 1 1 0',
  // The 🎲 on the random-name buttons was the last emoji left in the interface — one of a kind
  // is worse than a rule, so it becomes an icon. Pips use the same dot idiom as `palette`.
  dice: 'M8 3h8a5 5 0 0 1 5 5v8a5 5 0 0 1-5 5H8a5 5 0 0 1-5-5V8a5 5 0 0 1 5-5zM9 8.5a.5.5 0 1 1-1 0 .5.5 0 1 1 1 0M12.5 12a.5.5 0 1 1-1 0 .5.5 0 1 1 1 0M16 15.5a.5.5 0 1 1-1 0 .5.5 0 1 1 1 0'
}

interface Props {
  name: IconName
  /** 16 for UI, 20 for the map toolbar. Stroke is scaled to keep optical weight even. */
  size?: number
  className?: string
  /** Decorative by default: the accessible name belongs on the button, not here. */
  title?: string
  /** Playback transport glyphs read as hollow arrowheads at 13px; filling them
      is a deliberate exception, not a property of how their path is written. */
  filled?: boolean
}

export default function Icon({
  name,
  size = 16,
  className,
  title,
  filled
}: Props): React.JSX.Element {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      // Scaled so a 20px icon does not look heavier than a 16px one.
      strokeWidth={(1.75 * 16) / size}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
    >
      {title && <title>{title}</title>}
      <path d={PATHS[name]} />
    </svg>
  )
}
