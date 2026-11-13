# Leave Sync for YouTrack

Teams Shifts'te onaylanan izinleri YouTrack'e çeker.
- **Leaves** (sol menü): Her çalışan sadece kendi kalan izin hakkını, türlere göre kullanımını ve izin geçmişini görür. Görüntülenecek dönem izin yılı, takvim yılı veya özel bir tarih aralığı olabilir.
- **Adminler** aynı sayfada **View** seçicisiyle herhangi bir çalışanın sayfasını veya **Team overview** (tüm ekip) tablosunu görür.
- **Administration → Integrations → Leave Management**: Çalışanlar, işe giriş tarihleri, bakiyeler, izin türleri, tatiller ve Teams bağlantısı buradan yönetilir.

Ayrıntılı kurulum ve kullanım rehberi Getting Started dokümanındadır.

## Hesaplama kuralları
| Konu | Davranış |
|---|---|
| İzin yılı | İşe giriş yıl dönümünden bir sonraki yıl dönümüne kadar |
| Yıllık hak | 1–5 yıl: 14 gün, 6–14 yıl: 21 gün, 15+ yıl: 26 gün (*Entitlement rules* sekmesinden değiştirilebilir) |
| Yaş kuralı | 18 yaş ve altı ile 50 yaş ve üstü çalışanlara en az 20 gün (doğum tarihi girilmişse) |
| Devir | Kullanılmayan izin bir sonraki izin yılına devreder |
| Sayım | Saat bazında (8 saat = 1 gün). Hafta sonu ve resmi tatiller düşülmez, arife günleri yarım gündür. |
| İzin türleri | Teams'teki "Neden" listesi. Hangilerinin yıllık izinden düşeceğini admin seçer. |
| Gizlilik | Çalışan sadece kendi verisini alır, bu kontrol sunucu tarafında yapılır. Başkalarının verisini sadece System Admin'ler ve *Leave administrators* grubu görür. |

## Güncelleme
**Administration → Apps → Leave Sync for YouTrack** sayfasında yeni zip'i mevcut uygulamanın üstüne yükle. **Uygulamayı silme**, silersen tüm veriler gider.

Not: `manifest.json` dosyasındaki `name` alanı (`leave-tracker`) uygulamanın teknik kimliğidir ve değiştirilmemelidir. Değiştirilirse YouTrack yeni zip'i ayrı bir uygulama olarak kurar ve mevcut veriler yeni sürüme geçmez.

## Dosyalar
- `manifest.json`, `settings.json`, `entity-extensions.json`: uygulama tanımı, ayarlar ve veri alanları
- `api.js`: sayfaların kullandığı uç noktalar
- `engine.js`: izin hesaplama
- `teams-sync.js`: Microsoft Graph senkronizasyonu
- `store.js`: veri saklama
- `widgets/leaves`: Leaves sayfası
- `widgets/leaves-admin`: Leave Management sayfası
