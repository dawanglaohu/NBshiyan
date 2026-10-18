// Share images for products / contact / privacy pages (Refs #126). Layout/fit/checks: og-layout.mjs.
// Products: three light-background posters (corrugated, colour box, paper cup) cropped to the product, same product height,
// side by side with a gentle stagger, no overlap and no dark tiles.
// Run from repo root: NODE_PATH=<dir with playwright> node design/og-src/render-og-pages.mjs
import fs from 'node:fs';
import { tag } from './og-tagline.mjs';
import { resolvePoster } from './og-assets.mjs';
import { writeOgVersions } from './og-versions.mjs';
import { cropPoster, productRow, renderJobs, sharedBg } from './og-layout.mjs';
const R=process.cwd();
const msg={en:JSON.parse(fs.readFileSync(R+'/messages/en.json','utf8')),ru:JSON.parse(fs.readFileSync(R+'/messages/ru.json','utf8'))};
const P=k=>R+'/public/images/posters/'+resolvePoster('custom-'+k);
const ROW=['color-boxes','corrugated-boxes','paper-cups'];
const collage=async pg=>{const cs=[];for(const k of ROW) cs.push(await cropPoster(pg,P(k)));const r=productRow(cs);return {art:r.html,boxes:r.boxes,bgColor:sharedBg(cs),artInfo:`row h=${Math.round(r.h)}`};};
const envelope=`<svg viewBox="0 0 200 180" width="380"><rect x="20" y="40" width="160" height="110" rx="10" fill="#C49A6C"/><path d="M20 50l80 55 80-55" fill="none" stroke="#8a6440" stroke-width="5"/><circle cx="168" cy="40" r="22" fill="#FF5A36"/><path d="M158 40l7 7 13-14" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round"/></svg>`;
const shield=`<svg viewBox="0 0 200 180" width="380"><path d="M100 14l64 24v46c0 42-28 70-64 84-36-14-64-42-64-84V38Z" fill="#C49A6C"/><path d="M100 14v154c-36-14-64-42-64-84V38Z" fill="#A77D50"/><rect x="78" y="80" width="44" height="36" rx="6" fill="#FF5A36"/><path d="M86 80v-10a14 14 0 0 1 28 0v10" fill="none" stroke="#FF5A36" stroke-width="7"/></svg>`;
const jobs=[];
for(const l of ['en','ru']){
  jobs.push({file:`products-${l}.jpg`,title:msg[l].Products.title,sub:tag[l],locale:l,prepare:collage,textW:480});
  jobs.push({file:`contact-${l}.jpg`,title:msg[l].Contact.title,sub:tag[l],locale:l,side:envelope});
  jobs.push({file:`privacy-${l}.jpg`,title:msg[l].Privacy.title,sub:tag[l],locale:l,side:shield});
}
await renderJobs(R,jobs);
writeOgVersions(R);
