// Share images for category landing pages /[locale]/products/<slug> (Refs #209 #126): public/og/category-<locale slug>-<l>.jpg.
// 1200x630 JPG < 100 KB, Manrope, text logo; gift/wine dark theme. Layout/fit/checks: og-layout.mjs.
// Slugs from src/lib/seo/categoryMeta.ts (per locale); titles = #188 H1s (docs/content/<en-slug>.md).
// Every category uses its own 3D poster (#316 re-shoot; eco-paper-cups has no category page), cropped to the product (og-layout.mjs).
// Run from repo root: NODE_PATH=<dir with playwright> node design/og-src/render-og-categories.mjs
import fs from 'node:fs';
import { tag } from './og-tagline.mjs';
import { resolvePoster } from './og-assets.mjs';
import { writeOgVersions } from './og-versions.mjs';
import { renderJobs } from './og-layout.mjs';
import { productJob } from './render-og.mjs';
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
const jobs=[];
for(const l of ['en','ru']) for(const c of cats)
  jobs.push(productJob(`category-${c[l]}-${l}.jpg`,H1[c.key][l=='en'?0:1],tag[l],l,c.key,R+'/public/images/posters/'+resolvePoster('custom-'+c.key)));
await renderJobs(R,jobs);
writeOgVersions(R);
