import type { AboutImage, AboutStat } from '@/lib/about/model';

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

/** 后端定的 sizes（about 页和首页共用） */
export const ABOUT_IMAGE_SIZES = '(min-width: 1024px) 50vw, 100vw';

export function AboutFigure({ img, sizes, lazy = true }: { img: AboutImage; sizes: string; lazy?: boolean }) {
  return (
    <figure className="ab-fig">
      {/* PublicAsset 两种尺寸：sm 800w、lg 1600w（后端已定）；/media 已是重新编码好的 WebP，不再走 next/image */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={img.src.sm} srcSet={`${img.src.sm} 800w, ${img.src.lg} 1600w`}
        sizes={sizes} width={img.w} height={img.h} alt={img.alt}
        loading={lazy ? 'lazy' : undefined} decoding="async"
      />
      {img.caption?.trim() ? <figcaption>{img.caption}</figcaption> : null}
    </figure>
  );
}
