// Home share images (public/og/home-<l>.jpg) + productJob() used by render-og-categories.mjs. Layout/fit/checks: og-layout.mjs.
// The old per-product images (<en-slug>-<l>.jpg) were never referenced (products/[slug] uses category-*), so they are no longer generated.
// Run from repo root: NODE_PATH=<dir with playwright> node design/og-src/render-og.mjs [--only=<file prefix>]
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { writeOgVersions } from './og-versions.mjs';
import { cropPoster, productArt, renderJobs } from './og-layout.mjs';
const R=process.cwd();
const b64=f=>'data:image/'+(f.endsWith('.jpg')?'jpeg':f.endsWith('.png')?'png':'webp')+';base64,'+fs.readFileSync(f).toString('base64');
// The share image follows the selected poster used by the website.
const heroSrc=fs.readFileSync(R+'/src/lib/home/brandMedia.ts','utf8').match(/video:\s*\{[^}]*poster:\s*'([^']+)'/);
if(!heroSrc) throw new Error('selected video poster not found in brandMedia.ts');
export const HOME_POSTER_SOURCE=heroSrc[1];
// Existing home share-image copy; subtitle and layout remain unchanged.
const HOME={en:{title:'Custom printed packaging',sub:'From sample to bulk order'},ru:{title:'Упаковка с индивидуальной печатью',sub:'От образца до тиража'}};
const heroBg=`<img class="bg" src="${b64(R+'/public'+HOME_POSTER_SOURCE)}"><div style="position:absolute;inset:0 auto 0 0;width:620px;background:#FAF7F2"></div>`;
const DARK=['gift-boxes','wine-boxes'];
// Category art: poster cropped to the product's bounding box (+10%), same visual size rule for every category image (og-layout.mjs).
// Page background = the poster's own background colour (dark and light), so no tile edge or light fringe shows (og-layout.mjs placed()).
export const productJob=(file,title,sub,locale,key,poster)=>({file,title,sub,locale,dark:DARK.includes(key),
  prepare:async pg=>{const c=await cropPoster(pg,poster);const a=productArt(c);
    return {art:a.html,boxes:[a.box],bgColor:c.bg,artInfo:`${a.wide?'wide w':'tall h'}=${Math.round(a.size)}`};}});
const jobs=[];
for(const l of ['en','ru']){
  jobs.push({file:`home-${l}.jpg`,title:HOME[l].title,sub:HOME[l].sub,locale:l,full:heroBg,bgColor:'#FAF7F2',textW:540});
}
// --only=<file prefix or name> renders a subset, e.g. --only=home or --only=home-en (other images untouched).
const only=process.argv.find(a=>a.startsWith('--only='))?.slice(7);
if(only){jobs.splice(0,jobs.length,...jobs.filter(j=>j.file===only+'.jpg'||j.file.startsWith(only+'-')));if(!jobs.length) throw new Error('--only matched no jobs: '+only);}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){await renderJobs(R,jobs);writeOgVersions(R);}
