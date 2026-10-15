// #77 batch 2 印刷贴图（自绘 SVG，CC0 自有）：彩盒 / 圣诞纸罐。品牌仅 PackJoyU；无 NEW 标、无成分表、无条码；圣诞罐不印 MER… 文字
import sharp from 'sharp';
const O = process.argv[2] ?? 'tex-b2/';
const w = (f, W, H, b) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${b}</svg>`)).png().toFile(O + f);
const F = 'font-family="Manrope, Inter, sans-serif"';
const grad = `<defs><linearGradient id="a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff7a59"/><stop offset=".55" stop-color="#ffb347"/><stop offset="1" stop-color="#4fb3bf"/></linearGradient></defs>`;
// 彩盒正/背面 80×160mm → 512×1024
await w('colorbox_front.png', 512, 1024, `${grad}<rect width="512" height="1024" fill="url(#a)"/><circle cx="360" cy="300" r="150" fill="#fff" opacity=".25"/><g fill="#1f2a44" ${F}><text x="256" y="600" text-anchor="middle" font-size="92" font-weight="800">PackJoyU</text><text x="256" y="650" text-anchor="middle" font-size="27" letter-spacing="1">CUSTOM PRINTED BOXES</text></g>`);
await w('colorbox_side.png', 256, 1024, `${grad}<rect width="256" height="1024" fill="url(#a)"/>`);
await w('colorbox_lid.png', 512, 256, `${grad}<rect width="512" height="256" fill="url(#a)"/><text x="256" y="148" text-anchor="middle" fill="#1f2a44" ${F} font-size="54" font-weight="800">PackJoyU</text>`);
// 圣诞纸罐：周长 314mm × 高 160mm
await w('xmas_tube.png', 1024, 512, `<rect width="1024" height="512" fill="#b3202e"/>${Array.from({length: 40}, (_, i) => `<g transform="translate(${(i*97)%1024},${(i*61)%512})" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity=".85"><path d="M-12 0 H12 M0 -12 V12 M-8 -8 L8 8 M-8 8 L8 -8"/></g>`).join('')}`);
await w('xmas_captop.png', 512, 512, `<rect width="512" height="512" fill="#1f5a3a"/><circle cx="256" cy="256" r="150" fill="none" stroke="#e9d9a6" stroke-width="5"/><text x="256" y="272" text-anchor="middle" fill="#e9d9a6" ${F} font-size="54" font-weight="800">PackJoyU</text>`);
console.log('ok');
