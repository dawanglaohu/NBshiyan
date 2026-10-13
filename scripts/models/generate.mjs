import { Document, NodeIO } from '@gltf-transform/core';
import { PNG } from 'pngjs';
import fs from 'fs';
// ---------- procedural textures ----------
function tex(name, w, h, f){ const p=new PNG({width:w,height:h}); for(let y=0;y<h;y++)for(let x=0;x<w;x++){const [r,g,b]=f(x,y);const i=(y*w+x)*4;p.data[i]=r;p.data[i+1]=g;p.data[i+2]=b;p.data[i+3]=255;} const buf=PNG.sync.write(p); fs.writeFileSync(`tex/${name}.png`,buf); return buf; }
const rnd=(x,y)=>{let n=Math.sin(x*12.9898+y*78.233)*43758.5453;return n-Math.floor(n);};
const cl=v=>Math.max(0,Math.min(255,v|0));
const kraft=tex('kraft',512,512,(x,y)=>{const n=(rnd(x,y)-.5)*18+Math.sin(y*0.9)*3+Math.sin(x*0.05+y*0.02)*4;return [cl(196+n),cl(156+n),cl(108+n)];});
// gift: coral paper with faint linen texture
const gift=tex('gift',256,256,(x,y)=>{const n=(rnd(x,y)-.5)*10+((x%4==0)||(y%4==0)?-6:0);return [cl(232+n),cl(98+n),cl(78+n)];});
const ribbon=tex('ribbon',128,128,(x,y)=>{const n=Math.sin(x*0.8)*10+(rnd(x,y)-.5)*8;return [cl(214+n),cl(176+n),cl(96+n)];});
// wine: dark textured board with gold border band
const wine=tex('wine',512,512,(x,y)=>{const b=(Math.abs(y-40)<4)||(Math.abs(y-472)<4)||(Math.abs(x-40)<3&&y>40&&y<472)||(Math.abs(x-472)<3&&y>40&&y<472);const n=(rnd(x,y)-.5)*12;return b?[cl(201+n),cl(162+n),cl(84+n)]:[cl(34+n),cl(30+n),cl(32+n)];});
const inner=tex('inner',128,128,(x,y)=>{const n=(rnd(x,y)-.5)*10;return [cl(238+n),cl(232+n),cl(222+n)];});
// ---------- geometry ----------
class Geo{constructor(){this.p=[];this.n=[];this.uv=[];this.i=[];}
 box(cx,cy,cz,sx,sy,sz,us=1){const hx=sx/2,hy=sy/2,hz=sz/2;
  const faces=[[[1,0,0],[0,0,-1],[0,1,0],sz,sy,hx],[[-1,0,0],[0,0,1],[0,1,0],sz,sy,hx],[[0,1,0],[1,0,0],[0,0,-1],sx,sz,hy],[[0,-1,0],[1,0,0],[0,0,1],sx,sz,hy],[[0,0,1],[1,0,0],[0,1,0],sx,sy,hz],[[0,0,-1],[-1,0,0],[0,1,0],sx,sy,hz]];
  for(const [N,U,V,w,h,d] of faces){const b=this.p.length/3;
   for(const [a,c] of [[-1,-1],[1,-1],[1,1],[-1,1]]){for(let k=0;k<3;k++)this.p.push([cx,cy,cz][k]+N[k]*d+U[k]*a*w/2+V[k]*c*h/2);this.n.push(...N);this.uv.push((a+1)/2*w*us,(1-(c+1)/2)*h*us);}
   this.i.push(b,b+1,b+2,b,b+2,b+3);} return this;}}
function build(file, parts, anims){
 const doc=new Document(); const buf=doc.createBuffer(); const scene=doc.createScene('Scene'); const mats={}; const nodes={};
 const mat=(k,png,rough,metal=0)=>mats[k]??=doc.createMaterial(k).setRoughnessFactor(rough).setMetallicFactor(metal).setBaseColorTexture(doc.createTexture(k).setImage(png).setMimeType('image/png'));
 for(const pt of parts){const node=doc.createNode(pt.name).setTranslation(pt.t||[0,0,0]); nodes[pt.name]=node;
  (pt.parent?nodes[pt.parent]:scene).addChild(node);
  if(pt.geo){const mesh=doc.createMesh(pt.name);
   for(const [g,m] of pt.geo){const acc=(t,a,A)=>doc.createAccessor().setType(t).setArray(new A(a)).setBuffer(buf);
    mesh.addPrimitive(doc.createPrimitive().setAttribute('POSITION',acc('VEC3',g.p,Float32Array)).setAttribute('NORMAL',acc('VEC3',g.n,Float32Array)).setAttribute('TEXCOORD_0',acc('VEC2',g.uv,Float32Array)).setIndices(acc('SCALAR',g.i,Uint16Array)).setMaterial(mat(...m)));}
   node.setMesh(mesh);}}
 if(anims){const an=doc.createAnimation(anims.name);
  for(const [nn,path,times,vals] of anims.tracks){const s=doc.createAnimationSampler().setInput(doc.createAccessor().setType('SCALAR').setArray(new Float32Array(times)).setBuffer(buf)).setOutput(doc.createAccessor().setType(path==='rotation'?'VEC4':'VEC3').setArray(new Float32Array(vals.flat())).setBuffer(buf)).setInterpolation('LINEAR');
   an.addSampler(s).addChannel(doc.createAnimationChannel().setTargetNode(nodes[nn]).setTargetPath(path).setSampler(s));}}
 return new NodeIO().write(`out/${file}`,doc);}
