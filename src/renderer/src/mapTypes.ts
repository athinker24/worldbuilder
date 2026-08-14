// The map screen's shared vocabulary: the tool list, what a drawing's style is made of, and the
// small records the scale, travel and navigation features pass around.
//
// These were declared inside ToolPanel.tsx, which made a settings PANEL the module of record for
// types that have nothing to do with it — and the dependency that fell out of it was the tell:
// Atlas.tsx, a read-only statistics page, imported `MapScale` from the map's drawing panel. The
// panel is one consumer of this vocabulary now, like MapToolbar and MapView.
//
// Values as well as types, deliberately: DEFAULT_DRAW, TOOLS and the label maps are the same kind
// of thing — one declaration of what a tool is called and what a new drawing starts out as — and
// splitting them across two files would only mean remembering which half to look in.
import { IconName } from './icons'
import { PinShape } from './pinIcons'

export type Tool =
  'polygon' | 'line' | 'marker' | 'label' | 'scale' | 'nav' | 'edit' | 'drag' | 'remove'

// Map scale (the shape of MapView's settings 'mapScales' record)
export interface MapScale {
  perUnit: number
  unit: string
}

// Travel mode (settings 'travelModes', global): speed = map units/day
export interface TravelMode {
  name: string
  speed: number
}

// Navigation route (computed in MapView, displayed in the panel)
export interface NavLeg {
  fid: number // -1 = off-road
  name: string | null
  px: number
}
export interface NavRoute {
  totalPx: number
  offRoadPx: number
  legs: NavLeg[]
  pts: number[][]
}

export type LineDash = 'solid' | 'dashed' | 'dotted'
// Path direction arrow: none / at the end (destination — campaign/migration direction)
export type LineArrow = 'none' | 'end'

export interface DrawSettings {
  // img: custom pin image (assets/-relative path); plain colored badge without one
  marker: {
    size: number
    color: string
    shape?: PinShape
    img?: string
    imgFree?: boolean
    imgAR?: number
  }
  // fillImg: fill image (assets/-relative path) — the polygon is tiled via an SVG pattern
  polygon: {
    color: string
    fillOpacity: number
    weight: number
    font: string
    fillImg?: string
  }
  line: {
    color: string
    weight: number
    opacity: number
    dash: LineDash
    arrow: LineArrow
    curviness: number // 0-100; render-only curvature
  }
  // Free text label: map text with no polygon or pin behind it, optionally curved
  label: {
    text: string
    color: string
    font: string
    size: number
    angle: number
    curve: number // -100..100; 0 = straight (SVG textPath arc)
    halo: LabelHalo // paper-coloured behind dark ink, dark behind light text, or none at all
    haloWidth: number // fraction of the font size
    tracking: number // letter spacing, fraction of the font size
    bold: boolean
    italic: boolean
  }
}

export const DEFAULT_DRAW: DrawSettings = {
  marker: { size: 1, color: '#c0603a' },
  polygon: { color: '#7bb3ff', fillOpacity: 0.25, weight: 2, font: 'Cinzel' },
  line: { color: '#b08968', weight: 3, opacity: 0.9, dash: 'solid', arrow: 'none', curviness: 0 },
  label: {
    text: '',
    color: '#ffffff',
    font: 'Cinzel',
    size: 1,
    angle: 0,
    curve: 0,
    halo: 'dark',
    haloWidth: 0.08,
    tracking: 0,
    bold: false,
    italic: false
  }
}

export type LabelHalo = 'none' | 'light' | 'dark'
export const LABEL_HALOS: LabelHalo[] = ['none', 'light', 'dark']
export const HALO_LABELS: Record<LabelHalo, string> = {
  none: 'No halo',
  light: 'Light halo',
  dark: 'Dark halo'
}

export const LINE_ARROWS: LineArrow[] = ['none', 'end']
export const ARROW_LABELS: Record<LineArrow, string> = {
  none: 'No arrow',
  end: 'Arrow at end'
}

// Convert the line pattern to a Leaflet dashArray (proportional to weight; dotted + round cap = dots)
export const lineDashArray = (dash: LineDash | undefined, weight: number): string =>
  dash === 'dashed' ? `${weight * 3} ${weight * 2}` : dash === 'dotted' ? `0 ${weight * 2.5}` : ''

export const LINE_DASHES: LineDash[] = ['solid', 'dashed', 'dotted']
export const DASH_LABELS: Record<LineDash, string> = {
  solid: 'Solid',
  dashed: 'Dashed',
  dotted: 'Dotted'
}

// Label fonts (bundled via @fontsource, OFL-licensed)
export const FONTS = ['Cinzel', 'IM Fell English', 'MedievalSharp', 'Uncial Antiqua', 'system-ui']

// Exported so MapToolbar can show the same icon and name for the subset it displays — one source
// for tool labels, whichever container renders the buttons. Drawing tools carry the icon of the
// SHAPE they produce, so the palette reads as its own output.
export const TOOLS: { key: Tool; icon: IconName; name: string; hint?: string }[] = [
  { key: 'polygon', icon: 'polygon', name: 'Polygon' },
  { key: 'line', icon: 'path', name: 'Path', hint: 'Draw roads, routes, borders as lines.' },
  { key: 'marker', icon: 'map-pin', name: 'Location' },
  {
    key: 'label',
    icon: 'label',
    name: 'Label',
    hint: 'Free text on the map: name seas, mountain ranges, regions.'
  },
  {
    key: 'scale',
    icon: 'ruler',
    name: 'Scale',
    hint: 'Set the map scale; measure distance and area without drawing.'
  },
  {
    key: 'nav',
    icon: 'map',
    name: 'Navigate',
    hint: 'Pick two pins; the route follows your drawn paths.'
  },
  {
    key: 'edit',
    icon: 'pencil',
    name: 'Edit',
    hint: 'Drag the corner points of drawings to change their shape.'
  },
  { key: 'drag', icon: 'maximize', name: 'Move', hint: 'Drag drawings to move them.' },
  {
    key: 'remove',
    icon: 'trash',
    name: 'Delete',
    hint: 'Clicked drawing is deleted (undo with Ctrl+Z).'
  }
]
