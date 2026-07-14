# Dünya — Worldbuilding Uygulaması

Kişisel worldbuilding uygulaması: interaktif haritalar + birbirine bağlı ansiklopedik maddeler.
Amaç ve tasarım ilkeleri için [CLAUDE.md](CLAUDE.md).

## Kullanım

- **Masaüstü:** masaüstündeki "Dünya" kısayolu (ya da `dist/win-unpacked/Dünya.exe`).
- **Geliştirme:** `npm run dev`
- **Paketleme:** `npm run build:unpack` (kod değişince masaüstü sürümünü günceller)

## Veri

Tüm dünya `Belgeler\Dünya` klasöründe: `world.db` (SQLite) + `assets/` (harita görselleri).
Yedeklemek için bu klasörü kopyalamak yeterli.

## Kontroller

| Kısayol | İşlev |
| --- | --- |
| Ctrl+K | Hızlı geçiş paleti |
| Ctrl+Z / Ctrl+Y | Geri al / yinele |
| Alt+← / Alt+→ | Gezinme geçmişi |
| Orta tuş sürükleme | Haritayı kaydır |
| Sağ tık | Bağlam menüsü (harita, çizim, kenar çubuğu) |

## Testler

- Veritabanı self-check: `node src/main/db.ts`
- Tip denetimi: `npm run typecheck`
