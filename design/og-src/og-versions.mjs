// Cache-busting manifest for share images (og:image ?v=). Hashes every public/og/*.jpg
// -> src/data/og-versions.json { "<file>": "<first 8 hex of sha256>" }. Imported by src/lib/seo/pageMeta.ts.
// Called at the end of each render-og*.mjs; also runnable alone from repo root: node design/og-src/og-versions.mjs
import fs from 'node:fs';
import crypto from 'node:crypto';
export function writeOgVersions(R=process.cwd()){
  const dir=R+'/public/og';
  const out=Object.fromEntries(fs.readdirSync(dir).filter(f=>f.endsWith('.jpg')).sort()
    .map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(dir+'/'+f)).digest('hex').slice(0,8)]));
  fs.writeFileSync(R+'/src/data/og-versions.json',JSON.stringify(out,null,2)+'\n');
  return out;
}
if(import.meta.url===`file://${process.argv[1]}`) console.log(Object.keys(writeOgVersions()).length+' og versions written');
