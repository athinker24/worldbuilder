// The main process's test harness. There is no test framework here; this file stands in for one
// and must be run after any change to the data model.
//
//   node tests/db.test.ts
//
// WHY IT IS NOT INSIDE db.ts ANY MORE. It used to be the last 2155 lines of that module, behind
// `if (process.argv[1]?.endsWith('src/main/db.ts'))`. That guard is a RUNTIME test, so no bundler
// could eliminate it: every packaged build carried the whole harness — the hostile-world builders,
// the temp-directory fixtures, the assertion messages naming each mitigation — inside
// out/main/index.js. electron-builder.yml already refuses to ship check-api.mjs on the grounds
// that a test which stubs the IPC bridge is a description of the bridge; the same rule had simply
// never been applied to the one test that lived inside the module it tested. Out here it is a file
// nothing imports, so it cannot reach the bundle at all.
//
// THE TEST WINDOW. Nine things this file needs are module-private in db.ts and stay that way:
// `__test` is their one door, and it exists for this file alone. Do not import it from application
// code — `db` behind it is the raw connection, and reaching it would walk straight past the write
// gates that assertEntityPatch, assertFeaturePatch and assertSettingValue exist to enforce. There
// is an assertion further down that no file under src/ imports it.
//
// AND THE TRAP INSIDE THAT WINDOW: `db` is a `let`, reassigned at six sites — initDb, unpackWorld
// (three) and resetWorld (two). It is read through a getter on every use for that reason. A
// `const { db } = __test` at the top of this file would freeze the first connection, and since the
// scenarios below open, unpack and reset worlds in sequence, the assertions after the first
// reassignment would be interrogating a closed handle instead of the one the app is holding. That
// is why every use below is written `__test.db` and not `db`.
import assert from 'assert'
import { DatabaseSync } from 'node:sqlite'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'fs'
import { basename, join } from 'path'
import { homedir, tmpdir } from 'os'
import {
  api,
  assetName,
  backupIfNeeded,
  FORMAT_VERSION,
  hasContent,
  importAsset,
  initDb,
  migrateLegacyKeys,
  MUTATES,
  packWorld,
  resetWorld,
  resolveAssetPath,
  stripImageMetadata,
  unpackWorld,
  worldStats,
  __test
} from '../src/main/db.ts'
// NOT_A_WORLD, WORLD_TOO_NEW and WORLD_TOO_LARGE are deliberately not imported: the scenarios
// below match them as regexes against the thrown message (/WORLD_TOO_NEW/), which is how they were
// written when this lived inside db.ts. Importing them as well would look like the assertions use
// the constants when they do not.
import {
  flushLog,
  initLog,
  logError,
  logEvent,
  logSetDebug,
  logTime,
  noteCall
} from '../src/main/log.ts'
import { BATCH_MS, COALESCE_MS } from '../src/main/log/thresholds.ts'

// The stable half of the window. Only `db` is left out, for the reason in the header above.
const {
  SCHEMA,
  OUR_TABLES,
  MAX_TREE_DEPTH,
  BACKUP_KEEP_DAYS,
  BACKUP_KEEP_FILES,
  STAGING_SUFFIX,
  REPLACED_SUFFIX,
  pruneUnusedAssets
} = __test

// --- every api method is classified -------------------------------------------------------
// A method that changes the world and is not matched by MUTATES leaves the dirty flag unset:
// no star in the title, no prompt on close, and the user loses the work by doing exactly what
// the app told them was safe. The verb list is arbitrary — `renameEntity` or `moveMap` would
// both miss it — so the only real protection is that a NEW method cannot be added without
// someone deciding which side it is on.
{
  const READS = new Set([
    'backupNow', // writes a backup FILE, not the world
    'entityFeatureIds',
    'entityPlacements',
    'exportNotes', // writes .txt files, not the world
    'featuresByEntity',
    'findEntityByName',
    'getEntity',
    'getMap',
    'getSetting',
    'hierarchy',
    'listEntities',
    'listLinks',
    'listMaps',
    'searchContent'
  ])
  for (const name of Object.keys(api))
    assert.equal(
      MUTATES.test(name),
      !READS.has(name),
      `${name}: decide whether it changes the world — match MUTATES, or add it to READS here`
    )
  // The other half of the same invariant, for the methods that live on mainApi rather than here.
  // Both prefixes were CHOSEN to miss this regex, and both would be natural to rename: reporting
  // an error is not a change to the world, and `setPrefs` would mark it unsaved every time the
  // theme was switched. Written as the literal names because that is what the dispatch sees.
  for (const name of ['logEvents', 'logRendererError', 'logSessionInfo', 'savePrefs'])
    assert.ok(!MUTATES.test(name), `${name} must not read as a mutation — see its prefix`)
}

// --- the schema and the allow-list must agree ----------------------------------------------
// dropForeignTables deletes every table an opened file carries that is not in OUR_TABLES. That
// is what keeps a shared `.world` from smuggling one in — and it means a table added to SCHEMA
// and forgotten here would be DROPPED on the next open, with its rows, silently, in the one
// function whose job is to be ruthless. The trap needs no attacker and no mistake at open time:
// a new feature adding a table is enough.
{
  const declared = [...SCHEMA.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1])
  assert.ok(declared.length >= 5, 'the schema still declares its tables in the expected form')
  for (const t of declared)
    assert.ok(
      OUR_TABLES.has(t),
      `${t} is in the schema but not in OUR_TABLES — it would be dropped`
    )
  // And the other way: a name in the allow-list that no longer exists means a table was removed
  // and the list was not, which is how a future file's table gets silently adopted.
  for (const t of OUR_TABLES)
    assert.ok(declared.includes(t), `OUR_TABLES lists ${t}, which the schema no longer creates`)
}

const dir = mkdtempSync(join(tmpdir(), 'worlddb-'))
initDb(dir)
// A session file from the FIRST line, so the article events below actually reach a sink. The log
// section further down opens its own directory and is unaffected — this one only has to exist.
initLog(dir, '9.9.9', () => ({}))
const a = api.createEntity({ name: 'Test State' }) as { id: number }
const b = api.createEntity({
  name: 'Test Dynasty',
  content: 'See [[Test State]]'
}) as { id: number }
api.addLink(b.id, a.id, 'rules')
const got = api.getEntity(a.id) as { name: string; inLinks: unknown[]; mentions: unknown[] }
assert.equal(got.name, 'Test State')
assert.equal(got.inLinks.length, 1)
assert.equal(got.mentions.length, 1)
// Full-text search: content hits found; name matches excluded.
{
  const hits = api.searchContent('test state') as { id: number; snippet: string }[]
  assert.equal(hits.length, 1) // only b (content mentions [[Test State]]); a counts as a name match
  assert.equal(hits[0].id, b.id)
  assert.ok(hits[0].snippet.includes('Test State'))
  assert.equal((api.searchContent('nothinglikethis') as unknown[]).length, 0)
  // Note-tab hits are found; technical fields (banner file path) are not searched
  api.updateEntity(b.id, {
    fields: JSON.stringify({
      banner: 'assets/HIDDEN-PATH-oneword.png',
      notes: JSON.stringify([{ title: 'Wars', content: 'Northern campaign began' }])
    })
  })
  const noteHits = api.searchContent('northern campaign') as { id: number; snippet: string }[]
  assert.equal(noteHits.length, 1)
  assert.ok(noteHits[0].snippet.includes('Northern campaign'))
  assert.equal((api.searchContent('HIDDEN-PATH') as unknown[]).length, 0) // banner path is not searched
}
api.updateEntity(a.id, {
  fields: JSON.stringify({
    hierarchy: '#kingdom, #southern-languages',
    government: 'feudal',
    religion: 'Islam'
  })
})
const hier = api.hierarchy() as {
  tags: string[]
  govs: string[]
  entities: { id: number; tags: string[]; gov: string | null; fields: string }[]
}
assert.deepEqual(hier.tags, ['#kingdom', '#southern-languages'])
assert.deepEqual(hier.govs, ['feudal'])
assert.equal(hier.entities.length, 2) // no WHERE: untagged entities are returned too
const he = hier.entities.find((e) => e.id === a.id)!
assert.equal(he.tags.length, 2)
assert.equal(he.gov, 'feudal')
assert.equal((JSON.parse(he.fields) as { religion: string }).religion, 'Islam')
const m = api.createMap({ name: 'World' }) as { id: number }
const feat = api.createFeature({
  map_id: m.id,
  entity_id: a.id,
  geometry: '{"type":"Point","coordinates":[1,2]}'
}) as { id: number }
assert.equal((api.getMap(m.id) as { features: unknown[] }).features.length, 1)
// entityPlacements: the sidebar's map grouping is derived from drawings, not from a field on
// the entity, so a drawn article must report its map and an undrawn one must not appear at all.
assert.deepEqual(api.entityPlacements(), [{ entity_id: a.id, map_id: m.id, board: null }])
api.updateFeature(feat.id, { style: JSON.stringify({ board: 'b1' }) })
assert.equal(api.entityPlacements()[0].board, 'b1') // board read out of the style JSON
// A malformed style must not throw here — but it can no longer be PLANTED through the api,
// which is the E-01 gate doing its job, so it goes in the way it really arises: written into
// the file by somebody else. `entityPlacements`' own try/catch is belt and braces for the same
// reason it always was.
assert.throws(
  () => api.updateFeature(feat.id, { style: 'not json' }),
  /BAD_STYLE/,
  'updateFeature must refuse a style the open would reset'
)
__test.db.prepare(`UPDATE features SET style = 'not json' WHERE id = ?`).run(feat.id)
assert.equal(api.entityPlacements()[0].board, null) // malformed style must not throw
api.updateFeature(feat.id, { style: '{}' }) // restore: later checks share this fixture

// --- E-01: the write gate asks what the open asks ------------------------------------------
//
// `patchSql` allow-lists the COLUMNS and always did; nothing checked the VALUES. So the app
// could put a row into its own working copy that its own `repairImportedJson` would reset on the
// next open — and `packWorld` would hand that row to whoever the world was shared with.
//
// The predicates here are the SAME ones the open uses (isGeometry / isPlainObject, module
// level). Deliberately not stricter: undo writes back the string the file arrived with, so a
// narrower rule here would make Ctrl+Z fail on a world that opened cleanly.
{
  const good = '{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,0]]]}'
  const rejects: [string, unknown][] = [
    ['not json at all', 'not json at all'],
    ['empty string', ''],
    ['a number, not a string', 12345],
    ['an object, not a string', { type: 'Point', coordinates: [0, 0] }],
    ['an unknown type', '{"type":"Evil","coordinates":[]}'],
    ['coordinates not an array', '{"type":"Polygon","coordinates":"x"}'],
    ['no coordinates at all', '{"type":"Point"}'],
    ['an array, not an object', '[{"type":"Point","coordinates":[0,0]}]'],
    ['nested past MAX_JSON_DEPTH', '{"a":'.repeat(70) + '1' + '}'.repeat(70)]
  ]
  for (const [what, g] of rejects) {
    assert.throws(
      () => api.updateFeature(feat.id, { geometry: g }),
      /BAD_GEOMETRY/,
      `updateFeature must refuse geometry: ${what}`
    )
    assert.throws(
      () => api.createFeature({ map_id: m.id, geometry: g as string }),
      /BAD_GEOMETRY/,
      `createFeature must refuse geometry: ${what}`
    )
  }
  // …and the refusals leave nothing behind
  assert.equal(
    (api.getMap(m.id) as { features: { id: number; geometry: string }[] }).features.length,
    1,
    'a refused createFeature must not have inserted a row'
  )
  // Valid geometry still goes through, including the shapes a hostile file may legitimately
  // carry — the gate is about SHAPE, not about how a drawing was made.
  for (const g of [
    good,
    '{"type":"Point","coordinates":[0,0]}',
    '{"type":"MultiPolygon","coordinates":[]}', // empty is a shape, and the open accepts it
    '{"type":"LineString","coordinates":[[1e999,0],[1,1]]}' // non-finite: the OPEN accepts it too
  ]) {
    api.updateFeature(feat.id, { geometry: g })
    assert.equal(
      (api.getMap(m.id) as { features: { geometry: string }[] }).features[0].geometry,
      g,
      'valid geometry must still be written'
    )
  }
  api.updateFeature(feat.id, { geometry: good })
  // The column allow-list is untouched: map_id was never patchable and still is not.
  api.updateFeature(feat.id, { map_id: 9999, geometry: good } as Record<string, unknown>)
  assert.equal(
    (api.getMap(m.id) as { features: { map_id: number }[] }).features[0].map_id,
    m.id,
    'patchSql still drops a column that is not on its allow-list'
  )
}

