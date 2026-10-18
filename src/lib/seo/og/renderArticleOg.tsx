import { ImageResponse } from 'next/og';
import { ArticleOgImage } from './ArticleOgImage';
import { articleOgFonts } from './articleOgFonts';
import { OG_ARTICLE, ogSafeText } from './articleOgLayout';

/**
 * 文章分享图唯一的渲染入口：路由 src/app/[locale]/articles/[slug]/og/route.tsx 只调这一个函数，测试也调它。
 * - 标题在这里统一过 ogSafeText（去掉 Manrope 子集里没有的字符），之后才交给 Satori，所以 Satori 不会去网上补字体或 emoji。
 * - 字体只读本地 src/assets/og-fonts（articleOgFonts）。
 * - 结果完整读进内存：ImageResponse 是流式的，不读完的话渲染错误会在 200 之后才出现。
 * 返回 PNG；过滤后没有可渲染的标题或结果为空时返回 null（调用方回退到通用图）。渲染出错照常抛出。
 * opts.badge（#350）：右上角标签。不传 = 文章默认「Article / Статья」（文章输出不变）；传了也先过 ogSafeText，过滤后为空就不画标签。
 */
export async function renderArticleOgPng(rawTitle: unknown, locale: 'en' | 'ru', opts?: { badge?: unknown }): Promise<ArrayBuffer | null> {
  const title = typeof rawTitle === 'string' ? ogSafeText(rawTitle) : '';
  if (!title) return null;
  const badge = opts && 'badge' in opts && opts.badge !== undefined ? (typeof opts.badge === 'string' ? ogSafeText(opts.badge) : '') : undefined;
  const res = new ImageResponse(<ArticleOgImage title={title} locale={locale} badge={badge} />, { ...OG_ARTICLE, fonts: await articleOgFonts() });
  const png = await res.arrayBuffer();
  return png.byteLength ? png : null;
}
