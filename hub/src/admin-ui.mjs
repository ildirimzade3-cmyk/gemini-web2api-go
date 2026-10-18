// The admin page (Turkish) and the sign-in viewer. Plain HTML + fetch; no build step.

const STYLE = `
:root{--bg:#f6f7f9;--card:#fff;--ink:#16181d;--mute:#5d6470;--line:#e2e5ea;--ok:#127a3a;--warn:#a15c00;--bad:#b3261e;--acc:#2456c7}
@media (prefers-color-scheme:dark){:root{--bg:#121417;--card:#1b1e23;--ink:#e8eaee;--mute:#9aa1ac;--line:#2c3038;--ok:#4cc27a;--warn:#e0a24a;--bad:#f07167;--acc:#7aa2ff}}
*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,Segoe UI,Roboto,sans-serif}
header{display:flex;gap:12px;align-items:center;padding:14px 20px;border-bottom:1px solid var(--line);background:var(--card);position:sticky;top:0}
header h1{font-size:16px;margin:0}main{max-width:1200px;margin:0 auto;padding:16px 20px;display:grid;gap:16px}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
h2{font-size:14px;margin:0 0 10px;text-transform:uppercase;letter-spacing:.04em;color:var(--mute)}
table{width:100%;border-collapse:collapse}td,th{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{color:var(--mute);font-weight:600;font-size:12px}
.pill{display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px;border:1px solid var(--line)}
.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}.mute{color:var(--mute)}
button{font:inherit;padding:5px 10px;border-radius:7px;border:1px solid var(--line);background:var(--card);color:var(--ink);cursor:pointer}
button.primary{background:var(--acc);border-color:var(--acc);color:#fff}button:disabled{opacity:.5}
input,select{font:inherit;padding:5px 8px;border-radius:7px;border:1px solid var(--line);background:var(--bg);color:var(--ink)}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:12px}
.acct{border:1px solid var(--line);border-radius:9px;padding:12px}.acct h3{margin:0 0 4px;font-size:15px}
code,.mono{font-family:ui-monospace,Consolas,monospace;font-size:12px}.key{padding:10px;border:1px dashed var(--warn);border-radius:8px;word-break:break-all}
small{color:var(--mute)}
`;