// --- E-04: several rows, one transaction, and the undo entry only after it lands ------------
{
  const g = (n: number): string => `{"type":"Point","coordinates":[${n},${n}]}`
  const f2 = api.createFeature({ map_id: m.id, geometry: g(2) }) as { id: number }
  const f3 = api.createFeature({ map_id: m.id, geometry: g(3) }) as { id: number }
  const geomOf = (fid: number): string =>
    (api.getMap(m.id) as { features: { id: number; geometry: string }[] }).features.find(
      (x) => x.id === fid
    )!.geometry
  const before = [feat.id, f2.id, f3.id].map(geomOf)

  // The middle one is invalid. The validation runs before BEGIN so no transaction is opened at
  // all — but that is a design preference, not a testable one: moving the check inside `tx`
  // produces the SAME observable outcome, because the rollback is correct either way. Checked
  // by breaking it, which is why this is written down rather than asserted; what IS asserted
  // below is the outcome, which has teeth against a missing transaction and a missing rollback.
  assert.throws(
    () =>
      api.updateFeatures([
        { id: feat.id, patch: { geometry: g(90) } },
        { id: f2.id, patch: { geometry: 'not json' } },
        { id: f3.id, patch: { geometry: g(92) } }
      ]),
    /BAD_GEOMETRY/,
    'a batch with one bad patch is refused'
  )
  assert.deepEqual(
    [feat.id, f2.id, f3.id].map(geomOf),
    before,
    'and NOTHING in it was written — not even the rows before the bad one'
  )
  assert.ok(!__test.db.isTransaction, 'a refused batch leaves no transaction open')

  // And the same for a failure the validation cannot see: a foreign key only SQLite knows about,
  // which throws in the middle of the transaction and must roll the first write back.
  assert.throws(
    () =>
      api.updateFeatures([
        { id: feat.id, patch: { geometry: g(90) } },
        { id: f2.id, patch: { entity_id: 424242 } }, // no such entity
        { id: f3.id, patch: { geometry: g(92) } }
      ]),
    /FOREIGN KEY/,
    'a batch that fails inside the transaction still throws'
  )
  assert.deepEqual(
    [feat.id, f2.id, f3.id].map(geomOf),
    before,
    'and it rolled back: the write BEFORE the failing one is gone too'
  )
  assert.ok(!__test.db.isTransaction, 'the rollback left no transaction open')
  // The connection is still usable — a rollback must not wedge it for the rest of the session.
  api.updateFeatures([{ id: feat.id, patch: { geometry: g(7) } }])
  assert.equal(geomOf(feat.id), g(7), 'the connection works after a rollback')

  // A batch that succeeds writes every row.
  api.updateFeatures([
    { id: feat.id, patch: { geometry: g(11) } },
    { id: f2.id, patch: { geometry: g(12) } },
    { id: f3.id, patch: { geometry: g(13) } }
  ])
  assert.deepEqual([feat.id, f2.id, f3.id].map(geomOf), [g(11), g(12), g(13)])

  // updateEntities: the conquest path, same contract.
  const e2 = api.createEntity({ name: 'Second' }) as { id: number }
  assert.throws(
    () =>
      api.updateEntities([
        { id: a.id, patch: { fields: JSON.stringify({ mark: 'A' }) } },
        { id: e2.id, patch: { fields: 'not json' } }
      ]),
    /BAD_FIELDS/,
    'updateEntities validates fields the way the open does'
  )
  assert.ok(
    !((api.getEntity(a.id) as { fields: string }).fields ?? '').includes('mark'),
    'and wrote nothing'
  )
  api.updateEntities([
    { id: a.id, patch: { fields: JSON.stringify({ mark: 'A' }) } },
    { id: e2.id, patch: { fields: JSON.stringify({ mark: 'B' }) } }
  ])
  assert.ok((api.getEntity(a.id) as { fields: string }).fields.includes('"A"'))
  assert.ok((api.getEntity(e2.id) as { fields: string }).fields.includes('"B"'))

  // deleteFeatures: one action, one transaction.
  api.deleteFeatures([f2.id, f3.id])
  assert.equal(
    (api.getMap(m.id) as { features: unknown[] }).features.length,
    1,
    'deleteFeatures removes the whole set'
  )
  api.deleteEntity(e2.id)
  api.updateEntity(a.id, { fields: '{}' }) // restore: later checks share this fixture
  api.updateFeature(feat.id, { geometry: '{"type":"Point","coordinates":[1,2]}' })
}

// --- E-04, second round: user actions that span two TABLES ----------------------------------
//
// These could not become batches, because the entity's id is an INPUT to the feature — the
// second statement depends on the result of the first. One method per user action is what keeps
// the transaction obviously the right size.
{
  const pt = '{"type":"Point","coordinates":[4,4]}'
  const count = (): { e: number; f: number } => ({
    e: (api.listEntities() as unknown[]).length,
    f: (api.getMap(m.id) as { features: unknown[] }).features.length
  })

  // createDrawing: a drawing IS an article, so this is two inserts into two tables.
  {
    const was = count()
    const made = api.createDrawing({
      map_id: m.id,
      geometry: pt,
      entityName: 'Drawn Realm'
    }) as { featureId: number; entityId?: number }
    assert.ok(made.entityId !== undefined, 'createDrawing returns the entity it made')
    assert.deepEqual(count(), { e: was.e + 1, f: was.f + 1 }, 'both rows appeared')
    const bound = (
      api.getMap(m.id) as { features: { id: number; entity_id: number }[] }
    ).features.find((x) => x.id === made.featureId)!
    assert.equal(bound.entity_id, made.entityId, 'and the feature is bound to it')

    // deleteDrawing is its undo: both rows go, in one transaction.
    api.deleteDrawing(made.featureId, made.entityId)
    assert.deepEqual(count(), was, 'deleteDrawing removes both')

    // The FAILING half, which is the whole point: an invalid geometry must not leave the entity
    // behind. Before the transaction the entity was inserted first and the feature second, so
    // the refusal left an article with no drawing — an empty row in the sidebar the user never
    // made. The validation runs before BEGIN, so nothing is written at all.
    const before = count()
    assert.throws(
      () => api.createDrawing({ map_id: m.id, geometry: 'not json', entityName: 'Ghost' }),
      /BAD_GEOMETRY/,
      'createDrawing refuses an invalid geometry'
    )
    assert.deepEqual(count(), before, 'and left NO orphan entity behind')
    assert.ok(
      !(api.listEntities() as { name: string }[]).some((x) => x.name === 'Ghost'),
      'the entity it would have made is not there'
    )
    // And a failure SQLite raises mid-transaction rolls the entity back too.
    assert.throws(
      () => api.createDrawing({ map_id: 999999, geometry: pt, entityName: 'Ghost2' }),
      /FOREIGN KEY/,
      'createDrawing on a map that does not exist fails'
    )
    assert.deepEqual(count(), before, 'and that rolled the entity back as well')
    assert.ok(
      !(api.listEntities() as { name: string }[]).some((x) => x.name === 'Ghost2'),
      'no orphan from the mid-transaction failure either'
    )
  }

  // createFeatureFork / deleteFeatureFork: copy forward, close the original. A copy with no
  // closed original is two borders claiming the same land in the same year.
  {
    const src = api.createFeature({
      map_id: m.id,
      geometry: pt,
      style: JSON.stringify({ from: 100 })
    }) as { id: number }
    const styleOf = (fid: number): string =>
      (api.getMap(m.id) as { features: { id: number; style: string }[] }).features.find(
        (x) => x.id === fid
      )!.style
    const original = styleOf(src.id)
    const was = count()

    // A refused fork must not leave the copy behind. NOTE what this does and does not prove:
    // it proves the validation runs before any write, and it is what fails if that ordering is
    // lost. It does NOT prove the transaction, because there is no reachable failure BETWEEN
    // the insert and the update — the style is already validated and the source id is already
    // known to exist, so only an IO error could land there, and that cannot be arranged here.
    // Checked by breaking it: removing `tx` from this method leaves the run green. The
    // transaction stays as insurance, and is written down as insurance rather than asserted.
    // (createDrawing IS testable the same way and is tested — its second statement has a real
    // foreign key, so a failure there is arrangeable and the assertion has teeth.)
    assert.throws(
      () => api.createFeatureFork(src.id, JSON.stringify({ from: 200 }), 'not json'),
      /BAD_STYLE/,
      'a fork with an invalid closing style is refused'
    )
    assert.deepEqual(count(), was, 'and made no copy')
    assert.equal(styleOf(src.id), original, 'and did not touch the original')

    const copy = api.createFeatureFork(
      src.id,
      JSON.stringify({ from: 200 }),
      JSON.stringify({ from: 100, to: 199 })
    ) as { id: number }
    assert.equal(count().f, was.f + 1, 'a successful fork makes exactly one copy')
    assert.ok(styleOf(src.id).includes('"to":199'), 'and closes the original')
    assert.ok(styleOf(copy.id).includes('"from":200'), 'and the copy starts where it should')

    api.deleteFeatureFork(copy.id, src.id, original)
    assert.deepEqual(count(), was, 'unforking removes the copy')
    assert.equal(styleOf(src.id), original, 'and reopens the original — both halves, one step')
    api.deleteFeature(src.id)
  }

  // updateFeatureLink: rebind a drawing, and drop the article it left IF the app invented it.
  // Two writes and — in the renderer — two undo entries, so one Ctrl+Z used to put the drawing
  // back and leave the article deleted.
  {
    const keep = api.createEntity({ name: 'Has A Body' }) as { id: number }
    api.updateEntity(keep.id, { content: 'written by the user' })
    const invented = api.createDrawing({
      map_id: m.id,
      geometry: pt,
      entityName: 'Invented'
    }) as { featureId: number; entityId: number }
    const target = api.createEntity({ name: 'Target' }) as { id: number }

    const r = api.updateFeatureLink(invented.featureId, target.id, '{}', invented.entityId) as {
      dropped: { id: number; name: string } | null
    }
    assert.ok(r.dropped, 'the invented article was empty, so it went with the rebind')
    assert.equal(r.dropped!.name, 'Invented')
    assert.equal(
      (api.getMap(m.id) as { features: { id: number; entity_id: number }[] }).features.find(
        (x) => x.id === invented.featureId
      )!.entity_id,
      target.id,
      'and the drawing is on its new article'
    )
    assert.equal(api.getEntity(invented.entityId), null, 'the empty row is gone')

    // An article with anything written in it is NEVER dropped, whatever became of its drawing.
    const f2 = api.createDrawing({ map_id: m.id, geometry: pt, entity_id: keep.id }) as {
      featureId: number
    }
    const r2 = api.updateFeatureLink(f2.featureId, target.id, '{}', keep.id) as {
      dropped: unknown | null
    }
    assert.equal(r2.dropped, null, 'an article with a body survives the rebind')
    assert.ok(api.getEntity(keep.id), 'and is still there')

    // A refused style writes neither half.
    const boundTo = (fid: number): number =>
      (api.getMap(m.id) as { features: { id: number; entity_id: number }[] }).features.find(
        (x) => x.id === fid
      )!.entity_id
    const at = boundTo(f2.featureId)
    assert.throws(
      () => api.updateFeatureLink(f2.featureId, keep.id, 'not json', target.id),
      /BAD_STYLE/,
      'updateFeatureLink validates the style it is given'
    )
    assert.equal(boundTo(f2.featureId), at, 'and left the binding alone')

    api.deleteFeatures([invented.featureId, f2.featureId])
    api.deleteEntities([keep.id, target.id])
  }

  // deleteEntities / createFeatures: the plain batches, for a multi-select and a paste.
  {
    const ids = api.createFeatures([
      { map_id: m.id, geometry: pt },
      { map_id: m.id, geometry: pt }
    ]) as number[]
    assert.equal(ids.length, 2, 'createFeatures returns an id per row, in order')
    const was = count()
    assert.throws(
      () =>
        api.createFeatures([
          { map_id: m.id, geometry: pt },
          { map_id: m.id, geometry: 'not json' }
        ]),
      /BAD_GEOMETRY/,
      'a paste with one bad row is refused'
    )
    assert.deepEqual(count(), was, 'and none of it was written')
    api.deleteFeatures(ids)

    const e1 = api.createEntity({ name: 'Bulk 1' }) as { id: number }
    const e2b = api.createEntity({ name: 'Bulk 2' }) as { id: number }
    api.deleteEntities([e1.id, e2b.id])
    assert.equal(api.getEntity(e1.id), null)
    assert.equal(api.getEntity(e2b.id), null)
  }
  assert.ok(
    !__test.db.isTransaction,
    'every one of those left the connection outside a transaction'
  )
  // …and it still works, which is the property a bad rollback would take away.
  api.updateFeature(feat.id, { geometry: '{"type":"Point","coordinates":[1,2]}' })
}

