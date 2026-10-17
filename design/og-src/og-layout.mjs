// Shared layout for render-og*.mjs (1200x630 share images).
// - bindText: non-breaking spaces so RU one-letter prepositions/conjunctions (с в и к о у а) stick to the next word,
//   and a 1-2 character last word (e.g. "3D") sticks to the word before it.
// - cropPoster: crops a 3D poster to the product's bounding box (pixels that differ from the poster's corner background),
//   pads it with background colour, and reports product size so every image can show the product at the same visual size.
// - productArt: places a cropped poster so tall items are TALL_H px high and wide items WIDE_W px wide, centred in the right column.
// - page + renderJobs: one template/runner (headline fit, widow fix, safe-area + product/text overlap check, JPG < 100 KB).
import fs from 'node:fs';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

export const W = 1200, H = 630;
export const SAFE = { left: 60, top: 35, width: 1080, height: 560 };
export const TEXT_W = 520, GAP = 40;
export const COL = { left: SAFE.left + TEXT_W + GAP, right: SAFE.left + SAFE.width };   // right column 620..1140
export const TALL_H = 360;   // ~57% of 630
export const WIDE_W = 510;   // ~42.5% of 1200
export const WIDE_ASPECT = 1.3;

const NB = '\u00a0';
export function bindText(s, locale) {
  let t = s.trim().replace(/\s+/g, ' ');
  if (locale === 'ru') {
    let prev;
    do { prev = t; t = t.replace(/(^|[\s\u00a0])([свикоуа])\s/giu, (m, a, b) => a + b + NB); } while (t !== prev);
  }
  const parts = t.split(' ');
  if (parts.length > 2 && parts[parts.length - 1].length <= 2) t = parts.slice(0, -2).join(' ') + ' ' + parts.slice(-2).join(NB);
  else if (parts.length === 2 && parts[1].length <= 2) t = parts.join(NB);
  return t;
}
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
export const words = (s, locale) => bindText(s, locale).split(' ').map((w) => `<span class="w">${esc(w)}</span>`).join(' ');

const b64 = (f) => 'data:image/' + (f.endsWith('.png') ? 'png' : 'webp') + ';base64,' + fs.readFileSync(f).toString('base64');

// Runs in the browser: bbox of pixels whose max channel distance from the corner background > threshold.
export async function cropPoster(pg, file, { pad = 0.10, threshold = 20 } = {}) {
  return pg.evaluate(async ({ src, pad, threshold }) => {
    const img = new Image(); img.src = src; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const x = c.getContext('2d'); x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data, Wd = c.width, Hd = c.height;
    const px = (i) => [d[i], d[i + 1], d[i + 2]];
    const corners = []; for (const [cx, cy] of [[0, 0], [Wd - 8, 0], [0, Hd - 8], [Wd - 8, Hd - 8]]) for (let j = 0; j < 8; j++) for (let k = 0; k < 8; k++) corners.push(px(((cy + j) * Wd + cx + k) * 4));
    const med = [0, 1, 2].map((ch) => corners.map((p) => p[ch]).sort((a, b) => a - b)[corners.length >> 1]);
    let x0 = Wd, y0 = Hd, x1 = -1, y1 = -1;
    for (let yy = 0; yy < Hd; yy++) for (let xx = 0; xx < Wd; xx++) { const i = (yy * Wd + xx) * 4;
      if (Math.max(Math.abs(d[i] - med[0]), Math.abs(d[i + 1] - med[1]), Math.abs(d[i + 2] - med[2])) > threshold) { if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (yy < y0) y0 = yy; if (yy > y1) y1 = yy; } }
    if (x1 < 0) throw new Error('empty poster');
    const pw = x1 - x0 + 1, ph = y1 - y0 + 1, p = Math.round(pad * Math.max(pw, ph));
    const o = document.createElement('canvas'); o.width = pw + 2 * p; o.height = ph + 2 * p;
    const ox = o.getContext('2d'); const bg = `rgb(${med.join(',')})`; ox.fillStyle = bg; ox.fillRect(0, 0, o.width, o.height);
    ox.drawImage(c, x0 - p, y0 - p, o.width, o.height, 0, 0, o.width, o.height);
    return { url: o.toDataURL('image/png'), pw, ph, p, cw: o.width, ch: o.height, bg, bbox: [x0, y0, x1, y1] };
  }, { src: b64(file), pad, threshold });
}

