// Run every settings loader in api.ts against hostile values, with the IPC bridge stubbed.
// A loader must never throw and must never hand back something its caller will trip over.
const settings = new Map()
globalThis.window = {
  api: {
    invoke: async (method, ...args) => {
      if (method === 'getSetting') return settings.get(args[0]) ?? null
      if (method === 'setSetting') return void settings.set(args[0], args[1])
      return null
    }
  }
}

const A = await import('./src/renderer/src/api.ts')

const HOSTILE = [
  null,
  '',
  'hello', // not JSON at all, and the gate only checks values that LOOK like JSON
  '{',
  '[1,2,3]',
  '{"a":1}',
  'null',
  'true',
  '"a string"',
  '[null,null,null]',
  '[[[[[]]]]]',
  '{"dims":"not-an-array","colors":7}',
  '{"govs":"nope"}',
  '{"govs":[null,{"name":5,"tags":"x"},{"tags":[1,null,"ok"]}]}',
  '{"periods":[null],"events":[null],"min":"x","max":null,"year":{}}',
  '{"list":"x","active":9}',
  JSON.stringify(Array.from({ length: 50_000 }, (_, i) => 'x' + i)),
  '{"__proto__":{"pwned":true}}',
  '[{"__proto__":{"pwned":true}}]',
  // Keyed by map id 1, which is the id every per-map loader below is asked for. Without these the
  // per-map cases are vacuous: nothing else in this list has a "1" key, so the loader would answer
  // "absent" every time and pass no matter what it did with a value it FOUND.
  '{"1":"not a number"}',
  '{"1":[1,2,3]}',
  '{"1":{"perUnit":"x","list":7,"active":[]}}'
]

const LOADERS = [
  [
    'hierarchyConfig',
    A.getHierConfig,
    (r) => Array.isArray(r.govs) && r.govs.every((g) => Array.isArray(g.tags))
  ],
  ['mapModes', A.getMapModes, (r) => Array.isArray(r.dims) && typeof r.colors === 'object'],
  ['templates', A.getTemplates, (r) => Array.isArray(r)],
  ['entityFolders', A.getEntityFolders, (r) => Array.isArray(r)],
  ['favorites', A.getFavorites, (r) => Array.isArray(r) && r.every((v) => typeof v === 'number')],
  ['pinImages', A.getPinImages, (r) => Array.isArray(r)],
  [
    'timeline',
    A.getTimeline,
    (r) => Array.isArray(r.periods) && Number.isFinite(r.min) && Number.isFinite(r.year)
  ],
  ['recentColors', A.getRecentColors, (r) => Array.isArray(r)],
  [
    'mapBoards',
    () => A.getMapBoards(1),
    (r) => Array.isArray(r.list) && typeof r.active === 'string'
  ],
  // Per-map keys. `mapYears` feeds the year slider and yearRef, so anything but a finite number is
  // NaN spreading through every date comparison on the map — undefined is the honest answer, and
  // the caller falls back to the world's year.
  ['mapYears', () => A.getMapYear(1), (r) => r === undefined || Number.isFinite(r)],
  // perMapEntry is what every per-map read goes through, including the legacy fallbacks in MapView
  // that hand it the WHOLE value. It must survive being pointed at a list, a string or a number.
  ['mapScales', async () => A.perMapEntry(await A.perMapRaw('mapScales'), 1), () => true]
]

let fails = 0
for (const [key, load, ok] of LOADERS) {
  for (const v of HOSTILE) {
    settings.clear()
    if (v !== null) settings.set(key, v)
    // getRecentColors caches at module level; clear it the only way a caller can.
    let out, err
    try {
      out = await load()
    } catch (e) {
      err = e
    }
    const short = v === null ? '(absent)' : v.length > 44 ? v.slice(0, 44) + '…' : v
    if (err) {
      console.log(`THREW  ${key.padEnd(15)} ${short}  → ${err.message}`)
      fails++
    } else if (!ok(out)) {
      console.log(`SHAPE  ${key.padEnd(15)} ${short}  → ${JSON.stringify(out).slice(0, 90)}`)
      fails++
    }
  }
}

