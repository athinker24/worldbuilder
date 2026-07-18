import { DatabaseSync } from 'node:sqlite'
import { join, basename, extname } from 'path'
import {
  mkdirSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
  readdirSync,
  statSync,
  unlinkSync
} from 'fs'
import { tmpdir } from 'os'
import assert from 'assert'

// Elektron'dan bağımsız tutuldu ki `node src/main/db.ts` ile self-check çalışabilsin.
let db!: DatabaseSync
let assetsDir: string
let dbFile: string
let backupsDir: string
const BACKUP_KEEP_DAYS = 30

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS entities (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  fields TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY,
  from_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  to_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relation TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS maps (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  parent_map_id INTEGER REFERENCES maps(id) ON DELETE SET NULL,
  image_path TEXT,
  width INTEGER,
  height INTEGER,
  layers TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS features (
  id INTEGER PRIMARY KEY,
  map_id INTEGER NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
  entity_id INTEGER REFERENCES entities(id) ON DELETE SET NULL,
  geometry TEXT NOT NULL,
  style TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

export function initDb(dataDir: string): void {
  assetsDir = join(dataDir, 'assets')
  mkdirSync(assetsDir, { recursive: true })
  dbFile = join(dataDir, 'world.db')
  backupsDir = join(dataDir, 'backups')
  db = new DatabaseSync(dbFile)
  db.exec(SCHEMA)
}

// Günde bir kez (uygulama açılışında): world.db'nin tarihli kopyasını al, eski kopyaları temizle.
// Geri yükleme elle: backups/ klasöründeki bir dosyayı uygulama kapalıyken world.db üzerine kopyala.
export function backupIfNeeded(): void {
  mkdirSync(backupsDir, { recursive: true })
  const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  const target = join(backupsDir, `world-${today}.db`)
  if (!existsSync(target)) copyFileSync(dbFile, target)
  const cutoff = Date.now() - BACKUP_KEEP_DAYS * 24 * 60 * 60 * 1000
  for (const name of readdirSync(backupsDir)) {
    const p = join(backupsDir, name)
    if (statSync(p).mtimeMs < cutoff) unlinkSync(p)
  }
}

// Sadece izin verilen kolonlardan dinamik SET cümlesi kurar.
function patchSql(
  table: string,
  allowed: string[],
  patch: Record<string, unknown>
): { sql: string; vals: unknown[] } | null {
  const keys = Object.keys(patch).filter((k) => allowed.includes(k))
  if (!keys.length) return null
  return {
    sql: `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')}`,
    vals: keys.map((k) => patch[k] as never)
  }
}

export const api = {
  // --- maddeler ---
  listEntities(search = ''): unknown[] {
    return db
      .prepare(`SELECT id, type, name FROM entities WHERE name LIKE ? ORDER BY type, name`)
      .all(`%${search}%`)
  },
  // Tam metin arama: içerik + not sekmeleri + serbest alan değerlerinde geçen maddeler,
  // eşleşme çevresinden kısa bir bağlam parçasıyla. Teknik alanlar (sancak dosya yolu,
  // üst/yönetici/hane JSON geçmişleri, renk) aramaya girmez — snippet hep insan-okur metin.
  // Türkçe büyük/küçük harf doğru katlansın diye filtre JS'te (SQLite LIKE/lower yalnız
  // ASCII katlar). ponytail: kişisel ölçekte tüm satırları tarar, yavaşlarsa FTS5'e geçilir.
  searchContent(q: string): unknown[] {
    const needle = q.trim().toLocaleLowerCase('tr')
    if (needle.length < 2) return []
    const TECH = new Set(['sancak', 'üst', 'yönetici', 'hane', 'notlar', 'renk'])
    const rows = db.prepare(`SELECT id, type, name, content, fields FROM entities`).all() as {
      id: number
      type: string
      name: string
      content: string
      fields: string
    }[]
    const hits: { id: number; type: string; name: string; snippet: string }[] = []
    for (const r of rows) {
      if (r.name.toLocaleLowerCase('tr').includes(needle)) continue // isim eşleşmesi zaten listede
      // Aranabilir metinler: içerik, not sekmeleri (başlık + metin), serbest alan değerleri
      const texts: string[] = [r.content]
      try {
        const f = JSON.parse(r.fields || '{}') as Record<string, string>
        for (const [k, v] of Object.entries(f))
          if (!TECH.has(k) && typeof v === 'string') texts.push(`${k}: ${v}`)
        const notes = JSON.parse(f['notlar'] ?? '[]') as { title?: string; content?: string }[]
        if (Array.isArray(notes))
          for (const n of notes) texts.push([n.title, n.content].filter(Boolean).join(': '))
      } catch {
        /* bozuk fields → yalnız içerikte ara */
      }
      for (const src of texts) {
        const i = src.toLocaleLowerCase('tr').indexOf(needle)
        if (i < 0) continue
        const start = Math.max(0, i - 30)
        const snippet =
          (start > 0 ? '…' : '') +
          src.slice(start, i + needle.length + 40).replace(/\s+/g, ' ') +
          (i + needle.length + 40 < src.length ? '…' : '')
        hits.push({ id: r.id, type: r.type, name: r.name, snippet })
        break
      }
      if (hits.length >= 15) break
    }
    return hits
  },
  getEntity(id: number): unknown {
    const entity = db.prepare(`SELECT * FROM entities WHERE id = ?`).get(id)
    if (!entity) return null
    const outLinks = db
      .prepare(
        `SELECT l.id, l.relation, l.notes, l.to_id, e.name AS to_name FROM links l JOIN entities e ON e.id = l.to_id WHERE l.from_id = ?`
      )
      .all(id)
    const inLinks = db
      .prepare(
        `SELECT l.id, l.relation, l.notes, l.from_id, e.name AS from_name FROM links l JOIN entities e ON e.id = l.from_id WHERE l.to_id = ?`
      )
      .all(id)
    // İçerikte [[Bu Madde]] geçen diğer maddeler (backlink)
    const mentions = db
      .prepare(`SELECT id, name FROM entities WHERE id != ? AND content LIKE ?`)
      .all(id, `%[[${(entity as { name: string }).name}]]%`)
    return { ...entity, outLinks, inLinks, mentions }
  },
  findEntityByName(name: string): unknown {
    return (
      db.prepare(`SELECT id, type, name FROM entities WHERE name = ? COLLATE NOCASE`).get(name) ??
      null
    )
  },
  createEntity(e: { type?: string; name: string; content?: string; fields?: string }): unknown {
    const r = db
      .prepare(`INSERT INTO entities (type, name, content, fields) VALUES (?, ?, ?, ?)`)
      .run(e.type ?? '', e.name, e.content ?? '', e.fields ?? '{}')
    return { id: Number(r.lastInsertRowid) }
  },
  updateEntity(id: number, patch: Record<string, unknown>): void {
    const p = patchSql('entities', ['type', 'name', 'content', 'fields'], patch)
    if (p)
      db.prepare(`${p.sql}, updated_at = datetime('now') WHERE id = ?`).run(
        ...(p.vals as never[]),
        id
      )
  },
  deleteEntity(id: number): void {
    db.prepare(`DELETE FROM entities WHERE id = ?`).run(id)
  },
  // Silinen bir maddeyi aynı id ile, ilişkileri ve harita çizim bağlarıyla geri getirir (Ctrl+Z için)
  restoreEntity(
    row: {
      id: number
      type: string
      name: string
      content: string
      fields: string
      created_at: string
    },
    links: { from_id: number; to_id: number; relation: string; notes: string }[],
    featureIds: number[]
  ): void {
    db.prepare(
      `INSERT INTO entities (id, type, name, content, fields, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(row.id, row.type, row.name, row.content, row.fields, row.created_at)
    for (const l of links)
      db.prepare(`INSERT INTO links (from_id, to_id, relation, notes) VALUES (?, ?, ?, ?)`).run(
        l.from_id,
        l.to_id,
        l.relation,
        l.notes
      )
    for (const fid of featureIds)
      db.prepare(`UPDATE features SET entity_id = ? WHERE id = ?`).run(row.id, fid)
  },
  // Toplu geri yükleme (çoklu silme undo'su): önce TÜM madde satırları, sonra (dedup'lanmış)
  // ilişkiler, sonra çizim bağları — böylece iki silinen madde arası link FK'yı bozmaz.
  restoreEntities(
    rows: {
      id: number
      type: string
      name: string
      content: string
      fields: string
      created_at: string
    }[],
    links: { from_id: number; to_id: number; relation: string; notes: string }[],
    features: { entity_id: number; feature_id: number }[]
  ): void {
    for (const row of rows)
      db.prepare(
        `INSERT INTO entities (id, type, name, content, fields, created_at) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(row.id, row.type, row.name, row.content, row.fields, row.created_at)
    for (const l of links)
      db.prepare(`INSERT INTO links (from_id, to_id, relation, notes) VALUES (?, ?, ?, ?)`).run(
        l.from_id,
        l.to_id,
        l.relation,
        l.notes
      )
    for (const f of features)
      db.prepare(`UPDATE features SET entity_id = ? WHERE id = ?`).run(f.entity_id, f.feature_id)
  },
  featuresByEntity(entityId: number): unknown[] {
    return db
      .prepare(
        `SELECT f.id, f.map_id, f.style, m.name AS map_name
         FROM features f JOIN maps m ON m.id = f.map_id WHERE f.entity_id = ?`
      )
      .all(entityId)
  },
  entityFeatureIds(entityId: number): number[] {
    return (api.featuresByEntity(entityId) as { id: number }[]).map((r) => r.id)
  },
  retypeEntities(oldType: string, newType: string): void {
    db.prepare(`UPDATE entities SET type = ? WHERE type = ?`).run(newType, oldType)
  },
  // Hiyerarşi etiketleri: fields JSON'undaki "hiyerarşi" anahtarı, virgülle ayrılmış "#etiket" listesi.
  // gov: fields'daki "yönetim" (yönetim biçimi — paralel kademe merdivenleri).
  // fields ham JSON olarak da döner: harita modları (din/dil boyutları) ve datalist önerileri
  // renderer'da buradan türetilir. Tüm maddeler döner — kişisel ölçekte sorun değil.
  hierarchy(): unknown {
    const rows = db
      .prepare(
        `SELECT id, type, name, fields,
           json_extract(fields, '$.hiyerarşi') AS h,
           json_extract(fields, '$.yönetim') AS gov
         FROM entities`
      )
      .all() as {
      id: number
      type: string
      name: string
      fields: string
      h: string | null
      gov: string | null
    }[]
    const entities = rows.map((r) => ({
      id: r.id,
      type: r.type,
      name: r.name,
      fields: r.fields,
      gov: r.gov,
      tags: (r.h ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
    }))
    const tags = [...new Set(entities.flatMap((e) => e.tags))].sort((a, b) =>
      a.localeCompare(b, 'tr')
    )
    const govs = [...new Set(entities.map((e) => e.gov).filter(Boolean))].sort() as string[]
    return { tags, govs, entities }
  },

  // --- ilişkiler ---
  addLink(from_id: number, to_id: number, relation: string): unknown {
    const r = db
      .prepare(`INSERT INTO links (from_id, to_id, relation) VALUES (?, ?, ?)`)
      .run(from_id, to_id, relation)
    return { id: Number(r.lastInsertRowid) }
  },
  deleteLink(id: number): void {
    db.prepare(`DELETE FROM links WHERE id = ?`).run(id)
  },
  // Hanedan ağacı gibi tüm-graf görünümleri için: bütün bağlar (kişisel ölçekte sorun değil)
  listLinks(): unknown[] {
    return db.prepare(`SELECT id, from_id, to_id, relation FROM links`).all()
  },

  // --- haritalar ---
  listMaps(): unknown[] {
    return db.prepare(`SELECT id, name, parent_map_id FROM maps ORDER BY name`).all()
  },
  getMap(id: number): unknown {
    const map = db.prepare(`SELECT * FROM maps WHERE id = ?`).get(id)
    if (!map) return null
    const features = db
      .prepare(
        `SELECT f.*, e.name AS entity_name, e.type AS entity_type FROM features f LEFT JOIN entities e ON e.id = f.entity_id WHERE f.map_id = ?`
      )
      .all(id)
    return { ...map, features }
  },
  createMap(m: {
    name: string
    image_path?: string
    width?: number
    height?: number
    parent_map_id?: number
  }): unknown {
    // ponytail: layers JSON heightmap vb. için tesisat — şimdilik tek image katmanı yazılıyor, okunmuyor
    const layers = m.image_path ? JSON.stringify([{ type: 'image', path: m.image_path }]) : '[]'
    const r = db
      .prepare(
        `INSERT INTO maps (name, image_path, width, height, parent_map_id, layers) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        m.name,
        m.image_path ?? null,
        m.width ?? null,
        m.height ?? null,
        m.parent_map_id ?? null,
        layers
      )
    return { id: Number(r.lastInsertRowid) }
  },
  updateMap(id: number, patch: Record<string, unknown>): void {
    const p = patchSql(
      'maps',
      ['name', 'parent_map_id', 'image_path', 'width', 'height', 'layers'],
      patch
    )
    if (p) db.prepare(`${p.sql} WHERE id = ?`).run(...(p.vals as never[]), id)
  },
  deleteMap(id: number): void {
    db.prepare(`DELETE FROM maps WHERE id = ?`).run(id)
  },
  // Harita silme undo'su: satır + çizimler ORİJİNAL id'leriyle geri gelir (zaman çizgisi olayları /
  // madde harita geçmişi fid'e bağlı — id korunmalı), alt haritaların üst bağı yeniden kurulur.
  restoreMap(
    map: {
      id: number
      name: string
      parent_map_id: number | null
      image_path: string | null
      width: number | null
      height: number | null
      layers: string
    },
    features: {
      id: number
      map_id: number
      entity_id: number | null
      geometry: string
      style: string
    }[],
    childIds: number[]
  ): void {
    db.prepare(
      `INSERT INTO maps (id, name, parent_map_id, image_path, width, height, layers) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(map.id, map.name, map.parent_map_id, map.image_path, map.width, map.height, map.layers)
    for (const f of features)
      db.prepare(
        `INSERT INTO features (id, map_id, entity_id, geometry, style) VALUES (?, ?, ?, ?, ?)`
      ).run(f.id, f.map_id, f.entity_id, f.geometry, f.style)
    for (const cid of childIds)
      db.prepare(`UPDATE maps SET parent_map_id = ? WHERE id = ?`).run(map.id, cid)
  },

  // --- harita çizimleri ---
  createFeature(f: {
    map_id: number
    entity_id?: number
    geometry: string
    style?: string
  }): unknown {
    const r = db
      .prepare(`INSERT INTO features (map_id, entity_id, geometry, style) VALUES (?, ?, ?, ?)`)
      .run(f.map_id, f.entity_id ?? null, f.geometry, f.style ?? '{}')
    return { id: Number(r.lastInsertRowid) }
  },
  updateFeature(id: number, patch: Record<string, unknown>): void {
    const p = patchSql('features', ['entity_id', 'geometry', 'style'], patch)
    if (p) db.prepare(`${p.sql} WHERE id = ?`).run(...(p.vals as never[]), id)
  },
  deleteFeature(id: number): void {
    db.prepare(`DELETE FROM features WHERE id = ?`).run(id)
  },

  // --- ayarlar ---
  getSetting(key: string): string | null {
    const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
      { value: string } | undefined
    return row?.value ?? null
  },
  setSetting(key: string, value: string): void {
    db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(key, value)
  },

  // --- dosyalar ---
  importAsset(srcPath: string): string {
    if (!/\.(png|jpe?g|webp|gif)$/i.test(srcPath)) throw new Error('Yalnız görsel dosyaları')
    let name = basename(srcPath)
    if (existsSync(join(assetsDir, name))) {
      name = `${basename(name, extname(name))}-${Date.now()}${extname(name)}`
    }
    copyFileSync(srcPath, join(assetsDir, name))
    return `assets/${name}`
  },

  // Elle "şimdi yedekle" — saat damgalı, günlük otomatik yedekten bağımsız ayrı bir kopya
  backupNow(): string {
    mkdirSync(backupsDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const target = join(backupsDir, `world-${stamp}.db`)
    copyFileSync(dbFile, target)
    return target
  }
}

// Self-check: `node src/main/db.ts`
if (process.argv[1]?.replace(/\\/g, '/').endsWith('src/main/db.ts')) {
  const dir = mkdtempSync(join(tmpdir(), 'worlddb-'))
  initDb(dir)
  const a = api.createEntity({ name: 'Test Devleti', type: 'devlet' }) as { id: number }
  const b = api.createEntity({
    name: 'Test Hanedanı',
    type: 'hanedan',
    content: 'Bkz [[Test Devleti]]'
  }) as { id: number }
  api.addLink(b.id, a.id, 'yönetir')
  const got = api.getEntity(a.id) as { name: string; inLinks: unknown[]; mentions: unknown[] }
  assert.equal(got.name, 'Test Devleti')
  assert.equal(got.inLinks.length, 1)
  assert.equal(got.mentions.length, 1)
  api.retypeEntities('devlet', 'krallık')
  assert.equal((api.getEntity(a.id) as { type: string }).type, 'krallık')
  // Tam metin arama: içerikte geçen (Türkçe küçük harfle) bulunur, isim eşleşmesi hariç tutulur
  {
    const hits = api.searchContent('test devleti') as { id: number; snippet: string }[]
    assert.equal(hits.length, 1) // yalnız b (içeriğinde [[Test Devleti]]); a isim eşleşmesi sayılır
    assert.equal(hits[0].id, b.id)
    assert.ok(hits[0].snippet.includes('Test Devleti'))
    assert.equal((api.searchContent('yokböylebirşey') as unknown[]).length, 0)
    // Not sekmesinde geçen bulunur; teknik alan (sancak dosya yolu) aramaya girmez
    api.updateEntity(b.id, {
      fields: JSON.stringify({
        sancak: 'assets/GIZLI-YOL-birkelime.png',
        notlar: JSON.stringify([{ title: 'Savaşlar', content: 'Kuzey seferi başladı' }])
      })
    })
    const noteHits = api.searchContent('kuzey seferi') as { id: number; snippet: string }[]
    assert.equal(noteHits.length, 1)
    assert.ok(noteHits[0].snippet.includes('Kuzey seferi'))
    assert.equal((api.searchContent('GIZLI-YOL') as unknown[]).length, 0) // sancak yolu aranmaz
  }
  api.updateEntity(a.id, {
    fields: JSON.stringify({
      hiyerarşi: '#krallık, #güney-dilleri',
      yönetim: 'feodal',
      din: 'İslam'
    })
  })
  const hier = api.hierarchy() as {
    tags: string[]
    govs: string[]
    entities: { id: number; tags: string[]; gov: string | null; fields: string }[]
  }
  assert.deepEqual(hier.tags, ['#güney-dilleri', '#krallık'])
  assert.deepEqual(hier.govs, ['feodal'])
  assert.equal(hier.entities.length, 2) // WHERE yok: etiketsiz madde de döner
  const he = hier.entities.find((e) => e.id === a.id)!
  assert.equal(he.tags.length, 2)
  assert.equal(he.gov, 'feodal')
  assert.equal((JSON.parse(he.fields) as { din: string }).din, 'İslam')
  const m = api.createMap({ name: 'Dünya' }) as { id: number }
  api.createFeature({
    map_id: m.id,
    entity_id: a.id,
    geometry: '{"type":"Point","coordinates":[1,2]}'
  })
  assert.equal((api.getMap(m.id) as { features: unknown[] }).features.length, 1)
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
  api.restoreEntity(full, [{ from_id: b.id, to_id: a.id, relation: 'yönetir', notes: '' }], featIds)
  const restored = api.getEntity(a.id) as { name: string; inLinks: unknown[] }
  assert.equal(restored.name, 'Test Devleti')
  assert.equal(restored.inLinks.length, 1)
  assert.equal(
    (api.getMap(m.id) as { features: { entity_id: number }[] }).features[0].entity_id,
    a.id
  )
  // Toplu geri yükleme (çoklu silme undo'su): aralarında link olan a+b'yi birlikte sil, geri yükle
  const bFull = api.getEntity(b.id) as typeof full
  const aFeat = api.entityFeatureIds(a.id) as number[]
  api.deleteEntity(a.id)
  api.deleteEntity(b.id)
  assert.equal(api.getEntity(b.id) as unknown, null)
  api.restoreEntities(
    [full, bFull],
    [{ from_id: b.id, to_id: a.id, relation: 'yönetir', notes: '' }], // iki taraftan gelse de tek kayıt
    aFeat.map((fid) => ({ entity_id: a.id, feature_id: fid }))
  )
  const ra = api.getEntity(a.id) as { inLinks: unknown[] }
  assert.equal(ra.inLinks.length, 1) // link tam bir kez geri geldi (dedup)
  assert.ok(api.getEntity(b.id))
  assert.equal(
    (api.getMap(m.id) as { features: { entity_id: number }[] }).features[0].entity_id,
    a.id
  )
  // Harita silme undo'su: satır + çizim orijinal id ile geri gelir, alt harita üst bağı korunur
  const child = api.createMap({ name: 'Şehir', parent_map_id: m.id }) as { id: number }
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
  assert.equal(mBack.features[0].id, savedFid) // fid korundu (zaman çizgisi/harita geçmişi bağı)
  assert.equal((api.getMap(child.id) as { parent_map_id: number | null }).parent_map_id, m.id)
  backupIfNeeded()
  assert.ok(existsSync(join(dir, 'backups')))
  assert.ok(readdirSync(join(dir, 'backups')).length >= 1)
  const manual = api.backupNow()
  assert.ok(existsSync(manual))
  db.close()
  rmSync(dir, { recursive: true, force: true })
  console.log('db self-check OK')
}