// exportNotes mirrors the SIDEBAR FOLDER TREE: a sits in the nested folder Realms/States and is
// on the World map → notes/World/Realms/States/Test State/…; b is in no folder and on no map →
// notes/(no map)/(no folder)/…
api.setSetting(
  'entityFolders',
  JSON.stringify([
    { id: 'f1', name: 'Realms', parent: null, order: 1 },
    { id: 'f2', name: 'States', parent: 'f1', order: 1 }
  ])
)
api.updateEntity(a.id, {
  fields: JSON.stringify({
    folder: 'f2',
    notes: JSON.stringify([{ title: 'Founding', content: 'line1\nline2' }])
  })
})
const exp = api.exportNotes()
assert.equal(exp.files, 2) // a (on a map) + b (mapless)
const onMap = join(dir, 'notes', 'World', 'Realms', 'States', 'Test State', 'Founding.txt')
assert.ok(existsSync(onMap), 'note of an on-map entity must be written')
assert.equal(readFileSync(onMap, 'utf8'), 'line1\r\nline2') // \n → \r\n (Windows)
assert.ok(
  existsSync(join(dir, 'notes', '(no map)', '(no folder)', 'Test Dynasty', 'Wars.txt')),
  'a mapless, folderless entity must land under (no map)/(no folder)'
)
// Boards become a level between map and folders — but ONLY for maps that have boards, which
// is why the assertions above (a boardless map) keep passing unchanged.
{
  api.setSetting(
    'mapBoards',
    JSON.stringify({ [m.id]: { list: [{ id: 'b1', name: 'Borders' }], active: 'b1' } })
  )
  const e2 = api.exportNotes()
  assert.equal(e2.files, 2) // same notes, deeper tree
  assert.ok(
    existsSync(
      join(dir, 'notes', 'World', 'Borders', 'Realms', 'States', 'Test State', 'Founding.txt')
    ),
    'a board must sit between the map and the folder tree'
  )
  // The feature carries no board id, so it resolved to the first board rather than vanishing
  assert.ok(
    !existsSync(join(dir, 'notes', 'World', 'Realms')),
    'the board level must not be skipped'
  )
  api.setSetting('mapBoards', '{}') // restore: later checks share this fixture
}
// safe(): the Windows device name CON cannot be a folder → _CON; control chars become _.
// Without these, exportNotes would blow up on Windows with EPERM or a wrong target.
{
  const evilEnt = api.createEntity({
    name: 'CON',
    fields: JSON.stringify({ notes: JSON.stringify([{ title: 'x\x07y', content: 'z' }]) })
  }) as { id: number }
  api.exportNotes()
  assert.ok(
    existsSync(join(dir, 'notes', '(no map)', '(no folder)', '_CON', 'x_y.txt')),
    'CON → _CON, control character → _'
  )
  api.deleteEntity(evilEnt.id)
}
// pruneUnusedAssets: an image named in the DB text survives, an unnamed one is deleted
writeFileSync(join(dir, 'assets', 'used.png'), Buffer.from([9]))
writeFileSync(join(dir, 'assets', 'unused.png'), Buffer.from([9]))
api.updateEntity(a.id, { fields: JSON.stringify({ banner: 'assets/used.png' }) })
assert.equal(pruneUnusedAssets(), 1)
assert.ok(existsSync(join(dir, 'assets', 'used.png')), 'a used image must survive')
assert.ok(!existsSync(join(dir, 'assets', 'unused.png')), 'an unused image must be deleted')
rmSync(join(dir, 'assets', 'used.png')) // keep the following packWorld test isolated
api.updateEntity(a.id, { fields: '{}' }) // clean up for the following tests
const full = api.getEntity(a.id) as {
  id: number
  type: string
  name: string
  content: string
  fields: string
  created_at: string
}
const featIds = api.entityFeatureIds(a.id)
api.deleteEntity(a.id)
assert.equal(api.getEntity(a.id) as unknown, null)
api.restoreEntity(full, [{ from_id: b.id, to_id: a.id, relation: 'rules', notes: '' }], featIds)
const restored = api.getEntity(a.id) as { name: string; inLinks: unknown[] }
assert.equal(restored.name, 'Test State')
assert.equal(restored.inLinks.length, 1)
assert.equal(
  (api.getMap(m.id) as { features: { entity_id: number }[] }).features[0].entity_id,
  a.id
)
// Bulk restore (multi-delete undo): delete linked a+b together, then restore
const bFull = api.getEntity(b.id) as typeof full
const aFeat = api.entityFeatureIds(a.id) as number[]
api.deleteEntity(a.id)
api.deleteEntity(b.id)
assert.equal(api.getEntity(b.id) as unknown, null)
api.restoreEntities(
  [full, bFull],
  [{ from_id: b.id, to_id: a.id, relation: 'rules', notes: '' }], // one record even when captured from both sides
  aFeat.map((fid) => ({ entity_id: a.id, feature_id: fid }))
)
const ra = api.getEntity(a.id) as { inLinks: unknown[] }
assert.equal(ra.inLinks.length, 1) // link restored exactly once (dedup)
assert.ok(api.getEntity(b.id))
assert.equal(
  (api.getMap(m.id) as { features: { entity_id: number }[] }).features[0].entity_id,
  a.id
)
// Map-delete undo: row + feature return with original ids, the child map keeps its parent link
const child = api.createMap({ name: 'City', parent_map_id: m.id }) as { id: number }
// listMaps order is INSERTION order (not alphabetical): 'Island' was added last → last in the list
const late = api.createMap({ name: 'Island' }) as { id: number }
assert.equal((api.listMaps() as { id: number }[]).at(-1)?.id, late.id)
api.deleteMap(late.id)
const mFull = api.getMap(m.id) as {
  id: number
  name: string
  parent_map_id: number | null
  image_path: string | null
  width: number | null
  height: number | null
  layers: string
  features: {
    id: number
    map_id: number
    entity_id: number | null
    geometry: string
    style: string
  }[]
}
const savedFid = mFull.features[0].id
api.deleteMap(m.id)
assert.equal(api.getMap(m.id) as unknown, null)
assert.equal((api.getMap(child.id) as { parent_map_id: number | null }).parent_map_id, null)
api.restoreMap(
  mFull,
  mFull.features.map((f) => ({
    id: f.id,
    map_id: f.map_id,
    entity_id: f.entity_id,
    geometry: f.geometry,
    style: f.style
  })),
  [child.id]
)
const mBack = api.getMap(m.id) as { features: { id: number }[] }
assert.equal(mBack.features.length, 1)
assert.equal(mBack.features[0].id, savedFid) // fid preserved (timeline / map-history binding)
assert.equal((api.getMap(child.id) as { parent_map_id: number | null }).parent_map_id, m.id)
backupIfNeeded()
assert.ok(existsSync(join(dir, 'backups')))
assert.ok(readdirSync(join(dir, 'backups')).length >= 1)
const manual = api.backupNow()
assert.ok(existsSync(manual))
// Retention by COUNT, not only by age. Age alone bounds nothing: a copy is taken on every launch
// and again on every file opened, and three weeks of that reached 297 files without one being
// old enough to prune.
{
  const bdir = join(dir, 'backups')
  for (let i = 0; i < 70; i++) writeFileSync(join(bdir, `world-filler-${i}.db`), 'x')
  // Taken AFTER the filler, so it is genuinely the newest — which is the property being tested.
  const newest = api.backupNow()
  backupIfNeeded()
  const left = readdirSync(bdir)
  assert.ok(
    left.length <= BACKUP_KEEP_FILES,
    `count cap: ${left.length} files left, expected at most ${BACKUP_KEEP_FILES}`
  )
  // The newest survive: the copy taken seconds before something went wrong is the one wanted.
  assert.ok(left.includes(basename(newest)), 'the most recent backup must not be pruned')
  // Age is judged by when the BACKUP was taken, not by the mtime it inherited. copyFileSync
  // copies the source's timestamps on Windows, so a copy of a world untouched for a month was
  // born older than the cutoff and deleted on the next launch — silently, and exactly when it
  // was the only copy that mattered.
  const stale = join(bdir, 'world-stale-source.db')
  writeFileSync(stale, 'x')
  const long = new Date(Date.now() - (BACKUP_KEEP_DAYS + 10) * 86_400_000)
  utimesSync(stale, long, long) // an old mtime on a file created just now, as a copy would have
  backupIfNeeded()
  assert.ok(existsSync(stale), 'a fresh backup of an old world must not be pruned as old')
}
// .world pack/unpack round trip: the image is embedded; after the working copy is overwritten
// and reopened, both data and image come back intact, and no assets table remains
writeFileSync(join(dir, 'assets', 'test.png'), Buffer.from([1, 2, 3]))
// packWorld now prunes unused images → test.png must be referenced (or it would be deleted)
api.updateEntity(a.id, { fields: JSON.stringify({ banner: 'assets/test.png' }) })
const dunya = join(dir, 'test.world')
// saveWorld and unpackWorld both leave this row in the working copy before every pack, so the
// pack under test has to start from the same state or it proves nothing — the first version of
// the assertion below passed against the broken code precisely because this line was missing.
api.setSetting('worldFile', join(dir, 'AUTHORS-PRIVATE-PATH', 'test.world'))
packWorld(dunya)
assert.ok(existsSync(dunya))
api.updateEntity(a.id, { name: 'Changed After Packing' })
rmSync(join(dir, 'assets', 'test.png'))
unpackWorld(dunya)
assert.equal((api.getEntity(a.id) as { name: string }).name, 'Test State') // the state at pack time
assert.deepEqual([...readFileSync(join(dir, 'assets', 'test.png'))], [1, 2, 3]) // the image came back out
assert.equal(api.getSetting('worldFile'), dunya) // set by the OPEN, from the real path
// …and absent from the FILE — the BYTES, not the row. The first version of this asserted that
// `SELECT value FROM settings WHERE key = 'worldFile'` came back empty, and it passed while the
// path was still plainly readable in the packed file with a text editor: SQLite frees a cell by
// dropping it from the page index, not by erasing it, so deleting the row from the OUTPUT left
// its bytes behind. Found on one of the real worlds on this machine, not here. The row is a
// proxy; the file is the thing that gets handed to somebody, so the file is what is checked.
assert.ok(
  !readFileSync(dunya).includes('AUTHORS-PRIVATE-PATH'),
  'a shared .world must not carry the path it was saved to, in any form'
)
assert.ok(
  !__test.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'assets'`).get()
)
// …and the FILE shrank with it. Dropping the table frees pages without shrinking the file, so
// the working copy kept the full weight of every image it had ever unpacked: 102.4 MB measured
// on a real one, 26 206 of 26 217 pages free, and every backup copied it. VACUUM leaves none.
assert.equal(
  Object.values(__test.db.prepare(`PRAGMA freelist_count`).get() as object)[0],
  0,
  'unpackWorld must VACUUM: a dropped assets table leaves the file at its old size'
)
// FUZZ the metadata stripper. It is the only byte-level parser in this app, it was written in one
// sitting, and it runs over every image on the way into a shared file — so "it worked on my two
// fixtures" is not enough. Mutated JPEGs and PNGs, driven by a seeded generator so a failure is
// reproducible, against the two properties that actually matter:
//
//   1. it never throws (a save must not die on a strange image), and
//   2. it either returns the input UNCHANGED or something strictly shorter that still begins with
//      the same signature — it may remove, it may never add or rewrite.
//
// Anything it cannot follow must come back byte-identical, which is the property that keeps a
// half-understood file from being corrupted on its way out.
{
  let seed = 0x2545f491
  const rnd = (n: number): number => {
    // xorshift32 — deterministic, so a failing case can be reproduced from the seed alone
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return Math.abs(seed) % n
  }
  const baseJpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe0, 0x00, 0x09]),
    Buffer.from('JFIF-OK', 'latin1'),
    Buffer.from([0xff, 0xe1, 0x00, 0x0c]),
    Buffer.from('ExifSECRET', 'latin1'),
    Buffer.from([0xff, 0xda, 0x00, 0x02]),
    Buffer.from([0x11, 0x22, 0xff, 0xd9])
  ])
  const basePng = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0, 0, 0, 4]),
    Buffer.from('IHDR', 'latin1'),
    Buffer.from('DATA', 'latin1'),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from([0, 0, 0, 6]),
    Buffer.from('tEXtSECRET', 'latin1'),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from('IEND', 'latin1'),
    Buffer.from([0, 0, 0, 0])
  ])
  const baseWebp = (() => {
    const body = Buffer.concat([
      Buffer.from('WEBP', 'latin1'),
      Buffer.from('VP8L', 'latin1'),
      Buffer.from([6, 0, 0, 0]),
      Buffer.from('PIXELS', 'latin1'),
      Buffer.from('EXIF', 'latin1'),
      Buffer.from([6, 0, 0, 0]),
      Buffer.from('SECRET', 'latin1')
    ])
    const head = Buffer.alloc(8)
    head.write('RIFF', 0, 'latin1')
    head.writeUInt32LE(body.length, 4)
    return Buffer.concat([head, body])
  })()
  const baseGif = Buffer.concat([
    Buffer.from('GIF89a', 'latin1'),
    Buffer.from([1, 0, 1, 0, 0, 0, 0]),
    Buffer.from([0x21, 0xfe, 6]),
    Buffer.from('SECRET', 'latin1'),
    Buffer.from([0]),
    Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0]),
    Buffer.from([2, 2, 0x44, 0x41, 0]),
    Buffer.from([0x3b])
  ])
  let changed = 0
  for (let i = 0; i < 4000; i++) {
    const src = [baseJpeg, basePng, baseWebp, baseGif][i % 4]
    const b = Buffer.from(src)
    // One to three byte-level mutations: truncation, a flipped byte, a bogus length.
    const muts = 1 + rnd(3)
    for (let m = 0; m < muts; m++) b[rnd(b.length)] = rnd(256)
    const buf = rnd(4) === 0 ? b.subarray(0, 1 + rnd(b.length)) : b
    const out = stripImageMetadata(Buffer.from(buf))
    assert.ok(out.length <= buf.length, 'the stripper may remove, never add')
    if (out.length !== buf.length) {
      changed++
      assert.deepEqual(
        [...out.subarray(0, 3)],
        [...buf.subarray(0, 3)],
        'a rewritten image keeps its signature'
      )
      assert.ok(
        !out.includes('SECRET') || !buf.includes('SECRET'),
        'if it rewrote the file at all, the metadata block went with it'
      )
    } else {
      assert.deepEqual([...out], [...buf], 'unchanged length must mean unchanged bytes')
    }
  }
  // An EOI before the first SOS. The image ends there, so everything after it is not a segment
  // chain — but the standalone-marker range stopped at 0xD8, so 0xD9 fell through to the length
  // read and the walk desynchronised into whatever followed. This fixture is built so that the
  // bytes after EOI LOOK like an APP1 segment: read that way they are deleted, and a span of the
  // file disappears while the function reports success. Nothing here is metadata, so the honest
  // answer is the original buffer, byte for byte.
  {
    const afterEoi = Buffer.concat([
      Buffer.from([0xff, 0xd8]), // SOI
      Buffer.from([0xff, 0xe0, 0x00, 0x09]),
      Buffer.from('JFIF-OK', 'latin1'), // APP0
      Buffer.from([0xff, 0xd9]), // EOI — the image ends here
      Buffer.from([0x00, 0x04, 0x61, 0x62]), // read as EOI's "length" by the broken walk
      Buffer.from([0xff, 0xe1, 0x00, 0x08]),
      Buffer.from('PIXELS', 'latin1'), // and this then looks like APP1, and was deleted
      Buffer.from([0xff, 0xda, 0x00, 0x02]),
      Buffer.from([0x11, 0x22, 0xff, 0xd9])
    ])
    assert.ok(
      stripImageMetadata(afterEoi) === afterEoi,
      'nothing after an EOI may be parsed as a segment, let alone dropped'
    )
  }

  // WEBP AND GIF. importAsset has always accepted both, and neither had a stripper — so the
  // format most likely to carry GPS today (a phone photo saved as .webp) was the one the
  // guarantee did not cover. RIFF is a flat chunk list; the container size has to be rewritten
  // when a chunk goes, which is the only byte any stripper here edits rather than omits.
  {
    const riff = (chunks: Buffer[]): Buffer => {
      const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), ...chunks])
      const head = Buffer.alloc(8)
      head.write('RIFF', 0, 'latin1')
      head.writeUInt32LE(body.length, 4)
      return Buffer.concat([head, body])
    }
    const chunk = (fourcc: string, data: string): Buffer => {
      const size = Buffer.alloc(8)
      size.write(fourcc, 0, 'latin1')
      size.writeUInt32LE(data.length, 4)
      const pad = data.length % 2 ? Buffer.from([0]) : Buffer.alloc(0)
      return Buffer.concat([size, Buffer.from(data, 'latin1'), pad])
    }
    const webp = riff([chunk('VP8L', 'PIXELS'), chunk('EXIF', 'GPS 41.0 CAM#77')])
    const outW = stripImageMetadata(webp)
    assert.ok(!outW.includes('GPS 41.0'), 'a WEBP must not carry EXIF into a shared world')
    assert.ok(outW.includes('PIXELS'), 'and its picture data must survive')
    assert.equal(outW.toString('latin1', 0, 4), 'RIFF', 'still a RIFF file')
    assert.equal(
      outW.readUInt32LE(4),
      outW.length - 8,
      'and the container size must match what is left, or no decoder will read it'
    )
    // Nothing to remove: the bytes must come back untouched, not merely equal.
    const plain = riff([chunk('VP8L', 'PIXELS')])
    assert.ok(stripImageMetadata(plain) === plain, 'a clean WEBP is not even copied')

    // GIF: the comment extension goes; the NETSCAPE application extension is what makes an
    // animation loop and must NOT, which is why only XMP is dropped from that block type.
    const gif = Buffer.concat([
      Buffer.from('GIF89a', 'latin1'),
      Buffer.from([1, 0, 1, 0, 0, 0, 0]), // screen descriptor, no global colour table
      Buffer.from([0x21, 0xfe, 13]),
      Buffer.from('by the author', 'latin1'),
      Buffer.from([0]), // comment extension — must GO
      Buffer.from([0x21, 0xff, 11]),
      Buffer.from('NETSCAPE2.0', 'latin1'),
      Buffer.from([3, 1, 0, 0, 0]), // application extension — must SURVIVE
      Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0]),
      Buffer.from([2, 2, 0x44, 0x41, 0]), // lzw min code size + one sub-block + terminator
      Buffer.from([0x3b]) // trailer
    ])
    const outG = stripImageMetadata(gif)
    assert.ok(!outG.includes('by the author'), 'a GIF comment must not travel')
    assert.ok(outG.includes('NETSCAPE2.0'), 'but the looping block must stay')
    assert.equal(outG[outG.length - 1], 0x3b, 'and the file must still end at its trailer')
    assert.ok(stripImageMetadata(outG) === outG, 'a second pass finds nothing left to remove')
  }

  // A JPEG that runs out before SOS has no image data in it at all, so it is not a file this
  // function followed to the end and it comes back whole. Directed for the same reason as the
  // case below: the mutator rarely lands on one, and a guard no test reaches is not a guard.
  const noSos = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe1, 0x00, 0x0c]),
    Buffer.from('ExifSECRET', 'latin1')
  ])
  assert.deepEqual(
    [...stripImageMetadata(noSos)],
    [...noSos],
    'a JPEG that ends before its image data is left alone'
  )
  // Bytes AFTER IEND. Some tools append them; the mutator above never produces a file that is
  // both valid to IEND and followed by something, so this branch gets a fixture of its own.
  // Reverting it must break a test, or it is a guard nobody can trust.
  const withTail = Buffer.concat([basePng, Buffer.from('APPENDED-TAIL', 'latin1')])
  const tailOut = stripImageMetadata(withTail)
  assert.ok(!tailOut.includes('SECRET'), 'metadata still goes when the file has a tail')
  assert.ok(tailOut.includes('APPENDED-TAIL'), 'and whatever follows IEND is carried over whole')
  assert.ok(tailOut.length < withTail.length, 'so the result is shorter by exactly the chunk')

  // The run has to actually exercise the rewriting path, or it is 4000 no-ops.
  assert.ok(changed > 100, `the fuzz must reach the rewrite path (reached it ${changed} times)`)
}
// DELETED CONTENT MUST NOT TRAVEL. A SQLite delete frees the page, it does not erase the bytes —
// so a plain file copy of world.db would hand whoever you shared it with every entry you ever
// wrote and removed, readable with a text editor. packWorld uses VACUUM INTO, which REBUILDS the
// database into the target rather than copying it, and free pages are not rebuilt. That is a
// strong claim to leave resting on a comment, so it is measured: write something distinctive,
// delete it, pack, and search the packed FILE for it.
{
  const secret = 'DELETED-SECRET-' + 'zqxwv'
  const gone = api.createEntity({ name: 'To be deleted' }) as { id: number }
  api.updateEntity(gone.id, { content: secret + ' something private I removed' })
  api.deleteEntity(gone.id)
  const shared = join(dir, 'no-ghosts.world')
  packWorld(shared)
  assert.ok(
    !readFileSync(shared).includes(secret),
    'deleted content must not survive inside a shared .world'
  )
  // …and the same file still has what was NOT deleted, or the check above would pass on an
  // empty file.
  assert.ok(readFileSync(shared).includes('Test State'), 'while the world itself is still there')
  rmSync(shared, { force: true })
}
// What LEAVES must not carry the author. A photo's EXIF holds GPS to a few metres, the camera's
// serial and the exact second the shutter opened; XMP holds a name and an editing history. Both
// rode inside every .world handed to anybody, because importAsset and packWorld copy the file
// byte for byte. Stripped on the way OUT only — the user's own copy keeps what it came with.
//
// The fixtures are built by hand rather than checked in: a real photo in the repo would be
// someone's actual metadata, which is the thing being tested.
{
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8]), // SOI
    Buffer.from([0xff, 0xe0, 0x00, 0x09]), // APP0 JFIF — colour/format, must SURVIVE
    Buffer.from('JFIF-OK', 'latin1'),
    Buffer.from([0xff, 0xe1, 0x00, 0x1c]), // APP1 EXIF — must GO
    Buffer.from('Exif\0\0GPS 41.0 28.9 CAM#77', 'latin1'),
    Buffer.from([0xff, 0xfe, 0x00, 0x0f]), // COM — must GO
    Buffer.from('by the author', 'latin1'),
    Buffer.from([0xff, 0xda, 0x00, 0x02]), // SOS: everything after is copied verbatim
    Buffer.from([0x11, 0x22, 0x33, 0xff, 0xd9])
  ])
  const chunk = (type: string, data: string): Buffer =>
    Buffer.concat([
      (() => {
        const b = Buffer.alloc(4)
        b.writeUInt32BE(data.length)
        return b
      })(),
      Buffer.from(type, 'latin1'),
      Buffer.from(data, 'latin1'),
      Buffer.from([0, 0, 0, 0]) // crc — whole chunks are dropped, none is recomputed
    ])
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', 'PIXELDATA'), // must SURVIVE
    chunk('tEXt', 'Author\0the author'), // must GO
    chunk('IEND', '')
  ])
  writeFileSync(join(dir, 'assets', 'photo.jpg'), jpeg)
  writeFileSync(join(dir, 'assets', 'shot.png'), png)
  // Referenced, or pruneUnusedAssets deletes them before the pack and the test proves nothing.
  api.updateEntity(a.id, { content: 'assets/photo.jpg assets/shot.png' })
  const stripped = join(dir, 'stripped.world')
  packWorld(stripped)
  const sd = new DatabaseSync(stripped, { readOnly: true })
  const outJpeg = (
    sd.prepare(`SELECT data FROM assets WHERE name = 'photo.jpg'`).get() as { data: Uint8Array }
  ).data
  const outPng = (
    sd.prepare(`SELECT data FROM assets WHERE name = 'shot.png'`).get() as { data: Uint8Array }
  ).data
  sd.close()
  const j = Buffer.from(outJpeg).toString('latin1')
  assert.ok(!j.includes('GPS 41.0'), 'EXIF must not travel inside a shared .world')
  assert.ok(!j.includes('by the author'), 'nor a JPEG comment')
  assert.ok(j.includes('JFIF-OK'), 'but the colour/format segments must survive')
  assert.ok(j.endsWith('\u0011\u0022\u0033\u00ff\u00d9'), 'and the image data must be untouched')
  const g = Buffer.from(outPng).toString('latin1')
  assert.ok(!g.includes('the author'), 'a PNG text chunk must not travel either')
  assert.ok(g.includes('PIXELDATA'), 'and its real chunks must survive')
  // Anything it cannot parse comes back byte-identical — a cleaner that corrupts an image is
  // worse than the metadata it removes.
  const junk = Buffer.from([0xff, 0xd8, 0x00, 0x01, 0x02])
  assert.deepEqual([...stripImageMetadata(junk)], [...junk], 'an unreadable JPEG is left alone')
  const notImage = Buffer.from('this is a text file', 'utf8')
  assert.deepEqual([...stripImageMetadata(notImage)], [...notImage], 'and so is a non-image')
  rmSync(join(dir, 'assets', 'photo.jpg'), { force: true })
  rmSync(join(dir, 'assets', 'shot.png'), { force: true })
  rmSync(stripped, { force: true })
  api.updateEntity(a.id, { content: 'Test State content' })
}
// Malicious .world: what the embedded image NAMES are allowed to be. A shared world is the one
// way past the app's own rule for that folder — importAsset takes images only, and extraction
// used to take anything and reduce it to a basename. Escape was closed; the extension and the
// content were not, so a world could drop `setup.exe` into a folder inside the user's Documents.
//
// Every name below must produce NO file, at the place it points to AND inside assets/: the rule
// is refusal, not repair. `../../x.png` reduced to `x.png` writes over the image that IS ours.
{
  const evil = join(dir, 'evil.world')
  copyFileSync(dunya, evil)
  const ev = new DatabaseSync(evil)
  ev.exec(`CREATE TABLE IF NOT EXISTS assets (name TEXT PRIMARY KEY, data BLOB NOT NULL)`)
  const put = ev.prepare(`INSERT OR REPLACE INTO assets (name, data) VALUES (?, ?)`)
  const refused = [
    join('..', '..', 'kacti.png'), // escape, and the basename it used to be reduced to
    'setup.exe', // the whole point: an image folder takes images
    'evil.dll',
    'shortcut.lnk',
    'note.png.exe', // only the LAST extension counts
    'logo.png:ads', // an NTFS alternate data stream — basename() leaves the colon intact
    'nul.png', // a Windows device whatever the extension: writes nowhere
    'com1.png'
  ]
  for (const n of refused) put.run(n, Buffer.from([9]))
  // A real image alongside them: refusing the bad rows must not cost the world its good ones.
  put.run('iyi.png', Buffer.from([9]))
  // EVERY name is referenced from the world's text, not just the good one. unpackWorld ends with
  // pruneUnusedAssets, which deletes any file the database does not mention — so with the names
  // unreferenced this test passed against the OLD basename behaviour too: the escaped file was
  // written and then swept away before the assertion looked for it. Referencing them is what
  // makes the assertions mean "never written" instead of "not there any more".
  ev.prepare(`UPDATE entities SET fields = ?, content = ? WHERE id = ?`).run(
    JSON.stringify({ banner: 'assets/iyi.png' }),
    refused.map((n) => basename(n)).join(' '),
    a.id
  )
  ev.close()
  unpackWorld(evil)
  assert.ok(
    !existsSync(join(dir, 'assets', '..', '..', 'kacti.png')),
    'embedded name escaped assets/!'
  )
  for (const n of refused)
    assert.ok(!existsSync(join(dir, 'assets', basename(n))), `${n} was written into assets/`)
  assert.ok(existsSync(join(dir, 'assets', 'iyi.png')), 'a real image must still be extracted')
  // …and the same rule on the other side of the folder, so the two writers cannot drift apart.
  assert.throws(() => importAsset(join(dir, 'setup.exe')), /Images only/)
  assert.equal(assetName('a b-1.png'), 'a b-1.png') // spaces and hyphens are ordinary in names
  assert.equal(assetName('Türkiye.JPG'), 'Türkiye.JPG') // non-ASCII, any case
  assert.equal(assetName(7), null) // SQLite is dynamically typed; the FILE's schema is not ours
  assert.equal(assetName('x'.repeat(300) + '.png'), null)
  // The dedup path used to append thirteen digits to a name already at the limit, minting a name
  // this app writes and then REFUSES on its own next open — the image simply missing, counted as
  // assets.refused. Two imports of the same very long name is the whole reproduction.
  {
    const longName = 'y'.repeat(195) + '.png'
    const src = join(dir, longName)
    writeFileSync(src, Buffer.from([1]))
    const first = importAsset(src)
    const second = importAsset(src)
    assert.notEqual(first, second, 'the second import must be disambiguated')
    for (const rel of [first, second])
      assert.ok(assetName(basename(rel)), `importAsset minted a name it would refuse: ${rel}`)
    rmSync(join(dir, 'assets', basename(first)), { force: true })
    rmSync(join(dir, 'assets', basename(second)), { force: true })
    rmSync(src, { force: true })
  }
}
// A world from a LATER version of this app. dropForeignTables deletes anything that is not one
// of our five tables, with its rows and without a word — right for a smuggled table, catastrophic
// for one a future build added. The error screen has always said a file "may have been created by
// a newer version"; until now nothing gave the app a way to know. Refusing beats opening, because
// the failure it prevents is silent deletion rather than a visible error.
{
  // What this build writes, read back off the file it just wrote.
  const stamped = new DatabaseSync(dunya, { readOnly: true })
  const v = (stamped.prepare(`PRAGMA user_version`).get() as { user_version: number }).user_version
  stamped.close()
  assert.equal(v, FORMAT_VERSION, 'a packed world carries the format version it was written with')

  const future = join(dir, 'future.world')
  rmSync(future, { force: true })
  copyFileSync(dunya, future)
  const fd = new DatabaseSync(future)
  fd.exec(`PRAGMA user_version = ${FORMAT_VERSION + 1}`)
  fd.close()
  assert.throws(() => unpackWorld(future), /WORLD_TOO_NEW/, 'a newer world must be refused')
  assert.ok(api.getEntity(a.id), 'and refusing must not disturb the open world')

  // Everything already on disk reads back as 0, which is below the current version, so no world
  // written before this gate existed is locked out by it.
  const old = join(dir, 'old-format.world')
  rmSync(old, { force: true })
  copyFileSync(dunya, old)
  const od = new DatabaseSync(old)
  od.exec(`PRAGMA user_version = 0`)
  od.close()
  unpackWorld(old) // must not throw
  assert.ok(api.getEntity(a.id), 'a world from before the gate still opens')
}
// A .world whose tables carry our NAMES but not our SHAPE. `CREATE TABLE IF NOT EXISTS` is a
// no-op against a table that already exists, so this passes the read-only probe (real tables,
// queryable) and passes the repairs (which only UPDATE) — and then refuses every edit the user
// makes for the rest of the session, on a world that opened without a word.
{
  for (const [label, sql] of [
    [
      'a CHECK that refuses every row',
      `CREATE TABLE entities (id INTEGER PRIMARY KEY, type TEXT NOT NULL DEFAULT '', name TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', fields TEXT NOT NULL DEFAULT '{}', created_at TEXT, updated_at TEXT, CHECK (0))`
    ],
    [
      'a required column with no default',
      `CREATE TABLE entities (id INTEGER PRIMARY KEY, type TEXT NOT NULL DEFAULT '', name TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', fields TEXT NOT NULL DEFAULT '{}', created_at TEXT, updated_at TEXT, tribute TEXT NOT NULL)`
    ]
  ] as [string, string][]) {
    const wedge = join(dir, 'wedge.world')
    rmSync(wedge, { force: true })
    copyFileSync(dunya, wedge)
    const wd = new DatabaseSync(wedge)
    wd.exec(`DROP TABLE features; DROP TABLE links; DROP TABLE entities`)
    wd.exec(sql)
    wd.exec(
      `CREATE TABLE links (id INTEGER PRIMARY KEY, from_id INTEGER NOT NULL, to_id INTEGER NOT NULL, relation TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '')`
    )
    wd.exec(
      `CREATE TABLE features (id INTEGER PRIMARY KEY, map_id INTEGER NOT NULL, entity_id INTEGER, geometry TEXT NOT NULL, style TEXT NOT NULL DEFAULT '{}')`
    )
    wd.close()
    assert.throws(() => unpackWorld(wedge), /NOT_A_WORLD/, label)
  }
  assert.ok(api.getEntity(a.id), 'the open world must survive the refusal')
  // The probe must leave nothing of its own behind — it runs on every single open.
  assert.equal(api.getSetting('probe'), null, 'the write probe leaked a row')
}
// A .world with malformed JSON columns must be repaired on open — otherwise one of the 20+
// JSON.parse sites in the renderer throws and that whole view goes down (the map never opens)
{
  const broken = join(dir, 'broken.world')
  copyFileSync(dunya, broken)
  const bd = new DatabaseSync(broken)
  bd.exec(`UPDATE entities SET fields = 'BOZUK{{'`)
  bd.exec(`UPDATE features SET style = '[1,2]'`) // valid JSON but an ARRAY — an object is expected
  bd.exec(`UPDATE maps SET layers = 'yok'`)
  bd.exec(`UPDATE features SET geometry = '{"type":"Polygon" KESIK'`) // parsed unguarded in 8 places
  bd.exec(`INSERT OR REPLACE INTO settings (key, value) VALUES ('mapModes', '{bozuk')`)
  bd.exec(`INSERT OR REPLACE INTO settings (key, value) VALUES ('theme', 'dark')`)
  bd.close()
  unpackWorld(broken)
  assert.equal(
    (api.getEntity(a.id) as { fields: string }).fields,
    '{}',
    'malformed fields must be repaired'
  )
  const bm = api.getMap(m.id) as {
    layers: string
    features: { style: string; geometry: string }[]
  }
  assert.equal(bm.features[0].style, '{}', 'malformed style must be repaired')
  assert.equal(bm.layers, '[]', 'malformed layers must be repaired')
  assert.equal(api.getSetting('mapModes'), null, 'a malformed JSON setting must be deleted')
  assert.equal(api.getSetting('theme'), 'dark', 'a plain-TEXT setting must survive (not JSON)')
  // geometry was NOT covered by this gate once, and MapView/Atlas parse it without a try —
  // one bad row took down the whole map render. It must come out parseable.
  JSON.parse(bm.features[0].geometry) // throws the assertion for us if the repair regressed
  assert.equal(
    (JSON.parse(bm.features[0].geometry) as { type: string }).type,
    'Point',
    'malformed geometry must be repaired to a degenerate Point, not left as-is'
  )
  // ...and a geometry that PARSES but is not one is the same dead map one step further in:
  // L.geoJSON walks `coordinates` and throws inside the reload. A plausible object is not a
  // geometry.
  const shaped = join(dir, 'shaped.world')
  copyFileSync(dunya, shaped)
  const sh = new DatabaseSync(shaped)
  sh.exec(`UPDATE features SET geometry = '{"type":"Polygon","coordinates":"x"}'`)
  sh.close()
  unpackWorld(shaped)
  const sm = api.getMap(m.id) as { features: { geometry: string }[] }
  assert.equal(
    (JSON.parse(sm.features[0].geometry) as { type: string }).type,
    'Point',
    'a well-formed object that is not a geometry is repaired too'
  )
}
// A file that is NOT one of our worlds must be refused BEFORE anything is overwritten.
// Without the probe this destroyed world.db and the app could not be launched again at all:
// initDb threw on the garbage before a window existed, so ErrorBoundary could not help.
{
  const notDb = join(dir, 'not-a-world.world')
  writeFileSync(notDb, 'plain text wearing a .world extension')
  const before = (api.listEntities() as unknown[]).length
  assert.throws(() => unpackWorld(notDb), /NOT_A_WORLD/, 'a non-database must be refused')
  assert.equal((api.listEntities() as unknown[]).length, before, 'the open world must survive')
  // A real SQLite file that is not OURS is refused the same way (missing tables)
  const stray = join(dir, 'stray.world')
  const sd = new DatabaseSync(stray)
  sd.exec(`CREATE TABLE notes (id INTEGER PRIMARY KEY)`)
  sd.close()
  assert.throws(() => unpackWorld(stray), /NOT_A_WORLD/, 'a foreign database must be refused')
  assert.equal((api.listEntities() as unknown[]).length, before, 'the open world must survive')
  // A file that names a VIEW `entities` reads like a world and passes every SELECT, then
  // refuses writes — it must be caught at the gate, not half-opened.
  const viewy = join(dir, 'viewy.world')
  copyFileSync(dunya, viewy)
  const vd = new DatabaseSync(viewy)
  vd.exec(`ALTER TABLE entities RENAME TO real_ents`)
  vd.exec(`CREATE VIEW entities AS SELECT * FROM real_ents`)
  vd.close()
  assert.throws(() => unpackWorld(viewy), /NOT_A_WORLD/, 'a view standing in for a table')
}
// A .world carries more than rows. A TRIGGER rides along and then fires against the USER's own
// edits from then on — 'after every insert, rename everything' is sabotage that survives every
// save. None of this is part of the format, so it must not reach the working copy.
{
  const rigged = join(dir, 'rigged.world')
  copyFileSync(dunya, rigged)
  const rg = new DatabaseSync(rigged)
  rg.exec(
    `CREATE TRIGGER sabotage AFTER INSERT ON entities BEGIN UPDATE entities SET name = 'OWNED'; END`
  )
  rg.exec(`CREATE VIEW sneak AS SELECT * FROM entities`)
  rg.exec(`CREATE INDEX foreign_idx ON entities(name)`)
  rg.exec(`CREATE TABLE backdoor (x TEXT)`)
  rg.close()
  unpackWorld(rigged)
  const left = __test.db
    .prepare(`SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'`)
    .all() as { type: string; name: string }[]
  assert.ok(
    left.every((r) => r.type === 'table' && OUR_TABLES.has(r.name)),
    'only our tables may survive an open: ' + JSON.stringify(left)
  )
  api.createEntity({ name: 'After The Trigger' })
  assert.ok(
    !(api.listEntities() as { name: string }[]).some((e) => e.name === 'OWNED'),
    'a planted trigger must not fire on the user later'
  )
}
// Depth: whether a deeply nested value parses depends on the stack left, so main can accept
// what the renderer then cannot read. Measured with a 208 KB file that opened cleanly and left
// the map unrenderable. The gate bounds depth WITHOUT parsing, so both sides agree.
{
  // A LOOP in either tree. Both parents are plain ids in a file someone sent you, and the app's
  // own cycle guard sits where a cycle would be created — which a file bypasses entirely. Nobody
  // downstream survives one: the map breadcrumb is a `while` that never ends, and both trees are
  // recursive renders. The link is cut, never the row: the maps and their drawings are the work.
  // An assets table whose COLUMN TYPES are not ours. Easy to miss, because our schema says
  // `name TEXT, data BLOB` — and the schema being read here is the FILE's, in a database that is
  // dynamically typed. A name stored as an integer threw inside basename(), from a point where
  // the rescue copy had already been dropped: the open failed with the working copy already
  // replaced and none of the repairs run.
  const typed = join(dir, 'typed.world')
  copyFileSync(dunya, typed)
  const ty = new DatabaseSync(typed)
  // NO column types, which is the point: a TEXT column would have converted the integer below
  // on the way in (affinity), and the test would have proved nothing. A file writes its own
  // schema, and a typeless column keeps whatever it is given.
  ty.exec(`DROP TABLE IF EXISTS assets`)
  ty.exec(`CREATE TABLE assets (name, data)`)
  ty.exec(`INSERT INTO assets (name, data) VALUES (7, x'00'), ('ok.png', x'0102')`)
  // Referenced by a map, or pruneUnusedAssets deletes it at the end of the open — correctly,
  // and it would make this assertion test the pruner instead of the extractor.
  ty.exec(`UPDATE maps SET image_path = 'assets/ok.png'`)
  ty.close()
  unpackWorld(typed) // must not throw
  assert.ok(
    readdirSync(join(dir, 'assets')).includes('ok.png'),
    'a row that is not a name and some bytes is skipped, and the rest still extract'
  )
  assert.ok(
    !existsSync(join(dir, 'world.db.rescue')),
    'and the open completes rather than leaving the rescue copy behind'
  )

  // THE RECOVERY BOUNDARY COVERS assets/ AS WELL AS world.db.
  //
  // `world.db` has had a rescue copy since the beginning. The images never did — they were
  // written straight into assets/ — so a file that extracted its pictures and then threw was
  // rolled back for the database and not for the folder: the user was told the open had failed
  // and got their world back with someone else's pictures inside it. Nothing recovered that,
  // because every backup holds world.db alone.
  //
  // The failure is arranged with a `settings` table carrying no PRIMARY KEY. That is the LAST
  // thing to throw rather than an early one, and it is not contrived: `CREATE TABLE IF NOT
  // EXISTS` is a no-op against a table that already exists, so a file writes its own schema, and
  // the upsert in setSetting needs the key our schema declares. probeWritable does not catch it —
  // it inserts, and a plain INSERT works fine without the key. So this reproduces the exact
  // shape of the hole: a file that passes every gate and throws on the last line of the open.
  {
    const mine = join(dir, 'assets', 'logo.png')
    writeFileSync(mine, Buffer.from('THE USERS OWN PICTURE'))
    // Something the hostile file provably does NOT carry: `late` is a copy of `dunya`, which was
    // packed long before this line, so without a marker of its own the "we rolled back to the
    // world they had" assertion could pass on two identical worlds and prove nothing.
    api.createEntity({ name: 'ONLY IN THE USERS WORKING COPY' })
    api.setSetting('probe.before', 'the world the user already had')
    const before = (api.listEntities() as { name: string }[]).map((e) => e.name).join('|')
    assert.ok(before.includes('ONLY IN THE USERS WORKING COPY'), 'fixture: the marker is in place')

    const late = join(dir, 'late-failure.world')
    copyFileSync(dunya, late)
    const lf = new DatabaseSync(late)
    lf.exec(`DROP TABLE IF EXISTS assets`)
    lf.exec(`CREATE TABLE assets (name TEXT PRIMARY KEY, data BLOB NOT NULL)`)
    lf.prepare(`INSERT INTO assets (name, data) VALUES (?, ?)`).run(
      'logo.png', // the SAME name, which is the whole point
      Buffer.from('ATTACKER PAYLOAD')
    )
    // settings, minus the PRIMARY KEY: setSetting's upsert is the first thing to fail, and it
    // now runs inside the boundary rather than after the rescue was dropped.
    lf.exec(`ALTER TABLE settings RENAME TO settings_old`)
    lf.exec(`CREATE TABLE settings (key TEXT, value TEXT NOT NULL)`)
    lf.exec(`INSERT INTO settings (key, value) SELECT key, value FROM settings_old`)
    lf.exec(`DROP TABLE settings_old`)
    lf.close()

    assert.throws(() => unpackWorld(late), /.+/, 'a world that throws after extraction is refused')
    assert.equal(
      readFileSync(mine, 'utf8'),
      'THE USERS OWN PICTURE',
      "a refused open must leave the user's images exactly as they were"
    )
    assert.equal(
      (api.listEntities() as { name: string }[]).map((e) => e.name).join('|'),
      before,
      'and the database it rolled back to is still the one they had'
    )
    assert.equal(api.getSetting('probe.before'), 'the world the user already had')
    assert.ok(
      !existsSync(join(dir, 'assets' + STAGING_SUFFIX)) &&
        !existsSync(join(dir, 'assets' + REPLACED_SUFFIX)),
      'and neither staging folder is left behind'
    )
    assert.ok(
      !existsSync(join(dir, 'world.db.rescue')),
      'the rescue copy is consumed, not left on disk'
    )

    // The same path when it SUCCEEDS: the images do land, over the old ones, and nothing extra
    // survives. Without this the assertion above would pass on an unpack that never extracts.
    const fine = join(dir, 'late-ok.world')
    copyFileSync(dunya, fine)
    const fo = new DatabaseSync(fine)
    fo.exec(`DROP TABLE IF EXISTS assets`)
    fo.exec(`CREATE TABLE assets (name TEXT PRIMARY KEY, data BLOB NOT NULL)`)
    fo.prepare(`INSERT INTO assets (name, data) VALUES (?, ?)`).run(
      'logo.png',
      Buffer.from('THE NEW WORLDS PICTURE')
    )
    // Referenced, or pruneUnusedAssets removes it at the end of the open — correctly, and the
    // assertion would then be testing the pruner rather than the swap.
    fo.exec(`UPDATE maps SET image_path = 'assets/logo.png'`)
    fo.close()
    unpackWorld(fine)
    assert.equal(
      readFileSync(mine, 'utf8'),
      'THE NEW WORLDS PICTURE',
      'a successful open does replace the image'
    )
    assert.ok(
      !existsSync(join(dir, 'assets' + STAGING_SUFFIX)) &&
        !existsSync(join(dir, 'assets' + REPLACED_SUFFIX)),
      'and leaves no staging or rollback residue behind it'
    )
    assert.ok(!existsSync(join(dir, 'world.db.rescue')), 'nor a rescue copy')
    assert.equal(
      api.getSetting('worldFile'),
      fine,
      'worldFile is written inside the boundary now, and still written'
    )
  }

  const looped = join(dir, 'looped.world')
  copyFileSync(dunya, looped)
  const lp = new DatabaseSync(looped)
  lp.exec(`DELETE FROM maps`)
  lp.exec(`INSERT INTO maps (id, name, parent_map_id) VALUES (1, 'A', 2), (2, 'B', 1)`)
  lp.exec(
    `INSERT INTO settings (key, value) VALUES ('entityFolders',
      '[{"id":"f1","name":"one","parent":"f2"},{"id":"f2","name":"two","parent":"f1"}]')
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )
  lp.close()
  unpackWorld(looped)
  const loopedMaps = api.listMaps() as { id: number; parent_map_id: number | null }[]
  const chain = (start: number): number => {
    const seen = new Set<number>()
    let cur: number | null = start
    let n = 0
    while (cur !== null && !seen.has(cur)) {
      seen.add(cur)
      n++
      cur = loopedMaps.find((m) => m.id === cur)?.parent_map_id ?? null
    }
    // A terminated walk ends on null; a loop ends because `seen` caught it.
    return cur === null ? n : -1
  }
  assert.ok(
    loopedMaps.every((m) => chain(m.id) > 0),
    'no map may still sit on a parent loop after an open'
  )
  const foldersAfter = JSON.parse(api.getSetting('entityFolders') || '[]') as {
    id: string
    parent: string | null
  }[]
  assert.ok(
    foldersAfter.some((f) => f.parent === null),
    'the folder loop is opened too, by cutting one link'
  )
  assert.equal(foldersAfter.length, 2, 'and neither folder is thrown away to do it')

  // DEPTH, which the loop check alone lets straight through: this chain has no cycle in it, and
  // both trees are rendered recursively, so what it produces is a stack overflow rather than a
  // hang. 400 is far past MAX_TREE_DEPTH and far short of anything a person builds.
  {
    const tall = join(dir, 'tall.world')
    copyFileSync(dunya, tall)
    const tp = new DatabaseSync(tall)
    tp.exec(`DELETE FROM maps`)
    const ins = tp.prepare(`INSERT INTO maps (id, name, parent_map_id) VALUES (?, ?, ?)`)
    for (let i = 1; i <= 400; i++) ins.run(i, `M${i}`, i === 1 ? null : i - 1)
    const chainF = Array.from({ length: 400 }, (_, i) => ({
      id: `f${i}`,
      name: `f${i}`,
      parent: i === 0 ? null : `f${i - 1}`
    }))
    tp.prepare(
      `INSERT INTO settings (key, value) VALUES ('entityFolders', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(JSON.stringify(chainF))
    tp.close()
    unpackWorld(tall)
    const tallMaps = api.listMaps() as { id: number; parent_map_id: number | null }[]
    const byId = new Map(tallMaps.map((x) => [x.id, x.parent_map_id]))
    const depth = (start: number): number => {
      let n = 1
      let cur = byId.get(start) ?? null
      while (cur !== null && n < 5000) {
        n++
        cur = byId.get(cur) ?? null
      }
      return n
    }
    assert.ok(
      tallMaps.every((x) => depth(x.id) <= MAX_TREE_DEPTH + 1),
      'no map may sit deeper than the limit after an open'
    )
    assert.equal(tallMaps.length, 400, 'and not one of them is deleted to achieve it')
    const tallFolders = JSON.parse(api.getSetting('entityFolders') || '[]') as {
      id: string
      parent: string | null
    }[]
    assert.equal(tallFolders.length, 400, 'the folder chain keeps every folder')
    assert.ok(
      tallFolders.filter((f) => f.parent === null).length > 1,
      'and is cut into shallower pieces rather than left as one 400-deep chain'
    )
  }

  const deep = join(dir, 'deep.world')
  copyFileSync(dunya, deep)
  const nest = (n: number): string => '{"a":'.repeat(n) + '1' + '}'.repeat(n)
  const dp = new DatabaseSync(deep)
  dp.prepare(`UPDATE entities SET fields = ?`).run(nest(10000))
  dp.prepare(`UPDATE features SET style = ?, geometry = ?`).run(nest(10000), nest(10000))
  dp.close()
  unpackWorld(deep)
  const dm = api.getMap(m.id) as { features: { style: string; geometry: string }[] }
  assert.equal((api.getEntity(a.id) as { fields: string }).fields, '{}', 'deep fields reset')
  assert.equal(dm.features[0].style, '{}', 'deep style reset')
  assert.equal(
    dm.features[0].geometry,
    '{"type":"Point","coordinates":[0,0]}',
    'deep geometry reset'
  )
  // BRACES INSIDE STRINGS. The depth check scans rather than parses, so it has to know that a
  // brace inside a string value is text and not nesting — and getting that wrong does not throw,
  // it silently resets the entry's fields to '{}' at the entry gate. Silent data loss on a
  // perfectly good world, which is the worst failure this function can have and the one nothing
  // was testing. Not contrived either: someone writing about a constructed language keeps
  // grammar notation, sample code and quoted text in their notes.
  const bracey = JSON.stringify({
    note: '{'.repeat(100) + '}'.repeat(100), // 100 deep if the scanner counts these
    quoted: 'he said "{" and then a backslash \\ and "{" again',
    esc: '\\' // last character a backslash — the escape must not swallow the quote
  })
  api.updateEntity(a.id, { fields: bracey })
  packWorld(join(dir, 'bracey.world'))
  unpackWorld(join(dir, 'bracey.world'))
  assert.equal(
    (api.getEntity(a.id) as { fields: string }).fields,
    bracey,
    'braces and escapes inside strings are text, not nesting'
  )

  // A normally nested world must be untouched — the limit is a ceiling, not a filter
  const okDepth = JSON.stringify({ notes: JSON.stringify([{ title: 't', content: 'c' }]) })
  api.updateEntity(a.id, { fields: okDepth })
  packWorld(join(dir, 'ok.world'))
  unpackWorld(join(dir, 'ok.world'))
  assert.equal((api.getEntity(a.id) as { fields: string }).fields, okDepth, 'normal depth survives')
}
// Count: 20 000 tiny embedded images inside a 2 MB file froze the process for 22 seconds and
// wrote 20 000 files. Refused before a byte is written, so the open world survives.
{
  const many = join(dir, 'many.world')
  copyFileSync(dunya, many)
  const mn = new DatabaseSync(many)
  mn.exec(`CREATE TABLE IF NOT EXISTS assets (name TEXT PRIMARY KEY, data BLOB NOT NULL)`)
  mn.exec('BEGIN')
  const st = mn.prepare(`INSERT OR REPLACE INTO assets (name, data) VALUES (?, ?)`)
  for (let i = 0; i <= 10_000; i++) st.run(`i${i}.png`, Buffer.from([1]))
  mn.exec('COMMIT')
  mn.close()
  const filesBefore = readdirSync(join(dir, 'assets')).length
  assert.throws(() => unpackWorld(many), /WORLD_TOO_LARGE/, 'too many embedded images')
  assert.equal(readdirSync(join(dir, 'assets')).length, filesBefore, 'nothing written on refusal')
  assert.ok(api.getEntity(a.id), 'the open world must survive the refusal')
}
// An OPEN that fails before it has even begun must still leave a working database. unpackWorld
// closes the handle and then takes a full copy of the world as its rescue — a step that can fail
// on its own (no disk space is the obvious way) with the database already closed. Unguarded that
// left every later query throwing until a restart. A directory sitting where the rescue file
// wants to be reproduces the failure exactly, and needs no full disk to do it.
{
  const rescuePath = join(dir, 'world.db.rescue')
  mkdirSync(rescuePath, { recursive: true })
  assert.throws(() => unpackWorld(dunya), /.*/, 'the rescue copy must fail here')
  assert.ok(api.getEntity(a.id), 'a failed open must still leave a live database')
  api.createEntity({ name: 'writable after a failed open' })
  rmSync(rescuePath, { recursive: true, force: true })
}
// A reset that FAILS must still leave a working database. resetWorld closes the handle before
// deleting the file, and on Windows the delete is what fails: SQLite opens without
// share-delete, so anything else holding world.db — an antivirus mid-scan, OneDrive, the search
// indexer — makes rmSync throw. Unguarded that left the app with a closed db and no way back:
// every later query threw, and only a restart fixed it. A second connection reproduces the lock
// exactly, which is the only reason this can be asserted at all.
{
  const holder = new DatabaseSync(join(dir, 'world.db'))
  holder.prepare(`SELECT 1`).get() // make sure the handle is really open
  let threw = false
  try {
    resetWorld()
  } catch {
    threw = true
  }
  holder.close()
  if (threw) {
    // The point of the whole block: the world is still there and still answers.
    assert.ok(api.getEntity(a.id), 'a failed reset must leave a live database')
    api.createEntity({ name: 'still writable' })
  }
  // If the platform allowed the delete there was nothing to guard; say so rather than pretend
  // the case was covered.
  else
    console.log(
      '  (note: this platform allowed the delete — the locked-reset case was not exercised)'
    )
}
// Blank launch: content is detected; after reset both db and assets are empty
assert.ok(hasContent())
resetWorld()
assert.ok(!hasContent())
assert.ok(!existsSync(join(dir, 'assets', 'test.png')))
assert.equal(api.getSetting('worldFile'), null)

// The one map a blank session is seeded with (index.ts, never through this function) must not
// itself count as content, or every ordinary launch would re-trigger the snapshot-and-reset it
// exists to skip — the exact shape of bug that once filled backups/ with 8.4 GB of nothing.
{
  api.createMap({ name: 'New map' })
  assert.ok(!hasContent(), 'one blank map, freshly seeded, is not content')
  api.createMap({ name: 'Second map' })
  assert.ok(hasContent(), 'a second map is a deliberate action and IS content')
}
resetWorld()
{
  api.createMap({ name: 'New map', image_path: 'x.png', width: 100, height: 100 })
  assert.ok(hasContent(), 'an attached image is content even with nothing drawn on it')
}
resetWorld()
{
  const m = api.createMap({ name: 'New map' }) as { id: number }
  assert.ok(!hasContent())
  api.createFeature({
    map_id: m.id,
    geometry: '{"type":"Point","coordinates":[0,0]}',
    style: '{}'
  })
  assert.ok(hasContent(), 'a single drawing on the one seeded map is content')
}
resetWorld()

// Migration when an OLD world with Turkish keys is opened: no data may be lost. This was the
// one real data risk of anglicising the codebase — years of parent chains, banners and
// dynasty links depend on it. Turkish fixtures below are the point of the test.
{
  const old = api.createEntity({ name: 'Legacy Record' }) as { id: number }
  const kid = api.createEntity({ name: 'Legacy Child' }) as { id: number }
  __test.db.prepare(`UPDATE entities SET fields = ? WHERE id = ?`).run(
    JSON.stringify({
      '\u00fcst': '[{"from":null,"id":7}]',
      '\u0073\u0061\u006e\u0063\u0061\u006b': 'assets/old.png',
      '\u006e\u006f\u0074\u006c\u0061\u0072': '[{"title":"a","content":"b"}]',
      'hiyerar\u015fi': '#county',
      'y\u00f6netim': 'feudal',
      '\u0072\u0065\u006e\u006b': '#ff0000',
      religion: 'Islam' // user-defined map-mode dimension: never translate it
    }),
    old.id
  )
  __test.db
    .prepare(
      `INSERT INTO links (from_id, to_id, relation) VALUES (?, ?, '\u0062\u0061\u0062\u0061')`
    )
    .run(kid.id, old.id)
  assert.ok(migrateLegacyKeys() > 0)
  const f = JSON.parse((api.getEntity(old.id) as { fields: string }).fields) as Record<
    string,
    string
  >
  assert.equal(f['parent'], '[{"from":null,"id":7}]', 'legacy parent must migrate')
  assert.equal(f['banner'], 'assets/old.png')
  assert.equal(f['hierarchy'], '#county')
  assert.equal(f['government'], 'feudal')
  assert.equal(f['color'], '#ff0000')
  assert.equal(f['religion'], 'Islam', 'user-defined fields must be LEFT ALONE')
  // gender VALUE migration
  __test.db
    .prepare(`UPDATE entities SET fields = ? WHERE id = ?`)
    .run(
      JSON.stringify({ '\u0063\u0069\u006e\u0073\u0069\u0079\u0065\u0074': 'kad\u0131n' }),
      kid.id
    )
  migrateLegacyKeys()
  assert.equal(
    (JSON.parse((api.getEntity(kid.id) as { fields: string }).fields) as { gender: string }).gender,
    'female',
    'gender value must migrate too'
  )
  assert.ok(
    !('\u00fcst' in f) && !('\u0073\u0061\u006e\u0063\u0061\u006b' in f),
    'legacy keys must be removed'
  )
  assert.equal(
    (
      __test.db.prepare(`SELECT relation FROM links WHERE from_id = ?`).get(kid.id) as {
        relation: string
      }
    ).relation,
    'father',
    'legacy relation must migrate to father'
  )
  // Running twice must be harmless (it runs on every launch)
  assert.equal(migrateLegacyKeys(), 0, 'migration must be idempotent')
  // A stale Turkish key must NOT overwrite an existing English value
  __test.db
    .prepare(`UPDATE entities SET fields = ? WHERE id = ?`)
    .run(JSON.stringify({ '\u00fcst': 'stale', parent: 'current' }), old.id)
  migrateLegacyKeys()
  const f2 = JSON.parse((api.getEntity(old.id) as { fields: string }).fields) as Record<
    string,
    string
  >
  assert.equal(f2['parent'], 'current', 'the existing English value must win')
  assert.ok(!('\u00fcst' in f2))
}

// The article events. Logged in these functions rather than at the buttons, so every route in is
// covered by one place; what needs checking is the two that read the database BEFORE writing it.
{
  const e = api.createEntity({ name: 'Log Test Article' }) as { id: number }
  api.updateEntity(e.id, { name: 'Renamed Article' })
  api.updateEntity(e.id, { content: 'an ordinary field save' })
  api.deleteEntity(e.id)
  flushLog()
  const logs = join(dir, 'logs')
  const txt = readFileSync(join(logs, readdirSync(logs)[0]), 'utf8')
  assert.ok(/entity\.created .*name="Log Test Article"/.test(txt), 'a new article says its name')
  assert.ok(
    /entity\.renamed .*from="Log Test Article" to="Renamed Article"/.test(txt),
    'a rename carries both names — the old one is what a search will be for'
  )
  assert.ok(
    !/entity\.renamed .*from="Renamed Article"/.test(txt),
    'and an ordinary field save is not a rename'
  )
  assert.ok(
    /entity\.deleted .*name="Renamed Article"/.test(txt),
    'a deletion says the name, which means reading it BEFORE the row goes'
  )
}

// Three COUNT queries, but they run at open time inside a logTime: a wrong table name here would
// throw where the app is least able to explain itself.
{
  const s = worldStats()
  assert.deepEqual(
    Object.keys(s).sort(),
    ['entities', 'features', 'maps'],
    'worldStats reports the three tables an open should describe'
  )
  assert.ok(
    Object.values(s).every((v) => Number.isInteger(v) && v >= 0),
    'and each of them as a number — a wrong table name would throw here, not at open time'
  )
}

__test.db.close()
rmSync(dir, { recursive: true, force: true })
// Error log. Not a database concern, but this file is the project's only test harness and the
// logger is the one thing that has to work while everything else is failing.
{
  const ldir = join(dir, 'logtest')
  mkdirSync(ldir, { recursive: true })
  const logs = join(ldir, 'logs')
  const only = (): string => {
    const n = readdirSync(logs).filter((f) => /_session\.log$/.test(f))
    assert.equal(n.length, 1, 'one file per session')
    return join(logs, n[0])
  }

  initLog(ldir, '9.9.9', () => ({ file: 'w.world', dirty: true }))
  // The header is written at INIT, not on the first error: a session log that only sometimes
  // exists cannot be asked for by a user, which is the whole point of having one.
  assert.ok(readFileSync(only(), 'utf8').includes('SESSION START'), 'header at session start')

  logEvent('INFO', 'project.opened', { file: 'w.world', entities: 163 })
  logEvent('DEBUG', 'never.written', {})
  logSetDebug(true)
  logEvent('DEBUG', 'now.written', {})
  logTime('map.reload')({ features: 12 })
  // A repeated scope collapses into one line rather than sixty. The first real session log had
  // sixty map.reload lines in three seconds and they buried everything else.
  for (let i = 0; i < 12; i++) logEvent('INFO', 'noisy.scope', { took: `${5 + i}ms` })
  // Only genuinely identical events merge. Coalescing on the scope alone collapsed four tool
  // changes into two lines and threw two of the four values away.
  logEvent('INFO', 'tool.changed', { tool: 'polygon' })
  logEvent('INFO', 'tool.changed', { tool: 'line' })
  logEvent('INFO', 'something.else', {})
  // A run has to say how LONG it lasted: `feature.selected ×6` reads the same whether it was six
  // clicks over four seconds or six fires inside one frame, and only one of those is a bug.
  {
    const t0 = Date.now()
    logEvent('INFO', 'clicky.scope', { feature: 116 }, new Date(t0))
    logEvent('INFO', 'clicky.scope', { feature: 116 }, new Date(t0 + 1500))
  }
  // Lines are written in the order things HAPPENED, not the order they arrived: renderer events
  // carry their own stamp and reach main up to half a second late, and a reader trusts the order
  // of the lines over the clock in them.
  {
    const t0 = Date.now()
    logEvent('INFO', 'arrived.second', {}, new Date(t0 + 40))
    logEvent('INFO', 'happened.first', {}, new Date(t0 - 300))
  }
  noteCall('updateEntity') // only mutations reach the trail — index.ts is where reads are dropped
  noteCall('updateFeature')
  noteCall('logEvents') // reporting is not something the app was DOING — must stay out of it
  logError('ipc:updateFeature', new TypeError('boom: feature write failed'), {
    extra: 'x'.repeat(2000),
    component: 'at MapView (MapView.tsx:365) < at App (App.tsx:33)'
  })
  // The same failure reported twice — main catching an IPC call, then the renderer's unhandled
  // rejection carrying it wrapped — is one fault, and gets one block plus a pointer.
  logError(
    'renderer:unhandledRejection',
    new Error("Error invoking remote method 'api': boom: feature write failed")
  )
  flushLog()

  // The one relationship between two numbers chosen in different files. At 400 against a 500 ms
  // batch, a continuous drag settled once per batch forever and coalescing did nothing.
  assert.ok(
    COALESCE_MS > BATCH_MS,
    'the coalescing window must outlast the renderer batch, or repeats never merge across two'
  )

  // A record cannot be forged from the outside. The scope and the data KEYS are the two columns
  // written raw, and `logEvents` hands both straight through from the renderer — which is a page
  // rendering a shared `.world`'s content. A newline in either would print a line that looks
  // exactly like one the app wrote, in a file whose purpose is to be pasted into a message.
  logEvent('INFO', 'forged\n12:00:00.000  ERROR  main.uncaught', {
    'k\nINFO  fake.line': 'v'
  })
  flushLog()
  const forged = readFileSync(only(), 'utf8')
  assert.ok(!/^12:00:00\.000/m.test(forged), 'a newline in a scope cannot start a line')
  assert.ok(!/^INFO {2}fake\.line/m.test(forged), 'nor can one in a key')

  const txt = readFileSync(only(), 'utf8')
  assert.ok(txt.includes('App       9.9.9'), 'the header carries the version')
  assert.ok(/INFO {2}.*project\.opened.*entities=163/.test(txt), 'one line per event')
  assert.ok(!txt.includes('never.written'), 'DEBUG is silent while the switch is off')
  assert.ok(txt.includes('now.written'), 'and speaks once it is on')
  assert.ok(/map\.reload.*took=\d+ms/.test(txt), 'a timed operation reports its duration')
  // EVENT lines only — the scope also appears inside the error report's trail, which is correct
  // and must not be counted here.
  const eventLines = txt.split('\n').filter((l) => /^\d{2}:\d{2}:\d{2}\.\d{3} {2}/.test(l))
  assert.equal(
    eventLines.filter((l) => l.includes('noisy.scope')).length,
    1,
    'a repeated scope leaves ONE line, not one per occurrence'
  )
  assert.ok(/noisy\.scope.*count=×12 took=5-16ms/.test(txt), 'and it keeps the count and spread')
  assert.equal(
    eventLines.filter((l) => l.includes('tool.changed')).length,
    2,
    'events that share a scope but differ in data are NOT merged'
  )
  assert.ok(txt.includes('tool=polygon') && txt.includes('tool=line'), 'and neither is lost')
  assert.ok(
    /clicky\.scope.*count=×2 feature=116 over=1500ms/.test(txt),
    'a coalesced run says how long it lasted, not only how many'
  )
  assert.ok(txt.includes('ERROR REPORT'), 'an error gets the full block, not a line')
  assert.equal(
    txt.split('ERROR REPORT').length - 1,
    1,
    'one fault leaves ONE block, however many layers report it'
  )
  assert.ok(
    /error\.echo.*where=renderer:unhandledRejection of=ipc:updateFeature/.test(txt),
    'the echo says where it came from and which block it belongs to'
  )
  assert.ok(!txt.includes('logEvents'), 'the act of logging stays out of the trail')
  assert.ok(txt.includes('TypeError: boom'), 'the error itself')
  assert.ok(txt.includes('file=w.world dirty=true'), 'context from the app')
  assert.ok(txt.includes('updateEntity → updateFeature'), 'the call trail — how it got there')
  assert.ok(
    txt.indexOf('happened.first') < txt.indexOf('arrived.second'),
    'lines are ordered by when the event happened, not by when it was written'
  )
  // The component stack names the screen that broke; it is the most valuable field a render crash
  // has and far too long to sit inside the context line.
  assert.ok(/\nscreen {4}at MapView/.test(txt), 'the component stack gets its own row')
  // Without the value the trail reads `tool.changed → tool.changed` and the one thing it is
  // asked — which tool was live — is missing from the summary that exists to save reading.
  assert.ok(
    txt.includes('tool.changed(polygon) → tool.changed(line)'),
    'the trail carries what the event was ABOUT, not only its name'
  )
  assert.ok(txt.includes('chars]'), 'oversized fields are clipped, not written whole')
  // A logger that throws while reporting is worse than none: unwritable directory, no crash.
  initLog(join(dir, 'nope', '\u0000bad'), '1', () => ({}))
  logError('main:uncaught', new Error('during a broken log dir'))
  // One file per RUN: a second run writes its own, and files from the older naming schemes are
  // cleared out rather than left to sit there looking as current as everything else.
  const firstRun = basename(only())
  writeFileSync(join(logs, 'error-2026-01-01_00-00-00-abc.log'), 'from an older version')
  initLog(ldir, '9.9.9', () => ({}))
  logError('main:uncaught', new Error('second run'))
  flushLog()
  const files = readdirSync(logs)
  assert.equal(files.length, 2, 'a file per session, and the legacy name is gone')
  const secondRun = join(
    logs,
    files.find((f) => f !== firstRun)!
  )
  assert.ok(
    readFileSync(secondRun, 'utf8').includes('second run'),
    'the second run wrote its own file, leaving the first intact'
  )
  // A runaway loop stops the file rather than filling the disk, and says that it did.
  writeFileSync(secondRun, 'x'.repeat(1024 * 1024 + 10))
  logError('main:uncaught', new Error('after the cap'))
  logError('main:uncaught', new Error('long after the cap'))
  const capped = readFileSync(secondRun, 'utf8')
  assert.ok(capped.includes('log capped'), 'the cap is announced, not silent')
  assert.ok(!capped.includes('long after the cap'), 'and it holds')

  // Retention: past the age limit a file goes, whatever the count says. Logs must not be a
  // folder that only ever grows on someone's machine.
  const stale = join(logs, '2020-01-01_00-00-00_old_session.log')
  writeFileSync(stale, 'ancient')
  utimesSync(stale, new Date(0), new Date(0))
  initLog(ldir, '9.9.9', () => ({}))
  assert.ok(!existsSync(stale), 'a log past the retention window is removed on launch')

  // A report is written to be pasted into a message, and a stack frame is the one field that
  // carries a real path — which in a packaged build sits under the user's account folder.
  // Its own folder: only() asserts a single file, and the run above has left two by here.
  // The fake frame is built with join() rather than written out with escapes: a backslash in a
  // template literal is an escape, so `\app` had silently become `app` and the test passed the
  // wrong string to the thing it was testing.
  const sdir = join(dir, 'logscrub')
  initLog(sdir, '9.9.9', () => ({}))
  const homeErr = new Error('stack with a home path')
  const fakeFrame = join(homedir(), 'app', 'out', 'main', 'index.js')
  homeErr.stack = `Error: stack with a home path
  at f (${fakeFrame}:1:1)`
  logError('main:uncaught', homeErr)
  // The MESSAGE, not only the stack — and this is the shape that matters, because it is the
  // error this app actually hits. Node puts the path in the message of every fs failure, the
  // startup warning is an EBUSY on world.db, and the message is the report's headline. The
  // scrub used to be applied to the stack alone, under a comment claiming the stack was the
  // one place a path could reach the file; this assertion is what that comment was missing.
  logError('main:uncaught', new Error(`EBUSY: resource busy, open '${join(homedir(), 'x.db')}'`))
  // And an ordinary event line: `edit.*` and `map.baseImage` forward an error string into one,
  // so the block is not the only way a path arrives.
  logEvent('WARN', 'edit.undo', { ok: false, error: `ENOENT ${join(homedir(), 'y.png')}` })
  flushLog()
  const slogs = join(sdir, 'logs')
  const scrubbed = readFileSync(
    join(
      slogs,
      readdirSync(slogs).find((f) => /_session\.log$/.test(f))!
    ),
    'utf8'
  )
  assert.ok(!scrubbed.includes(homedir()), 'the home directory never reaches the file')
  assert.ok(scrubbed.includes(join('~', 'app')), 'and what replaces it still names the file')
  assert.ok(scrubbed.includes(join('~', 'x.db')), 'an fs error message is scrubbed too')
  assert.ok(scrubbed.includes('y.png'), 'and so is an ordinary event line, name intact')
  // The form this file MAKES: kv quotes a value holding whitespace with JSON.stringify, which
  // doubles every backslash — so the path went in as C:\\Users\\… and a scrub looking for the
  // raw one walked past it. Both spellings have to be gone.
  assert.ok(
    !scrubbed.includes(JSON.stringify(homedir()).slice(1, -1)),
    'nor the JSON-escaped home path that kv writes itself'
  )
}

// --- what the packaged build promises ------------------------------------------------------
// Two things in electron-builder.yml that are one deleted line away from being gone, and whose
// absence shows up in nothing: a build still succeeds, still installs, still runs.
//
// The fuses are flipped in the binary, so they cannot be turned back on by an environment
// variable or a command line — each closes a way to make our signed-looking exe run somebody
// else's code. The excludes keep the internals dossier out of the asar: CLAUDE.md is a map of
// every mitigation in this list, which is worth more to an attacker than to any user.
{
  const yml = readFileSync(join(import.meta.dirname, '../electron-builder.yml'), 'utf8')
  for (const fuse of [
    'runAsNode: false',
    'enableNodeOptionsEnvironmentVariable: false',
    'enableNodeCliInspectArguments: false',
    'onlyLoadAppFromAsar: true',
    'enableEmbeddedAsarIntegrityValidation: true'
  ])
    assert.ok(yml.includes(fuse), `the packaged build must keep the fuse ${fuse}`)
  for (const doc of ['CLAUDE.md', 'HANDOFF.md'])
    assert.ok(
      new RegExp(`!\\{[^}]*${doc.replace('.', '\\.')}`).test(yml),
      `${doc} must stay out of the shipped asar`
    )
  assert.ok(yml.includes("'!src/**'"), 'the sources must stay out too — a single * misses them')
  // The root is not covered by any of the patterns above it: electron-builder ships everything
  // it is not told to leave out, so a file added beside package.json ships by default. That is
  // how the renderer check harness would have gone out with the app.
  //
  // The exclude is a DIRECTORY rule now rather than one line per filename, which is worth
  // something only while the scripts are actually inside that directory — otherwise `'!scripts'`
  // guards an empty folder while the harnesses sit unprotected at the root, and this assertion
  // passes without checking anything. So both halves are asserted: the rule exists, AND every
  // harness is somewhere the rule reaches.
  assert.ok(yml.includes("'!scripts'"), 'the development scripts must stay out of the asar')
  for (const harness of ['check-api.mjs', 'check-corrupt.mjs', 'check-pack.mjs', 'gen-notices.mjs'])
    assert.ok(
      existsSync(join(import.meta.dirname, '../scripts', harness)),
      `${harness} must live under scripts/, which is what the '!scripts' exclude covers`
    )
  // The developer's own setup. `.claude/settings.local.json` holds absolute paths with the
  // account name in them, and the log has a whole gate about not leaking that name — shipping it
  // inside the binary is the same leak in every copy, permanently.
  for (const dev of ["'!.claude'", "'!.agents'", "'!.mcp.json'", "'!skills-lock.json'"])
    assert.ok(yml.includes(dev), `agent configuration must stay out of the asar: ${dev}`)
}

// --- the test window stays a test window ----------------------------------------------------
// `__test` exists so this file can reach nine module-private things in db.ts without any of them
// becoming part of the API. The one behind it that matters is `db`, the raw connection: an
// application-side import would be a second door into the database, past assertEntityPatch,
// assertFeaturePatch and assertSettingValue — the three gates that make `api` the only way in.
//
// Nothing else enforces that. It is an ordinary export, so a tired afternoon and an autocomplete
// are all it takes, and the result compiles, runs and looks like every other import in the file.
{
  const srcDir = join(import.meta.dirname, '../src')
  const walk = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]
    )
  const offenders = walk(srcDir).filter(
    (f) =>
      /\.(ts|tsx)$/.test(f) &&
      !f.endsWith(join('main', 'db.ts')) && // where it is declared
      /\b__test\b/.test(readFileSync(f, 'utf8'))
  )
  assert.deepEqual(
    offenders.map((f) => f.slice(srcDir.length + 1)),
    [],
    'nothing under src/ may import __test — it is the test harness window, not an API'
  )
}

