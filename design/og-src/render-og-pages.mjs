// Share images for products / contact / privacy pages (Refs #126). Same layout as render-og.mjs.
// Run from repo root: NODE_PATH=<dir with playwright> node design/og-src/render-og-pages.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright');
const R=process.cwd();
const msg={en:JSON.parse(fs.readFileSync(R+'/messages/en.json','utf8')),ru:JSON.parse(fs.readFileSync(R+'/messages/ru.json','utf8'))};
const P=f=>'data:image/webp;base64,'+fs.readFileSync(R+'/public/images/posters/'+f).toString('base64');
const collage=`<div style="position:relative;width:460px;height:440px"><img src="${P('custom-corrugated-boxes.webp')}" style="position:absolute;left:0;top:120px;width:250px;height:250px"><img src="${P('custom-gift-boxes.webp')}" style="position:absolute;left:210px;top:0;width:250px;height:250px"><img src="${P('custom-wine-boxes.webp')}" style="position:absolute;left:180px;top:200px;width:240px;height:240px"></div>`;
const envelope=`<svg viewBox="0 0 200 180" width="380"><rect x="20" y="40" width="160" height="110" rx="10" fill="#C49A6C"/><path d="M20 50l80 55 80-55" fill="none" stroke="#8a6440" stroke-width="5"/><circle cx="168" cy="40" r="22" fill="#FF5A36"/><path d="M158 40l7 7 13-14" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round"/></svg>`;
const shield=`<svg viewBox="0 0 200 180" width="380"><path d="M100 14l64 24v46c0 42-28 70-64 84-36-14-64-42-64-84V38Z" fill="#C49A6C"/><path d="M100 14v154c-36-14-64-42-64-84V38Z" fill="#A77D50"/><rect x="78" y="80" width="44" height="36" rx="6" fill="#FF5A36"/><path d="M86 80v-10a14 14 0 0 1 28 0v10" fill="none" stroke="#FF5A36" stroke-width="7"/></svg>`;
const tag={en:'Custom packaging & printing · Factory direct',ru:'Упаковка и печать на заказ · Напрямую с фабрики'};
const page=({title,sub,img})=>`<!doctype html><html><head><meta charset="utf-8"><style>
*{margin:0;box-sizing:border-box}body{width:1200px;height:630px;overflow:hidden;font-family:Manrope,sans-serif;background:#FBF8F3;color:#1C1C1C}
.safe{position:absolute;left:60px;top:35px;width:1080px;height:560px;display:flex;align-items:center;gap:40px}
.l{flex:1.15;min-width:0;display:flex;flex-direction:column;gap:26px}.wm{font-size:34px;font-weight:800;letter-spacing:-.01em}.wm i{font-style:normal;color:#FF5A36}
h1{font-size:${title.length>24?58:70}px;line-height:1.05;font-weight:800;letter-spacing:-.02em;overflow-wrap:normal;word-break:normal;hyphens:none}h1 span{display:inline-block}.bar{width:90px;height:8px;border-radius:4px;background:#FF5A36}
p{font-size:26px;color:#5A5650;font-weight:600}.r{flex:1;display:grid;place-items:center;height:100%}
.edge{position:absolute;right:0;bottom:0;width:1200px;height:10px;background:#FF5A36}</style></head><body>
<div class="safe"><div class="l"><div class="wm">Pack<i>Joy</i>U</div><div class="bar"></div><h1>${title.split(' ').map(w=>`<span>${w}</span>`).join(' ')}</h1><p>${sub}</p></div><div class="r">${img}</div></div><div class="edge"></div></body></html>`;
const jobs=[];
for(const l of ['en','ru']) for(const [name,ns,img] of [['products','Products',collage],['contact','Contact',envelope],['privacy','Privacy',shield]])
  jobs.push({file:`${name}-${l}.jpg`,title:msg[l][ns].title,sub:tag[l],img});
const b=await chromium.launch();const pg=await b.newPage({viewport:{width:1200,height:630}});const out=[];
for(const j of jobs){await pg.setContent(page(j));await pg.evaluate(()=>document.fonts.ready);
  await pg.evaluate(()=>{const h=document.querySelector('h1');let f=parseFloat(getComputedStyle(h).fontSize);const W=h.clientWidth;while([...h.children].some(c=>c.getBoundingClientRect().width>W)&&f>40){f-=2;h.style.fontSize=f+'px'}});
  const ok=await pg.evaluate(()=>{const W=document.querySelector('h1').clientWidth;if([...document.querySelectorAll('h1 span')].some(c=>c.getBoundingClientRect().width>W))return false;const s=document.querySelector('.safe').getBoundingClientRect();return [...document.querySelectorAll('.l *')].every(e=>{const r=e.getBoundingClientRect();return r.left>=s.left&&r.right<=s.right&&r.top>=s.top&&r.bottom<=s.bottom&&e.scrollWidth<=e.clientWidth+1})});
  const font=await pg.evaluate(()=>document.fonts.check('800 70px Manrope','Яя'));
  let q=88,buf;do{buf=await pg.screenshot({type:'jpeg',quality:q});q-=6}while(buf.length>100*1024&&q>40);
  fs.writeFileSync(`${R}/public/og/${j.file}`,buf);out.push([j.file,j.title,buf.length,q+6,ok,font]);}
await b.close();console.log(JSON.stringify(out,null,0));