const q=(ax,deg)=>{const r=deg*Math.PI/360,s=Math.sin(r);return ax==='x'?[s,0,0,Math.cos(r)]:ax==='y'?[0,s,0,Math.cos(r)]:[0,0,s,Math.cos(r)];};
const T=[0,0.4,0.8,1.2];
const steps=(ax,deg)=>[0,1/3,2/3,1].map(f=>q(ax,deg*f));
// 1) Corrugated RSC box 400x300x300mm (4mm wall), 4 flaps open
{const W=.4,D=.3,H=.3,t=.005,k=['kraft',kraft,.9];
 const body=new Geo().box(0,t/2,0,W,t,D,2).box(0,H/2,D/2-t/2,W,H,t,2).box(0,H/2,-D/2+t/2,W,H,t,2).box(W/2-t/2,H/2,0,t,H,D,2).box(-W/2+t/2,H/2,0,t,H,D,2);
 build('corrugated-box.glb',[
  {name:'Body',geo:[[body,k]]},
  {name:'FlapFront',t:[0,H,D/2],geo:[[new Geo().box(0,t/2,-D/4,W,t,D/2,2),k]]},
  {name:'FlapBack',t:[0,H,-D/2],geo:[[new Geo().box(0,t/2,D/4,W,t,D/2,2),k]]},
  {name:'FlapLeft',t:[-W/2,H,0],geo:[[new Geo().box(D/4,t*1.5,0,D/2,t,D-.004,2),k]]},
  {name:'FlapRight',t:[W/2,H,0],geo:[[new Geo().box(-D/4,t*1.5,0,D/2,t,D-.004,2),k]]},
 ],{name:'Open',tracks:[['FlapFront','rotation',T,steps('x',110)],['FlapBack','rotation',T,steps('x',-110)],['FlapLeft','rotation',T,steps('z',115)],['FlapRight','rotation',T,steps('z',-115)]]});}
// 2) Rigid gift box 250x100x250 with lift-off lid + ribbon
{const W=.25,H=.1,t=.003,LH=.035,LW=W+.006,g=['gift',gift,.6],in_=['inner',inner,.8],rb=['ribbon',ribbon,.35,.6];
 const base=new Geo().box(0,t/2,0,W,t,W,4).box(0,H/2,W/2-t/2,W,H,t,4).box(0,H/2,-W/2+t/2,W,H,t,4).box(W/2-t/2,H/2,0,t,H,W,4).box(-W/2+t/2,H/2,0,t,H,W,4);
 const lid=new Geo().box(0,-t/2,0,LW,t,LW,4).box(0,-LH/2,LW/2-t/2,LW,LH,t,4).box(0,-LH/2,-LW/2+t/2,LW,LH,t,4).box(LW/2-t/2,-LH/2,0,t,LH,LW,4).box(-LW/2+t/2,-LH/2,0,t,LH,LW,4);
 const r=.022,rib=new Geo().box(0,.0008,0,r,.0016,LW+.002,8).box(0,.0008,0,LW+.002,.0016,r,8).box(0,-LH/2,LW/2+.001,r,LH,.0016,8).box(0,-LH/2,-LW/2-.001,r,LH,.0016,8).box(LW/2+.001,-LH/2,0,.0016,LH,r,8).box(-LW/2-.001,-LH/2,0,.0016,LH,r,8)
  .box(-.018,.008,0,.03,.012,.012,8).box(.018,.008,0,.03,.012,.012,8).box(0,.008,0,.012,.014,.014,8);
 build('gift-box.glb',[
  {name:'Base',geo:[[base,g],[new Geo().box(0,t+.0005,0,W-2*t,.001,W-2*t,4),in_]]},
  {name:'Lid',t:[0,H+.003,0],geo:[[lid,g],[rib,rb]]},
 ],{name:'Open',tracks:[['Lid','translation',T,[[0,H+.003,0],[0,H+.06,0],[.06,H+.11,-.06],[.12,H+.08,-.16]]],['Lid','rotation',T,[[0,0,0,1],q('x',-8),q('x',-25),q('x',-40)]]]});}
// 3) Wine box (single bottle, magnetic flip lid) 110x360x110
{const W=.11,H=.36,D=.11,t=.003,w=['wine',wine,.45,.1],in_=['inner',inner,.8];
 const LH=.06,body=new Geo().box(0,t/2,0,W,t,D,1).box(0,(H-LH)/2,D/2-t/2,W,H-LH,t,1).box(0,(H-LH)/2,-D/2+t/2,W,H-LH,t,1).box(W/2-t/2,(H-LH)/2,0,t,H-LH,D,1).box(-W/2+t/2,(H-LH)/2,0,t,H-LH,D,1);
 // lid hinged at back-top edge of body: cap covering top LH plus top plate
 const lid=new Geo().box(0,LH,D/2+t/2,W+2*t,t,D+2*t,1).box(0,LH/2,D+t,W+2*t,LH,t,1).box(W/2+t/2,LH/2,D/2,t,LH,D+2*t,1).box(-W/2-t/2,LH/2,D/2,t,LH,D+2*t,1).box(0,LH/2,0,W+2*t,LH,t,1);
 // simple bottle silhouette inside (dark glass)
 const bottle=new Geo().box(0,.15,0,.075,.28,.075,1).box(0,.31,0,.028,.06,.028,1);
 const glass=tex('glass',8,8,()=>[24,52,34]);
 build('wine-box.glb',[
  {name:'Body',geo:[[body,w],[new Geo().box(0,t+.0005,0,W-2*t,.001,D-2*t,1),in_],[bottle,['glass',glass,.15]]]},
  {name:'Lid',t:[0,H-LH,-D/2-t/2],geo:[[lid,w]]},
 ],{name:'Open',tracks:[['Lid','rotation',T,steps('x',-105)]]});}
