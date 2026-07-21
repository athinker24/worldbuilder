# Dünya — Worldbuilding Uygulaması

Kurgusal bir dünyanın haritasını, halklarını, devletlerini, dillerini, hanedanlarını ve tarihini
tek bir yerde, **birbirine bağlı** biçimde tutan masaüstü uygulaması.

- İç içe geçen interaktif haritalar (kıta → şehir → bina), üzerine çizilen sınırlar ve pinler
- Ansiklopedik maddeler: birbirine `[[bağlantı]]` verilebilen, serbest alanlı, şablonlanabilir
- CK3 tarzı katmanlı siyasi hiyerarşi, yıl bazlı fetih ve sınır değişimi
- Din/dil/kültür gibi **kendi tanımladığın** harita modları
- Zaman çizgisi: yılı kaydırdıkça harita o güne döner
- Hanedan ağaçları, diplomasi ağı, atlas istatistikleri

Her şey sonradan yeniden adlandırılabilir, taşınabilir ya da silinebilir — sabit kategori yok.
Tasarım gerekçeleri: [CLAUDE.md](CLAUDE.md).

---

## Kurulum (Windows)

[**Releases**](../../releases) sayfasından son sürümü indir. İki seçenek var, ikisi de aynı
uygulamayı açar:

| Dosya | Ne yapar |
| --- | --- |
| **`Dunya-…-Setup.exe`** | Normal kurulum. Nereye kurulacağını sorar, masaüstü + Başlat menüsü kısayolu oluşturur, sonradan Ayarlar'dan kaldırılabilir. Yönetici hakkı istemez. |
| **`Dunya-…-portable.zip`** | Kurulum yok. Bir klasöre çıkar, içindeki `Dünya.exe`'yi çalıştır. USB'de de taşınabilir. |

Her ikisinde de `.dunya` dosyalarına çift tıklayarak doğrudan o dünyayı açabilirsin.

### "Windows bilgisayarınızı korudu" uyarısı

`.exe`yi çalıştırınca Windows mavi bir uyarı gösterecek. **Bu bir virüs uyarısı değil.** Uygulama
ücretli bir sertifikayla imzalanmadığı için çıkıyor; Windows tanımadığı her yayıncı için bunu
gösterir. Geçmek için: **"Daha fazla bilgi" → "Yine de çalıştır"**. Dosya başına bir kez yeterli.

İmzasız bir `.exe` çalıştırmak istemiyorsan bu tamamen makul — aşağıdaki
[kaynaktan derleme](#kaynaktan-derleme) adımlarıyla kodu inceleyip kendin derleyebilirsin.

---

## Verilerin nerede

Yazdığın her şey **anında** şuraya kaydedilir:

```
Belgeler\Dünya\
├── world.db      → tüm içerik (SQLite veritabanı)
├── assets\       → eklediğin görseller (sancaklar, harita zeminleri)
└── backups\      → otomatik günlük yedekler (30 gün saklanır)
```

Bulut yok, hesap yok — her şey kendi bilgisayarında. Yedeklemek için bu klasörü kopyalaman yeterli.

**`.dunya` dosyası** ise Photoshop'un `.psd`'si gibi: `Ctrl+S` ile dünyanın tamamını (görseller
dahil) tek bir dosyaya paketler. Başkasına gönderebilir, başka bilgisayarda açabilirsin.

---

## Kısayollar

| Kısayol | İşlev |
| --- | --- |
| `Ctrl+K` | Her şeyde ara (palet) |
| `Ctrl+S` / `Ctrl+Shift+S` | Kaydet / Farklı kaydet |
| `Ctrl+O` | Dünya aç |
| `Ctrl+Z` / `Ctrl+Y` | Geri al / Yinele |
| `F1` | Kısayolların tam listesi |
| `Ctrl`+tık | Haritada birden çok çizim seç |
| `Ctrl+C` / `Ctrl+V` / `Ctrl+D` | Çizimi kopyala / yapıştır / çoğalt |
| `Shift`+tekerlek | Seçili çizimin (ya da aktif aracın) boyutu |
| `Alt+←` / `Alt+→` | Gezinme geçmişi |

Tamamı uygulama içindeki **⌨ Kısayollar** sayfasında.

---

## Başkasından gelen `.dunya` dosyaları

Dosyalar paylaşılmak için tasarlandı, bu yüzden içerikleri **güvenilmez girdi** kabul edilir:
not içeriği HTML/JavaScript çalıştıramaz, gömülü görseller `assets\` klasörünün dışına yazamaz,
bozuk veri uygulamayı kilitlemek yerine onarılır. Ayrıntı: CLAUDE.md'deki "Güvenlik sözleşmesi".

Yine de: tanımadığın birinden gelen bir dosyaya, tanımadığın bir programa gösterdiğin şüpheyi göster.

---

## Kaynaktan derleme

[Node.js](https://nodejs.org) 22 veya üzeri gerekir.

```bash
npm install
npm run dev          # geliştirme sunucusu (anında yenilemeli)
npm run build:win    # dist/ altına kurulum + zip üretir
```

Diğer komutlar:

```bash
npm run typecheck    # tip denetimi
npm run lint         # eslint
node src/main/db.ts  # veritabanı self-check (şema + CRUD + undo + güvenlik assert'leri)
```

Sürüm yayımlama: `git tag v1.0.1 && git push --tags` → GitHub Actions derleyip taslak bir
Release'e kurulum ve zip'i ekler ([.github/workflows/release.yml](.github/workflows/release.yml)).

---

## Durum

Kişisel bir hobi projesi, sürekli gelişiyor. Bir şey bozuksa ya da tuhaf görünüyorsa
[issue açabilirsin](../../issues).

## Lisans

Lisans **uygulamanın kodunu** kapsar. Uygulamayla ürettiğin dünya (`.dunya` dosyan, haritaların,
maddelerin) tamamen sana aittir ve bu depoda yer almaz.
