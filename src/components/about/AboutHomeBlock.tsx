import { getTranslations } from 'next-intl/server';
import { ABOUT_LIMITS, homeBlockVisible, visibleImages, visibleStats, type AboutContent } from '@/lib/about/model';
import { ABOUT_IMAGE_SIZES, AboutFigure, AboutStats } from './AboutParts';
import { Button } from '@/components/sections/ui';
import '@/components/sections/sections.css';
import './about.css';

/**
 * #350 首页「公司实力」区块（后台字段名；前台不出现这几个字。UX spec v1.0 §4）。
 * 只是摘要：首页标题、首页简介、数据条、前 4 张图，不出现正文。about 不显示时整块不渲染（按钮链到 /about，避免死链）。
 * 稿件：home-block / home-block-no-stats / home-block-no-images。
 */
export default async function AboutHomeBlock({ content, aboutVisible }: { content: AboutContent | null; aboutVisible: boolean }) {
  if (!content || !homeBlockVisible(content, aboutVisible)) return null;
  const t = await getTranslations('About.home');
  const stats = visibleStats(content.stats);
  const images = visibleImages(content.images).slice(0, ABOUT_LIMITS.homeImages);
  return (
    <section className="ab-home" aria-labelledby="ab-home-h">
      <div className="sx sx-block">
        <div className={`ab-home-grid${stats.length ? '' : ' is-single'}`}>
          <div>
            <p className="sx-eyebrow">{t('eyebrow')}</p>
            <h2 id="ab-home-h" className="sx-h">{content.home.title}</h2>
            <p className="sx-lead">{content.home.intro}</p>
            <div className="sx-actions"><Button href="/about" variant="ghost">{t('more')} <span aria-hidden="true">→</span></Button></div>
          </div>
          {stats.length > 0 && <AboutStats stats={stats} />}
        </div>
        {images.length > 0 && (
          <div className="ab-home-imgs">
            {images.map((img) => <AboutFigure key={img.id} img={img} sizes={ABOUT_IMAGE_SIZES} />)}
          </div>
        )}
      </div>
    </section>
  );
}