// <img> absolutely positioned so the product's centre is at (cx, cy) and its size is scaled by s.
export function placed(crop, s, cx, cy, extra = '') {
  const w = crop.cw * s, h = crop.ch * s, f = ((crop.p / crop.cw) * 100 * 0.9).toFixed(2), g = ((crop.p / crop.ch) * 100 * 0.9).toFixed(2);
  const mask = `linear-gradient(to right,transparent,#000 ${f}%,#000 ${100 - f}%,transparent),linear-gradient(to bottom,transparent,#000 ${g}%,#000 ${100 - g}%,transparent)`;
  return { html: `<img class="art" src="${crop.url}" style="left:${(cx - w / 2).toFixed(1)}px;top:${(cy - h / 2).toFixed(1)}px;width:${w.toFixed(1)}px;height:${h.toFixed(1)}px;-webkit-mask-image:${mask};-webkit-mask-composite:source-in;mask-image:${mask};mask-composite:intersect;${extra}">`,
    box: [cx - (crop.pw * s) / 2, cy - (crop.ph * s) / 2, cx + (crop.pw * s) / 2, cy + (crop.ph * s) / 2] };
}

// One product, same visual size rule for every category/product image.
export function productArt(crop) {
  const wide = crop.pw / crop.ph > WIDE_ASPECT;
  let s = wide ? WIDE_W / crop.pw : TALL_H / crop.ph;
  s = Math.min(s, WIDE_W / crop.pw, 420 / crop.ph);
  const cx = (COL.left + COL.right) / 2, cy = SAFE.top + SAFE.height / 2;
  const r = placed(crop, s, cx, cy);
  return { ...r, wide, size: wide ? crop.pw * s : crop.ph * s };
}

// A non-overlapping, gently staggered row of several products with the same product height.
export function productRow(crops, { gap = 24, stagger = 22, left = COL.left - 20, right = COL.right } = {}) {
  const ratio = crops.reduce((a, c) => a + c.pw / c.ph, 0);
  const h = Math.min(300, (right - left - gap * (crops.length - 1)) / ratio);
  let x = left + (right - left - (ratio * h + gap * (crops.length - 1))) / 2; const cy = SAFE.top + SAFE.height / 2;
  const out = crops.map((c, i) => { const s = h / c.ph, w = c.pw * s; const r = placed(c, s, x + w / 2, cy + (i % 2 ? -stagger : stagger)); x += w + gap; return r; });
  return { html: out.map((o) => o.html).join(''), boxes: out.map((o) => o.box), h };
}

export const page = ({ title, sub, locale, dark, bgColor, art = '', side = '', full = '', textW = TEXT_W }) => `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><style>
*{margin:0;box-sizing:border-box}body{width:${W}px;height:${H}px;overflow:hidden;position:relative;font-family:Manrope,sans-serif;background:${bgColor || (dark ? '#121214' : '#FBF8F3')};color:${dark ? '#F2E9D8' : '#1C1C1C'}}
.safe{position:absolute;left:${SAFE.left}px;top:${SAFE.top}px;width:${SAFE.width}px;height:${SAFE.height}px;display:flex;align-items:center;gap:${GAP}px;z-index:1}
.l{flex:0 0 ${textW}px;min-width:0;display:flex;flex-direction:column;gap:26px}.wm{font-size:34px;font-weight:800;letter-spacing:-.01em}.wm i{font-style:normal;color:${dark ? '#D4AF6A' : '#FF5A36'}}
h1{font-size:${title.length > 24 ? 58 : 70}px;line-height:1.05;font-weight:800;letter-spacing:-.02em;overflow-wrap:normal;word-break:normal;hyphens:none;text-wrap:balance}
.bar{width:90px;height:8px;border-radius:4px;background:${dark ? '#D4AF6A' : '#FF5A36'}}
p{font-size:26px;color:${dark ? '#BFB6A6' : '#5A5650'};font-weight:600;text-wrap:balance}.r{flex:1;display:grid;place-items:center;height:100%}
.art{position:absolute;z-index:0;display:block}
.bg{position:absolute;inset:0;width:1200px;height:630px;object-fit:cover;object-position:62% 50%;transform:translate(48px,-14px) scale(1.06);transform-origin:74% 52%}
.edge{position:absolute;right:0;bottom:0;width:1200px;height:10px;background:${dark ? '#D4AF6A' : '#FF5A36'};z-index:2}</style></head><body>
${full}${art}<div class="safe"><div class="l"><div class="wm">Pack<i>Joy</i>U</div><div class="bar"></div><h1>${words(title, locale)}</h1>${sub ? `<p>${words(sub, locale)}</p>` : ''}</div><div class="r">${side}</div></div><div class="edge"></div></body></html>`;

