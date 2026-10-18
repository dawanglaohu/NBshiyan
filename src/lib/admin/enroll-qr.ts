import qrcode from 'qrcode-generator';

// 单独一个文件：只有 /admin-enroll 页面引入，二维码库不会被打进其他后台页面
/**
 * 在本地把 otpauth URI 编成二维码，输出 SVG data URL（给 <img src> 用，CSP 已允许 img-src data:）。
 * SVG 由我们自己按模块拼成只含 rect/path 的固定结构，不含任何输入文本，不走外部服务。
 */
export function qrSvgDataUrl(text: string, margin = 4): string {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const size = n + margin * 2;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + margin} ${r + margin}h1v1h-1z`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
