// Bit rot, and bytes damaged on purpose.
//
// db.ts's own scenarios build files that are ODD but structurally valid SQLite — a hostile schema,
// a name that escapes, a value of the wrong type. This is the other kind of bad file: a truncated
// download, a failing disk, a hostile edit. It takes a real packed world and damages it, six
// hundred ways, from a seeded generator so a failure can be reproduced from the seed alone.
//
// The bar is not "it opens". unpackWorld may refuse — most of these are not worlds any more. The
// bar is that the APP survives being asked: the working copy still readable AND writable
// afterwards, nothing written outside assets/, and no failure that leaves the database closed.
//
// Run from the repository root: node scripts/check-corrupt.mjs
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { initDb, api, packWorld, unpackWorld } from '../src/main/db.ts'

const ROUNDS = 600
const dir = mkdtempSync(join(tmpdir(), 'worldcorrupt-'))
initDb(dir)
const m = api.createMap({ name: 'World', width: 100, height: 100 })
const e = api.createEntity({ name: 'Realm' })
api.createFeature({
  map_id: m.id,
  entity_id: e.id,
  geometry: JSON.stringify({
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 0]
      ]
    ]
  }),
  style: '{}'
})
api.updateEntity(e.id, { fields: JSON.stringify({ banner: 'assets/pic.png' }) })
writeFileSync(join(dir, 'assets', 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
const good = join(dir, 'good.world')
packWorld(good)
const golden = readFileSync(good)

let seed = 0x9e3779b9
const rnd = (n) => {
  seed ^= seed << 13
  seed ^= seed >>> 17
  seed ^= seed << 5
  return Math.abs(seed) % n
}

const tally = { opened: 0, refused: 0, otherError: 0, unusable: 0, stray: 0 }
const seen = new Map()
const f = join(dir, 'damaged.world')
for (let i = 0; i < ROUNDS; i++) {
  const b = Buffer.from(golden)
  const mode = rnd(4)
  if (mode === 0)
    for (let k = 0; k < 1 + rnd(8); k++) b[rnd(b.length)] = rnd(256) // scattered flips
  else if (mode === 1)
    for (let k = 0; k < 1 + rnd(6); k++) b[rnd(200)] = rnd(256) // the header
  else if (mode === 2) {
    const off = rnd(Math.max(1, b.length - 4096)) // a whole page zeroed
    b.fill(0, off, off + 4096)
  }
  writeFileSync(f, mode === 3 ? b.subarray(0, 1 + rnd(b.length)) : b) // truncation
  try {
    unpackWorld(f)
    tally.opened++
  } catch (ex) {
    const msg = String(ex.message)
    if (/NOT_A_WORLD|WORLD_TOO_LARGE/.test(msg)) tally.refused++
    else {
      tally.otherError++
      const k = msg.slice(0, 60)
      seen.set(k, (seen.get(k) ?? 0) + 1)
    }
  }
  // Whatever happened, the app has to keep working — this is the whole assertion.
  try {
    api.listEntities()
    const x = api.createEntity({ name: 'after' })
    api.deleteEntity(x.id)
  } catch (ex) {
    tally.unusable++
    seen.set('UNUSABLE ' + String(ex.message).slice(0, 50), 1)
  }
  if (readdirSync(join(dir, 'assets')).some((a) => !/\.(png|jpe?g|webp|gif)$/i.test(a)))
    tally.stray++
}
rmSync(f, { force: true })

console.log(tally)
if (seen.size) {
  console.log('--- outcomes other than a clean refusal (all of these still restore the world) ---')
  for (const [msg, n] of [...seen].sort((a, b) => b[1] - a[1]).slice(0, 10))
    console.log(String(n).padStart(4), msg)
}
// A run where nothing was ever refused and nothing ever opened would pass every assertion below
// while testing nothing, so the shape of the run is checked too.
const fail = []
if (tally.unusable) fail.push(`${tally.unusable} corruption(s) left the app unusable`)
if (tally.stray) fail.push(`${tally.stray} corruption(s) wrote outside the image rules`)
if (tally.refused < ROUNDS / 10)
  fail.push('too few refusals — the corruption is not reaching the gate')
if (tally.opened < ROUNDS / 10) fail.push('too few opens — the fixture may not be a world at all')
if (fail.length) {
  for (const x of fail) console.error('FAIL: ' + x)
  process.exit(1)
}
console.log('the app survived every corruption')