// In-page: shrink h1 until no unbreakable token is wider than the column; then if the last line holds a single token
// (EN only, 3+ tokens), glue the last two tokens with a no-break space and refit (kept only if font stays >= 50px).
const FIT = () => {
  const h = document.querySelector('h1');
  const fit = () => { let f = parseFloat(getComputedStyle(h).fontSize); const Wc = h.clientWidth;
    while ([...h.querySelectorAll('.w')].some((c) => c.getBoundingClientRect().width > Wc + .5) && f > 40) { f -= 2; h.style.fontSize = f + 'px'; } return f; };
  const lines = (el) => { const ws = [...el.querySelectorAll('.w')]; const tops = [...new Set(ws.map((w) => Math.round(w.getBoundingClientRect().top)))]; return { ws, tops, last: ws.filter((w) => Math.round(w.getBoundingClientRect().top) === tops[tops.length - 1]).reduce((n, w) => n + w.textContent.split(/[\s\u00a0]+/).length, 0) }; };
  const f0 = fit(); let widowFixed = false;
  let L = lines(h);
  if (document.documentElement.lang === 'en' && L.tops.length > 1 && L.last === 1 && L.ws.length >= 3) {
    const save = h.innerHTML, fs0 = h.style.fontSize; const ws = L.ws; ws[ws.length - 2].textContent += '\u00a0' + ws[ws.length - 1].textContent; ws[ws.length - 1].previousSibling?.remove?.(); ws[ws.length - 1].remove();
    const f1 = fit(); if (f1 < 50 || f1 < f0 - 12) { h.innerHTML = save; h.style.fontSize = fs0; } else widowFixed = true;
  }
  L = lines(h); const p = document.querySelector('.l p'); const P = p ? lines(p) : null;
  const ends = (el) => { const ws = [...el.querySelectorAll('.w')]; const out = []; ws.forEach((w, i) => { const n = ws[i + 1]; if (n && Math.round(n.getBoundingClientRect().top) > Math.round(w.getBoundingClientRect().top)) out.push(w.textContent.split('\u00a0').pop()); }); return out; };
  const lineEnds = [...ends(h), ...(p ? ends(p) : [])];
  const s = document.querySelector('.safe').getBoundingClientRect();
  const inSafe = [...document.querySelectorAll('.l *')].every((e) => { const r = e.getBoundingClientRect(); return r.left >= s.left - .5 && r.right <= s.right + .5 && r.top >= s.top - .5 && r.bottom <= s.bottom + .5; });
  const noWordOverflow = ![...document.querySelectorAll('h1 .w')].some((c) => c.getBoundingClientRect().width > h.clientWidth + .5);
  const textRight = Math.max(...[...document.querySelectorAll('.l .wm,.l .w,.l .bar')].map((e) => e.getBoundingClientRect().right));
  const textBox = (() => { const r = document.querySelector('.l').getBoundingClientRect(); return [r.left, r.top, textRight, r.bottom]; })();
  return { font: parseFloat(getComputedStyle(h).fontSize), lines: L.tops.length, widow: L.tops.length > 1 && L.last === 1, widowFixed, subWidow: P ? P.tops.length > 1 && P.last === 1 : false, lineEnds, ok: inSafe && noWordOverflow, textBox };
};

export async function renderJobs(R, jobs) {
  const b = await chromium.launch(); const pg = await b.newPage({ viewport: { width: W, height: H } }); const out = [];
  for (const j of jobs) {
    if (j.prepare) Object.assign(j, await j.prepare(pg));
    await pg.setContent(page(j)); await pg.evaluate(() => document.fonts.ready);
    const m = await pg.evaluate(FIT);
    const fam = await pg.evaluate(() => document.fonts.check('800 70px Manrope', 'Яя'));
    const boxes = j.boxes || [];
    const clear = boxes.every((bx) => bx[0] >= m.textBox[2] + 16 && bx[0] >= 0 && bx[1] >= 0 && bx[2] <= W && bx[3] <= H - 10);
    const shortEnd = m.lineEnds.filter((w) => /^[свикоуа]$/iu.test(w));
    let q = 88, buf; do { buf = await pg.screenshot({ type: 'jpeg', quality: q }); q -= 6; } while (buf.length > 100 * 1024 && q > 40);
    fs.writeFileSync(`${R}/public/og/${j.file}`, buf);
    out.push({ file: j.file, title: j.title, kb: +(buf.length / 1024).toFixed(1), q: q + 6, ok: m.ok, font: m.font, lines: m.lines, widow: m.widow, widowFixed: m.widowFixed, subWidow: m.subWidow, badLineEnd: shortEnd, artClear: clear, art: j.artInfo || '', manrope: fam });
  }
  await b.close();
  for (const o of out) console.log(Object.values(o).map((v) => (Array.isArray(v) ? v.join('/') || '-' : v)).join(' | '));
  const bad = out.filter((o) => !o.ok || !o.artClear || o.badLineEnd.length || !o.manrope);
  if (bad.length) { console.error('CHECK FAILED: ' + bad.map((o) => o.file).join(', ')); process.exitCode = 1; }
  return out;
}