export const ADMIN_HTML = `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gemini Hub</title><style>${STYLE}</style></head><body>
<header><h1>Gemini Hub</h1><span id="summary" class="mute"></span><span style="flex:1"></span><button id="logout" hidden>Çıkış</button></header>
<main>
<section id="login"><h2>Giriş</h2><div class="row"><input id="token" type="password" placeholder="Yönetici anahtarı" size="50" autocomplete="off"><button class="primary" id="go">Gir</button></div><p id="loginmsg" class="bad"></p>
<p><small>Bu sayfa yalnız VPS'in loopback adresinde açılır: <code>ssh -L 18091:127.0.0.1:18091 miraz-vps</code>. Tek kullanımlık giriş bağlantısı: <code>ssh miraz-vps gemini-hub-login</code></small></p></section>
<div id="app" hidden style="display:grid;gap:16px">
<section><h2>Hesaplar</h2><div class="row" style="margin-bottom:10px"><input id="newlabel" placeholder="Hesap adı (ör. İş hesabı)"><button class="primary" id="add">Hesap ekle</button>
<small>Ekledikten sonra “Giriş yap”: hub'ın kendi tarayıcısı açılır, Google'a bir kez girersiniz.</small></div><div id="accounts" class="grid"></div></section>
<section><h2>Kapasite (son 24 saat)</h2><div id="capacity"></div></section>
<section><h2>Uygulamalar</h2><div id="apps"></div>
<div class="row" style="margin-top:10px"><input id="appname" placeholder="ad (ör. miraz-n8n)"><input id="appcidrs" placeholder="kaynak adresler: 172.18.0.0/16,100.119.199.122" size="40"><input id="appmodels" placeholder="modeller (* = hepsi)" value="*"><input id="appcap" placeholder="günlük üst sınır (boş = yok)" size="18"><button class="primary" id="appadd">Anahtar üret</button></div>
<div id="newkey"></div></section>
<section><h2>Kuyruk</h2><div id="queue" class="mute">boş</div></section>
<section><h2>Olaylar</h2><div class="row" style="margin-bottom:8px"><button id="testalert">Test bildirimi</button><span id="alertinfo" class="mute"></span></div><div id="events"></div></section>
</div></main>
<script>
let csrf='';const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const t=ms=>ms?new Date(ms).toLocaleString('tr-TR'):'—';
const STATE={new:['yeni — giriş bekliyor','warn'],ready:['hazır','ok'],paused:['duraklatıldı','mute'],attention:['sizi bekliyor','bad']};
const BLOCK={cooldown:'Google yavaşlattı (429) — soğuyor',usage_5h:'5 saatlik Gemini kotası dolu',usage_weekly:'haftalık Gemini kotası dolu',resting:'dinleniyor',limit:'Google limiti',budget:'günlük güvenli pay doldu',hourly:'saatlik sınır',signin:'giriş ekranı açık',new:'giriş yok',paused:'duraklatıldı',attention:'sizi bekliyor',no_model:'model yok',model_disabled:'model kapalı'};
async function api(path,body){const r=await fetch(path,{method:body?'POST':'GET',headers:{'content-type':'application/json','x-csrf':csrf},body:body?JSON.stringify(body):undefined});
 const j=await r.json().catch(()=>({}));if(r.status===401){show(false);throw new Error('login')}if(!r.ok)throw new Error(j.error||r.status);return j}
function show(on){$('#login').hidden=on;$('#app').hidden=!on;$('#logout').hidden=!on}
$('#go').onclick=async()=>{const r=await fetch('/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:$('#token').value})});
 const j=await r.json();if(!r.ok)return alert(j.error);csrf=j.csrf;$('#token').value='';show(true);refresh()};
$('#logout').onclick=async()=>{await api('/logout',{});show(false)};
$('#add').onclick=async()=>{await api('/api/accounts',{label:$('#newlabel').value});$('#newlabel').value='';refresh()};
$('#appadd').onclick=async()=>{try{const j=await api('/api/apps',{name:$('#appname').value,cidrs:$('#appcidrs').value,models:$('#appmodels').value,daily_cap:$('#appcap').value});
 $('#newkey').innerHTML='<p><b>'+esc(j.name)+'</b> anahtarı (yalnız şimdi gösterilir):</p><div class="key mono">'+esc(j.key)+'</div><small>'+esc(j.note)+'</small>';refresh()}catch(e){alert(e.message)}};
$('#testalert').onclick=async()=>{const j=await api('/api/test-alert',{});alert(j.topic_set?'Gönderildi':'Bildirim konusu (HUB_NTFY_TOPIC) ayarlı değil; olay kaydına yazıldı.')};
async function act(id,a,extra){try{if(a==='remove'){if(!confirm(id+' hesabı ve tarayıcı profili silinsin mi?'))return;extra={confirm:id}}
 const j=await api('/api/accounts/'+id+'/'+a,extra||{});if(a==='signin'){sessionStorage.setItem('vnc:'+id,j.password);window.open(j.viewer,'_blank')}refresh()}catch(e){alert(e.message)}}
async function appAct(id,a){if(a==='revoke'&&!confirm('Anahtar iptal edilsin mi?'))return;await api('/api/apps/'+id+'/'+a,{});refresh()}
function usageLine(a){const ms=(a.usage&&a.usage.meters)||[];if(!ms.length)return '<div class=mute><small>Gemini kullanımı henüz okunmadı</small></div>';
 const nm={'5h':'5 saatlik','weekly':'haftalık','daily':'günlük','monthly':'aylık'};
 return '<div>Gemini kullanımı: '+ms.map(m=>'<b class="'+(m.used_pct>=80?'bad':m.used_pct>=60?'warn':'ok')+'">'+esc(nm[m.name]||m.name)+' %'+m.used_pct+'</b>'+(m.resets_at?' <small>(sıfırlanma '+t(m.resets_at)+')</small>':'')).join(' · ')+' <small class=mute>okundu '+t(a.usage.read_at)+'</small></div>'}
function mins(m){const h=String(Math.floor(m/60)).padStart(2,'0'),mm=String(m%60).padStart(2,'0');return h+':'+mm}
function render(s){csrf=s.csrf;
 const ready=s.accounts.filter(a=>a.state==='ready').length;$('#summary').textContent=s.accounts.length+' hesap, '+ready+' hazır · '+s.apps.filter(a=>!a.revoked_at).length+' uygulama';
 $('#accounts').innerHTML=s.accounts.map(a=>{const st=STATE[a.state]||[a.state,''];
  const caps=s.capacity.flatMap(c=>c.accounts.filter(x=>x.account===a.id).map(x=>'<tr><td>'+esc(c.label)+'</td><td>'+x.used+' / '+x.budget+' <small>'+esc(x.budget_source)+'</small></td><td>'+(x.blockers.map(b=>BLOCK[b]||b).join(', ')||'<span class=ok>uygun</span>')+(x.exhausted_until?' <small>('+t(x.exhausted_until)+')</small>':'')+'</td></tr>')).join('');
  return '<div class="acct"><h3>'+esc(a.label)+' <span class="pill '+st[1]+'">'+st[0]+'</span></h3>'+
  '<div class="mute">'+esc(a.identity||'—')+' · plan: '+esc(a.plan)+(a.plan_label?' ('+esc(a.plan_label)+')':'')+' · '+(a.busy?'çalışıyor':a.warm?'tarayıcı açık':'tarayıcı kapalı')+'</div>'+
  (a.state_reason?'<div class="'+(a.state==='attention'?'bad':'mute')+'">'+esc(a.state_reason)+'</div>':'')+
  usageLine(a)+
  '<div><small>Günlük dinlenme (UTC): '+mins(a.sleep_start_min)+' + '+Math.round(a.sleep_len_min/60)+' sa · son iş: '+t(a.last_job_at)+'</small></div>'+
  (caps?'<table style="margin-top:6px"><tr><th>model</th><th>24 sa kullanım / güvenli pay</th><th>durum</th></tr>'+caps+'</table>':'')+
  '<div class="row" style="margin-top:8px">'+(a.signin?'<button class="primary" onclick="act(\\''+a.id+'\\',\\'done\\')">Girişi bitirdim</button><button onclick="act(\\''+a.id+'\\',\\'signin\\')">Ekranı aç</button>':'<button class="primary" onclick="act(\\''+a.id+'\\',\\'signin\\')">Giriş yap</button>')+
  '<button onclick="act(\\''+a.id+'\\',\\'refresh\\')">Yenile</button><button onclick="act(\\''+a.id+'\\',\\'usage\\')">Kullanımı oku</button>'+(a.state==='paused'?'<button onclick="act(\\''+a.id+'\\',\\'resume\\')">Devam</button>':'<button onclick="act(\\''+a.id+'\\',\\'pause\\')">Duraklat</button>')+
  '<button onclick="act(\\''+a.id+'\\',\\'remove\\')">Sil</button></div></div>'}).join('')||'<p class="mute">Henüz hesap yok.</p>';
 $('#capacity').innerHTML=s.capacity.length?'<table><tr><th>model</th><th>güvenli günlük kapasite</th><th>şu an kalan</th><th>24 sa istek</th><th>reddedilen</th><th></th></tr>'+s.capacity.map(c=>'<tr><td>'+esc(c.label)+' <small class=mono>'+esc(c.model)+'</small></td><td>'+c.safe_per_day+'</td><td>'+c.remaining_now+'</td><td>'+c.requests_24h+'</td><td>'+c.rejected_24h+'</td><td>'+(c.overloaded?'<span class=bad>yük güvenli kapasitenin üstünde — hesap ekleyin ya da yükü azaltın</span>':'<span class=ok>güvenli</span>')+'</td></tr>').join('')+'</table>':'<p class="mute">Giriş yapılmış hesap yok.</p>';
 $('#apps').innerHTML=s.apps.length?'<table><tr><th>ad</th><th>anahtar</th><th>kaynak adresler</th><th>modeller</th><th>günlük sınır</th><th></th></tr>'+s.apps.map(a=>'<tr class="'+(a.revoked_at?'mute':'')+'"><td>'+esc(a.name)+'</td><td class=mono>'+esc(a.key_hint)+'</td><td class=mono>'+esc(a.cidrs)+'</td><td class=mono>'+esc(a.models)+'</td><td>'+(a.daily_cap??'—')+'</td><td>'+(a.revoked_at?'iptal':'<button onclick="appAct(\\''+a.id+'\\',\\'revoke\\')">İptal et</button>')+'</td></tr>').join('')+'</table>':'<p class="mute">Henüz uygulama yok.</p>';
 $('#queue').innerHTML=s.queue.length?s.queue.map(q=>esc(q.app)+' → '+esc(q.model)+' ('+Math.round(q.waiting_ms/1000)+' sn)').join('<br>'):'boş';
 $('#alertinfo').textContent=s.alerts.ntfy_topic_set?'Telefon bildirimi açık (ntfy).':'Telefon bildirimi kapalı (HUB_NTFY_TOPIC).';
 $('#events').innerHTML='<table>'+s.events.slice(0,80).map(e=>'<tr><td class=mono>'+t(e.ts)+'</td><td class="'+(e.level==='alert'?'bad':e.level==='warn'?'warn':'mute')+'">'+esc(e.kind)+'</td><td>'+esc(e.account_id||'')+'</td><td class=mono>'+esc(JSON.stringify(e.detail)).slice(0,300)+'</td></tr>').join('')+'</table>'}
async function refresh(){try{render(await api('/api/state'))}catch(e){}}
setInterval(()=>{if(!$('#app').hidden)refresh()},5000);
// A single-use link (#otc=...) logs in; it also works when opened in a tab that already shows this page.
function useLink(){const otc=new URLSearchParams(location.hash.slice(1)).get('otc');if(!otc)return false;history.replaceState(null,'','/');
 fetch('/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({otc})}).then(async r=>{const j=await r.json();if(!r.ok){$('#loginmsg').textContent='Giriş bağlantısı geçersiz ya da kullanılmış: '+j.error;return}csrf=j.csrf;show(true);refresh()});return true}
window.addEventListener('hashchange',useLink);
if(!useLink())fetch('/api/state').then(r=>r.ok?r.json():null).then(s=>{if(s){show(true);render(s)}else show(false)});
</script></body></html>`;

