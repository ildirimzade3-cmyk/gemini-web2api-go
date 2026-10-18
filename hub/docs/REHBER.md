# Gemini Hub — kullanım rehberi (n8n ve kendi uygulamaların)

Hub, Gemini hesaplarını tek adreste toplar ve **resmî OpenAI ya da Gemini API'si gibi**
konuşur. Uygulamanın tek bilmesi gereken: **adres + anahtar + model adı.**

## 1. Bilgisayar gerekmez, kurulum gerekmez

Hub **VPS'te 7/24 çalışan bir sunucu servisidir** (yeniden başlatmada kendiliğinden açılır).
Bilgisayarın kapalı olsa da çalışır; hesap tarayıcıları ve oturumlar sunucuda durur.

Her uygulama için yönetim sayfasında **"internetten (genel link)"** işaretli bir anahtar üretirsin.
Hub sana iki şey verir:

- **Link:** `https://hub.152-53-39-199.sslip.io/p/<gizli-yol>/v1` (OpenAI uyumlu) ve sonunda
  `/v1` olmadan aynı link (Gemini uyumlu)
- **Anahtar:** `ghk_…`

Bu link **her yerden** çalışır: kendi bilgisayarın, laptop, telefon, başka bir sunucu, n8n.
Tailscale, tünel ya da kurulum gerekmez.

**Güvenlik:** link ve anahtar iki ayrı sırdır, ikisi birlikte gerekir. Biri sızarsa tek başına işe
yaramaz. İkisi birden sızarsa o uygulamanın anahtarını panelden **İptal et**, yenisini üret;
hesapların kendisine ve oturumlarına bu yoldan ulaşılamaz. Her uygulamaya ayrı anahtar ver; istersen
günlük üst sınır ve model listesi koy.

Aynı sunucudaki uygulamalar için (n8n gibi) internete hiç çıkmayan iç adres de kullanılabilir;
biraz daha hızlıdır (anahtar üretirken kaynak adres yazılır, "internetten" işareti gerekmez):

| Uygulama | İç adres | Anahtarın kaynak adresi |
|---|---|---|
| VPS'teki Docker (n8n dahil) | `http://host.docker.internal:18090` | n8n için `172.19.0.0/16` |
| VPS'in kendisi | `http://127.0.0.1:18090` | `127.0.0.1` |