// --- what the WINDOW promises --------------------------------------------------------------
// The same reasoning as the fuses below, one layer up. Each of these is a single line whose
// absence changes nothing visible: the app opens, the map draws, and a door nobody uses is
// unlocked. Read from the source that ships, so this cannot pass by agreeing with a copy.
//
// The two permission handlers are both listed on purpose — `setPermissionRequestHandler` covers
// only the ASKING path, while a synchronous permission CHECK (what `navigator.permissions.query`
// and several Blink call sites use) goes through the other one, which defaults to permissive.
{
  const main = readFileSync(join(import.meta.dirname, '../src/main/index.ts'), 'utf8')
  for (const line of [
    'setPermissionRequestHandler',
    'setPermissionCheckHandler',
    'setDevicePermissionHandler',
    'app.enableSandbox()',
    // Bound to the APP, not to one window: a second window must not be able to exist without
    // the navigation guards, and binding them per-window is how that happens by omission.
    "app.on('web-contents-created'",
    "wc.on('will-navigate'",
    'wc.setWindowOpenHandler',
    // The only outbound request the app would make: Electron's spellchecker fetches its
    // dictionaries from Google's CDN, below the page and outside the CSP.
    'spellcheck: false'
  ])
    assert.ok(main.includes(line), `main must keep ${line}`)
  // shell.openExternal takes whatever it is given — file:, and on Windows anything the shell
  // knows how to launch. The scheme test is the only thing between a link in a note and that.
  //
  // COMMENTS STRIPPED FIRST, and the assertion is "nothing reaches openExternal before the
  // scheme test" rather than an exact spelling of the function. The old version pinned the whole
  // shape (`openSafe = (url: string): void => {` immediately followed by the regex) and broke the
  // moment the body gained a line, while proving nothing the looser form does not — and the
  // prose around it quotes `shell.openExternal`, which is the trap the Vite assertion below
  // already documents.
  const code = main.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.equal(
    code.split('shell.openExternal').length - 1,
    1,
    'exactly one call may reach the external browser, or the guard below covers only one of them'
  )
  assert.ok(
    code
      .slice(code.indexOf('const openSafe ='), code.indexOf('shell.openExternal'))
      .includes('if (/^https?:'),
    'only http(s) may reach the external browser'
  )
  // The dev-server allowance. Without it, electron-vite serving the renderer over http makes the
  // app's own address read as external to the guard above, so Vite's HMR full reload — the
  // fallback for any edit it cannot apply hot — was posted to the user's default browser: one
  // tab per edit, each the renderer with no preload behind it. What must hold is that the
  // allowance is derived from the ENVIRONMENT, so it does not exist in a packaged build rather
  // than being switched off there; `ELECTRON_RENDERER_URL` is set by electron-vite in dev and is
  // undefined in the shipped app, where every http(s) URL really is external. A hardcoded host
  // would ship, and a shipped build would then follow a link into a local server.
  assert.ok(
    code.includes("process.env['ELECTRON_RENDERER_URL']"),
    'the dev-origin allowance must come from the environment'
  )
  assert.ok(
    !/localhost|127\.0\.0\.1/.test(code),
    'no hardcoded host belongs in main — the dev origin is read from the environment'
  )
  // The instance that LOSES the lock must die before it can touch anything. app.quit() returns
  // and lets whenReady run, which walks the startup sequence — schema exec and migration UPDATEs
  // into the winner's open database, then resetWorld() deleting its world.db and emptying
  // assets/. One word apart, and the difference is another process's data.
  assert.ok(
    main.includes('if (!app.requestSingleInstanceLock()) app.exit(0)'),
    'the losing instance must exit(), not quit() and carry on into the startup sequence'
  )
}

