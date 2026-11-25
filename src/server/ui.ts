import { BCU_PAGE } from "../rates/bcu.ts";
import { MARKET_CREDIT } from "../rates/market.ts";

/**
 * The two pages a server answers besides the API, with no build step and no
 * framework: HTML with a little script that reads the API it sits next to.
 *
 *   /        the public page: the kept pairs with both rates, a converter for any
 *            two currencies, the credits the sources ask for, and the API.
 *   /admin   the panel: add and retire currencies and pairs, order and star the
 *            pairs, read now, load the bank's history. It asks the admin API
 *            first with nothing: where `authorize` lets the request in (a session
 *            cookie, an access proxy) it opens straight away; else it asks for the
 *            token once and keeps it for the tab.
 *
 * Light and dark follow the system. English or Spanish: the link's `?lang=`, else
 * the server's `lang`, else the browser's.
 */

export interface PageOptions {
  /** The name at the top and in the tab. */
  title: string;
  /** A line under it. */
  tagline?: string;
  /** Extra HTML at the foot of the public page (a link home, a credit). */
  footer?: string;
  /** The pages' language when the link doesn't say (`?lang=`); without it, the browser's. */
  lang?: Lang;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const TEXT = {
  en: {
    pairs: "Rates", official: "Official", market: "Market", buy: "Buy", sell: "Sell", convert: "Converter", amount: "Amount",
    from: "From", to: "To", day: "Day", api: "API", none: "No readings yet.", sourceOfficial: "Official rates: Banco Central del Uruguay",
    swap: "Swap", rateLine: "1 {from} = {rate} {to}", noRate: "No rate for this pair from this source.",
    admin: "Panel", token: "Admin token", enter: "Enter", currencies: "Currencies", addCurrency: "Add a currency", add: "Add",
    pairsAdmin: "Pairs", addPair: "Add a pair", active: "Active", favourite: "Starred", reverse: "Reverse", up: "Up", down: "Down",
    symbol: "Mark", read: "Read now", backfill: "Load the BCU's history from", load: "Load", runs: "Last readings", ok: "OK", failed: "Failed",
    search: "Search by code, name or country", saved: "Saved", wrongToken: "That token is not right.", quotedByBcu: "BCU",
  },
  es: {
    pairs: "Cotizaciones", official: "Oficial", market: "Mercado", buy: "Compra", sell: "Venta", convert: "Conversor", amount: "Monto",
    from: "De", to: "A", day: "Día", api: "API", none: "Todavía no hay lecturas.", sourceOfficial: "Cotizaciones oficiales: Banco Central del Uruguay",
    swap: "Invertir", rateLine: "1 {from} = {rate} {to}", noRate: "No hay cotización de este par en esta fuente.",
    admin: "Panel", token: "Token de administración", enter: "Entrar", currencies: "Monedas", addCurrency: "Agregar una moneda", add: "Agregar",
    pairsAdmin: "Pares", addPair: "Agregar un par", active: "Activa", favourite: "Destacado", reverse: "Invertir", up: "Subir", down: "Bajar",
    symbol: "Símbolo", read: "Leer ahora", backfill: "Cargar el historial del BCU desde", load: "Cargar", runs: "Últimas lecturas", ok: "Bien", failed: "Con error",
    search: "Buscar por código, nombre o país", saved: "Guardado", wrongToken: "Ese token no es correcto.", quotedByBcu: "BCU",
  },
} as const;
export type Lang = keyof typeof TEXT;

/** The link's `?lang=`, else the server's own, else the browser's. */
export function pickLang(req: Request, fallback?: Lang): Lang {
  const asked = new URL(req.url).searchParams.get("lang") ?? fallback ?? req.headers.get("accept-language") ?? "";
  return asked.toLowerCase().startsWith("es") ? "es" : "en";
}

const STYLE = `
:root{--bg:#fff;--fg:#111;--muted:#6b6b6b;--line:#e7e7e7;--card:#f7f7f7;--accent:#111;--on-accent:#fff;--bad:#c62828;--good:#1a7f37;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#0c0c0c;--fg:#f2f2f2;--muted:#9a9a9a;--line:#262626;--card:#151515;--accent:#f2f2f2;--on-accent:#111;--bad:#ff6b6b;--good:#4ac26b}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:880px;margin:0 auto;padding:40px 16px 72px}h1{font-size:30px;line-height:1.2;margin:0 0 6px}h2{font-size:19px;margin:40px 0 12px}
p{margin:0 0 8px}.muted{color:var(--muted)}.small{font-size:14px}a{color:inherit}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px}
.pair h3{margin:0 0 10px;font-size:16px}.figs{display:flex;gap:18px;flex-wrap:wrap}.fig span{display:block;font-size:13px;color:var(--muted)}
.fig b{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums}.star{color:#e0a100}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}th,td{padding:10px 8px;text-align:left;border-bottom:1px solid var(--line);vertical-align:middle}
th{font-weight:500;color:var(--muted);font-size:14px}tr:last-child td{border-bottom:0}.scroll{overflow-x:auto}
label{display:block;font-size:14px;color:var(--muted);margin-bottom:4px}
input,select,button{font:inherit;color:inherit}input,select{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg)}
button{padding:9px 16px;border-radius:999px;border:1px solid var(--line);background:var(--bg);cursor:pointer;white-space:nowrap}
button.primary{background:var(--accent);color:var(--on-accent);border-color:var(--accent)}button:disabled{opacity:.5;cursor:default}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}.row>div{flex:1 1 160px}
.result{font-size:28px;font-weight:600;margin:14px 0 2px;font-variant-numeric:tabular-nums}
.tabs{display:inline-flex;border:1px solid var(--line);border-radius:999px;padding:3px;gap:2px}.tabs button{border:0;padding:6px 14px}
.tabs button[aria-pressed=true]{background:var(--accent);color:var(--on-accent)}
code{font-size:14px;word-break:break-word}.bad{color:var(--bad)}.good{color:var(--good)}dl{margin:0}dt{margin-top:14px}dd{margin:2px 0 0;color:var(--muted)}
.notice{margin:12px 0;padding:10px 14px;border-radius:12px;background:var(--card);border:1px solid var(--line)}
`;

/** A rate written with four digits that mean something (`ratePlaces` in `cambista/money`), for the browser. */
const RATE_JS = `
function places(v){var s=Math.abs(v);if(!isFinite(s)||s===0)return 2;if(s>=1){var w=Math.floor(Math.log10(s))+1;var p=Math.max(4-w,0);return w>=4?p:Math.max(p,2)}return Math.min(-Math.floor(Math.log10(s))+2,8)}
function fmtRate(v,lang){var p=places(v);return new Intl.NumberFormat(lang,{minimumFractionDigits:p,maximumFractionDigits:p}).format(v)}
function fmtDay(d,lang){return new Intl.DateTimeFormat(lang,{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}).format(new Date(d+'T12:00:00Z'))}
function esc(s){return String(s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
`;

function shell(lang: Lang, title: string, body: string, script: string): string {
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main><script>${RATE_JS}${script}</script></body></html>`;
}

export function publicPage(lang: Lang, o: PageOptions): string {
  const t = TEXT[lang];
  const body = `
<h1>${esc(o.title)}</h1>${o.tagline ? `<p class="muted">${esc(o.tagline)}</p>` : ""}
<h2>${t.pairs}</h2><div id="pairs" class="grid"><p class="muted">…</p></div>
<h2>${t.convert}</h2>
<div class="card">
  <div class="row">
    <div><label for="amount">${t.amount}</label><input id="amount" type="number" inputmode="decimal" value="100" min="0" step="any"></div>
    <div><label for="from">${t.from}</label><select id="from"></select></div>
    <div style="flex:0 0 auto"><button id="swap" type="button" aria-label="${t.swap}">⇄</button></div>
    <div><label for="to">${t.to}</label><select id="to"></select></div>
  </div>
  <div style="margin-top:14px" class="tabs" role="group"><button type="button" data-src="official" aria-pressed="true">${t.official}</button><button type="button" data-src="market" aria-pressed="false">${t.market}</button></div>
  <div id="result" class="result" aria-live="polite"></div><p id="rateline" class="muted small"></p>
</div>
<p class="muted small" style="margin-top:16px"><a href="${BCU_PAGE}">${t.sourceOfficial}</a> · <a href="${MARKET_CREDIT.href}">${MARKET_CREDIT.label}</a></p>
<h2>${t.api}</h2>
<dl>
<dt><code><a href="/v1/pairs">/v1/pairs</a></code></dt><dd>${lang === "es" ? "Los pares con la cotización oficial (compra y venta) y la de mercado. <code>?date=AAAA-MM-DD</code> para otro día." : "The pairs with the official rate (buy and sell) and the market's. <code>?date=YYYY-MM-DD</code> for another day."}</dd>
<dt><code><a href="/v1/pairs/USD-UYU/history">/v1/pairs/USD-UYU/history</a></code></dt><dd>${lang === "es" ? "Un par día por día; <code>?from=&amp;to=&amp;source=official|market</code>." : "One pair day by day; <code>?from=&amp;to=&amp;source=official|market</code>."}</dd>
<dt><code><a href="/v1/convert?amount=100&amp;from=USD&amp;to=UYU&amp;source=official">/v1/convert?amount=100&amp;from=USD&amp;to=UYU</a></code></dt><dd>${lang === "es" ? "Un monto en otra moneda; <code>source=official|market</code>, <code>side=buy|sell|mid</code>." : "An amount in another currency; <code>source=official|market</code>, <code>side=buy|sell|mid</code>."}</dd>
<dt><code><a href="/v1/official">/v1/official</a></code> · <code><a href="/v1/market">/v1/market</a></code></dt><dd>${lang === "es" ? "Lo que dijo cada fuente: el BCU en pesos por moneda, el mercado en monedas por dólar." : "What each source said: the BCU in pesos per currency, the market in currencies per dollar."}</dd>
<dt><code><a href="/v1/currencies">/v1/currencies</a></code> · <code><a href="/v1/status">/v1/status</a></code></dt><dd>${lang === "es" ? "Las monedas, y las últimas lecturas." : "The currencies, and the last readings."}</dd>
</dl>
${o.footer ?? ""}`;
  const script = `
var LANG=${JSON.stringify(lang)},T=${JSON.stringify(t)},src='official',O=null,M=null,C=[];
function cross(b,q){if(src==='market'){if(!M)return null;var f=M.perUsd[b],t=M.perUsd[q];return f>0&&t>0?{rate:t/f,day:M.day}:null}
 if(!O)return null;var d=O.published[b+'/'+q];if(d)return{rate:d.sell,day:O.day};var a=O.perLocal[b],c=O.perLocal[q];if(!a||!c)return null;return{rate:a.sell/c.buy,day:O.day}}
function fill(){var f=document.getElementById('from'),t=document.getElementById('to');var list=src==='market'&&M?Object.keys(M.perUsd).sort():C.map(function(c){return c.iso});
 var names={};C.forEach(function(c){names[c.iso]=c.name});var keep=[f.value||'USD',t.value||'UYU'];
 [f,t].forEach(function(s,i){s.innerHTML=list.map(function(iso){return'<option value="'+iso+'">'+iso+(names[iso]?' · '+esc(names[iso]):'')+'</option>'}).join('');if(list.indexOf(keep[i])>=0)s.value=keep[i]});calc()}
function calc(){var a=Number(document.getElementById('amount').value),b=document.getElementById('from').value,q=document.getElementById('to').value,r=b===q?{rate:1,day:''}:cross(b,q),out=document.getElementById('result'),line=document.getElementById('rateline');
 if(!r){out.textContent='';line.textContent=T.noRate;return}
 var places=(C.find(function(c){return c.iso===q})||{places:2}).places;out.textContent=new Intl.NumberFormat(LANG,{style:'currency',currency:q,currencyDisplay:'code',maximumFractionDigits:places}).format(a*r.rate);
 line.textContent=T.rateLine.replace('{from}',b).replace('{rate}',fmtRate(r.rate,LANG)).replace('{to}',q)+(r.day?' · '+fmtDay(r.day,LANG):'')}
function card(p){var o=p.official?'<div class="fig"><span>'+T.official+' · '+T.buy+'</span><b>'+fmtRate(p.official.buy,LANG)+'</b></div><div class="fig"><span>'+T.sell+'</span><b>'+fmtRate(p.official.sell,LANG)+'</b></div>':'';
 var m=p.market?'<div class="fig"><span>'+T.market+'</span><b>'+fmtRate(p.market.rate,LANG)+'</b></div>':'';var day=(p.official||p.market||{}).day;
 return'<div class="card pair"><h3>'+(p.favourite?'<span class="star">★</span> ':'')+esc(p.pair)+'</h3><div class="figs">'+o+m+'</div>'+(day?'<p class="muted small" style="margin-top:8px">'+fmtDay(day,LANG)+'</p>':'')+'</div>'}
Promise.all(['/v1/pairs','/v1/currencies?lang='+LANG,'/v1/official','/v1/market'].map(function(u){return fetch(u).then(function(r){return r.ok?r.json():null}).catch(function(){return null})})).then(function(a){
 var ps=a[0]&&a[0].pairs||[];C=a[1]&&a[1].currencies||[];O=a[2];M=a[3];
 document.getElementById('pairs').innerHTML=ps.length?ps.sort(function(x,y){return y.favourite-x.favourite}).map(card).join(''):'<p class="muted">'+T.none+'</p>';fill()});
document.querySelectorAll('[data-src]').forEach(function(b){b.onclick=function(){src=b.dataset.src;document.querySelectorAll('[data-src]').forEach(function(x){x.setAttribute('aria-pressed',x===b)});fill()}});
['amount','from','to'].forEach(function(id){document.getElementById(id).addEventListener('input',calc)});
document.getElementById('swap').onclick=function(){var f=document.getElementById('from'),t=document.getElementById('to'),v=f.value;f.value=t.value;t.value=v;calc()};`;
  return shell(lang, o.title, body, script);
}

export function adminPage(lang: Lang, o: PageOptions): string {
  const t = TEXT[lang];
  const body = `
<h1>${esc(o.title)} · ${t.admin}</h1>
<form id="login" class="card" style="max-width:420px;margin-top:20px" hidden><label for="token">${t.token}</label><input id="token" type="password" autocomplete="current-password"><p></p><button class="primary">${t.enter}</button><p id="loginerr" class="bad small"></p></form>
<div id="app" hidden>
  <div class="row" style="margin-top:12px"><button id="read" class="primary" type="button">${t.read}</button><span id="msg" class="muted small" aria-live="polite"></span></div>
  <h2>${t.pairsAdmin}</h2>
  <div class="card scroll"><table><thead><tr><th>${t.pairsAdmin}</th><th>${t.official}</th><th>${t.market}</th><th>${t.active}</th><th>${t.favourite}</th><th></th></tr></thead><tbody id="pairs"></tbody></table></div>
  <div class="card" style="margin-top:12px"><div class="row"><div><label for="pbase">${t.from}</label><select id="pbase"></select></div><div><label for="pquote">${t.to}</label><select id="pquote"></select></div><div style="flex:0 0 auto"><button id="addpair" type="button">${t.addPair}</button></div></div></div>
  <h2>${t.currencies}</h2>
  <div class="card scroll"><table><thead><tr><th>ISO</th><th></th><th>${t.symbol}</th><th>${t.active}</th></tr></thead><tbody id="currencies"></tbody></table></div>
  <div class="card" style="margin-top:12px"><div class="row"><div><label for="newiso">${t.addCurrency}</label><input id="newiso" list="catalog" placeholder="${t.search}"><datalist id="catalog"></datalist></div><div style="flex:0 0 auto"><button id="addcur" type="button">${t.add}</button></div></div></div>
  <h2>${t.backfill}</h2>
  <div class="card"><div class="row"><div><input id="bfrom" type="date" value="2018-01-01"></div><div style="flex:0 0 auto"><button id="backfill" type="button">${t.load}</button></div></div></div>
  <h2>${t.runs}</h2><ul id="runs" class="small" style="padding-left:18px"></ul>
</div>`;
  const script = `
var LANG=${JSON.stringify(lang)},T=${JSON.stringify(t)},KEY='cambista-token',token=sessionStorage.getItem(KEY)||'',D=null;
function api(method,body){var h={'Content-Type':'application/json'};if(token)h.Authorization='Bearer '+token;return fetch('/v1/admin?lang='+LANG,{method:method,credentials:'same-origin',headers:h,body:body?JSON.stringify(body):undefined}).then(function(r){return r.json().then(function(j){if(r.status===401)throw new Error('401');if(!r.ok)throw new Error(j.error||r.status);return j})})}
function say(s,bad){var m=document.getElementById('msg');m.textContent=s;m.className=(bad?'bad':'muted')+' small'}
function act(body){return api('POST',body).then(function(){say(T.saved);return load()}).catch(function(e){say(e.message,true)})}
function load(){return api('GET').then(function(d){D=d;draw()}).catch(function(e){if(e.message==='401'){var had=!!token;sessionStorage.removeItem(KEY);token='';show(false,had?T.wrongToken:'')}else say(e.message,true)})}
function show(ok,err){document.getElementById('login').hidden=ok;document.getElementById('app').hidden=!ok;document.getElementById('loginerr').textContent=err||''}
function draw(){show(true);var n=D.pairs.length;
 document.getElementById('pairs').innerHTML=D.pairs.map(function(p,i){return'<tr><td><b>'+esc(p.pair)+'</b></td><td>'+(p.official?fmtRate(p.official.buy,LANG)+' / '+fmtRate(p.official.sell,LANG):'')+'</td><td>'+(p.market?fmtRate(p.market.rate,LANG):'')+'</td>'+
 '<td><input type="checkbox" data-pair="'+esc(p.pair)+'" data-f="active" '+(p.active?'checked':'')+' style="width:auto"></td><td><input type="checkbox" data-pair="'+esc(p.pair)+'" data-f="favourite" '+(p.favourite?'checked':'')+' style="width:auto"></td>'+
 '<td class="row" style="flex-wrap:nowrap"><button data-up="'+i+'" '+(i===0?'disabled':'')+' aria-label="'+T.up+'">↑</button><button data-down="'+i+'" '+(i===n-1?'disabled':'')+' aria-label="'+T.down+'">↓</button><button data-rev="'+esc(p.pair)+'">'+T.reverse+'</button></td></tr>'}).join('');
 document.getElementById('currencies').innerHTML=D.currencies.map(function(c){return'<tr><td><b>'+c.iso+'</b>'+(c.official?' <span class="muted small">'+T.quotedByBcu+'</span>':'')+'</td><td>'+esc(c.name)+'</td><td><input data-sym="'+c.iso+'" value="'+esc(c.ownSymbol||'')+'" placeholder="'+esc(c.symbol)+'" maxlength="4" style="max-width:90px"></td><td><input type="checkbox" data-cur="'+c.iso+'" '+(c.active?'checked':'')+' style="width:auto"></td></tr>'}).join('');
 var opts=D.currencies.filter(function(c){return c.active}).map(function(c){return'<option value="'+c.iso+'">'+c.iso+' · '+esc(c.name)+'</option>'}).join('');
 document.getElementById('pbase').innerHTML=opts;document.getElementById('pquote').innerHTML=opts;
 document.getElementById('catalog').innerHTML=D.catalog.map(function(c){return'<option value="'+c.iso+'">'+esc(c.label)+'</option>'}).join('');
 document.getElementById('runs').innerHTML=D.status.runs.map(function(r){return'<li><span class="'+(r.ok?'good':'bad')+'">'+(r.ok?T.ok:T.failed)+'</span> '+esc(r.job)+', '+new Date(r.at).toLocaleString(LANG)+(r.ok?'':' · '+esc((r.detail&&r.detail.error)||''))+'</li>'}).join('');
 document.querySelectorAll('[data-pair]').forEach(function(x){x.onchange=function(){var b={kind:'pair',pair:x.dataset.pair};b[x.dataset.f]=x.checked;act(b)}});
 document.querySelectorAll('[data-cur]').forEach(function(x){x.onchange=function(){act({kind:'currency',iso:x.dataset.cur,active:x.checked})}});
 document.querySelectorAll('[data-sym]').forEach(function(x){x.onchange=function(){act({kind:'currency',iso:x.dataset.sym,symbol:x.value})}});
 document.querySelectorAll('[data-rev]').forEach(function(x){x.onclick=function(){act({kind:'reverse',pair:x.dataset.rev})}});
 function move(i,j){var l=D.pairs.map(function(p){return p.pair});var a=l[i];l[i]=l[j];l[j]=a;act({kind:'order',pairs:l})}
 document.querySelectorAll('[data-up]').forEach(function(x){x.onclick=function(){var i=+x.dataset.up;move(i,i-1)}});
 document.querySelectorAll('[data-down]').forEach(function(x){x.onclick=function(){var i=+x.dataset.down;move(i,i+1)}})}
document.getElementById('login').onsubmit=function(e){e.preventDefault();token=document.getElementById('token').value;sessionStorage.setItem(KEY,token);load()};
document.getElementById('addcur').onclick=function(){var v=document.getElementById('newiso').value.trim().slice(0,3).toUpperCase();if(v)act({kind:'currency',fresh:true,iso:v}).then(function(){document.getElementById('newiso').value=''})};
document.getElementById('addpair').onclick=function(){act({kind:'pair',fresh:true,base:document.getElementById('pbase').value,quote:document.getElementById('pquote').value})};
document.getElementById('read').onclick=function(){var b=this;b.disabled=true;say('…');api('POST',{kind:'read'}).then(function(r){say(r.ok?T.ok:T.failed,!r.ok);return load()}).catch(function(e){say(e.message,true)}).finally(function(){b.disabled=false})};
document.getElementById('backfill').onclick=function(){var b=this,from=document.getElementById('bfrom').value;b.disabled=true;
 (function step(f){say('… '+f);api('POST',{kind:'backfill',from:f}).then(function(r){if(r.next)return step(r.next);say(T.ok);b.disabled=false;return load()}).catch(function(e){say(e.message,true);b.disabled=false})})(from)};
load();`;
  return shell(lang, `${o.title} · ${t.admin}`, body, script);
}
