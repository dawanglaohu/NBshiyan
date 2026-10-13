import { chromium } from 'playwright'; import fs from 'node:fs';
const R='/workspace/nb-design', svg=fs.readFileSync(R+'/src/app/icon.svg','utf8');
const b=await chromium.launch();
async function png(size,out,{pad=0,rx=true}={}){const p=await b.newPage({viewport:{width:size,height:size}});
 const s=svg.replace('rx="14"',rx?'rx="14"':'rx="0"');
 const inner=pad?`<div style="width:${size}px;height:${size}px;background:#FF5A36;display:grid;place-items:center"><div style="width:${size*(1-pad*2)}px;height:${size*(1-pad*2)}px">${s.replace('<rect width="64" height="64" rx="0" fill="#FF5A36"/>','')}</div></div>`:s;
 await p.setContent(`<style>*{margin:0}svg{width:100%;height:100%;display:block}body{width:${size}px;height:${size}px;background:transparent}</style>${inner}`);
 await p.screenshot({path:out,omitBackground:true});await p.close();}
await png(180,R+'/src/app/apple-icon.png',{rx:false});
await png(192,R+'/public/icon-192.png');await png(512,R+'/public/icon-512.png');
await png(512,R+'/public/icon-maskable-512.png',{pad:.12,rx:false});
for(const s of [16,32,48]) await png(s,`/workspace/tmp112/fav${s}.png`);
await b.close();