// --- the CSP -------------------------------------------------------------------------------
// The policy is the spine of the security contract and nothing tested it: it is one attribute in
// one HTML file, edited by hand, and every directive in it was added because something specific
// was possible without it. A loosened one is invisible in review and silent at runtime — the app
// simply allows more. Read from disk on purpose: this asserts the file that ships, not a copy of
// its text kept here, which would only ever agree with itself.
{
  const html = readFileSync(join(import.meta.dirname, '../src/renderer/index.html'), 'utf8')
  const csp = /content="([^"]*Content-Security|[^"]*default-src[^"]*)"/.exec(html)?.[1] ?? html
  for (const directive of [
    "default-src 'self'",
    "script-src 'self'",
    // The base image is fetched (a blob decodes off the main thread, an element does not), so
    // the app's own scheme has to be a legal fetch target. Asserted so it cannot be dropped in
    // a tidy-up: without it the map loses its picture and the only sign is a WARN in the log.
    "connect-src 'self' world:",
    "object-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'"
  ])
    assert.ok(csp.includes(directive), `the CSP must keep ${directive}`)
  // 'unsafe-eval' is what Pixi wants and what pixi.js/unsafe-eval exists to avoid needing; a
  // remote origin in script-src or connect-src would be a way to run or reach somebody else's
  // code. The dev-only widening for the annotation toolbar lives in electron.vite.config.ts and
  // is applied at serve time, which is exactly why it must not appear in this file.
  assert.ok(!/unsafe-eval/.test(csp), 'the CSP must never allow unsafe-eval')
  assert.ok(!/https?:\/\//.test(csp), 'no remote origin belongs in the shipped policy')

  // …and the dev-only widening, which the two assertions above can only say is absent from the
  // SOURCE html. What actually keeps it out of the shipped app is one line in the Vite config,
  // and its absence is invisible: `npm run build` still succeeds, the app still runs, and the
  // packaged policy quietly permits http://localhost:4747. A development tool must never buy
  // itself an exception in the app users get, and that promise was resting on a line nothing
  // tested. Verified against a real build too — out/renderer keeps the original policy.
  //
  // COMMENTS ARE STRIPPED FIRST, and that is not tidiness. The config explains itself in prose
  // that quotes the very line being asserted, so the first version of this passed with the line
  // deleted — it was matching the paragraph describing it. Read against the code only.
  const vite = readFileSync(join(import.meta.dirname, '../electron.vite.config.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  assert.ok(
    /apply:\s*'serve'/.test(vite),
    "the dev CSP widening must stay apply: 'serve' — without it, it ships"
  )
  // The widening REPLACES the real directive rather than inserting a second one (a duplicate is
  // not merged: the first occurrence wins). That only works while the string it searches for is
  // still the string the policy contains, and nothing else would notice it had stopped matching.
  const needle = /html\.replace\(\s*"([^"]+)"/.exec(vite)?.[1]
  assert.ok(
    needle && csp.includes(needle.replace(/;$/, '')),
    'the dev widening no longer matches the CSP it edits'
  )
}

