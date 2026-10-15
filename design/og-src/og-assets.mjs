// Strict poster resolver for render-og*.mjs: posters are content-hashed (#283/#284).
// resolvePoster('custom-gift-boxes') -> 'custom-gift-boxes.<8 hex>.webp'. Exactly one match, else throw (no fallback).
import fs from 'node:fs';
const esc=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function resolvePoster(slug, dir=process.cwd()+'/public/images/posters'){
  const re=new RegExp('^'+esc(slug)+'\\.[0-9a-f]{8}\\.webp$');
  const m=fs.readdirSync(dir).filter(f=>re.test(f));
  if(m.length!==1) throw new Error(`resolvePoster('${slug}'): expected exactly 1 file matching ${re} in ${dir}, found ${m.length}${m.length?': '+m.join(', '):''}`);
  return m[0];
}
