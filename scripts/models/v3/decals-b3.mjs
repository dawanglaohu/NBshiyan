// #77 batch 3 印刷贴图（自绘 SVG，CC0 自有）：纸杯 / 牛皮纸杯 / 派对用品 + 彩盒字标加粗。品牌仅 PackJoyU，无环保/认证声明
import sharp from 'sharp';
const O = process.argv[2] ?? 'tex-b3/';
const w = (f, W, H, b) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${b}</svg>`)).png().toFile(O + f);
const NAVY = process.env.NAVY_PRINT ?? '#020924';  // #252b：目标 #1f2a44 的印刷输入色（按 linear + AgX、LIGHT 0.6 迭代求解，渲染实测 ΔE76 7.0）
// 字标：Inter Black + 同色描边加粗
const mark = (x, y, size, fill = NAVY, sw = size*.045) => `<text x="${x}" y="${y}" text-anchor="middle" font-family="Inter" font-weight="900" font-size="${size}" fill="${fill}" stroke="${fill}" stroke-width="${sw}" stroke-linejoin="round">PackJoyU</text>`;
// 纸杯：u=0.5 朝镜头；可见宽 ≈ 半周 = 512px → 字标 ≤ 60% ≈ 300px，取 ~270px
await w('cup_wrap.png', 1024, 512, `<rect width="1024" height="512" fill="#fbf8f3"/>${mark(512, 268, 60)}`);
// 牛皮纸杯：#8e5f36，杯套之上一圈 PackJoyU（4 个，其中一个居中朝镜头）
await w('ecocup_wrap.png', 1024, 512, `<rect width="1024" height="512" fill="#8e5f36"/>${[128, 384, 640, 896].map(x => mark(x, 66, 40, '#2a1c10')).join('')}`);
await w('sleeve.png', 512, 128, `<rect width="512" height="128" fill="#6f4724"/>${Array.from({length: 32}, (_, i) => `<rect x="${i*16}" width="6" height="128" fill="#5f3b1d" opacity=".55"/>`).join('')}`);
// 派对用品
await w('party_dots.png', 512, 512, `<rect width="512" height="512" fill="#fff6e8"/>${Array.from({length: 64}, (_, i) => `<circle cx="${(i%8)*64 + 32 + (i>>3)%2*32}" cy="${(i>>3)*64 + 32}" r="12" fill="${['#ff7a59', '#4fb3bf', '#ffb347', '#a77bd8'][i%4]}"/>`).join('')}`);
await w('party_stripes.png', 512, 256, Array.from({length: 16}, (_, i) => `<rect x="${i*32}" width="32" height="256" fill="${i%2 ? '#ffb347' : '#ff7a59'}"/>`).join(''));
await w('party_cup.png', 1024, 512, `${Array.from({length: 32}, (_, i) => `<rect x="${i*32}" width="32" height="512" fill="${i%2 ? '#ffb347' : '#ff7a59'}"/>`).join('')}<rect y="190" width="1024" height="120" fill="#fff6e8"/>${mark(512, 270, 54)}`);
// 彩盒（沿用 b2 版面，字标改 Inter Black + 描边）；正面 384×768 控制预览体积
const grad = `<defs><linearGradient id="a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff7a59"/><stop offset=".55" stop-color="#ffb347"/><stop offset="1" stop-color="#4fb3bf"/></linearGradient></defs>`;
await w('colorbox_front.png', 512, 1024, `${grad}<rect width="512" height="1024" fill="url(#a)"/><circle cx="360" cy="300" r="150" fill="#fff" opacity=".25"/>${mark(256, 600, 96)}<text x="256" y="655" text-anchor="middle" font-family="Inter" font-weight="700" font-size="28" fill="${NAVY}">CUSTOM PRINTED BOXES</text>`);
await w('colorbox_lid.png', 512, 256, `${grad}<rect width="512" height="256" fill="url(#a)"/>${mark(256, 150, 58)}`);
console.log('ok');
