// Share images for category landing pages /[locale]/products/<slug> (Refs #209 #126).
// Same layout/spec as render-og.mjs + render-og-pages.mjs: 1200x630 JPG < 100 KB, theme C (gift/wine: theme B), Manrope, text logo.
// Slugs from src/lib/seo/categoryMeta.ts (per locale); titles = #188 H1s (docs/content/<en-slug>.md).
// Run from repo root: NODE_PATH=<dir with playwright> node design/og-src/render-og-categories.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { tag } from './og-tagline.mjs';
import { resolvePoster } from './og-assets.mjs';
import { writeOgVersions } from './og-versions.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
const R=process.cwd(), ts=fs.readFileSync(R+'/src/lib/seo/categoryMeta.ts','utf8');
const cats=[...ts.matchAll(/key: '([\w-]+)',\s*en: \{ slug: '([\w-]+)'.*?ru: \{ slug: '([\w-]+)'/gs)].map(m=>({key:m[1],en:m[2],ru:m[3]}));
if(cats.length!==11) throw new Error('expected 11 categories (eco-paper-cups removed, #296), got '+cats.length);
// #188 H1s (EN / RU)
const H1={'corrugated-boxes':['Custom Corrugated Boxes','Гофрокороба на заказ'],'color-boxes':['Custom Printed Boxes','Картонные коробки с печатью на заказ'],
'gift-boxes':['Custom Gift Boxes','Подарочные коробки на заказ'],'pulp-molding':['Molded Pulp Packaging','Упаковка из формованной целлюлозы'],
'paper-cups':['Custom Paper Cups','Бумажные стаканы с логотипом'],'party-supplies':['Custom Party Supplies','Бумажная посуда для праздника оптом'],
'wine-boxes':['Custom Wine Boxes','Коробки для вина на заказ'],'color-printing':['Packaging Printing Services','Печать упаковки на заказ'],
'offset-printing':['Offset Printing Services','Офсетная печать упаковки'],
'gift-cards':['Custom Gift Cards','Печать подарочных карт на заказ'],'christmas-merchandise':['Custom Christmas Packaging','Новогодняя упаковка на заказ']};
// Every category uses its own 3D poster (#316 re-shot all 12; eco-paper-cups has no category page). No illustration fallback.
const posters=Object.fromEntries(cats.map(c=>[c.key,resolvePoster('custom-'+c.key)]));
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
  jobs.push({file:`category-${c[l]}-${l}.jpg`,title:H1[c.key][l=='en'?0:1],sub:tag[l],dark,img:`<img src="${b64(posters[c.key])}">`});}
const b=await chromium.launch();const pg=await b.newPage({viewport:{width:1200,height:630}});const out=[];
for(const j of jobs){await pg.setContent(page(j));await pg.evaluate(()=>document.fonts.ready);
  await pg.evaluate(()=>{const h=document.querySelector('h1');let f=parseFloat(getComputedStyle(h).fontSize);const W=h.clientWidth;while([...h.children].some(c=>c.getBoundingClientRect().width>W)&&f>40){f-=2;h.style.fontSize=f+'px'}});
  const ok=await pg.evaluate(()=>{const W=document.querySelector('h1').clientWidth;if([...document.querySelectorAll('h1 span')].some(c=>c.getBoundingClientRect().width>W))return false;const s=document.querySelector('.safe').getBoundingClientRect();return [...document.querySelectorAll('.safe *')].every(e=>{const r=e.getBoundingClientRect();return r.left>=s.left-.5&&r.right<=s.right+.5&&r.top>=s.top-.5&&r.bottom<=s.bottom+.5})});
  const font=await pg.evaluate(()=>document.fonts.check('800 70px Manrope','Яя'));
  let q=88,buf;do{buf=await pg.screenshot({type:'jpeg',quality:q});q-=6}while(buf.length>100*1024&&q>40);
  fs.writeFileSync(`${R}/public/og/${j.file}`,buf);out.push([j.file,j.title,buf.length,q+6,ok,font]);}
await b.close();console.log(out.map(o=>o.join(' | ')).join('\n'));
writeOgVersions(R);
