import { createContext, useContext } from 'react'
import { Lang } from './api'

// English is the canonical text used directly in JSX (t('Some Text')); this dictionary
// only needs to hold the Turkish alternative. Missing keys fall back to the English text.
const TR: Record<string, string> = {
  // App.tsx
  'Search…  (Ctrl+K)': 'Ara…  (Ctrl+K)',
  Maps: 'Haritalar',
  'map name': 'harita adı',
  '🗺 Open': '🗺 Aç',
  '🗑 Delete': '🗑 Sil',
  'Delete "{name}" and all drawings on it?':
    '"{name}" haritası ve üzerindeki tüm çizimler silinsin mi?',
  Entities: 'Maddeler',
  'New Entity': 'Yeni Madde',
  '📖 Open': '📖 Aç',
  '📍 Show on map': '📍 Haritada göster',
  'Show on map': 'Haritada göster',
  '⚙ Settings': '⚙ Ayarlar',
  World: 'Dünya',
  'Select an entity or map from the left, or search with Ctrl+K.':
    'Soldan bir madde ya da harita seç, ya da Ctrl+K ile ara.',
  'This entity is not marked on any map yet.': 'Bu madde henüz hiçbir haritada işaretli değil.',

  // Settings.tsx
  'Entity Types': 'Madde Tipleri',
  'Types are completely free: add, rename, delete. Renaming a type updates all entities of that type.':
    'Tipler tamamen serbesttir: ekle, yeniden adlandır, sil. Yeniden adlandırma o tipteki tüm maddeleri günceller.',
  'Delete type "{name}" from the list? (Entities are not deleted, they keep their type)':
    '"{name}" tipi listeden silinsin mi? (Maddeler silinmez, tipleri kalır)',
  'new type (state, dynasty, religion…)': 'yeni tip (devlet, hanedan, din…)',
  Person: 'Kişi',
  'Person entities: family/dynasty pickers only suggest these; they cannot be linked to map polygons.':
    'Kişi maddeleri: aile/hanedan alanları yalnız bunları önerir; harita poligonlarına bağlanamazlar.',
  'Hierarchy Ranks': 'Hiyerarşi Kademeleri',
  'Each government form has its own rank ladder (top to bottom: empire → county, for example). Government forms appear here as tabs as they are written into the "Government form" field on entity pages.':
    'Her yönetim biçiminin kendi kademe merdiveni vardır (sıra üstten alta: imparatorluk → kontluk gibi). Yönetim biçimleri madde sayfasındaki "Yönetim biçimi" alanına yazıldıkça burada sekme olarak belirir.',
  'new government form (feudal, nomadic…)': 'yeni yönetim biçimi (feodal, göçebe…)',
  'Delete government form': 'Yönetim biçimini sil',
  'Delete government form "{name}" and its rank ladder?':
    '"{name}" yönetim biçimi ve kademe merdiveni silinsin mi?',
  'add tag to ladder (#county…)': 'merdivene etiket ekle (#kontluk…)',
  'Unassigned tags: {list}': 'Atanmamış etiketler: {list}',
  'Map Modes': 'Harita Modları',
  'Dimensions like religion, language, culture. Each dimension you add appears as a field on entity pages (e.g. "religion: Islam"); the map is painted by that dimension from the Hierarchy panel.':
    'Din, dil, kültür gibi boyutlar. Eklenen her boyut madde sayfasında bir alan olarak belirir (örn. "din: İslam"); haritada Hiyerarşi panelinden o boyuta göre boyama yapılır.',
  'religion, language, culture…': 'din, dil, kültür…',
  Language: 'Dil',
  'Interface language': 'Arayüz dili',

  // Palette.tsx
  '🗺 map': '🗺 harita',
  entity: 'madde',
  'Create new entity named "{query}"': '"{query}" adında yeni madde oluştur',
  'Search entity or map…': 'Madde ya da harita ara…',

  // ToolPanel.tsx
  Polygon: 'Poligon',
  Location: 'Konum',
  Edit: 'Düzenle',
  'Drag the corner points of drawings to change their shape.':
    'Çizimlerin köşe noktalarını sürükleyerek şekli değiştir.',
  Move: 'Taşı',
  'Drag drawings to move them.': 'Çizimleri sürükleyerek taşı.',
  Delete: 'Sil',
  'Clicked drawing is deleted (undo with Ctrl+Z).':
    'Tıkladığın çizim silinir (Ctrl+Z ile geri alınır).',
  Color: 'Renk',
  'Fill opacity: {val}': 'İç opaklık: {val}',
  'Outline thickness: {val}px': 'Dış hat kalınlığı: {val}px',
  'Label font': 'Etiket fontu',
  Path: 'Yol',
  'Draw roads, routes, borders as lines.': 'Yol, güzergâh, sınır gibi çizgiler çizer.',
  'Thickness: {val}px': 'Kalınlık: {val}px',
  'Opacity: {val}': 'Opaklık: {val}',
  'Line style': 'Çizgi deseni',
  Solid: 'Düz',
  Dashed: 'Kesikli',
  Dotted: 'Noktalı',
  '〰 Draw path': '〰 Yol çiz',
  'Direction arrow': 'Yön oku',
  'No arrow': 'Ok yok',
  'Arrow at end': 'Sonda ok (varış)',
  Export: 'Dışa aktar',
  'Export as image': 'Görsel olarak dışa aktar',
  '-100 years (Ctrl+←)': '-100 yıl (Ctrl+←)',
  '-10 years (Shift+←)': '-10 yıl (Shift+←)',
  '+10 years (Shift+→)': '+10 yıl (Shift+→)',
  '+100 years (Ctrl+→)': '+100 yıl (Ctrl+→)',
  Layers: 'Katmanlar',
  Polygons: 'Poligonlar',
  Paths: 'Yollar',
  Pins: 'Pinler',
  Labels: 'Etiketler',
  'State / region borders': 'Devlet / bölge sınırları',
  'Roads, routes, rivers': 'Yollar, rotalar, nehirler',
  'Markers on the map': 'Harita üzerindeki işaretçiler',
  'Names written on polygons': 'Poligonların üzerine yazılan adlar',
  'Exported to {path}': '{path} konumuna aktarıldı',
  Backup: 'Yedekleme',
  'A dated copy of world.db is made automatically once a day (last 30 days kept). Restoring is manual: with the app closed, copy a file from the backups folder over world.db.':
    "world.db'nin tarihli bir kopyası günde bir kez otomatik alınır (son 30 gün saklanır). Geri yükleme elle yapılır: uygulama kapalıyken backups klasöründeki bir dosyayı world.db üzerine kopyala.",
  'Back up now': 'Şimdi yedekle',
  'Backed up to {path}': '{path} konumuna yedeklendi',
  'Size: ×{val}': 'Boyut: ×{val}',
  'Select a tool; its settings appear here.': 'Bir araç seç; ayarları burada görünür.',

  // entityOps.ts
  'Delete "{name}"?': '"{name}" silinsin mi?',

  // EntityPage.tsx
  'Loading…': 'Yükleniyor…',
  View: 'Görüntüle',
  type: 'tip',
  'new field': 'yeni alan',
  value: 'değer',
  'Markdown content… link to other entities with [[Entity Name]].':
    'Markdown içerik… [[Madde Adı]] ile diğer maddelere bağlanabilirsin.',
  'No entity named "{name}". Create it?': '"{name}" adında madde yok. Oluşturulsun mu?',
  Hierarchy: 'Hiyerarşi',
  'county, religion, language…': 'kontluk, din, dil…',
  'Government form': 'Yönetim biçimi',
  'feudal, nomadic…': 'feodal, göçebe…',
  Parent: 'Üst',
  start: 'başlangıç',
  'year {n}': 'yıl {n}',
  'parent entity': 'üst madde',
  'year (blank=from start)': 'yıl (boş=baştan)',
  'Map history': 'Harita geçmişi',
  always: 'her zaman',
  Relations: 'İlişkiler',
  'relation (rules, member of…)': 'ilişki (yönetir, mensubu…)',
  'target entity': 'hedef madde',
  'Linked from here': 'Buraya bağlananlar',
  'mentions in content': 'içerikte anıyor',
  '🗒 New tab': '🗒 Yeni sekme',
  'New note': 'Yeni not',
  'Delete note "{name}"?': '"{name}" notu silinsin mi?',
  'Right click → new tab for long notes.': 'Uzun notlar için sağ tık → yeni sekme.',
  'Add banner': 'Sancak ekle',
  'Replace banner': 'Sancağı değiştir',
  'Remove banner': 'Sancağı kaldır',
  Ruler: 'Yönetici',
  'ruler (person)': 'yönetici (kişi)',
  Rules: 'Yönettiği',
  'Ruling house': 'Yöneten hane',
  'ruling house': 'yöneten hane',
  'Delete selected ({n})': 'Seçilenleri sil ({n})',
  'Delete {n} entities?': '{n} madde silinsin mi?',
  Clear: 'Temizle',
  Cancel: 'İptal',
  Family: 'Aile',
  Mother: 'Anne',
  Father: 'Baba',
  Spouse: 'Eş',
  Children: 'Çocuklar',
  'person…': 'kişi…',
  'Family tree': 'Hanedan ağacı',
  Dynasty: 'Hanedan',
  'Click: center the tree on this person': 'Tıkla: ağacı bu kişiye merkezle',

  // HierarchyPanel.tsx
  All: 'Tümü',
  'No ladder yet. Write a government form on entities, then order the ranks from Settings.':
    "Henüz merdiven yok. Maddelere yönetim biçimi yaz, Ayarlar'dan kademeleri sırala.",
  Conquest: 'Fetih',
  'No entities in this rank.': 'Bu kademede madde yok.',
  'No values in this dimension. Write a "{dim}" field on entities.':
    'Bu boyutta değer yok. Maddelere "{dim}" alanı yaz.',

  // Timeline.tsx
  Pause: 'Duraklat',
  Play: 'Oynat',
  'Playback speed: {n} yr/s': 'Oynatma hızı: {n} yıl/sn',
  'Calendar settings': 'Takvim ayarları',
  'Click, type a year (negative = before epoch)': 'Tıkla, yıl yaz (negatif = dönümden önce)',
  'Era abbreviations': 'Çağ kısaltmaları',
  'Before epoch': 'Dönümden önce',
  'After epoch': 'Dönümden sonra',
  'Year range': 'Yıl aralığı',
  'period name': 'dönem adı',
  'start.': 'başl.',
  end: 'bitiş',
  'event name (no location)': 'olay adı (konumsuz)',
  year: 'yıl',
  '🕰 Time': '🕰 Zaman',

  // MapView.tsx
  'The slider must be within the year range the drawing exists (after its start).':
    'Slider, çizimin var olduğu yıl aralığının içinde (başlangıcından sonra) olmalı.',
  'This entity has no parent — first set a "Parent" from the entity page.':
    'Bu maddenin üstü yok — önce madde sayfasından "Üst" ata.',
  '📖 Open entity': '📖 Maddeyi aç',
  '🔍 Show in panel': '🔍 Panelde göster',
  '🔗 Link to entity…': '🔗 Maddeye bağla…',
  '🗺 Open map →': '🗺 Haritayı aç →',
  '⏳ Change border from this year': '⏳ Sınırı bu yıldan itibaren değiştir',
  '📅 Add event to this drawing': '📅 Bu çizime olay ekle',
  '⬠ Draw polygon': '⬠ Poligon çiz',
  '📍 Add location': '📍 Konum ekle',
  '✏️ Edit mode': '✏️ Düzenle modu',
  '✋ Move mode': '✋ Taşı modu',
  '🗑 Delete mode': '🗑 Silme modu',
  'Could not load image. The file may be corrupt or in an unsupported format.':
    'Görsel yüklenemedi. Dosya bozuk ya da desteklenmeyen bir biçimde olabilir.',
  'Add base image': 'Zemin görseli ekle',
  "⚔ Click the conqueror's border polygon (receiver = its parent)…":
    '⚔ Fethedenin sınırdaki poligonuna tıkla (alıcı = onun üstü)…',
  cancel: 'iptal',
  '⚔ Select polygons to join {name} ({n} selected)':
    "⚔ {name}'e katılacak poligonları seç ({n} seçili)",
  OK: 'Tamam',
  '📅 Event name (year {n}):': '📅 Olay adı (yıl {n}):',
  'event name': 'olay adı',
  add: 'ekle',
  'This entity has no drawing on the map.': 'Bu maddenin haritada çizimi yok.',
  'Drawing #{id}': 'Çizim #{id}',
  'View:': 'Görünüm:',
  'Time (blank = always; negative = before epoch):':
    'Zaman (boş = her zaman; negatif = dönümden önce):',
  'Unlink entity': 'Madde bağlantısını kaldır',
  'Link to entity:': 'Maddeye bağla:',
  'search entity…': 'madde ara…',
  'Link / Create': 'Bağla / Oluştur',
  'Child map (door):': 'Çocuk harita (kapı):',
  '— none —': '— yok —',
  'Open map →': 'Haritayı aç →'
}

export const LangContext = createContext<Lang>('en')

/** t('English text', {placeholder: value}) — Turkish is looked up by the English text itself. */
export function translate(lang: Lang, s: string, params?: Record<string, string | number>): string {
  let out = lang === 'tr' ? (TR[s] ?? s) : s
  if (params) for (const [k, v] of Object.entries(params)) out = out.split(`{${k}}`).join(String(v))
  return out
}

export function useT(): (s: string, params?: Record<string, string | number>) => string {
  const lang = useContext(LangContext)
  return (s, params) => translate(lang, s, params)
}
