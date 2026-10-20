import { aboutImageAttrs, type AboutImage, type AboutStat } from '@/lib/about/model';

// #350 /about 和首页区块共用的数据条、图片。只渲染后台填的内容；空数组时调用方整块不渲染。

/** 数据条：<dl>，按条数 1–4 均分列（spec §2.4）。数值和说明都来自后台，代码里没有任何默认数字 */
export function AboutStats({ stats, className = '' }: { stats: AboutStat[]; className?: string }) {
  return (
    <dl className={`ab-stats-list ${className}`.trim()} data-count={stats.length}>
      {stats.map((s, i) => (
        <div key={`${i}-${s.label}`} className="sx-kpi">
          <dt>{s.label}</dt>
          <dd>{s.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * sizes 按布局（UX spec v1.0.10 + SEO P3 ①）。布局断点是 about.css 的 768px（≤767px 是手机的 2 列 / 首图整行）：
 * - /about 第 1 张（桌面 2×2，占 3 列里的 2 列）：桌面 66vw、手机 100vw
 * - /about 其余：桌面 33vw（3 列）、手机 50vw（2 列）
 * spec 原文写的是 (min-width:1024px)，但 768–1023px 已经是 3 列布局，按实际断点写 768px（PR 正文「和 spec 不同」）
 */
export const ABOUT_IMAGE_SIZES = {
  lead: '(min-width: 768px) 66vw, 100vw',
  rest: '(min-width: 768px) 33vw, 50vw',
} as const;
export const aboutImageSizes = (index: number): string => (index === 0 ? ABOUT_IMAGE_SIZES.lead : ABOUT_IMAGE_SIZES.rest);
/** 首页区块的图（桌面 4 列；手机横向滑动、每张 78% 宽） */
export const HOME_IMAGE_SIZES = '(min-width: 768px) 25vw, 78vw';

/**
 * 前台统一 4:3 居中裁切（UX spec v1.0.10）：裁切由外层 .ab-fig-box 的 aspect-ratio: 4/3 + img 的 object-fit: cover 完成，
 * img 的 width / height 仍是文件实际宽高（只用来占位比例，避免 CLS），存储的文件不裁。
 * lazy=false：/about 第 1 张（正文很短时一打开就在首屏，SEO P3 ②）。
 */
export function AboutFigure({ img, sizes, lazy = true }: { img: AboutImage; sizes: string; lazy?: boolean }) {
  const a = aboutImageAttrs(img);
  return (
    <figure className="ab-fig">
      <div className="ab-fig-box">
        {/* PublicAsset 两种尺寸：srcset 的 w 描述符和 width / height 用 sm / lg 的实际宽高（URL 里的 800 / 1600 是名义长边）；/media 已是重新编码好的 WebP，不再走 next/image */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={a.src} srcSet={a.srcSet}
          sizes={sizes} width={a.width} height={a.height} alt={img.alt}
          loading={lazy ? 'lazy' : 'eager'} decoding="async"
        />
      </div>
      {img.caption?.trim() ? <figcaption>{img.caption}</figcaption> : null}
    </figure>
  );
}
