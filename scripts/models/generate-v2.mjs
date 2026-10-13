// v2 程序化模型：更贴近实物（参考常见商品实拍：RSC 纸箱、天地盖礼盒、单支磁吸翻盖酒盒等）
import { Document, NodeIO } from '@gltf-transform/core';
import sharp from 'sharp';
const OUT = process.argv[2] || 'out';
const only = process.argv[3];
const svgTex = (w, h, body) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`)).png().toBuffer();
const noise = (id, f = 0.9, op = 0.12) => `<filter id="${id}"><feTurbulence type="fractalNoise" baseFrequency="${f}" numOctaves="3" seed="3"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="linear" slope="${op}"/></feComponentTransfer></filter>`;
const grain = (w, h, id = 'n', f, op) => `<defs>${noise(id, f, op)}</defs><rect width="${w}" height="${h}" filter="url(#${id})"/>`;
const F = `font-family="Manrope, Sen, Asap, sans-serif"`;

class Geo { constructor() { this.p = []; this.n = []; this.uv = []; this.i = []; }
  box(cx, cy, cz, sx, sy, sz, uvr) { // uvr: [u0,v0,u1,v1] 区域；所有面共享
    const [u0, v0, u1, v1] = uvr ?? [0, 0, 1, 1], hx = sx / 2, hy = sy / 2, hz = sz / 2;
    const faces = [[[1,0,0],[0,0,-1],[0,1,0],sz,sy,hx],[[-1,0,0],[0,0,1],[0,1,0],sz,sy,hx],[[0,1,0],[1,0,0],[0,0,-1],sx,sz,hy],[[0,-1,0],[1,0,0],[0,0,1],sx,sz,hy],[[0,0,1],[1,0,0],[0,1,0],sx,sy,hz],[[0,0,-1],[-1,0,0],[0,1,0],sx,sy,hz]];
    for (const [N, U, V, w, h, d] of faces) { const b = this.p.length / 3;
      for (const [a, c] of [[-1,-1],[1,-1],[1,1],[-1,1]]) { for (let k = 0; k < 3; k++) this.p.push([cx,cy,cz][k] + N[k]*d + U[k]*a*w/2 + V[k]*c*h/2); this.n.push(...N); this.uv.push(u0 + (a+1)/2*(u1-u0), v1 - (c+1)/2*(v1-v0)); }
      this.i.push(b, b+1, b+2, b, b+2, b+3); }
    return this; }
  // 单面板（只朝 N 和 -N），uv 覆盖整张图，用于印刷面
  panel(c, N, U, V, w, h, uvr = [0,0,1,1], th = 0.0005) { return this.box(...c, ...[0,1,2].map(k => Math.abs(U[k])*w + Math.abs(V[k])*h + Math.abs(N[k])*th), uvr); }
  lathe(prof, seg = 48, cx = 0, cy = 0, cz = 0, vScale = 1, uRep = 1) { // prof: [[r,y],...] 自下而上
    const b = this.p.length / 3; let L = [0]; for (let j = 1; j < prof.length; j++) L.push(L[j-1] + Math.hypot(prof[j][0]-prof[j-1][0], prof[j][1]-prof[j-1][1]));
    for (let s = 0; s <= seg; s++) { const a = s / seg * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      for (let j = 0; j < prof.length; j++) { const [r, y] = prof[j]; const [r0, y0] = prof[Math.max(0, j-1)], [r1, y1] = prof[Math.min(prof.length-1, j+1)];
        let dr = r1 - r0, dy = y1 - y0; const l = Math.hypot(dr, dy) || 1; const nr = dy / l, ny = -dr / l;
        this.p.push(cx + r*sa, cy + y, cz + r*ca); this.n.push(nr*sa, ny, nr*ca); this.uv.push(s/seg*uRep, 1 - L[j]/L[L.length-1]*vScale); } }
    const P = prof.length; for (let s = 0; s < seg; s++) for (let j = 0; j < P-1; j++) { const a = b + s*P + j, c = a + P; this.i.push(a, c, a+1, a+1, c, c+1); }
    return this; }
  disc(r, y, up = 1, seg = 48, cx = 0, cz = 0) { const b = this.p.length / 3; this.p.push(cx, y, cz); this.n.push(0, up, 0); this.uv.push(.5, .5);
    for (let s = 0; s <= seg; s++) { const a = s/seg*Math.PI*2; this.p.push(cx + r*Math.sin(a), y, cz + r*Math.cos(a)); this.n.push(0, up, 0); this.uv.push(.5 + .5*Math.sin(a), .5 - .5*Math.cos(a)); }
    for (let s = 0; s < seg; s++) up > 0 ? this.i.push(b, b+1+s, b+2+s) : this.i.push(b, b+2+s, b+1+s); return this; }
  torus(R, r, cx, cy, cz, sx = 1, sz = 1, seg = 24, rs = 10, rotZ = 0) { const b = this.p.length / 3;
    for (let i = 0; i <= seg; i++) { const u = i/seg*Math.PI*2; for (let j = 0; j <= rs; j++) { const v = j/rs*Math.PI*2;
      let x = (R + r*Math.cos(v))*Math.cos(u)*sx, y = r*Math.sin(v), z = (R + r*Math.cos(v))*Math.sin(u)*sz;
      let nx = Math.cos(v)*Math.cos(u), ny = Math.sin(v), nz = Math.cos(v)*Math.sin(u);
      const c = Math.cos(rotZ), s = Math.sin(rotZ); [x, y] = [x*c - y*s, x*s + y*c]; [nx, ny] = [nx*c - ny*s, nx*s + ny*c];
      this.p.push(cx + x, cy + y, cz + z); this.n.push(nx, ny, nz); this.uv.push(i/seg, j/rs); } }
    for (let i = 0; i < seg; i++) for (let j = 0; j < rs; j++) { const a = b + i*(rs+1) + j, c = a + rs + 1; this.i.push(a, c, a+1, a+1, c, c+1); } return this; } }

async function build(file, parts, anims) {
  const doc = new Document(); const buf = doc.createBuffer(); const scene = doc.createScene('Scene'); const mats = {}; const nodes = {};
  const mat = (k, png, rough, metal = 0, extra = {}) => mats[k] ??= (() => { const m = doc.createMaterial(k).setRoughnessFactor(rough).setMetallicFactor(metal);
    if (png) m.setBaseColorTexture(doc.createTexture(k).setImage(png).setMimeType('image/png')); if (extra.color) m.setBaseColorFactor(extra.color); if (extra.double) m.setDoubleSided(true); if (extra.blend) m.setAlphaMode('BLEND'); return m; })();
  for (const pt of parts) { const node = doc.createNode(pt.name).setTranslation(pt.t || [0,0,0]); if (pt.r) node.setRotation(pt.r); nodes[pt.name] = node; (pt.parent ? nodes[pt.parent] : scene).addChild(node);
    if (pt.geo) { const mesh = doc.createMesh(pt.name);
      for (const [g, m] of pt.geo) { const acc = (t, a, A) => doc.createAccessor().setType(t).setArray(new A(a)).setBuffer(buf);
        mesh.addPrimitive(doc.createPrimitive().setAttribute('POSITION', acc('VEC3', g.p, Float32Array)).setAttribute('NORMAL', acc('VEC3', g.n, Float32Array)).setAttribute('TEXCOORD_0', acc('VEC2', g.uv, Float32Array)).setIndices(acc('SCALAR', g.i, g.p.length/3 > 65535 ? Uint32Array : Uint16Array)).setMaterial(mat(...m))); }
      node.setMesh(mesh); } }
  if (anims) { const an = doc.createAnimation(anims.name);
    for (const [nn, path, times, vals] of anims.tracks) { const s = doc.createAnimationSampler().setInput(doc.createAccessor().setType('SCALAR').setArray(new Float32Array(times)).setBuffer(buf)).setOutput(doc.createAccessor().setType(path === 'rotation' ? 'VEC4' : 'VEC3').setArray(new Float32Array(vals.flat())).setBuffer(buf)).setInterpolation('LINEAR');
      an.addSampler(s).addChannel(doc.createAnimationChannel().setTargetNode(nodes[nn]).setTargetPath(path).setSampler(s)); } }
  await new NodeIO().write(`${OUT}/${file}`, doc); console.log('built', file); }
const q = (ax, deg) => { const r = deg*Math.PI/360, s = Math.sin(r); return ax === 'x' ? [s,0,0,Math.cos(r)] : ax === 'y' ? [0,s,0,Math.cos(r)] : [0,0,s,Math.cos(r)]; };
const T = [0, .25, .5, .75, 1, 1.25];
const ease = (ax, deg) => T.map((_, i) => q(ax, deg * (1 - Math.cos(Math.PI * i / (T.length-1))) / 2));
const M = {};
const want = n => !only || only.split(',').includes(n);

// ---------- 共用贴图 ----------
const kraftBase = (w, h, c = '#c49a6c') => `<rect width="${w}" height="${h}" fill="${c}"/>${grain(w, h, 'k', .8, .18)}`;
const kraftTex = await svgTex(512, 512, kraftBase(512, 512));
const whiteBoard = await svgTex(64, 64, `<rect width="64" height="64" fill="#f1ece3"/>${grain(64, 64)}`);
const fluteTex = await svgTex(256, 64, `<rect width="256" height="64" fill="#b88a5a"/>${Array.from({length: 32}, (_, i) => `<path d="M${i*8} 32 q2 -14 4 0 t4 0" stroke="#8a6238" stroke-width="2" fill="none"/>`).join('')}`);

// 1) 瓦楞纸箱：RSC 400×300×300，侧面印刷 Logo/箭头/易碎标识 + 封箱胶带 + 运单贴
if (want('corrugated')) {
  const W = .4, D = .3, H = .3, t = .005;
  const side = await svgTex(1024, 768, kraftBase(1024, 768) + `<g fill="#3b2a1a" ${F}><text x="70" y="140" font-size="72" font-weight="700">PackJoyU</text><text x="72" y="190" font-size="30">CORRUGATED SHIPPING BOX · 5-PLY</text>
    <g transform="translate(840,90)" stroke="#3b2a1a" stroke-width="10" fill="none"><path d="M20 120 V20 M0 40 L20 10 L40 40"/><path d="M80 120 V20 M60 40 L80 10 L100 40"/></g>
    <g transform="translate(70,560)"><rect width="340" height="140" fill="none" stroke="#3b2a1a" stroke-width="4"/><text x="18" y="50" font-size="30">BOX MAKER CERTIFICATE</text><text x="18" y="95" font-size="24">BURST TEST 275 LB/IN²</text><text x="18" y="125" font-size="24">SIZE LIMIT 120 IN</text></g>
    <g transform="translate(820,560)"><path d="M30 20 h60 l-10 60 h-40 z" fill="none" stroke="#3b2a1a" stroke-width="6"/><path d="M60 80 v40 M35 125 h50" stroke="#3b2a1a" stroke-width="6"/><text x="-10" y="170" font-size="26">FRAGILE</text></g></g>`);
  const flap = await svgTex(512, 512, kraftBase(512, 512) + `<rect x="226" y="0" width="60" height="512" fill="#b98c55" opacity=".9"/><rect x="226" y="0" width="60" height="512" fill="#fff" opacity=".18"/>`);
  const label = await svgTex(256, 192, `<rect width="256" height="192" fill="#fbfaf6"/><g fill="#111" ${F}><text x="12" y="30" font-size="20" font-weight="700">SHIP TO</text><rect x="12" y="44" width="150" height="8"/><rect x="12" y="62" width="120" height="8"/><rect x="12" y="80" width="135" height="8"/>${Array.from({length: 46}, (_, i) => `<rect x="${12 + i*5}" y="110" width="${(i*7)%3 + 1}" height="60"/>`).join('')}</g>`);
  const k = ['kraft', kraftTex, .92], s = ['kraftPrint', side, .9], fl = ['flute', fluteTex, .95];
  const body = new Geo().box(0, t/2, 0, W, t, D)
    .box(0, H/2, D/2 - t/2, W, H, t, [0, 0, 1, 1]).box(0, H/2, -D/2 + t/2, W, H, t, [0, 0, 1, 1])
    .box(W/2 - t/2, H/2, 0, t, H, D, [0, 0, .75, 1]).box(-W/2 + t/2, H/2, 0, t, H, D, [0, 0, .75, 1]);
  const edges = new Geo().box(0, H - .001, D/2 - t/2, W, .002, t + .0004).box(0, H - .001, -D/2 + t/2, W, .002, t + .0004);
  build('corrugated-box.glb', [
    { name: 'Body', geo: [[body, s], [edges, fl], [new Geo().panel([.07, .17, D/2 + .0006], [0,0,1], [1,0,0], [0,1,0], .12, .09), ['label', label, .7]]] },
    { name: 'FlapFront', t: [0, H, D/2], geo: [[new Geo().box(0, t/2, -D/4 + .0005, W, t, D/2 - .001, [0, 0, 1, .5]), ['flap', flap, .9]]] },
    { name: 'FlapBack', t: [0, H, -D/2], geo: [[new Geo().box(0, t/2, D/4 - .0005, W, t, D/2 - .001, [0, .5, 1, 1]), ['flap', flap, .9]]] },
    { name: 'FlapLeft', t: [-W/2, H, 0], geo: [[new Geo().box(D/4, -t/2, 0, D/2 - .002, t, D - .006), k]] },
    { name: 'FlapRight', t: [W/2, H, 0], geo: [[new Geo().box(-D/4, -t/2, 0, D/2 - .002, t, D - .006), k]] },
  ], { name: 'Open', tracks: [['FlapFront', 'rotation', T, ease('x', 115)], ['FlapBack', 'rotation', T, ease('x', -115)], ['FlapLeft', 'rotation', T, ease('z', 120)], ['FlapRight', 'rotation', T, ease('z', -120)]] });
}

// 2) 礼盒：天地盖硬盒 250×250×100，珊瑚色特种纸 + 金色缎带蝴蝶结 + 内衬
if (want('gift')) {
  const W = .25, H = .1, t = .003, LH = .04, LW = W + .006;
  const paper = await svgTex(512, 512, `<rect width="512" height="512" fill="#e8654f"/>${grain(512, 512, 'g', 1.4, .1)}`);
  const lidTop = await svgTex(512, 512, `<rect width="512" height="512" fill="#e8654f"/>${grain(512, 512, 'g', 1.4, .1)}<text x="400" y="480" text-anchor="middle" fill="#f6d9a0" ${F} font-size="26" letter-spacing="6">PACKJOYU</text>`);
  const satin = await svgTex(128, 128, `<defs><linearGradient id="s" x1="0" x2="1"><stop offset="0" stop-color="#c9a24c"/><stop offset=".5" stop-color="#f4dc98"/><stop offset="1" stop-color="#c9a24c"/></linearGradient></defs><rect width="128" height="128" fill="url(#s)"/>`);
  const g = ['giftPaper', paper, .65], gt = ['giftLid', lidTop, .65], in_ = ['liner', whiteBoard, .85], rb = ['satin', satin, .3, .3];
  const wall = (h, y, w) => new Geo().box(0, y, w/2 - t/2, w, h, t).box(0, y, -w/2 + t/2, w, h, t).box(w/2 - t/2, y, 0, t, h, w).box(-w/2 + t/2, y, 0, t, h, w);
  const base = wall(H, H/2, W).box(0, t/2, 0, W, t, W);
  const lidWalls = wall(LH, -LH/2, LW), lidTopG = new Geo().box(0, -t/2, 0, LW, t, LW);
  const r = .024, rib = new Geo().box(0, .001, 0, r, .002, LW + .003).box(0, .001, 0, LW + .003, .002, r)
    .box(0, -LH/2, LW/2 + .0012, r, LH, .002).box(0, -LH/2, -LW/2 - .0012, r, LH, .002).box(LW/2 + .0012, -LH/2, 0, .002, LH, r).box(-LW/2 - .0012, -LH/2, 0, .002, LH, r);
  const bow = new Geo().torus(.03, .007, -.032, .02, 0, 1, .45, 24, 8, .5).torus(.03, .007, .032, .02, 0, 1, .45, 24, 8, -.5)
    .box(0, .012, 0, .02, .02, .022).box(-.03, .004, .02, .012, .003, .06).box(.03, .004, .02, .012, .003, .06);
  build('gift-box.glb', [
    { name: 'Base', geo: [[base, g], [new Geo().box(0, t + .004, 0, W - 2*t, .008, W - 2*t), in_]] },
    { name: 'Lid', t: [0, H + .004, 0], geo: [[lidWalls, g], [lidTopG, gt], [rib, rb], [bow, rb]] },
  ], { name: 'Open', tracks: [['Lid', 'translation', T, [[0, H+.004, 0], [0, H+.03, 0], [0, H+.08, 0], [.05, H+.12, -.06], [.11, H+.1, -.15], [.14, H+.06, -.2]]], ['Lid', 'rotation', T, [[0,0,0,1], q('x', -2), q('x', -10), q('x', -25), q('x', -40), q('x', -50)]]] });
}

// 3) 酒盒：单支磁吸翻盖 110×360×110，深色特种纸 + 烫金，内衬丝绒 + 玻璃酒瓶
if (want('wine')) {
  const W = .11, H = .36, D = .11, t = .003, LH = .07;
  const front = await svgTex(512, 1024, `<rect width="512" height="1024" fill="#1d1a1c"/>${grain(512, 1024, 'w', 1.2, .12)}<g stroke="#d4af5f" fill="none" stroke-width="5"><rect x="34" y="34" width="444" height="956"/><rect x="48" y="48" width="416" height="928" stroke-width="2"/></g><g fill="#d4af5f" ${F} text-anchor="middle"><text x="256" y="520" font-size="58" letter-spacing="6">RÉSERVE</text><text x="256" y="570" font-size="22" letter-spacing="10">PACKJOYU · MMXXVI</text><path d="M256 380 l20 40 h-40 z"/></g>`);
  const dark = await svgTex(256, 256, `<rect width="256" height="256" fill="#1d1a1c"/>${grain(256, 256, 'w', 1.2, .12)}`);
  const velvet = await svgTex(64, 64, `<rect width="64" height="64" fill="#5e1622"/>${grain(64, 64, 'v', 2, .2)}`);
  const lbl = await svgTex(256, 256, `<rect width="256" height="256" fill="#f3ead6"/><g fill="#3a2a1a" ${F} text-anchor="middle"><text x="128" y="110" font-size="30">Château</text><text x="128" y="150" font-size="18">CABERNET 2022</text></g>`);
  const w = ['wineFront', front, .5, .05], wd = ['wineDark', dark, .5, .05], vv = ['velvet', velvet, 1];
  const BH = H - LH;
  const body = new Geo().box(0, t/2, 0, W, t, D).box(0, BH/2, -D/2 + t/2, W, BH, t).box(W/2 - t/2, BH/2, 0, t, BH, D).box(-W/2 + t/2, BH/2, 0, t, BH, D);
  const frontP = new Geo().box(0, BH/2, D/2 - t/2, W, BH, t, [0, LH/H, 1, 1]);
  const lid = new Geo().box(0, LH, D/2 + t/2, W + 2*t, t, D + 2*t).box(W/2 + t/2, LH/2, D/2, t, LH, D + 2*t).box(-W/2 - t/2, LH/2, D/2, t, LH, D + 2*t).box(0, LH/2, 0, W + 2*t, LH, t);
  const lidFront = new Geo().box(0, LH/2, D + t, W + 2*t, LH, t, [0, 0, 1, LH/H]);
  const bottle = new Geo().lathe([[0, .005], [.036, .006], [.037, .02], [.037, .2], [.034, .225], [.022, .25], [.0135, .27], [.0135, .325], [.015, .328], [.015, .335], [0, .336]], 40);
  const label = new Geo().lathe([[.0375, .07], [.0375, .15]], 40, 0, 0, 0, 1, 1);
  const foil = new Geo().lathe([[.014, .3], [.014, .325], [.0155, .328], [.0155, .336], [0, .337]], 32);
  build('wine-box.glb', [
    { name: 'Body', geo: [[body, wd], [frontP, w], [new Geo().box(0, t + .006, 0, W - 2*t, .012, D - 2*t), vv], [bottle, ['glass', null, .08, 0, { color: [.08, .17, .1, 1] }]], [label, ['bottleLabel', lbl, .8, 0, { double: true }]], [foil, ['foil', null, .3, .9, { color: [.55, .1, .14, 1] }]]] },
    { name: 'Lid', t: [0, BH, -D/2 - t/2], geo: [[lid, wd], [lidFront, w]] },
  ], { name: 'Open', tracks: [['Lid', 'rotation', T, ease('x', -110)]] });
}

// ================= 其余 9 类（静态模型） =================
// 4) 彩盒：反插式（tuck-end）折叠彩盒 80×40×160，四色印刷
if (want('color')) {
  const W = .08, D = .04, H = .16, t = .0006;
  const art = await svgTex(1024, 1024, `<defs><linearGradient id="a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff7a59"/><stop offset=".55" stop-color="#ffb347"/><stop offset="1" stop-color="#4fb3bf"/></linearGradient></defs><rect width="1024" height="1024" fill="url(#a)"/><circle cx="760" cy="300" r="190" fill="#fff" opacity=".25"/><g fill="#fff" ${F}><text x="70" y="560" font-size="120" font-weight="800">GLOW</text><text x="74" y="620" font-size="40">VITAMIN C SERUM · 30 ml</text></g><rect x="70" y="860" width="240" height="70" rx="35" fill="#fff"/><text x="190" y="907" text-anchor="middle" fill="#ff7a59" ${F} font-size="34" font-weight="700">NEW</text>`);
  const sideArt = await svgTex(256, 1024, `<rect width="256" height="1024" fill="#4fb3bf"/><g fill="#fff" ${F} font-size="22"><text x="20" y="80">INGREDIENTS</text>${Array.from({length: 10}, (_, i) => `<rect x="20" y="${110 + i*30}" width="${150 + (i*37)%60}" height="8" opacity=".8"/>`).join('')}</g>${Array.from({length: 30}, (_, i) => `<rect x="${30 + i*6}" y="900" width="${(i*5)%3 + 1}" height="80" fill="#111"/>`).join('')}`);
  const a = ['colorBoxFront', art, .45], s = ['colorBoxSide', sideArt, .45];
  const g = new Geo().box(0, H/2, D/2 - t/2, W, H, t).box(0, H/2, -D/2 + t/2, W, H, t);
  const sides = new Geo().box(W/2 - t/2, H/2, 0, t, H, D).box(-W/2 + t/2, H/2, 0, t, H, D);
  const caps = new Geo().box(0, t/2, 0, W, t, D).box(0, H - t/2, 0, W, t, D).box(0, H + .006, -D/2 + .0006, W - .002, .012, t * 1.2);
  build('color-box.glb', [{ name: 'Carton', geo: [[g, a], [sides, s], [caps, s]] }]);
}
// 5) 纸浆模塑：30 枚蛋托 300×300
if (want('pulp')) {
  const pulp = await svgTex(256, 256, `<rect width="256" height="256" fill="#b9b2a6"/>${grain(256, 256, 'p', .6, .35)}`);
  const N = 6, S = .05, g = new Geo();
  const cell = [[0, .0], [.012, .002], [.02, .012], [.022, .028], [.026, .036], [.025, .038]];
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) g.lathe(cell, 20, (i - (N-1)/2)*S, 0, (j - (N-1)/2)*S);
  for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) g.lathe([[0, .046], [.008, .044], [.012, .036]], 12, (i - N/2)*S, 0, (j - N/2)*S);
  g.box(0, .037, 0, N*S + .01, .003, N*S + .01, [0, 0, 4, 4]);
  build('pulp-egg-tray.glb', [{ name: 'Tray', geo: [[g, ['pulp', pulp, 1, 0, { double: true }]]] }]);
}
const cupProfile = (h, rb, rt) => [[0, .002], [rb - .002, .002], [rb, .006], [rb, .008], ...Array.from({length: 8}, (_, i) => [rb + (rt - rb)*(i+1)/8, .008 + (h - .012)*(i+1)/8]), [rt + .002, h - .002], [rt + .003, h], [rt, h + .001]];
// 6) 纸杯：12oz 热饮杯 + 杯盖
if (want('cup')) {
  const wrap = await svgTex(1024, 512, `<rect width="1024" height="512" fill="#fdf8f2"/><rect y="300" width="1024" height="212" fill="#ff7a59"/>${Array.from({length: 8}, (_, i) => `<circle cx="${64 + i*128}" cy="300" r="40" fill="#ffb347"/>`).join('')}<g fill="#3b2a1a" ${F}><text x="512" y="190" text-anchor="middle" font-size="88" font-weight="800">COFFEE&amp;CO</text><text x="512" y="250" text-anchor="middle" font-size="32">FRESHLY ROASTED</text></g>`);
  const cup = new Geo().lathe(cupProfile(.11, .028, .045), 48, 0, 0, 0, 1, 1);
  const inside = new Geo().lathe([[.044, .108], [.029, .01], [0, .009]], 48);
  const lid = new Geo().lathe([[.047, .108], [.048, .118], [.04, .12], [.038, .128], [.012, .13], [0, .13]], 48);
  build('paper-cup.glb', [{ name: 'Cup', geo: [[cup, ['cupWrap', wrap, .55]], [inside, ['cupIn', whiteBoard, .6, 0, { double: true }]], [lid, ['lid', null, .35, 0, { color: [.95, .95, .93, 1] }]]] }]);
}
// 7) 派对用品：纸盘 + 纸杯 + 派对帽 + 吸管
if (want('party')) {
  const dots = await svgTex(512, 512, `<rect width="512" height="512" fill="#fff6e8"/>${Array.from({length: 64}, (_, i) => `<circle cx="${(i%8)*64 + 32 + (i>>3)%2*32}" cy="${(i>>3)*64 + 32}" r="12" fill="${['#ff7a59', '#4fb3bf', '#ffb347', '#a77bd8'][i%4]}"/>`).join('')}`);
  const stripes = await svgTex(512, 256, Array.from({length: 16}, (_, i) => `<rect x="${i*32}" width="32" height="256" fill="${i%2 ? '#ffb347' : '#ff7a59'}"/>`).join(''));
  const plate = new Geo().lathe([[0, .004], [.07, .004], [.085, .012], [.11, .018], [.112, .016], [.09, .006], [.07, 0], [0, 0]], 48);
  const hat = new Geo().lathe([[.055, 0], [0, .16]], 40, .17, 0, -.03, 1, 2).torus(.006, .006, 0, 0, 0).lathe([[0, .158], [.015, .165], [.017, .175], [0, .19]], 16, .17, 0, -.03);
  const cup = new Geo().lathe(cupProfile(.09, .025, .036), 40, -.15, 0, .05, 1, 1);
  const straw = new Geo().lathe([[.003, 0], [.003, .2]], 10, 0, 0, 0, 1, 4);
  build('party-supplies.glb', [
    { name: 'Plate', geo: [[plate, ['dots', dots, .7, 0, { double: true }]]] },
    { name: 'Hat', geo: [[hat, ['stripes', stripes, .6, 0, { double: true }]]] },
    { name: 'Cup', geo: [[cup, ['stripes', stripes, .6, 0, { double: true }]]] },
    { name: 'Straw', t: [-.135, .02, .06], r: [0, 0, -.13, .99], geo: [[straw, ['stripes', stripes, .6, 0, { double: true }]]] },
  ]);
}
// 8) 彩色印刷：三折页宣传册（半展开）+ 一叠传单
if (want('colorprint')) {
  const W = .1, H = .21, t = .0004;
  const pages = await Promise.all([['#ff7a59', 'BROCHURE'], ['#4fb3bf', 'SERVICES'], ['#ffb347', 'CONTACT']].map(([c, s], i) => svgTex(256, 512, `<rect width="256" height="512" fill="#fffaf3"/><rect width="256" height="200" fill="${c}"/><circle cx="${60 + i*60}" cy="120" r="50" fill="#fff" opacity=".35"/><text x="20" y="250" ${F} font-size="30" font-weight="800" fill="#2b2b2b">${s}</text>${Array.from({length: 9}, (_, k) => `<rect x="20" y="${280 + k*22}" width="${180 - (k*29)%60}" height="7" fill="#999"/>`).join('')}`)));
  const panel = (i) => new Geo().box(W/2, H/2, 0, W, H, t);
  build('color-printing.glb', [
    { name: 'Center', geo: [[panel(0), ['p1', pages[1], .8]]] },
    { name: 'Left', r: q('y', 200), geo: [[panel(1), ['p0', pages[0], .8]]] },
    { name: 'Right', t: [W, 0, 0], r: q('y', -25), geo: [[panel(2), ['p2', pages[2], .8]]] },
    { name: 'Flyers', t: [.06, 0, .12], r: [-.7071, 0, 0, .7071], geo: [[new Geo().box(0, 0, -.0015, .148, .21, .003), ['p0', pages[0], .8]]] },
  ]);
}
// 9) 胶印：精装画册（封面 + 书脊 + 内页）
if (want('offset')) {
  const W = .21, H = .28, T_ = .025;
  const cover = await svgTex(512, 683, `<rect width="512" height="683" fill="#24324a"/><rect x="40" y="40" width="432" height="420" fill="#e8b04a"/><circle cx="256" cy="250" r="140" fill="#ff7a59"/><circle cx="330" cy="200" r="80" fill="#4fb3bf" opacity=".85"/><g fill="#fff" ${F}><text x="40" y="560" font-size="60" font-weight="800">CATALOGUE</text><text x="40" y="610" font-size="26">OFFSET PRINTING · 2026</text></g>`);
  const pages = await svgTex(64, 64, `<rect width="64" height="64" fill="#f7f3ea"/>${Array.from({length: 16}, (_, i) => `<rect y="${i*4}" width="64" height="1" fill="#ddd5c5"/>`).join('')}`);
  const c = ['cover', cover, .5], p = ['pages', pages, .9];
  const g = new Geo().box(0, .0015, 0, W, .003, H).box(0, T_ - .0015, 0, W, .003, H);
  build('offset-catalog.glb', [{ name: 'Book', r: q('y', 20), geo: [[g, c], [new Geo().box(-W/2 - .0015, T_/2, 0, .003, T_, H), c], [new Geo().box(.003, T_/2, 0, W - .008, T_ - .006, H - .006), p]] }]);
}
// 10) 环保纸杯：牛皮纸杯 + PLA 盖 + 杯套
if (want('ecocup')) {
  const wrap = await svgTex(1024, 512, kraftBase(1024, 512, '#c9a676') + `<g fill="#3a2a1a" ${F}><text x="512" y="240" text-anchor="middle" font-size="84" font-weight="800">PackJoyU</text><text x="512" y="300" text-anchor="middle" font-size="30" letter-spacing="10">CUSTOM PAPER CUPS</text></g>${Array.from({length: 16}, (_, i) => `<circle cx="${40 + i*63}" cy="410" r="9" fill="#FF5A36" opacity=".85"/>`).join('')}`);  // 中性图案：不印无依据的环保/认证声明
  const sleeve = await svgTex(512, 128, kraftBase(512, 128, '#a87d4c') + Array.from({length: 32}, (_, i) => `<rect x="${i*16}" width="6" height="128" fill="#8a6238" opacity=".5"/>`).join(''));
  const cup = new Geo().lathe(cupProfile(.11, .028, .045), 48, 0, 0, 0, 1, 1);
  const inside = new Geo().lathe([[.044, .108], [.029, .01], [0, .009]], 48);
  const sl = new Geo().lathe([[.0365, .035], [.0425, .085]], 48, 0, 0, 0, 1, 2);
  const lid = new Geo().lathe([[.047, .108], [.048, .118], [.038, .124], [.012, .126], [0, .126]], 48);
  build('eco-paper-cup.glb', [{ name: 'Cup', geo: [[cup, ['ecoWrap', wrap, .8]], [inside, ['kraftIn', kraftTex, .9, 0, { double: true }]], [sl, ['sleeve', sleeve, .95, 0, { double: true }]], [lid, ['plaLid', null, .5, 0, { color: [.93, .9, .82, 1] }]]] }]);
}
// 11) 礼品卡：卡片 + 信封
if (want('giftcard')) {
  const card = await svgTex(512, 323, `<defs><linearGradient id="c" x1="0" x2="1"><stop offset="0" stop-color="#ff7a59"/><stop offset="1" stop-color="#a77bd8"/></linearGradient></defs><rect width="512" height="323" rx="24" fill="url(#c)"/><g fill="#fff" ${F}><text x="36" y="80" font-size="44" font-weight="800">GIFT CARD</text><text x="36" y="270" font-size="56" font-weight="800">$50</text></g><rect x="380" y="40" width="90" height="64" rx="10" fill="#f4dc98"/>`);
  const env = await svgTex(256, 256, `<rect width="256" height="256" fill="#f6efe2"/>${grain(256, 256)}<path d="M0 0 L128 110 L256 0" stroke="#d9cbb0" stroke-width="3" fill="none"/>`);
  build('gift-card.glb', [
    { name: 'Envelope', geo: [[new Geo().box(0, .001, 0, .17, .002, .115), ['env', env, .9]]] },
    { name: 'Card', t: [.025, .004, -.03], r: q('y', -12), geo: [[new Geo().box(0, 0, 0, .0856, .0008, .054), ['card', card, .35]]] },
  ]);
}
// 12) 圣诞周边：圆筒礼盒（纸罐）+ 球形挂饰
if (want('xmas')) {
  const tube = await svgTex(1024, 512, `<rect width="1024" height="512" fill="#b3202e"/>${Array.from({length: 40}, (_, i) => `<g transform="translate(${(i*97)%1024},${(i*61)%512})" stroke="#fff" stroke-width="3" opacity=".8"><path d="M-12 0 H12 M0 -12 V12 M-8 -8 L8 8 M-8 8 L8 -8"/></g>`).join('')}<g fill="#f4dc98" ${F}><text x="512" y="280" text-anchor="middle" font-size="76" font-weight="800">MERRY CHRISTMAS</text></g>`);
  const capT = await svgTex(256, 256, `<rect width="256" height="256" fill="#1f5a3a"/>${grain(256, 256)}`);
  const body = new Geo().lathe([[.05, 0], [.05, .16]], 48, 0, 0, 0, 1, 1).disc(.05, 0, -1);
  const cap = new Geo().lathe([[.0515, .13], [.0515, .182], [0, .182]], 48);
  const ball = new Geo().lathe(Array.from({length: 13}, (_, i) => { const a = -Math.PI/2 + i/12*Math.PI; return [Math.max(0, .035*Math.cos(a)), .035 + .035*Math.sin(a)]; }), 32, .1, 0, .03).lathe([[.008, .068], [.008, .078], [0, .078]], 12, .1, 0, .03);
  build('christmas-tube.glb', [{ name: 'Tube', geo: [[body, ['xmasTube', tube, .55]], [cap, ['xmasCap', capT, .6]], [ball, ['bauble', null, .15, .8, { color: [.85, .65, .25, 1] }]]] }]);
}
