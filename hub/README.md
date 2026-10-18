# Gemini Hub

Tüm Gemini hesaplarınızı tek bir özel sunucuda toplayan ve bütün uygulamalarınıza
**resmî API gibi tek adres** sunan servis. Her hesap, hub'ın içindeki **kendi kalıcı
Chrome profiliyle** gemini.google.com'u bir insan gibi kullanır: Google yalnızca tek
bir makinede tek bir sıradan Chrome görür.

## Uygulamalar için

| | |
|---|---|
| **Genel link (her yerden)** | `https://hub.152-53-39-199.sslip.io/p/<uygulamanın gizli yolu>/v1` (OpenAI) · sonunda `/v1` olmadan (Gemini) |
| VPS içi (n8n vb.) | `http://host.docker.internal:18090/v1` · `http://127.0.0.1:18090/v1` |
| Anahtar | `Authorization: Bearer ghk_…`, `x-goog-api-key` ya da `?key=` |
| Yönetim | `http://100.102.156.33:18091` (Tailscale) ya da SSH tüneliyle `127.0.0.1:18091`; internete kapalı |

**Adım adım rehber (n8n ve kendi uygulamaların): [docs/REHBER.md](docs/REHBER.md).**
Örnekler: [`examples/openai_client.py`](examples/openai_client.py), [`examples/genai_client.py`](examples/genai_client.py).

- Model adları hesaplardaki model seçiciden gelir: `gemini-3.8-flash`, `gemini-3.1-pro`,
  `gemini-4-argon`, `gemini-3.5-flash-lite`… (`GET /v1/models`).
- İstenen model kullanılır ya da istek hata verir; **asla sessizce başka model** yok.
  Cevabın hangi modelden ve hesaptan geldiği `x-hub-model-label`, `x-hub-account` başlıklarında.
- Süre sınırı ve çıktı kesmesi yoktur; güçlü model düşünmesini bitirir.
- JSON modu (`response_format`, `responseMimeType`/`responseSchema`) şemaya göre denetlenir;
  geçersizse aynı sohbette bir kez düzelttirilir.
- Görsel/dosya: yalnız base64 (`data:` URL ya da `inlineData`); hub uzak URL çekmez.
- Aynı istek 10 dakika içinde tekrar gelirse Google'a ikinci kez gönderilmez, ilk cevap
  döner (`x-hub-deduplicated: 1`; `Idempotency-Key` başlığı da desteklenir).

### Hatalar (uygulamanın beklemesi gerekenler)

| Kod | Anlamı |
|---|---|
| 401 | anahtar yanlış ya da bu makineden kullanılamaz |
| 404 `model_not_found` | hiçbir hesap bu modeli sunmuyor |
| 429 `capacity` (+`Retry-After`) | bu modeli sunan bütün hesaplar Google'a göre dolu ya da beklemede; mesajda sebepler ve sonraki boşalma saati |
| 429 `app_cap` / `queue_full` | bu uygulamanın kendi sınırı |
| 429 `account_limit` / `account_throttled` | Google cevap sırasında limit ya da 429 verdi; istem tekrar gönderilmez |
| 502 `model_changed` | Gemini başka modelle cevap verdi; cevap atıldı |
| 503 `no_account` / `account_stopped` / `upstream_ui_changed` | hesaplar sizi bekliyor ya da site değişti |

## Hesaplar ve yönlendirme (router)

- Her hesabın modelleri kendi model seçicisinden okunur; istek o modeli sunan hesaba gider
  (ücretsiz hesaplarda bugün yalnız **Auto** seçilebilir; Pro/Argon orada satış düğmesidir).
- Bir hesabın çalışıp çalışamayacağına **Google karar verir**: Gemini'nin kullanım sayfası
  (`gemini.google.com/usage`: 5 saatlik pencere + haftalık tavan, yüzde ve sıfırlanma saati) ve
  Google'ın gösterdiği limit / doğrulama / çıkış / HTTP 429 mesajları. Yerel tahmin, istem sayısı
  bütçesi ya da günlük dinlenme yoktur.
