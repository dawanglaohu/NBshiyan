// Share images for category landing pages /[locale]/products/<slug> (Refs #209 #126).
// Same layout/spec as render-og.mjs + render-og-pages.mjs: 1200x630 JPG < 100 KB, theme C (gift/wine: theme B), Manrope, text logo.
// Slugs from src/lib/seo/categoryMeta.ts (per locale); titles = #188 H1s (docs/content/<en-slug>.md).
// Run from repo root: NODE_PATH=<dir with playwright> node design/og-src/render-og-categories.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright');
const R=process.cwd(), ts=fs.readFileSync(R+'/src/lib/seo/categoryMeta.ts','utf8');
const cats=[...ts.matchAll(/key: '([\w-]+)',\s*en: \{ slug: '([\w-]+)'.*?ru: \{ slug: '([\w-]+)'/gs)].map(m=>({key:m[1],en:m[2],ru:m[3]}));
if(cats.length!==12) throw new Error('expected 12 categories, got '+cats.length);
// #188 H1s (EN / RU)
const H1={'corrugated-boxes':['Custom Corrugated Boxes','Гофрокороба на заказ'],'color-boxes':['Custom Printed Boxes','Картонные коробки с печатью на заказ'],
'gift-boxes':['Custom Gift Boxes','Подарочные коробки на заказ'],'pulp-molding':['Molded Pulp Packaging','Упаковка из формованной целлюлозы'],
'paper-cups':['Custom Paper Cups','Бумажные стаканы с логотипом'],'party-supplies':['Custom Party Supplies','Бумажная посуда для праздника оптом'],
'wine-boxes':['Custom Wine Boxes','Коробки для вина на заказ'],'color-printing':['Packaging Printing Services','Печать упаковки на заказ'],
'offset-printing':['Offset Printing Services','Офсетная печать упаковки'],
'gift-cards':['Custom Gift Cards','Печать подарочных карт на заказ'],'christmas-merchandise':['Custom Christmas Packaging','Новогодняя упаковка на заказ']};
const posters={'corrugated-boxes':'custom-corrugated-boxes.88879bdf.webp','gift-boxes':'custom-gift-boxes.2b476905.webp','wine-boxes':'custom-wine-boxes.98e212ab.webp'};
const K='#C49A6C',KD='#A77D50',KL='#8a6440',C='#FF5A36',Y='#FFD166',G='#2E9E6B';
const S=b=>`<svg viewBox="0 0 200 180" width="380">${b}</svg>`;
const box=(f=K,d=KD,s=KL,acc=Y)=>`<path d="M30 60 100 30l70 30v80l-70 34-70-34Z" fill="${f}"/><path d="M100 90v84L30 140V60Z" fill="${d}"/><path d="m30 60 70 30 70-30" fill="none" stroke="${s}" stroke-width="3"/><circle cx="168" cy="26" r="14" fill="${acc}"/>`;
const cup=(band,lid='#fff')=>`<path d="M60 50h80l-12 120H72Z" fill="#fff" stroke="#E4DCCF" stroke-width="3"/><path d="M64 90h72l-4 40H68Z" fill="${band}"/><rect x="52" y="36" width="96" height="18" rx="6" fill="${lid}" stroke="#E4DCCF" stroke-width="3"/>`;
const ill={
 'color-boxes':S(box('#FF5A36','#D4421F','#fff','#FFD166')+`<circle cx="62" cy="112" r="12" fill="${Y}"/><rect x="118" y="98" width="34" height="10" rx="5" fill="#fff" transform="rotate(-25 135 103)"/>`),
 'pulp-molding':S(`<rect x="20" y="70" width="160" height="70" rx="14" fill="#D9CDB8"/>${[0,1,2,3].map(i=>`<ellipse cx="${45+i*37}" cy="100" rx="15" ry="18" fill="#C2B497"/><ellipse cx="${45+i*37}" cy="96" rx="12" ry="14" fill="#F3EBDD"/>`).join('')}<path d="M150 30c20 0 28 14 28 30-16 0-28-10-28-30Z" fill="${G}"/>`),
 'paper-cups':S(cup(C)),
 'party-supplies':S(`<circle cx="80" cy="110" r="58" fill="#fff" stroke="#E4DCCF" stroke-width="4"/><circle cx="80" cy="110" r="38" fill="none" stroke="${C}" stroke-width="6" stroke-dasharray="10 8"/><path d="M140 160 165 40l25 120Z" fill="${Y}"/><path d="M152 100h26M146 130h38" stroke="${C}" stroke-width="6"/><circle cx="165" cy="36" r="8" fill="${C}"/>`),
 'color-printing':S(`<rect x="40" y="30" width="120" height="140" rx="8" fill="#fff" stroke="#E4DCCF" stroke-width="3"/>${['#00AEEF','#EC008C','#FFD400','#1C1C1C'].map((c,i)=>`<rect x="${52+i*26}" y="44" width="20" height="20" rx="3" fill="${c}"/>`).join('')}<circle cx="85" cy="118" r="30" fill="#00AEEF" opacity=".75"/><circle cx="115" cy="118" r="30" fill="#EC008C" opacity=".75"/><circle cx="100" cy="94" r="30" fill="#FFD400" opacity=".75"/>`),
 'offset-printing':S(`${[0,1,2].map(i=>`<rect x="${38+i*10}" y="${40+i*14}" width="120" height="96" rx="6" fill="${['#E4DCCF','#F3EBDD','#fff'][i]}" stroke="#D2C7B6" stroke-width="2"/>`).join('')}<rect x="70" y="84" width="96" height="10" rx="5" fill="${C}"/><rect x="70" y="102" width="70" height="8" rx="4" fill="${K}"/><rect x="70" y="118" width="84" height="8" rx="4" fill="${K}"/><circle cx="164" cy="44" r="14" fill="${Y}"/>`),
 'gift-cards':S(`<rect x="30" y="54" width="130" height="84" rx="12" fill="${K}" transform="rotate(-10 95 96)"/><rect x="44" y="64" width="130" height="84" rx="12" fill="${C}"/><rect x="58" y="80" width="30" height="22" rx="4" fill="${Y}"/><rect x="58" y="120" width="90" height="8" rx="4" fill="#fff"/>`),
 'christmas-merchandise':S(box('#C2381A','#9E2C13','#fff','#FFD166')+`<path d="M100 30v144" stroke="#2E9E6B" stroke-width="10"/><path d="M100 30c-20-22-40-4-20 8M100 30c20-22 40-4 20 8" fill="none" stroke="#2E9E6B" stroke-width="7"/>`),
};
const tag={en:'Custom packaging & printing · Factory direct',ru:'Упаковка и печать на заказ · Напрямую с фабрики'};
const b64=f=>'data:image/webp;base64,'+fs.readFileSync(R+'/public/images/posters/'+f).toString('base64');
const page=({title,sub,img,dark})=>`<!doctype html><html><head><meta charset="utf-8"><style>
*{margin:0;box-sizing:border-box}body{width:1200px;height:630px;overflow:hidden;font-family:Manrope,sans-serif;background:${dark?'#121214':'#FBF8F3'};color:${dark?'#F2E9D8':'#1C1C1C'}}
.safe{position:absolute;left:60px;top:35px;width:1080px;height:560px;display:flex;align-items:center;gap:40px}
.l{flex:1.15;min-width:0;display:flex;flex-direction:column;gap:26px}.wm{font-size:34px;font-weight:800;letter-spacing:-.01em}.wm i{font-style:normal;color:${dark?'#D4AF6A':'#FF5A36'}}
h1{font-size:${title.length>24?58:70}px;line-height:1.05;font-weight:800;letter-spacing:-.02em;overflow-wrap:normal;word-break:normal;hyphens:none}h1 span{display:inline-block}.bar{width:90px;height:8px;border-radius:4px;background:${dark?'#D4AF6A':'#FF5A36'}}
p{font-size:26px;color:${dark?'#BFB6A6':'#5A5650'};font-weight:600}.r{flex:1;display:grid;place-items:center;height:100%}.r img{width:440px;height:440px;object-fit:cover;border-radius:28px}
.edge{position:absolute;right:0;bottom:0;width:1200px;height:10px;background:${dark?'#D4AF6A':'#FF5A36'}}</style></head><body>
<div class="safe"><div class="l"><div class="wm">Pack<i>Joy</i>U</div><div class="bar"></div><h1>${title.split(' ').map(w=>`<span>${w}</span>`).join(' ')}</h1><p>${sub}</p></div><div class="r">${img}</div></div><div class="edge"></div></body></html>`;
const jobs=[];
for(const l of ['en','ru']) for(const c of cats){const dark=['gift-boxes','wine-boxes'].includes(c.key);
  jobs.push({file:`category-${c[l]}-${l}.jpg`,title:H1[c.key][l=='en'?0:1],sub:tag[l],dark,img:posters[c.key]?`<img src="${b64(posters[c.key])}">`:ill[c.key]});}
const b=await chromium.launch();const pg=await b.newPage({viewport:{width:1200,height:630}});const out=[];
for(const j of jobs){await pg.setContent(page(j));await pg.evaluate(()=>document.fonts.ready);
  await pg.evaluate(()=>{const h=document.querySelector('h1');let f=parseFloat(getComputedStyle(h).fontSize);const W=h.clientWidth;while([...h.children].some(c=>c.getBoundingClientRect().width>W)&&f>40){f-=2;h.style.fontSize=f+'px'}});
  const ok=await pg.evaluate(()=>{const W=document.querySelector('h1').clientWidth;if([...document.querySelectorAll('h1 span')].some(c=>c.getBoundingClientRect().width>W))return false;const s=document.querySelector('.safe').getBoundingClientRect();return [...document.querySelectorAll('.safe *')].every(e=>{const r=e.getBoundingClientRect();return r.left>=s.left-.5&&r.right<=s.right+.5&&r.top>=s.top-.5&&r.bottom<=s.bottom+.5})});
  const font=await pg.evaluate(()=>document.fonts.check('800 70px Manrope','Яя'));
  let q=88,buf;do{buf=await pg.screenshot({type:'jpeg',quality:q});q-=6}while(buf.length>100*1024&&q>40);
  fs.writeFileSync(`${R}/public/og/${j.file}`,buf);out.push([j.file,j.title,buf.length,q+6,ok,font]);}
await b.close();console.log(out.map(o=>o.join(' | ')).join('\n'));
