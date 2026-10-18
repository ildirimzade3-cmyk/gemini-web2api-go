# Gemini Hub

Tüm Gemini hesaplarınızı tek bir özel sunucuda toplayan ve bütün uygulamalarınıza
**resmî API gibi tek adres** sunan servis. Her hesap, hub'ın içindeki **kendi kalıcı
Chrome profiliyle** gemini.google.com'u bir insan gibi kullanır: Google yalnızca tek
bir makinede tek bir sıradan Chrome görür.

## Uygulamalar için

| | |
|---|---|
| OpenAI uyumlu | `http://100.102.156.33:18090/v1` (`/chat/completions`, `/models`) |
| Gemini uyumlu | `http://100.102.156.33:18090` (`/v1beta/models/{model}:generateContent`, `:streamGenerateContent`) |
| VPS'teki Docker uygulamaları | `http://172.17.0.1:18090` (`host.docker.internal:18090`, `extra_hosts: host.docker.internal:host-gateway`) |
| Anahtar | `Authorization: Bearer ghk_…`, `x-goog-api-key` ya da `?key=` |

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
| 429 `capacity` (+`Retry-After`) | hesapların güvenli günlük payı doldu — yük hesapların kaldırabileceğinden fazla |
| 429 `app_cap` / `queue_full` | bu uygulamanın kendi sınırı |
| 429 `account_limit` | Google cevap sırasında limit gösterdi; istem tekrar gönderilmez |
| 502 `model_changed` | Gemini başka modelle cevap verdi; cevap atıldı |
| 503 `no_account` / `account_stopped` / `upstream_ui_changed` | hesaplar sizi bekliyor ya da site değişti |

## Hesap güvenliği (neden ban riski düşük)

- Hesap başına ayrı kalıcı profil, sabit makine/IP/saat dilimi (VPS Virginia'da: `America/New_York`).
- Giriş, **otomasyon bağlı olmayan düz Chrome**'da sizin tarafınızdan bir kez yapılır (VNC ile).
- Çalışırken Chrome'a hata ayıklama portu açılmaz (CDP pipe), Chrome kendi sandbox'ıyla çalışır.
- Hesap başına **aynı anda tek iş**, her cevaptan sonra 6–40 sn "okuma" molası, saatlik üst sınır,
  model başına günlük **güvenli pay** (tüketici planı limitlerinin yaklaşık yarısı), her gün
  ±30 dk kayan 5 saatlik dinlenme (hesaplar 3'er saat kaydırılır, hub hiç uyumaz).
- Google bir limit gösterirse o model o hesapta sıfırlanma saatine kadar durur ve payı,
  limitin göründüğü sayının %60'ına iner. "Olağandışı etkinlik", doğrulama, oturum kapanması:
  hesap anında durur, size bildirim gider, hub hiçbir şeyi otomatik denemez.
- Google'a ulaşmış bir istem **asla yeniden gönderilmez**; başka hesaba yalnız hiçbir şey
  gönderilmemişse geçer. Her istek yeni (mümkünse geçici) bir sohbette.
- Uygulamalar arasında adil sıra; uygulama başına günlük üst sınır ve model listesi.
- Yönetim sayfasındaki **Kapasite** tablosu, istenen yükün güvenli kapasiteyi aşıp aşmadığını gösterir.

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
