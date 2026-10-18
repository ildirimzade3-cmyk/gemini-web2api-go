# Gemini Hub — kullanım rehberi (n8n ve kendi uygulamaların)

Hub, Gemini hesaplarını tek adreste toplar ve **resmî OpenAI ya da Gemini API'si gibi**
konuşur. Uygulamanın tek bilmesi gereken: **adres + anahtar + model adı.**

## 1. Bilgisayar gerekmez

Hub **VPS'te 7/24 çalışan bir sunucu servisidir** (yeniden başlatmada kendiliğinden açılır).
Bilgisayarın kapalı olsa da çalışır. Hesap tarayıcıları da, oturumlar da sunucuda durur.

| Uygulama nerede | Adres | Bilgisayar gerekir mi |
|---|---|---|
| **VPS'teki Docker** (n8n dahil) | `http://host.docker.internal:18090` | hayır |
| **VPS'in kendisi** | `http://127.0.0.1:18090` | hayır |
| **Başka bir sunucu / bilgisayar** (kendi uygulamaların, laptop, başka VPS) | `http://100.102.156.33:18090` | hayır, o makinede Tailscale yeterli |

OpenAI uyumlu kullanımda adresin sonuna `/v1` eklenir (`.../v1`); Gemini uyumlu kullanımda adres olduğu gibi.

`100.102.156.33`, **VPS'in** özel (Tailscale) adresidir; senin bilgisayarının değil. Hub genel
internete kapalıdır. Bu adrese yalnız senin Tailscale ağındaki makinelerin ulaşır.

### Yeni bir makineyi (sunucu, laptop) bağlamak: bir kerelik

1. O makineye Tailscale kur ve kendi Tailscale hesabınla giriş yap (ücretsiz): <https://tailscale.com/download>
2. Makinenin Tailscale adresini öğren (`tailscale ip -4`, 100.x.y.z).
3. VPS'te izin ver (API + yönetim sayfası):
   ```bash
   ssh miraz-vps gemini-hub-allow 100.x.y.z "laptop"
   ```
4. O makinede çalışacak uygulamalar için anahtarı bu adresle üret (aşağıda).

Docker içindeki uygulama için compose'a şunu ekle (n8n'de zaten var):
```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

## 2. Yönetim sayfası ve anahtar üretme

- Tailscale'li herhangi bir cihazından: **`http://100.102.156.33:18091`**. Tarayıcı oturumu 30 gün açık kalır.
- İlk girişte yönetici anahtarı sorulur. Anahtarı bir kez alıp parola yöneticine kaydet:
  ```bash
  ssh miraz-vps cat /etc/gemini-hub/admin-token
  ```
  Ya da tek kullanımlık giriş bağlantısı al (10 dk geçerli):
  ```bash
  ssh miraz-vps gemini-hub-login
  ```
  `100.102.156.33` ile başlayan satırı aç.
- **Uygulamalar** → ad + **kaynak adres** + (isteğe bağlı) model listesi ve günlük sınır → **Anahtar üret**.
  Anahtar yalnız o an gösterilir; bir kenara kaydet.

Kaynak adres, anahtarın **hangi makineden** çalışacağıdır. Bu yüzden sızan bir anahtar başka yerde işe yaramaz.

| Uygulama | Kaynak adres |
|---|---|
| n8n (VPS, `newsroom-v2_default` ağı) | `172.19.0.0/16` |
| VPS'teki başka bir Docker ağı | o ağın alt ağı (`docker network inspect <ağ>` → Subnet) |
| Tailscale'li bir makine | o makinenin 100.x adresi (birden fazlaysa virgülle) |

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
   - Base URL: `http://host.docker.internal:18090/v1`
2. OpenAI düğümlerinde bu kimliği seç; **Model** alanına listeden ya da elle `gemini-3.8-flash`
   (veya `gemini-3.1-pro`, `gemini-4-argon`) yaz.
3. Düğüm ayarlarında **Timeout**'u yükselt (örn. 900000 ms). Pro modeller dakikalarca düşünebilir;
   hub 4 dakikadan sonra bağlantıyı canlı tutar.
4. **Retry On Fail'i kapat** ya da yalnız 429'da, `Retry-After` kadar bekleyerek kullan.
   Hub aynı isteği zaten iki kez göndermez.

### Yol B — HTTP Request düğümü (Gemini biçimi, JSON şeması ile)

- Method `POST`, URL: `http://host.docker.internal:18090/v1beta/models/gemini-3.8-flash:generateContent`
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

### n8n'de "hepsi dolu" durumu

Hub, bu modeli sunan bütün hesaplar o an doluysa (Gemini kotası %95) ya da Google tarafından
duraklatılmışsa **bekletmez**, hemen `429` döner:
```json
{"error":{"code":"capacity","message":"every account that offers 3.1 Pro is full or paused by Google [Hesap 1: usage_5h 5h 97%, weekly 40% until 2026-10-18T19:17:00Z]; next free at 2026-10-18T19:17:00Z"}}
```
`Retry-After` başlığı saniye cinsinden ne kadar bekleneceğini söyler. n8n'de IF düğümüyle
`statusCode == 429` ise başka modele (örn. `gemini-3.8-flash`) ya da resmî Gemini API'sine dallandır.

Önceden bakmak için: `GET http://host.docker.internal:18090/v1/hub/accounts` (aynı anahtarla) →
her hesabın `five_hour_pct`, `weekly_pct`, sıfırlanma saatleri, `available` ve sebepleri.

## 5. Kendi uygulamalarında

### Python — OpenAI SDK
```python
from openai import OpenAI
# VPS içindeki uygulama: http://127.0.0.1:18090/v1 ya da Docker'da http://host.docker.internal:18090/v1
client = OpenAI(base_url="http://100.102.156.33:18090/v1", api_key="ghk_...", timeout=None)
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
client = genai.Client(api_key="ghk_...", http_options=types.HttpOptions(base_url="http://100.102.156.33:18090", timeout=None))
r = client.models.generate_content(model="gemini-3.1-pro", contents="Bir şiir yaz.")
print(r.text)
```

### Node.js
```js
const res = await fetch('http://100.102.156.33:18090/v1/chat/completions', {
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
curl http://100.102.156.33:18090/v1/chat/completions -H "Authorization: Bearer ghk_..." -H "content-type: application/json" -d '{"model":"gemini-3.8-flash","messages":[{"role":"user","content":"Merhaba"}]}'
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
| 429 `account_limit` / `account_throttled` | Google cevap sırasında limit/429 verdi | tekrar gönderme; sonra dene |
| 502 `model_changed` | Gemini başka modelle cevap verdi, cevap atıldı | tekrar dene |
| 503 `no_account` | hesaplar giriş/onay bekliyor | yönetim sayfasına bak |
| 503 `upstream_ui_changed` | Gemini sitesi değişti | hub kendini onarmaya çalışır, bildirim gelir |