// --- world:// path confinement -----------------------------------------------------------
// Every one of these is something a `.world` can put in a note or a polygon's fill, so the
// check gets assertions rather than a careful reading. initDb has already run above, so
// resolveAssetPath is answering about this run's temp data folder.
{
  assert.ok(resolveAssetPath('assets/x.png'), 'an ordinary asset is served')
  assert.ok(resolveAssetPath('assets/sub/x.png'), 'and one in a subfolder')
  // The two files in the data folder that are NOT images, and the folder full of copies of it.
  assert.equal(resolveAssetPath('world.db'), null, 'the database is not an asset')
  assert.equal(resolveAssetPath('logs/today.log'), null, 'nor is the log')
  assert.equal(resolveAssetPath('backups/world-2026.db'), null, 'nor is a backup')
  // Traversal, in the forms that actually arrive: a decoded relative path, a Windows separator
  // (path.normalize treats both on win32), and a sibling folder that shares the prefix.
  assert.equal(resolveAssetPath('assets/../world.db'), null, 'climbing out of assets is refused')
  assert.equal(resolveAssetPath('../../../etc/passwd'), null, 'and so is climbing past the root')
  assert.equal(resolveAssetPath('assets\\..\\world.db'), null, 'backslashes are separators too')
  assert.equal(resolveAssetPath('assets-other/x.png'), null, 'a sibling folder must not pass')
  // The check must not be defeated by the thing it looks for appearing later in the path.
  assert.equal(resolveAssetPath('backups/assets/x.png'), null, 'assets/ elsewhere is not assets/')
}