- Kullanım %95'e (5 saatlik ya da haftalık) ulaşınca hesap sıfırlanma saatine kadar iş almaz; okuma
  30 dakikadan eskiyse hesap kullanılmadan önce sayfa yeniden okunur (istem gönderip denemez).
- Hesaplar paralel çalışır (hesap başına aynı anda bir istem, cevaplar arası 2–18 sn).
- Hiçbir hesap şu an alamıyorsa istek **beklemez**: hemen `429 capacity` (ya da `503 no_account`)
  döner; mesajda her hesabın durumu ve bir sonraki boşalma saati, `Retry-After` başlığında saniye olarak.
  Uygulamalar `GET /v1/hub/accounts` ile her hesabın yüzdesini, sıfırlanma saatini ve uygunluğunu görür.
- Google limit gösterirse o model o hesapta sıfırlanmaya kadar durur; HTTP 429'da hesap 15 dk
  (aynı gün tekrarında 1 saat) bekler ve kendiliğinden döner; doğrulama / çıkışta hesap durur ve
  telefona bildirim gider. Hepsi olay kaydına yazılır.
- Google'a ulaşmış bir istem **asla yeniden gönderilmez**; başka hesaba yalnız hiçbir şey
  gönderilmemişse geçer. Her istek yeni bir geçici sohbette. Uzun düşünen modeller kesilmez.
- 5–7 saatte bir istemsiz kısa ziyaret oturumu taze tutar; giriş bir kez, otomatik algılanır.

## Güvenlik

- API yalnız loopback, Tailscale adresi ve docker0 köprüsünde; genel IP'de port yok; ufw ayrıca kapatır.
- Her bağlantı önce ağ izin listesinden geçer; her anahtar **kaynak adresine bağlıdır**
  (sızan anahtar başka makineden çalışmaz). Anahtarlar yalnız SHA-256 özeti olarak saklanır.
- Yönetim tarafı yalnız `127.0.0.1:18091` (SSH tüneli), Host başlığı denetimi, oturum çerezi
  (HttpOnly, SameSite=Strict) + CSRF, tek kullanımlık giriş bağlantıları.
- X ekranları çerezle korunur, VNC yalnız loopback'te tek seferlik parolayla ve yalnız giriş sırasında açık.
- Günlüklerde istem/cevap metni yok; veritabanında yalnız meta veri.

## Yönetim

```bash
ssh -N -L 18091:127.0.0.1:18091 miraz-vps     # tünel (açık kalsın)
ssh miraz-vps gemini-hub-login                 # tek kullanımlık giriş bağlantısı (10 dk)
```

Bağlantıyı tarayıcıda açın → **Hesap ekle** → **Giriş yap** → görüntüleyicide Google'a girin →
**Girişi bitirdim**. Uygulama anahtarı: **Uygulamalar** → ad + kaynak adres(ler).
Yeni bir Tailscale makinesine izin: `ssh miraz-vps gemini-hub-allow 100.x.y.z "laptop"`.

Telefon bildirimi: ntfy uygulamasında konuya abone olun
(`ssh miraz-vps "grep NTFY /etc/gemini-hub/hub.env"`).

## Kurulum / güncelleme

`deploy/` — `docker-compose.yml` (host ağı, salt okunur kök, tüm yetkiler düşük,
`seccomp-chrome.json`), `gemini-hub-allow`, `gemini-hub-login`. VPS'te `/opt/gemini-hub`,
veri `/var/lib/gemini-hub`, gizli değerler `/etc/gemini-hub/` (0600).
Güncelleme: kaynağı `/opt/gemini-hub/src-<commit>`'e açın, `docker build -t gemini-hub:<commit>`,
`.env` içinde `HUB_COMMIT=<commit>`, `docker compose up -d`. **Bir hesabın giriş ekranı açıkken güncellemeyin.**

Testler: `npm test`. Gerçek trafik kanıtı: `python tools/proof.py <url> out.json app=<keyfile> …`.