// READ-MODIFY-WRITE. A saver that reads the current value, changes part of it and writes the whole
// thing back is where a hostile value stops being the FILE's problem and becomes the world's: it
// gets persisted into whatever the user saves next, and from then on it is their data. What must
// hold is that after any save, the stored value still parses and still has the shape its loader
// expects — whatever was there before.
const ROUNDTRIP = [
  [
    'mapBoards',
    async () => A.saveMapBoards(1, { list: [{ id: 'a', name: 'Board' }], active: 'a' }),
    (v) => {
      const o = JSON.parse(v)
      return o && typeof o === 'object' && !Array.isArray(o) && Array.isArray(o['1'].list)
    }
  ],
  [
    'recentColors',
    () => A.pushRecentColor('#AABBCC'),
    (v) => {
      const l = JSON.parse(v)
      return Array.isArray(l) && l.length <= 12 && l.every((c) => /^#[0-9a-fA-F]{3,8}$/.test(c))
    }
  ],
  // savePerMap is the sharpest read-modify-write in the file: it reads the whole `{[mapId]: value}`
  // object, changes ONE entry and writes it all back, so a hostile value under any of the five
  // per-map keys would be re-persisted into the user's own world. What must hold is that the
  // result is always an object keyed by map id — a list or a string there is replaced, not merged.
  [
    'mapYears',
    () => A.saveMapYear(1, 1200),
    (v) => {
      const o = JSON.parse(v)
      return o && typeof o === 'object' && !Array.isArray(o) && o['1'] === 1200
    }
  ],
  // Delete-a-map and undo it: the entry must be gone after the take and back after the restore,
  // whatever was in the key to begin with. This is what stops a recycled map id inheriting it.
  [
    'mapScales',
    async () => {
      await A.savePerMap('mapScales', 1, { perUnit: 2, unit: 'km' })
      const saved = await A.takeMapSettings(1)
      if (A.perMapEntry(await A.perMapRaw('mapScales'), 1) !== undefined)
        throw new Error('takeMapSettings left the entry behind')
      await A.restoreMapSettings(1, saved)
    },
    (v) => {
      const o = JSON.parse(v)
      return o && typeof o === 'object' && !Array.isArray(o) && o['1'].unit === 'km'
    }
  ]
]
for (const [key, save, ok] of ROUNDTRIP) {
  for (const v of HOSTILE) {
    settings.clear()
    if (v !== null) settings.set(key, v)
    // pushRecentColor caches at module level, so each case needs the module's view reset. The only
    // handle a caller has is the getter, so the cache is refilled from the value under test first.
    if (key === 'recentColors') {
      const mod = await import('./src/renderer/src/api.ts?bust=' + encodeURIComponent(String(v)))
      try {
        await mod.pushRecentColor('#AABBCC')
      } catch (e) {
        console.log(`THREW  save:${key.padEnd(10)} ${String(v).slice(0, 30)} → ${e.message}`)
        fails++
        continue
      }
    } else {
      try {
        await save()
      } catch (e) {
        console.log(`THREW  save:${key.padEnd(10)} ${String(v).slice(0, 30)} → ${e.message}`)
        fails++
        continue
      }
    }
    const stored = settings.get(key)
    let good = false
    try {
      good = ok(stored)
    } catch {
      good = false
    }
    if (!good) {
      const short = v === null ? '(absent)' : String(v).slice(0, 40)
      console.log(`WROTE  save:${key.padEnd(10)} ${short} → ${String(stored).slice(0, 80)}`)
      fails++
    }
  }
}

// The pure helpers, with the kind of values a .world can carry.
const pure = [
  [
    'getYearRecs garbage',
    () => A.getYearRecs('{"parent":"[null,5,{\\"id\\":\\"x\\"},{\\"id\\":3}]"}', 'parent')
  ],
  ['getYearRecs non-json', () => A.getYearRecs('nope', 'parent')],
  [
    'parentAt on junk',
    () =>
      A.parentAt(
        [
          { from: NaN, id: 1 },
          { from: null, id: 2 }
        ],
        5
      )
  ],
  ['rootAtYear cycle', () => A.rootAtYear(1, 0, (id) => [{ from: null, id: id === 1 ? 2 : 1 }])],
  ['ringArea empty', () => A.ringArea([])],
  ['ringArea junk', () => A.ringArea([['a', 'b'], [1]])],
  ['outlineColor junk', () => A.outlineColor('url(#x)')],
  ['autoColor empty', () => A.autoColor('')],
  ['assetUrl traversal', () => A.assetUrl('../../world.db')],
  ['assetUrl backslash', () => A.assetUrl('assets\\..\\world.db')],
  ['inYearRange junk', () => A.inYearRange(undefined, undefined, NaN)],
  ['formatYear junk', () => A.formatYear(NaN, { before: 'BC', after: 'AD' })]
]
for (const [label, fn] of pure) {
  try {
    console.log(`ok     ${label.padEnd(24)} → ${JSON.stringify(fn())?.slice(0, 70)}`)
  } catch (e) {
    console.log(`THREW  ${label.padEnd(24)} → ${e.message}`)
    fails++
  }
}

// --- the relations graph's force layout -----------------------------------------------------
// Pure arithmetic in a module of its own (that is WHY it is in a module — see graphLayout.ts),
// so it can be exercised with nothing but a stub for requestAnimationFrame. Four properties,
// each one a way it could be wrong without ever throwing:
//   · every position stays finite — one NaN spreads to the whole graph in a single pass
//   · repulsion actually separates: the closest pair ends up further apart than a node is wide
//   · the same world lays out the same way twice (the seed and the tie-break are by INDEX)
//   · an empty graph and a single node do not divide by zero
globalThis.requestAnimationFrame = () => 0
globalThis.cancelAnimationFrame = () => {}
const { ForceLayout } = await import('./src/renderer/src/graphLayout.ts')
const settle = (ids, edges) => {
  const g = new ForceLayout()
  g.seed(ids, edges, 900, 600)
  g.heat(1)
  for (let i = 0; i < 600; i++) g.tick()
  return g.nodes
}
const ids = Array.from({ length: 24 }, (_, i) => i + 1)
const chain = ids.slice(1).map((id, i) => ({ from: ids[i], to: id }))
const a = settle(ids, chain)
const b = settle(ids, chain)
let closest = Infinity
for (let i = 0; i < a.length; i++)
  for (let j = i + 1; j < a.length; j++)
    closest = Math.min(closest, Math.hypot(a[i].x - a[j].x, a[i].y - a[j].y))
// The coincident-node branch needs its OWN fixture, and finding that out is the point of
// break-testing: the circle seed never puts two nodes on the same spot, so making that tie-break
// random left "same world, same layout" green — an assertion that was passing without ever
// reaching the line it was meant to be guarding. Here they all start stacked on one point.
const stacked = () => {
  const g = new ForceLayout()
  g.seed([1, 2, 3, 4, 5], [], 900, 600)
  for (const n of g.nodes) {
    n.x = 400
    n.y = 300
  }
  g.heat(1)
  for (let i = 0; i < 400; i++) g.tick()
  return g.nodes
}
const s1 = stacked()
const s2 = stacked()

/* What the SPRINGS are for, asked as a COMPARISON — the same nodes with and without their links,
   which is the only form of the question that isolates the link force.
   Two earlier forms of this check were wrong and break-testing found both. "Linked pairs sit
   closer than the average pair" passed with the springs turned off when measured on a chain,
   because a chain links 1–2–3… and the seed puts those side by side on the circle: the seed was
   doing the work the springs were credited for. Measured on pairs across the circle it then
   FAILED with the springs on — correctly, because each node there has one link and twenty-two
   other nodes pushing it away, so a linked pair genuinely does sit further apart than average.
   That is the physics being right, not the force being absent. */
const acrossEdges = ids.slice(0, 12).map((id) => ({ from: id, to: id + 12 }))
const mean = (l) => l.reduce((s, v) => s + v, 0) / l.length
const gapAcross = (nodes) =>
  mean(
    acrossEdges.map((e) =>
      Math.hypot(nodes[e.from - 1].x - nodes[e.to - 1].x, nodes[e.from - 1].y - nodes[e.to - 1].y)
    )
  )
const withLinks = gapAcross(settle(ids, acrossEdges))
const withoutLinks = gapAcross(settle(ids, []))

// What the FRICTION is for: it comes to REST. Velocity that survives every tick with nothing to
// bleed it away is a graph that drifts for ever, and "all finite" does not notice.
const resting = Math.max(...a.map((n) => Math.hypot(n.vx, n.vy)))

const graph = [
  ['all finite', a.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))],
  ['no two nodes on top of each other', closest > 16],
  ['a link pulls its two ends together', withLinks < withoutLinks * 0.75],
  ['it comes to rest', resting < 0.5],
  ['same world, same layout', a.every((n, i) => Math.abs(n.x - b[i].x) < 1e-9)],
  ['coincident nodes separate', s1.every((n) => Number.isFinite(n.x)) && s1[0].x !== s1[1].x],
  ['…and separate the SAME way twice', s1.every((n, i) => Math.abs(n.x - s2[i].x) < 1e-9)],
  ['empty graph', settle([], []).length === 0],
  ['one node', Number.isFinite(settle([1], [])[0].x)]
]
for (const [label, pass] of graph) {
  console.log(`${pass ? 'ok    ' : 'FAILED'} layout: ${label}`)
  if (!pass) fails++
}

console.log('\nObject.prototype.pwned =', {}.pwned)
console.log(fails ? `${fails} PROBLEM(S)` : 'every loader total, no loader threw')