// A .rescue left on disk means the last open died halfway: world.db is whatever that
// interrupted unpack left behind, and the .rescue beside it is the only intact copy of what the
// user had. Under its own name nobody would ever find it and the next open would write straight
// over it, so a launch moves it into backups/ — the one folder the app tells people to look in
// — dated, so a second interruption cannot overwrite the first. Never restored automatically:
// which of the two files they want is not a decision to make for them at launch.
//
// LAST, and in its own folder: initDb rebinds every module path and opens a second handle on
// world.db, so anything after it would be asserting against a different world.
{
  const rdir = mkdtempSync(join(tmpdir(), 'worldrescue-'))
  writeFileSync(join(rdir, 'world.db.rescue'), 'pretend this is the old world')
  initDb(rdir) // a launch
  assert.ok(!existsSync(join(rdir, 'world.db.rescue')), 'the leftover must not be left in place')
  const moved = readdirSync(join(rdir, 'backups')).filter((f) => f.startsWith('interrupted-open-'))
  assert.equal(moved.length, 1, 'and it must land in backups/ under a dated name')
  assert.equal(
    readFileSync(join(rdir, 'backups', moved[0]), 'utf8'),
    'pretend this is the old world',
    'moved, not recreated — the bytes are the point'
  )
  assert.ok(!hasContent(), 'and the world still opens')
}

console.log('db self-check OK')