Docker'da `host.docker.internal` için compose'a şunu ekle (n8n'de zaten var):
```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

## 2. Yönetim sayfası ve anahtar üretme

Yönetim sayfası bilerek internete **kapalıdır**; oradan hesaplara giriş ekranı açılabildiği için
en hassas kısım orasıdır. Açmanın iki yolu var:

- **Tailscale'li bir cihazdan (önerilen, tünelsiz):** kendi PC'ne ve telefonuna bir kez Tailscale
  kur, sonra `http://100.102.156.33:18091` linkini aç. Bilgisayarın bu cihazlardan biri olarak zaten
  izinli. Yeni bir cihaza izin vermek için:
  ```bash
  ssh miraz-vps gemini-hub-allow 100.x.y.z "telefon"
  ```
- **SSH tüneliyle (Tailscale'siz):**
  ```bash
  ssh -N -L 18091:127.0.0.1:18091 miraz-vps
  ```
  Sonra `http://127.0.0.1:18091`.

Giriş: oturum tarayıcıda 30 gün açık kalır. İlk girişte yönetici anahtarı sorulur; anahtarı bir kez
alıp parola yöneticine kaydedebilirsin:
```bash
ssh miraz-vps cat /etc/gemini-hub/admin-token
```
Ya da 10 dakika geçerli tek kullanımlık giriş bağlantısı al:
```bash
ssh miraz-vps gemini-hub-login
```

**Anahtar üretme:** **Uygulamalar** → ad → "internetten (genel link)" işaretli kalsın (iç adres
kullanacaksan kaynak adresi yaz) → isteğe bağlı model listesi ve günlük sınır → **Anahtar üret**.
Anahtar ve link yalnız o an gösterilir; ikisini birlikte kaydet.

## 3. Model adları

`GET /v1/models` (anahtarla) bugün kullanılabilen modelleri verir. Bugünkü hesaplarla:

| Model adı | Nerede | Not |
|---|---|---|
| `gemini-3.8-flash` | Pro hesap(lar) | günlük işler için en iyi denge |
| `gemini-3.1-pro` | Pro hesap(lar) | ileri akıl yürütme, uzun düşünebilir |
| `gemini-4-argon` | Pro hesap(lar) | en zor işler |
| `gemini-3.5-flash-lite` | Pro hesap(lar) | en hızlı |
| `gemini-auto` | ücretsiz hesap(lar) | modeli Google seçer |

Hub istenen modeli kullanır ya da hata verir; başka modelle sessizce cevap vermez. Cevabın hangi
model ve hesaptan geldiği `x-hub-model-label` ve `x-hub-account` başlıklarında yazar.

## 4. n8n'de kullanma

### Yol A — OpenAI kimlik bilgisi (en kolayı; AI Agent / "OpenAI Chat Model" / "Message a model")

1. **Credentials → New → OpenAI**
   - API Key: hub anahtarın (`ghk_…`)
   - Base URL: anahtarla birlikte verilen link (`https://hub.152-53-39-199.sslip.io/p/<gizli-yol>/v1`)
     ya da iç adres `http://host.docker.internal:18090/v1`
2. OpenAI düğümlerinde bu kimliği seç; **Model** alanına listeden ya da elle `gemini-3.8-flash`
   (veya `gemini-3.1-pro`, `gemini-4-argon`) yaz.
3. Düğüm ayarlarında **Timeout**'u yükselt (örn. 900000 ms). Pro modeller dakikalarca düşünebilir;
   hub 4 dakikadan sonra bağlantıyı canlı tutar.
4. **Retry On Fail'i kapat** ya da yalnız 429'da, `Retry-After` kadar bekleyerek kullan.
   Hub aynı isteği zaten iki kez göndermez.

### Yol B — HTTP Request düğümü (Gemini biçimi, JSON şeması ile)

- Method `POST`, URL: `<Gemini linki>/v1beta/models/gemini-3.8-flash:generateContent`
  (genel link: `https://hub.152-53-39-199.sslip.io/p/<gizli-yol>/v1beta/...`, iç adres: `http://host.docker.internal:18090/v1beta/...`)
- Header: `x-goog-api-key: ghk_…` (Header Auth kimliği olarak kaydet)
- Body (JSON):
```json
{
  "systemInstruction": { "parts": [{ "text": "Sen bir haber editörüsün." }] },
  "contents": [{ "role": "user", "parts": [{ "text": "{{ $json.metin }}" }] }],
  "generationConfig": {
    "responseMimeType": "application/json",
    "responseSchema": {
      "type": "OBJECT",
      "properties": { "baslik": { "type": "STRING" }, "ozet": { "type": "STRING" } },
      "required": ["baslik", "ozet"]
    }
  }
}
```
- Cevap: `{{ $json.candidates[0].content.parts[0].text }}` (JSON metni; Code düğümünde `JSON.parse`).
- Options → Timeout: 900000. Options → Response → "Never Error" açarsan 429/503'ü kendin dallandırırsın.

### n8n'de "hepsi dolu" ve "sıra dolu" durumları

Sırada en fazla **4 istek** bekler. Fazlası kuyruğa girmez; hemen `429 queue_full` döner ve
mesajda tahmini bekleme süresi yazar (`Retry-After` başlığında saniye olarak).


Hub, bu modeli sunan bütün hesaplar o an doluysa (Gemini kotası %95) ya da Google tarafından
duraklatılmışsa **bekletmez**, hemen `429` döner:
```json
{"error":{"code":"capacity","message":"every account that offers 3.1 Pro is full or paused by Google [Hesap 1: usage_5h 5h 97%, weekly 40% until 2026-10-18T19:17:00Z]; next free at 2026-10-18T19:17:00Z"}}
```
`Retry-After` başlığı saniye cinsinden ne kadar bekleneceğini söyler. n8n'de IF düğümüyle
`statusCode == 429` ise başka modele (örn. `gemini-3.8-flash`) ya da resmî Gemini API'sine dallandır.

Önceden bakmak için: `GET <OpenAI linki>/hub/accounts` (yani `.../p/<gizli-yol>/v1/hub/accounts`, aynı anahtarla) →
her hesabın `five_hour_pct`, `weekly_pct`, sıfırlanma saatleri, `available` ve sebepleri.

## 5. Kendi uygulamalarında

### Python — OpenAI SDK
```python
from openai import OpenAI
client = OpenAI(base_url="https://hub.152-53-39-199.sslip.io/p/<gizli-yol>/v1", api_key="ghk_...", timeout=None)
r = client.chat.completions.create(
    model="gemini-3.8-flash",
    messages=[{"role": "system", "content": "Kısa cevap ver."},
              {"role": "user", "content": "Bakü'nün nüfusu kaç?"}],
)
print(r.choices[0].message.content)
```
Akış (stream) için `stream=True`; görsel için `{"type": "image_url", "image_url": {"url": "data:image/png;base64,..."}}`.

### Python — Google'ın kendi SDK'sı (google-genai)
```python
from google import genai
from google.genai import types
client = genai.Client(api_key="ghk_...", http_options=types.HttpOptions(base_url="https://hub.152-53-39-199.sslip.io/p/<gizli-yol>", timeout=None))
r = client.models.generate_content(model="gemini-3.1-pro", contents="Bir şiir yaz.")
print(r.text)
```

### Node.js
```js
const res = await fetch('https://hub.152-53-39-199.sslip.io/p/<gizli-yol>/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ghk_...' },
  body: JSON.stringify({ model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'Merhaba' }] }),
});
const data = await res.json();
if (res.status === 429) console.log('dolu; şu kadar saniye sonra dene:', res.headers.get('retry-after'));
else console.log(data.choices[0].message.content);
```
(Node 18+ `fetch` başlıkları 300 sn'de keser; hub 240 sn'de başlıkları önden gönderdiği için sorun olmaz.)

### curl
```bash
curl https://hub.152-53-39-199.sslip.io/p/<gizli-yol>/v1/chat/completions -H "Authorization: Bearer ghk_..." -H "content-type: application/json" -d '{"model":"gemini-3.8-flash","messages":[{"role":"user","content":"Merhaba"}]}'
```

## 6. Bilmen gerekenler

- Her istek Gemini'de **yeni ve geçici bir sohbettir**; hub önceki istekleri hatırlamaz. Sohbet
  geçmişi gerekiyorsa `messages` içinde gönder (system + önceki user/assistant).
- Dosya/görsel yalnız base64 (`data:` URL ya da `inlineData`); hub uzak URL indirmez.
- Aynı istek 10 dakika içinde tekrar gelirse Google'a ikinci kez gitmez, ilk cevap döner
  (`x-hub-deduplicated: 1`). Bilerek yeni cevap istiyorsan metni biraz değiştir.
- Süre sınırı ve çıktı kesmesi yok; istemcide de zaman aşımını kapat ya da yükselt.

### Hata kodları

| Kod | Anlamı | Ne yapmalı |
|---|---|---|
| 401 | anahtar yanlış ya da bu makineden geçersiz | anahtarı / kaynak adresi kontrol et |
| 404 `model_not_found` | hiçbir hesap bu modeli sunmuyor | `GET /v1/models` |
| 429 `capacity` | tüm uygun hesaplar dolu/duraklatılmış | `Retry-After` kadar bekle ya da başka modele geç |
| 429 `queue_full` | sırada zaten 4 istek bekliyor; mesajda tahmini bekleme süresi | `Retry-After` kadar sonra tekrar dene |
| 429 `account_limit` / `account_throttled` | Google cevap sırasında limit/429 verdi | tekrar gönderme; sonra dene |
| 502 `model_changed` | Gemini başka modelle cevap verdi, cevap atıldı | tekrar dene |
| 503 `no_account` | hesaplar giriş/onay bekliyor | yönetim sayfasına bak |
| 503 `upstream_ui_changed` | Gemini sitesi değişti | hub kendini onarmaya çalışır, bildirim gelir |
