---
name: map-internals
description: How the map screen actually works — Leaflet + CRS.Simple, the WebGL rendering split (pixiLabels/pixiShapes), the base-image texture, timeline and year filtering, rank and paint modes, pins, labels, paths, boards, multi-select, the context menu, and the measured fixes that must not be retried. Read before editing MapView.tsx, pixiLabels.ts, pixiShapes.ts, ToolPanel.tsx, Timeline.tsx or HierarchyPanel.tsx.
---

# Map internals

**Read [`docs/map-internals.md`](../../../docs/map-internals.md) — the whole thing.**

It lives in `docs/` for the same reason the security gates do: it describes how the map screen
works, not how an agent should behave, and a contributor reading `MapView.tsx` should be able to
find it without knowing what `.claude/` is.

The part that matters most: several of the fixes in there were arrived at by measurement and the
document records the dead ends as well as the answers. Do not re-attempt something it says was
tried and reverted, and do not restructure `reloadFeatures`, `applyYear`, `updateOverlaySizes` or
`rebuildDerivedLabels` for tidiness — their shape is the performance contract.
