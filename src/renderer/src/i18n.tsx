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
  'New region': 'Yeni bölge',
  'New pin': 'Yeni pin',
  'New path': 'Yeni yol',
  '📖 Open': '📖 Aç',
  '📍 Show on map': '📍 Haritada göster',
  'Show on map': 'Haritada göster',
  'Search on map…': 'Haritada ara…',
  'Pin types': 'Pin tipleri',
  '(no entity)': '(maddesiz)',
  '⚙ Settings': '⚙ Ayarlar',
  // Hata sınırı (bozuk .dunya render'ı patlatırsa çıkış yolu)
  'This world could not be opened': 'Bu dünya açılamadı',
  'The file may be corrupt or created by a newer version.':
    'Dosya bozuk olabilir ya da daha yeni bir sürümle oluşturulmuş olabilir.',
  Details: 'Ayrıntılar',
  // Kaydetme bildirimi + otomatik kaydetme
  'Saved: {name}': 'Kaydedildi: {name}',
  'Auto-saved': 'Otomatik kaydedildi',
  // Kısayol yardımı (Shortcuts.tsx)
  '⌨ Shortcuts': '⌨ Kısayollar',
  General: 'Genel',
  'Map — selection': 'Harita — seçim',
  'Map — copy': 'Harita — kopyalama',
  'Map — view & drawing': 'Harita — görünüm ve çizim',
  Timeline: 'Zaman çizgisi',
  Notes: 'Notlar',
  'Suggest entity names — ↑↓ to pick, Enter/Tab to insert':
    'Madde adı öner — ↑↓ ile seç, Enter/Tab ile ekle',
  'Close the suggestion list': 'Öneri listesini kapat',
  'Search everything (palette)': 'Her şeyde ara (palet)',
  'Save world / Save as': 'Dünyayı kaydet / Farklı kaydet',
  'Open world': 'Dünya aç',
  'Undo / Redo': 'Geri al / Yinele',
  'Back / Forward in history': 'Geçmişte geri / ileri',
  'This page': 'Bu sayfa',
  'Delete selected entities (in the list)': 'Seçili maddeleri sil (listede)',
  Click: 'Tık',
  'Select a drawing': 'Bir çizim seç',
  'Ctrl+click': 'Ctrl+tık',
  'Add/remove from selection (edits apply to all)':
    'Seçime ekle/çıkar (düzenlemeler hepsine uygulanır)',
  'Delete selected drawings': 'Seçili çizimleri sil',
  'Cancel conquest / measure / route session': 'Fetih / ölçüm / rota oturumunu iptal et',
  'Copy selected drawings': 'Seçili çizimleri kopyala',
  'Paste under the cursor (also into another map)':
    'İmlecin altına yapıştır (başka haritaya da olur)',
  'Duplicate in place (slightly offset)': 'Yerinde çoğalt (biraz kaydırarak)',
  Wheel: 'Tekerlek',
  'Smooth zoom': 'Yumuşak yakınlaştırma',
  'Shift+wheel': 'Shift+tekerlek',
  'Size/thickness — of the selection, or of the active tool default':
    'Boyut/kalınlık — seçilinin, seçim yoksa aktif aracın varsayılanının',
  'Ctrl+drag a vertex': 'Ctrl+köşe sürükle',
  'Weld: move the neighbouring polygon vertex along with it':
    'Kaynak: komşu poligonun köşesini de birlikte taşı',
  'Right click on a drawing': 'Çizime sağ tık',
  'Menu: event, fork border, delete…': 'Menü: olay, sınırı çatalla, sil…',
  'Step one year (while the strip is open)': 'Bir yıl ilerle/geri (şerit açıkken)',
  'Click the year': 'Yıla tıkla',
  'Type a year by hand': 'Elle yıl gir',
  // Haritada çoklu seçim
  '{n} drawings selected': '{n} çizim seçili',
  'Edits apply to all selected drawings. Ctrl+click to add/remove.':
    'Düzenlemeler seçili tüm çizimlere uygulanır. Ctrl+tık ile ekle/çıkar.',
  '📜 Chronology': '📜 Kronoloji',
  'Save World': 'Dünyayı Kaydet',
  'Open World': 'Dünya Aç',
  'This will discard unsaved changes. Continue?':
    'Kaydedilmemiş değişiklikler kaybolacak. Devam edilsin mi?',
  // Başlangıç ekranı (son kullanılan .dunya dosyaları)
  '＋ New world': '＋ Yeni dünya',
  '📂 Open…': '📂 Aç…',
  Recent: 'Son kullanılanlar',
  Presets: 'Hazır renkler', // renk seçicideki sabit altılı şerit (son kullanılanlardan ayrı)
  'No recent worlds yet — save one with Ctrl+S.':
    'Henüz son kullanılan dünya yok — Ctrl+S ile kaydet.',
  'file not found': 'dosya bulunamadı',
  'File not found: {p}': 'Dosya bulunamadı: {p}',
  'Remove from list': 'Listeden çıkar',
  World: 'Dünya',
  'Pick an entity or 🗺 Maps from the left, or search with Ctrl+K.':
    'Soldan bir madde ya da 🗺 Haritalar seç, ya da Ctrl+K ile ara.',
  'This entity is not marked on any map yet.': 'Bu madde henüz hiçbir haritada işaretli değil.',

  // Settings.tsx
  'Export notes': 'Notları dışa aktar',
  'Write every entity’s notes to a readable .txt tree: notes/<map>/<type>/<entity>/<note>.txt. Entities appear under each map they’re drawn on; ones on no map go under “(no map)”. One-way export; the tree is rebuilt each time.':
    'Her maddenin notlarını okunabilir bir .txt ağacına yazar: notes/<harita>/<tip>/<madde>/<not>.txt. Maddeler çizildikleri her haritanın altında görünür; hiçbir haritada olmayanlar “(no map)” altında. Tek yönlü; ağaç her seferinde yeniden üretilir.',
  'Export notes to .txt': 'Notları .txt olarak aktar',
  'Exported {n} note file(s); opening the folder…': '{n} not dosyası yazıldı; klasör açılıyor…',
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
  'Load preset': 'Hazır şablon',
  'Adds example government forms and ladders (existing ones are kept)':
    'Örnek yönetim biçimleri ve merdivenleri ekler (mevcutlar korunur)',
  'Add starter ladders…': 'Başlangıç merdivenleri ekle…',
  Medieval: 'Orta Çağ',
  Modern: 'Modern',
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
  // Madde şablonları
  'Entity Templates': 'Madde Şablonları',
  'A starting point, never a constraint: pick a template on a new entity and its fields arrive ready. Leave a value empty for a blank field, or fill it in as a default. Everything stays editable afterwards — on the entity and here.':
    'Başlangıç noktası, dayatma değil: yeni bir maddede şablon seç, alanları hazır gelsin. Değeri boş bırakırsan alan boş gelir, doldurursan varsayılan olur. Sonrasında her şey değiştirilebilir — hem maddede hem burada.',
  'new template (city, dynasty…)': 'yeni şablon (şehir, hanedan…)',
  'Delete template "{name}"?': '"{name}" şablonu silinsin mi?',
  '(none)': '(yok)',
  'default value (optional)': 'varsayılan değer (isteğe bağlı)',
  'Apply template…': 'Şablon uygula…',
  'Apply a template (adds missing fields only)':
    'Şablon uygula (yalnız eksik alanları ekler, mevcutları değiştirmez)',
  'Save as template': 'Şablon olarak kaydet',
  'Save this page’s fields as a reusable template':
    'Bu sayfanın alanlarını yeniden kullanılabilir bir şablon olarak kaydet',
  'template name': 'şablon adı',
  Save: 'Kaydet',
  Language: 'Dil',
  'Interface language': 'Arayüz dili',
  Theme: 'Tema',
  Dark: 'Koyu',
  Light: 'Açık',

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
  Icon: 'İkon',
  // Özel pin görselleri
  'Upload image': 'Görsel yükle',
  'Remove from library': 'Kütüphaneden çıkar',
  'Removing only takes it out of this list; the file stays in your Dünya\\assets folder.':
    'Çıkarmak yalnız bu listeden siler; dosya Dünya\\assets klasöründe kalır.',
  'Image style': 'Görsel biçimi',
  Badge: 'Rozet',
  Free: 'Serbest',
  'Fill image (click again to remove)': 'Dolgu görseli (kaldırmak için tekrar tıkla)',
  'Remove fill image': 'Dolgu görselini kaldır',
  'Pin image (click again to remove)': 'Pin görseli (kaldırmak için tekrar tıkla)',
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
  'Curviness: {val}': 'Eğrilik: {val}',
  'Curve appears after drawing; the live preview stays straight.':
    'Eğri çizim bittikten sonra belirir; canlı önizleme düz kalır.',
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
  'Names on polygons and free text': 'Poligon adları ve serbest yazılar',
  // 🏷 Serbest metin etiketi
  Label: 'Etiket',
  'Free text on the map — name seas, mountain ranges, regions.':
    'Harita üzerine serbest yazı — deniz, dağ sırası, bölge adlandır.',
  Text: 'Metin',
  'sea, mountain range…': 'deniz, dağ sırası…',
  'Angle: {val}°': 'Açı: {val}°',
  'Curve: {val}': 'Eğri: {val}',
  'Gentle curves read best; sharp ones crowd the letters.':
    'Hafif eğriler en okunaklısıdır; sert eğrilerde harfler sıkışır.',
  '🏷 Add label': '🏷 Etiket ekle',
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
  'Belongs to': 'Bağlı olduğu',
  start: 'başlangıç',
  'year {n}': 'yıl {n}',
  'belongs to…': 'bağlı olduğu madde',
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
  'New folder': 'Yeni klasör',
  'Delete note "{name}"?': '"{name}" notu silinsin mi?',
  'Right click → new tab for long notes.': 'Uzun notlar için sağ tık → yeni sekme.',
  Sort: 'Sırala',
  Created: 'Oluşturulma',
  Modified: 'Değiştirilme',
  '🗒 New note': '🗒 Yeni not',
  '📁 New folder': '📁 Yeni klasör',
  '✎ Rename': '✎ Yeniden adlandır',
  'Folder color': 'Klasör rengi',
  '👤 Person folder': '👤 Kişi klasörü',
  '👤 Person folder ✓': '👤 Kişi klasörü ✓',
  'Enlarge — center it on screen for reading': 'Büyüt — okumak için ekranın ortasına al',
  'Pin folders': 'Pin klasörleri',
  rank: 'kademe',
  base: 'taban',
  'Which ladder rank changes hands (upper ranks take their whole branch)':
    'Hangi kademe el değiştiriyor (üst kademeler tüm dalını götürür)',
  'This region has no owner at that rank in this year.':
    'Bu bölgenin o yıl o kademede bir sahibi yok.',
  '(no folder)': '(klasörsüz)',
  '＋ Note': '＋ Not',
  '＋ Folder': '＋ Klasör',
  'Delete folder "{name}"? (articles are kept)': '"{name}" klasörü silinsin mi? (maddeler korunur)',
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
  'Ruled: {list}': 'Yönetti: {list}',
  Gender: 'Cinsiyet',
  Male: 'Erkek',
  Female: 'Kadın',
  '(auto from relations)': '(bağlardan otomatik)',
  Life: 'Yaşam',
  'birth year': 'doğum yılı',
  'death year': 'ölüm yılı',
  'child…': 'çocuk…',
  'Labels frozen': 'Etiketler donduruldu',
  'Labels frozen + hidden': 'Etiketler donduruldu + gizlendi',
  '🎲 Random male name': '🎲 Rastgele erkek ismi',
  '🎲 Random female name': '🎲 Rastgele kadın ismi',
  'in content': 'içerikte',

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

  // Atlas.tsx ('📊 Atlas' iki dilde aynı)
  Year: 'Yıl',
  Realms: 'Devletler',
  'mapped area': 'haritalanmış alan',
  'mu²': 'hb²', // harita birimi² (ölçek yokken)
  'no scale set — 📏 tool on the map': 'ölçek atanmamış — haritada 📏 aracı',
  'No measurable regions yet. Draw base-rank polygons on a map (and set a map scale with the 📏 tool for real areas).':
    'Henüz ölçülebilir bölge yok. Bir haritaya taban kademe poligonları çiz (gerçek alanlar için 📏 aracıyla harita ölçeği ata).',

  // Diplomacy.tsx
  '🕸 Diplomacy': '🕸 Diplomasi',
  '🕸 Diplomacy Web': '🕸 Diplomasi Ağı',
  'No relations between entities yet. Add links from the Relations tab of an entity page.':
    'Maddeler arasında henüz ilişki yok. Madde sayfasının İlişkiler sekmesinden bağ ekleyebilirsin.',

  // Chronology.tsx
  '{ruler} became ruler of {realm}': '{ruler}, {realm} yöneticisi oldu',
  'No events or reigns recorded yet. Add events from the map timeline, or ruler reigns from an entity page.':
    'Henüz olay ya da saltanat kaydı yok. Olayları harita zaman çizgisinden, yönetici geçmişini madde sayfasından ekleyebilirsin.',

  // MapView.tsx
  'The slider must be within the year range the drawing exists (after its start).':
    'Slider, çizimin var olduğu yıl aralığının içinde (başlangıcından sonra) olmalı.',
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
  'New map': 'Yeni harita',
  Rename: 'Yeniden adlandır',
  Remove: 'Kaldır',
  'Hide by zoom — now {z}': 'Zoom ile gizle — şimdi {z}',
  'Hide when zoomed out below': 'Bundan uzakta gizle',
  'Hide when zoomed in above': 'Bundan yakında gizle',
  Boards: 'Zeminler',
  'New board': 'Yeni zemin',
  'board name': 'zemin adı',
  'Everything is on one board. Add a board to split drawings into layers.':
    'Her şey tek zeminde. Çizimleri katmanlara ayırmak için zemin ekle.',
  'Delete board "{name}"? Its drawings move to the first board.':
    '"{name}" zemini silinsin mi? Çizimleri ilk zemine taşınır.',
  '⚔ Click the conqueror — the picks join it…': '⚔ Fethedene tıkla — seçtiklerin ona bağlanır…',
  conqueror: 'fetheden',
  takes: 'aldığı',
  'Which rank the conqueror is taken as': 'Fetheden hangi kademe olarak alınsın',
  'A region cannot conquer the realm it belongs to.':
    'Bir bölge bağlı olduğu üst devleti fethedemez.',
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
  Scale: 'Ölçek',
  'Set the map scale; measure distance and area without drawing.':
    'Harita ölçeğini ayarla; çizmeden mesafe ve alan ölç.',
  Unit: 'Birim',
  'km, miles, leagues…': 'km, mil, fersah…',
  'Map width ({unit})': 'Harita genişliği ({unit})',
  'e.g. 3000': 'örn. 3000',
  'No base image — measure a known distance instead.':
    'Zemin görseli yok — onun yerine bilinen bir mesafeyi ölç.',
  'Measure known distance…': 'Bilinen mesafeyi ölç…',
  'Remove scale': 'Ölçeği kaldır',
  'Measure (not saved)': 'Ölç (kaydedilmez)',
  Distance: 'Mesafe',
  Area: 'Alan',
  'Click to add points; Esc to finish. Measurements are not saved.':
    'Tıklayarak nokta ekle; Esc bitirir. Ölçümler kaydedilmez.',
  // 🧭 Navigasyon
  Navigate: 'Rota',
  'Pick two pins; the route follows your drawn paths.':
    'İki pin seç; rota çizdiğin yollar üzerinden hesaplanır.',
  'Navigation needs the default map view (turn off the rank/paint mode).':
    'Rota için varsayılan harita görünümü gerekli (kademe/boya modunu kapat).',
  'Travel modes': 'Seyahat modları',
  day: 'gün',
  'on foot': 'yaya',
  Add: 'Ekle',
  'Pick two pins': 'İki pin seç',
  // ('Clear' ve 'Delete' anahtarları yukarıda zaten var)
  '🧭 Click the START pin…': '🧭 Başlangıç pinine tıkla…',
  '🧭 Now click the DESTINATION pin ({from} → …)': '🧭 Şimdi varış pinine tıkla ({from} → …)',
  'Route: {a} → {b}': 'Rota: {a} → {b}',
  '{val} days': '{val} gün',
  '(off-road)': '(yol dışı)',
  '(unnamed path)': '(adsız yol)',
  'No route — make sure the paths meet at a shared point.':
    'Rota yok — yolların ortak bir noktada birleştiğinden emin ol.',
  '📏 Click the FIRST point of a known distance…': '📏 Bilinen bir mesafenin İLK noktasına tıkla…',
  '📏 Now click the SECOND point…': '📏 Şimdi İKİNCİ noktaya tıkla…',
  '📏 Real distance between the two points:': '📏 İki nokta arasındaki gerçek mesafe:',
  Finish: 'Bitir',
  'Distance: {val} {unit}': 'Mesafe: {val} {unit}',
  'Length: {val} {unit}': 'Uzunluk: {val} {unit}',
  'Area: {val} {unit}²': 'Alan: {val} {unit}²',
  'Perimeter: {val} {unit}': 'Çevre: {val} {unit}',
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
