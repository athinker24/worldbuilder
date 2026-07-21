import { DatabaseSync } from 'node:sqlite'
import { join, basename, extname } from 'path'
import {
  mkdirSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import assert from 'assert'

// Elektron'dan bağımsız tutuldu ki `node src/main/db.ts` ile self-check çalışabilsin.
let db!: DatabaseSync
let assetsDir: string
let dbFile: string
let backupsDir: string
let notesDir: string
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
  notesDir = join(dataDir, 'notes')
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

// --- .dunya dosya biçimi (Wonderdraft'ın kendi dosyası gibi): tek dosyada HER ŞEY ---
// Biçim = aynı şemalı bir SQLite kopyası + ekstra `assets` tablosu (görseller BLOB olarak gömülü).
// Çalışma kopyası (world.db + assets/) hiç değişmedi — Save paketler, Open paketi açar.
// settings.worldFile dosyanın kendi yolunu taşır (Ctrl+S hedefi; açılınca gerçek yolla güncellenir).

/** Çalışma kopyasını (db + assets/ görselleri) tek .dunya dosyasına paketle. */
export function packWorld(targetPath: string): void {
  pruneUnusedAssets() // kaydetmeden önce kullanılmayan görselleri temizle → .dunya + çalışma kopyası yalın
  const tmp = targetPath + '.tmp'
  rmSync(tmp, { force: true })
  db.exec(`VACUUM INTO '${tmp.replaceAll("'", "''")}'`) // temiz, atomik anlık kopya
  const out = new DatabaseSync(tmp)
  out.exec(`CREATE TABLE IF NOT EXISTS assets (name TEXT PRIMARY KEY, data BLOB NOT NULL)`)
  const ins = out.prepare(`INSERT OR REPLACE INTO assets (name, data) VALUES (?, ?)`)
  for (const name of readdirSync(assetsDir)) {
    const p = join(assetsDir, name)
    if (statSync(p).isFile()) ins.run(name, readFileSync(p))
  }
  out
    .prepare(
      `INSERT INTO settings (key, value) VALUES ('worldFile', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(targetPath)
  out.close()
  renameSync(tmp, targetPath) // önce tmp'ye yaz sonra adlandır — yarım dosya kalmaz
}

/** Bir .dunya dosyasını çalışma kopyasının ÜZERİNE aç (mevcut çalışma kopyası ezilir —
 *  çağıran taraf önce onay/yedek almalı). Gömülü görseller assets/ klasörüne çıkarılır. */
export function unpackWorld(sourcePath: string): void {
  db.close()
  copyFileSync(sourcePath, dbFile)
  db = new DatabaseSync(dbFile)
  db.exec(SCHEMA)
  const hasAssets = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'assets'`)
    .get()
  if (hasAssets) {
    for (const row of db.prepare(`SELECT name, data FROM assets`).all() as {
      name: string
      data: Uint8Array
    }[]) {
      // .dunya PAYLAŞILAN bir dosya: gömülü ad güvenilmez girdi. basename olmadan
      // `../../…` ya da `C:\…` biçiminde bir ad assets/ DIŞINA yazardı (dosya üzerine yazma).
      // packWorld zaten yalnız basename yazar, bu yüzden kayıp yok.
      const name = basename(row.name)
      if (name && name !== '.' && name !== '..') writeFileSync(join(assetsDir, name), row.data)
    }
    db.exec(`DROP TABLE assets`) // çalışma kopyası yalın kalsın (görseller diskte)
  }
  repairImportedJson() // bozuk JSON kolonları varsayılana düşür (aşağıdaki gerekçe)
  api.setSetting('worldFile', sourcePath)
  pruneUnusedAssets() // açılan dünyada kullanılmayan (önceki dünyadan kalan) görselleri temizle
}

/** Dışarıdan gelen bir .dunya'daki bozuk JSON kolonlarını varsayılana düşür; onarılan satır
 *  sayısını döner. TEK YERDE olması bilinçli: renderer bu kolonları 20'den fazla noktada
 *  `JSON.parse` ediyor ve bir tek satır bozuksa o görünüm komple çökerdi (harita hiç açılmaz,
 *  madde sayfası beyaz kalırdı). Her çağrı noktasını try/catch'e sarmak yerine veri, uygulamaya
 *  girdiği kapıda onarılıyor. Satır SİLİNMEZ — yalnız bozuk alan sıfırlanır, gerisi durur. */
function repairImportedJson(): number {
  let fixed = 0
  const isPlainObject = (v: string): boolean => {
    try {
      const p: unknown = JSON.parse(v)
      return typeof p === 'object' && p !== null && !Array.isArray(p)
    } catch {
      return false
    }
  }
  const isArray = (v: string): boolean => {
    try {
      return Array.isArray(JSON.parse(v))
    } catch {
      return false
    }
  }
  const repair = <T extends { id: number; v: string }>(
    rows: T[],
    ok: (v: string) => boolean,
    sql: string,
    def: string
  ): void => {
    const st = db.prepare(sql)
    for (const r of rows)
      if (!ok(r.v)) {
        st.run(def, r.id)
        fixed++
      }
  }
  repair(
    db.prepare(`SELECT id, fields AS v FROM entities`).all() as { id: number; v: string }[],
    isPlainObject,
    `UPDATE entities SET fields = ? WHERE id = ?`,
    '{}'
  )
  repair(
    db.prepare(`SELECT id, style AS v FROM features`).all() as { id: number; v: string }[],
    isPlainObject,
    `UPDATE features SET style = ? WHERE id = ?`,
    '{}'
  )
  repair(
    db.prepare(`SELECT id, layers AS v FROM maps`).all() as { id: number; v: string }[],
    isArray,
    `UPDATE maps SET layers = ? WHERE id = ?`,
    '[]'
  )
  // settings: değerlerin bir kısmı düz metin ('dark', 'tr', dosya yolu) — yalnız JSON GÖRÜNÜMLÜ
  // olanlar ({ ya da [ ile başlayanlar) denetlenir, bozuksa satır silinir → kod varsayılana düşer
  const del = db.prepare(`DELETE FROM settings WHERE key = ?`)
  for (const r of db.prepare(`SELECT key, value FROM settings`).all() as {
    key: string
    value: string
  }[]) {
    if (!/^\s*[[{]/.test(r.value)) continue
    if (isPlainObject(r.value) || isArray(r.value)) continue
    del.run(r.key)
    fixed++
  }
  return fixed
}

/** Çalışma kopyasında kayda değer içerik var mı? (boş açılışta gereksiz anlık paket alınmasın) */
export function hasContent(): boolean {
  return (
    !!db.prepare(`SELECT 1 FROM entities LIMIT 1`).get() ||
    !!db.prepare(`SELECT 1 FROM maps LIMIT 1`).get()
  )
}

/** Çalışma kopyasını sıfırla: boş şema + boş assets/ (Photoshop'un boş belgeyle açılışı).
 *  Çağıran taraf önce packWorld ile anlık paket almalı — burada yedek alınmaz. */
export function resetWorld(): void {
  db.close()
  rmSync(dbFile, { force: true })
  db = new DatabaseSync(dbFile)
  db.exec(SCHEMA)
  for (const name of readdirSync(assetsDir)) {
    const p = join(assetsDir, name)
    if (statSync(p).isFile()) rmSync(p)
  }
}

// Kullanılmayan görselleri assets/'ten sil ve silinen sayısını döndür. Bir dosya, adı veritabanı
// METNİNDE hiçbir yerde geçmiyorsa (fields+content, features.style, maps.image_path+layers,
// settings.value) kullanılmıyor sayılır. Ada göre eşleşme bilinçli KORUYUCU — alt-dize çakışması
// yalnız fazla dosya TUTMAYA yol açar, asla kullanımdaki bir dosyayı silmez. packWorld (kaydet) ve
// unpackWorld (aç) içinde otomatik çağrılır (undo yığınının önemsiz olduğu checkpoint/yeniden-yükleme
// anları). Tamamen otomatik — UI yok.
function pruneUnusedAssets(): number {
  const files = readdirSync(assetsDir).filter((f) => statSync(join(assetsDir, f)).isFile())
  const texts: string[] = []
  for (const r of db.prepare(`SELECT fields, content FROM entities`).all() as {
    fields: string
    content: string
  }[])
    texts.push(r.fields, r.content)
  for (const r of db.prepare(`SELECT style FROM features`).all() as { style: string }[])
    texts.push(r.style)
  for (const r of db.prepare(`SELECT image_path, layers FROM maps`).all() as {
    image_path: string | null
    layers: string
  }[]) {
    if (r.image_path) texts.push(r.image_path)
    texts.push(r.layers)
  }
  for (const r of db.prepare(`SELECT value FROM settings`).all() as { value: string }[])
    texts.push(r.value)
  const blob = texts.join('\n')
  let removed = 0
  for (const f of files) {
    if (!blob.includes(f)) {
      rmSync(join(assetsDir, f))
      removed++
    }
  }
  return removed
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
    // Sıra = EKLENME sırası (id), alfabetik değil: kullanıcı haritalarını kendi kurduğu düzende
    // görmek istiyor (araç çubuğu menüsü ve "ilk harita" seçimi bu listeden okur).
    return db.prepare(`SELECT id, name, parent_map_id FROM maps ORDER BY id`).all()
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
  },

  // Her maddenin not sekmelerini (fields['notlar']) okunabilir .txt ağacına döker:
  //   notes/<harita adı>/<madde tipi>/<madde adı>/<not başlığı>.txt
  // Bir maddenin çizimi hangi harita(lar)daysa o harita(lar)ın altında görünür; hiçbir haritada
  // olmayanlar "(no map)", tipsizler "(no type)" altında (sistem klasör adları İngilizce). Tek yönlü
  // dışa aktarım (app → .txt); ağaç her seferinde sıfırdan yeniden üretilir (rename/silme temiz yansır).
  exportNotes(): { path: string; files: number } {
    const ents = db.prepare(`SELECT id, type, name, fields FROM entities`).all() as {
      id: number
      type: string
      name: string
      fields: string
    }[]
    const maps = db.prepare(`SELECT id, name FROM maps`).all() as { id: number; name: string }[]
    const feats = db
      .prepare(`SELECT DISTINCT map_id, entity_id FROM features WHERE entity_id IS NOT NULL`)
      .all() as { map_id: number; entity_id: number }[]

    const mapName = new Map(maps.map((m) => [m.id, m.name]))
    const entMaps = new Map<number, Set<number>>() // madde id → çizimi olan harita id'leri
    for (const f of feats) {
      if (!entMaps.has(f.entity_id)) entMaps.set(f.entity_id, new Set())
      entMaps.get(f.entity_id)!.add(f.map_id)
    }
    const parseNotes = (fields: string): { title: string; content: string }[] => {
      try {
        const notlar = (JSON.parse(fields || '{}') as Record<string, string>)['notlar']
        const arr = JSON.parse(notlar ?? '[]')
        return Array.isArray(arr) ? arr : []
      } catch {
        return []
      }
    }
    // Windows dosya adı güvenli: yasak karakterler → _, sondaki nokta/boşluk atılır, boşsa yedek
    // (kontrol karakterleri not başlıklarında oluşmaz — sadece Windows'un yasak sembolleri elenir)
    const safe = (name: string, fallback: string): string => {
      const s = name
        // eslint-disable-next-line no-control-regex -- kontrol karakterleri de dosya adında geçersiz
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
        .replace(/[. ]+$/, '')
        .trim()
      // Windows aygıt adları (CON, NUL, COM1…) dosya/klasör olamaz — yazma hata verirdi
      const out = (s || fallback).slice(0, 120)
      return /^(CON|PRN|AUX|NUL|COM\d|LPT\d)$/i.test(out) ? `_${out}` : out
    }

    rmSync(notesDir, { recursive: true, force: true }) // eski ağacı temizle → yeniden üret
    mkdirSync(notesDir, { recursive: true })

    let files = 0
    for (const ent of ents) {
      const notes = parseNotes(ent.fields)
      if (!notes.length) continue
      const mids = entMaps.get(ent.id)
      const mapFolders =
        mids && mids.size
          ? [...mids].map((mid) => safe(mapName.get(mid) ?? '', `map-${mid}`))
          : ['(no map)']
      const typeFolder = ent.type ? safe(ent.type, '(no type)') : '(no type)'
      for (const mf of mapFolders) {
        // Aynı ad/tip altında ad çakışırsa madde id'siyle benzersizleştir
        let entDir = join(notesDir, mf, typeFolder, safe(ent.name, `entity-${ent.id}`))
        if (existsSync(entDir)) entDir += ` (#${ent.id})`
        mkdirSync(entDir, { recursive: true })
        const used = new Set<string>()
        notes.forEach((n, i) => {
          const baseName = safe(n.title, `note-${i + 1}`)
          let fname = baseName
          for (let k = 2; used.has(fname.toLowerCase()); k++) fname = `${baseName} (${k})`
          used.add(fname.toLowerCase())
          // Windows Not Defteri uyumu için \r\n
          writeFileSync(
            join(entDir, `${fname}.txt`),
            (n.content ?? '').replace(/\r?\n/g, '\r\n'),
            'utf8'
          )
          files++
        })
      }
    }
    return { path: notesDir, files }
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
  // exportNotes: a (tip 'krallık' — yukarıda retype edildi) Dünya haritasında →
  // notes/Dünya/krallık/Test Devleti/…; b (tip 'hanedan') hiçbir haritada değil → notes/(no map)/hanedan/…
  api.updateEntity(a.id, {
    fields: JSON.stringify({
      notlar: JSON.stringify([{ title: 'Kuruluş', content: 'satır1\nsatır2' }])
    })
  })
  const exp = api.exportNotes()
  assert.equal(exp.files, 2) // a (haritada) + b (haritasız)
  const onMap = join(dir, 'notes', 'Dünya', 'krallık', 'Test Devleti', 'Kuruluş.txt')
  assert.ok(existsSync(onMap), 'haritadaki maddenin notu yazılmalı')
  assert.equal(readFileSync(onMap, 'utf8'), 'satır1\r\nsatır2') // \n → \r\n (Windows)
  assert.ok(
    existsSync(join(dir, 'notes', '(no map)', 'hanedan', 'Test Hanedanı', 'Savaşlar.txt')),
    'haritasız madde (no map) altında olmalı'
  )
  // safe(): Windows aygıt adı (CON) klasör olamaz → _CON; kontrol karakteri _ olur.
  // Bunlarsız exportNotes Windows'ta EPERM/yanlış hedefle patlardı.
  {
    const evilEnt = api.createEntity({
      name: 'CON',
      fields: JSON.stringify({ notlar: JSON.stringify([{ title: 'x\x07y', content: 'z' }]) })
    }) as { id: number }
    api.exportNotes()
    assert.ok(
      existsSync(join(dir, 'notes', '(no map)', '(no type)', '_CON', 'x_y.txt')),
      'CON → _CON, kontrol karakteri → _'
    )
    api.deleteEntity(evilEnt.id)
  }
  // pruneUnusedAssets: adı DB metninde geçen görsel korunur, geçmeyen silinir
  writeFileSync(join(dir, 'assets', 'used.png'), Buffer.from([9]))
  writeFileSync(join(dir, 'assets', 'unused.png'), Buffer.from([9]))
  api.updateEntity(a.id, { fields: JSON.stringify({ sancak: 'assets/used.png' }) })
  assert.equal(pruneUnusedAssets(), 1)
  assert.ok(existsSync(join(dir, 'assets', 'used.png')), 'kullanılan görsel kalmalı')
  assert.ok(!existsSync(join(dir, 'assets', 'unused.png')), 'kullanılmayan görsel silinmeli')
  rmSync(join(dir, 'assets', 'used.png')) // sonraki packWorld testini etkilemesin
  api.updateEntity(a.id, { fields: '{}' }) // sonraki testler için temizle
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
  // listMaps sırası EKLENME sırası (alfabetik değil): 'Ada' en son eklendi → listede de son
  const late = api.createMap({ name: 'Ada' }) as { id: number }
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
  assert.equal(mBack.features[0].id, savedFid) // fid korundu (zaman çizgisi/harita geçmişi bağı)
  assert.equal((api.getMap(child.id) as { parent_map_id: number | null }).parent_map_id, m.id)
  backupIfNeeded()
  assert.ok(existsSync(join(dir, 'backups')))
  assert.ok(readdirSync(join(dir, 'backups')).length >= 1)
  const manual = api.backupNow()
  assert.ok(existsSync(manual))
  // .dunya paketle/aç gidiş-dönüşü: görsel gömülür, çalışma kopyası ezilip geri açılınca
  // hem veri hem görsel aynen döner, assets tablosu çalışma kopyasında kalmaz
  writeFileSync(join(dir, 'assets', 'test.png'), Buffer.from([1, 2, 3]))
  // packWorld artık kullanılmayan görselleri temizler → test.png referanslı olmalı (yoksa silinir)
  api.updateEntity(a.id, { fields: JSON.stringify({ sancak: 'assets/test.png' }) })
  const dunya = join(dir, 'test.dunya')
  packWorld(dunya)
  assert.ok(existsSync(dunya))
  api.updateEntity(a.id, { name: 'Paketten Sonra Değişti' })
  rmSync(join(dir, 'assets', 'test.png'))
  unpackWorld(dunya)
  assert.equal((api.getEntity(a.id) as { name: string }).name, 'Test Devleti') // paket anındaki hâl
  assert.deepEqual([...readFileSync(join(dir, 'assets', 'test.png'))], [1, 2, 3]) // görsel geri çıktı
  assert.equal(api.getSetting('worldFile'), dunya)
  assert.ok(
    !db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'assets'`).get()
  )
  // Kötü niyetli .dunya: gömülü görsel adı assets/ DIŞINA yazamamalı (paylaşılan dosya!)
  {
    const evil = join(dir, 'evil.dunya')
    copyFileSync(dunya, evil)
    const ev = new DatabaseSync(evil)
    ev.exec(`CREATE TABLE IF NOT EXISTS assets (name TEXT PRIMARY KEY, data BLOB NOT NULL)`)
    ev.prepare(`INSERT OR REPLACE INTO assets (name, data) VALUES (?, ?)`).run(
      join('..', '..', 'kacti.png'),
      Buffer.from([9])
    )
    // Referanslı olmalı, yoksa unpackWorld sonundaki pruneUnusedAssets onu silerdi ve
    // "içeride kaldı" iddiası sınanamazdı
    ev.prepare(`UPDATE entities SET fields = ? WHERE id = ?`).run(
      JSON.stringify({ sancak: 'assets/kacti.png' }),
      a.id
    )
    ev.close()
    unpackWorld(evil)
    // Adın işaret ettiği yer: assets/../../kacti.png (temp kökünün bir üstü) — orada OLMAMALI
    assert.ok(
      !existsSync(join(dir, 'assets', '..', '..', 'kacti.png')),
      'gömülü ad assets/ dışına yazdı!'
    )
    assert.ok(existsSync(join(dir, 'assets', 'kacti.png'))) // basename'e indirgenip içeride kaldı
  }
  // Bozuk JSON kolonlu .dunya: açılışta onarılmalı — yoksa renderer'daki 20+ JSON.parse
  // noktasından biri patlar ve o görünüm komple çöker (harita hiç açılmaz)
  {
    const broken = join(dir, 'broken.dunya')
    copyFileSync(dunya, broken)
    const bd = new DatabaseSync(broken)
    bd.exec(`UPDATE entities SET fields = 'BOZUK{{'`)
    bd.exec(`UPDATE features SET style = '[1,2]'`) // geçerli JSON ama DİZİ — nesne bekleniyor
    bd.exec(`UPDATE maps SET layers = 'yok'`)
    bd.exec(`INSERT OR REPLACE INTO settings (key, value) VALUES ('mapModes', '{bozuk')`)
    bd.exec(`INSERT OR REPLACE INTO settings (key, value) VALUES ('theme', 'dark')`)
    bd.close()
    unpackWorld(broken)
    assert.equal(
      (api.getEntity(a.id) as { fields: string }).fields,
      '{}',
      'bozuk fields onarılmalı'
    )
    const bm = api.getMap(m.id) as { layers: string; features: { style: string }[] }
    assert.equal(bm.features[0].style, '{}', 'bozuk style onarılmalı')
    assert.equal(bm.layers, '[]', 'bozuk layers onarılmalı')
    assert.equal(api.getSetting('mapModes'), null, 'bozuk JSON ayarı silinmeli')
    assert.equal(api.getSetting('theme'), 'dark', 'düz METİN ayar korunmalı (JSON değil)')
  }
  // Boş açılış: içerik algılanır, reset sonrası db + assets bomboş
  assert.ok(hasContent())
  resetWorld()
  assert.ok(!hasContent())
  assert.ok(!existsSync(join(dir, 'assets', 'test.png')))
  assert.equal(api.getSetting('worldFile'), null)
  db.close()
  rmSync(dir, { recursive: true, force: true })
  console.log('db self-check OK')
}
