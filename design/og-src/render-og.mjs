import { createRequire } from 'node:module';
import fs from 'node:fs';
import { tag } from './og-tagline.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
const R=process.cwd(), ts=fs.readFileSync(R+'/src/lib/seo/categoryMeta.ts','utf8');
const cats=[...ts.matchAll(/key: '([\w-]+)',\s*en: \{ slug: '([\w-]+)', keyword: '([^']+)'.*?ru: \{ slug: '[\w-]+', keyword: '([^']+)'/gs)].map(m=>({key:m[1],slug:m[2],en:m[3],ru:m[4]}));
const cap=s=>s.replace(/^./,c=>c.toUpperCase()).replace(/christmas/,'Christmas');
const posters={}; for(const f of fs.readdirSync(R+'/public/images/posters')) posters[f.replace(/^custom-|\.webp$/g,'')]=f;
const b64=f=>'data:image/webp;base64,'+fs.readFileSync(f).toString('base64');
const P=f=>b64(R+'/public/images/posters/'+f);const hero=`<div style="position:relative;width:460px;height:440px"><img src="${P('custom-corrugated-boxes.webp')}" style="position:absolute;left:0;top:120px;width:250px;height:250px"><img src="${P('custom-gift-boxes.webp')}" style="position:absolute;left:210px;top:0;width:250px;height:250px"><img src="${P('custom-wine-boxes.webp')}" style="position:absolute;left:180px;top:200px;width:240px;height:240px"></div>`;
const box=(c)=>`<svg viewBox="0 0 200 180" width="380"><path d="M30 60 100 30l70 30v80l-70 34-70-34Z" fill="${c?'#2A2A2E':'#C49A6C'}"/><path d="M100 90v84L30 140V60Z" fill="${c?'#1E1E22':'#A77D50'}"/><path d="m30 60 70 30 70-30" fill="none" stroke="${c?'#D4AF6A':'#8a6440'}" stroke-width="3"/><circle cx="168" cy="26" r="14" fill="${c?'#D4AF6A':'#FFD166'}"/></svg>`;
const page=({title,sub,img,dark})=>`<!doctype html><html><head><meta charset="utf-8"><style>
*{margin:0;box-sizing:border-box}body{width:1200px;height:630px;overflow:hidden;font-family:Manrope,sans-serif;background:${dark?'#121214':'#FBF8F3'};color:${dark?'#F2E9D8':'#1C1C1C'}}
.safe{position:absolute;left:60px;top:35px;width:1080px;height:560px;display:flex;align-items:center;gap:40px}
.l{flex:1.15;display:flex;flex-direction:column;gap:26px}.wm{font-size:34px;font-weight:800;letter-spacing:-.01em}.wm i{font-style:normal;color:${dark?'#D4AF6A':'#FF5A36'}}
h1{font-size:${title.length>30?58:70}px;line-height:1.05;font-weight:800;letter-spacing:-.02em}.bar{width:90px;height:8px;border-radius:4px;background:${dark?'#D4AF6A':'#FF5A36'}}
p{font-size:26px;color:${dark?'#BFB6A6':'#5A5650'};font-weight:600}.r{flex:1;display:grid;place-items:center;height:100%}.r img{width:440px;height:440px;object-fit:cover;border-radius:28px}
.edge{position:absolute;right:0;bottom:0;width:1200px;height:10px;background:${dark?'#D4AF6A':'#FF5A36'}}</style></head><body>
<div class="safe"><div class="l"><div class="wm">Pack<i>Joy</i>U</div><div class="bar"></div><h1>${title}</h1><p>${sub}</p></div><div class="r">${img}</div></div><div class="edge"></div></body></html>`;
const jobs=[];
for(const l of ['en','ru']){
  jobs.push({file:`home-${l}.jpg`,title:l=='en'?'Custom packaging that sparks joy':'Упаковка на заказ, которая дарит радость',sub:tag[l],img:hero,dark:false});
  for(const c of cats){const dark=['gift-boxes','wine-boxes'].includes(c.key);const p=posters[c.key];
    jobs.push({file:`${c.slug}-${l}.jpg`,title:cap(l=='en'?c.en:c.ru),sub:tag[l],img:p?`<img src="${b64(R+'/public/images/posters/'+p)}">`:box(dark),dark});}
}
const b=await chromium.launch();const pg=await b.newPage({viewport:{width:1200,height:630}});const out=[];
for(const j of jobs){await pg.setContent(page(j));await pg.evaluate(()=>document.fonts.ready);
  const fam=await pg.evaluate(()=>document.fonts.check('800 70px Manrope','Яя'));
  let q=88,buf;do{buf=await pg.screenshot({type:'jpeg',quality:q});q-=6}while(buf.length>100*1024&&q>40);
  fs.writeFileSync(`${R}/public/og/${j.file}`,buf);out.push([j.file,buf.length,q+6,fam]);}
await b.close();console.log(JSON.stringify(out));
