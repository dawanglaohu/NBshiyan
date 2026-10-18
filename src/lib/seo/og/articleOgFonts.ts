import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Satori 只认 TTF/OTF/WOFF 的静态字重：Manrope 800/600，含拉丁 + 西里尔（design/og-src/og-article-font.py 生成）。
// standalone 构建靠 next.config.ts 的 outputFileTracingIncludes 把这两个文件带进镜像。
const DIR = path.join(process.cwd(), 'src/assets/og-fonts');
let cache: Promise<{ name: string; data: ArrayBuffer; weight: 800 | 600; style: 'normal' }[]> | null = null;

export function articleOgFonts() {
  cache ??= Promise.all([
    readFile(path.join(DIR, 'Manrope-ExtraBold.ttf')),
    readFile(path.join(DIR, 'Manrope-SemiBold.ttf'))
  ]).then(([b, s]) => [
    { name: 'Manrope', data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, weight: 800 as const, style: 'normal' as const },
    { name: 'Manrope', data: s.buffer.slice(s.byteOffset, s.byteOffset + s.byteLength) as ArrayBuffer, weight: 600 as const, style: 'normal' as const }
  ]).catch((e) => { cache = null; throw e; });
  return cache;
}