export const VIEWER_HTML = `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>Gemini Hub — giriş</title><style>${STYLE}
#screen{width:100%;height:calc(100vh - 56px);background:#000}</style></head><body>
<header><h1>Hesaba giriş</h1><span class="mute">Aşağıdaki ekran hub'ın kendi tarayıcısı. Gemini'de sağ üstteki <b>Sign in</b> ile Google hesabınıza girin; hub girişi kendisi algılayıp tamamlar.</span><span style="flex:1"></span><span id="st" class="mute">bağlanıyor…</span><span id="seen" class="warn">giriş henüz görülmedi</span><button class="primary" id="done" disabled>Girişi bitirdim</button><a href="#" id="force" class="mute" style="font-size:12px">yine de bitir</a></header>
<div id="screen"></div>
<script type="module">
import RFB from '/novnc/core/rfb.js';
const id=location.pathname.split('/').pop();const pw=sessionStorage.getItem('vnc:'+id)||'';
const rfb=new RFB(document.getElementById('screen'),'ws://'+location.host+'/vnc/'+id,{credentials:{password:pw}});
rfb.scaleViewport=true;rfb.resizeSession=false;
rfb.addEventListener('connect',()=>document.getElementById('st').textContent='bağlı');
rfb.addEventListener('disconnect',()=>document.getElementById('st').textContent='bağlantı kapandı');
const poll=async()=>{try{const s=await fetch('/api/accounts/'+id+'/signin-status').then(r=>r.json());
 const e=document.getElementById('seen');if(!e)return;
 if(!s.open&&s.state==='ready'){sessionStorage.removeItem('vnc:'+id);document.body.innerHTML='<main><section><h2>Hazır</h2><p>Giriş otomatik algılandı, hesap kullanıma alındı: '+(s.identity||'')+' · '+s.models+' model. Bu pencereyi kapatabilirsiniz.</p></section></main>';return}
 if(s.signed_in){e.textContent='giriş algılandı ✓ — birkaç saniye içinde otomatik tamamlanacak';e.className='ok';document.getElementById('done').disabled=false}}catch{}};
setInterval(poll,3000);poll();
document.getElementById('force').onclick=(ev)=>{ev.preventDefault();if(confirm('Hub girişi henüz görmedi. Yine de bitirilsin mi?'))finish()};
document.getElementById('done').onclick=()=>finish();
async function finish(){
 const st=await fetch('/api/state').then(r=>r.json());
 const r=await fetch('/api/accounts/'+id+'/done',{method:'POST',headers:{'content-type':'application/json','x-csrf':st.csrf},body:'{}'});
 const j=await r.json();sessionStorage.removeItem('vnc:'+id);
 document.body.innerHTML='<main><section><h2>'+(j.state==='ready'?'Hazır':'Giriş görülmedi')+'</h2><p>'+(j.state==='ready'?'Hesap kullanıma alındı: '+(j.identity||'')+' · '+(j.models||[]).length+' model.':'Hesap henüz giriş yapmış görünmüyor. Yönetim sayfasından tekrar “Giriş yap”.')+'</p></section></main>';
}
</script></body></html>`;
