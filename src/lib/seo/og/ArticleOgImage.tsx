import { fitTitle, OG_ARTICLE, LETTER_SPACING_EM, TITLE_WIDTH } from './articleOgLayout';

// 文章分享图模板（Satori / next/og）。与 design/og-src 的品牌图一致：#FBF8F3 底、Manrope、Pack<Joy>U 字标、
// 珊瑚色短条和底边。右上角是类型标签，左下角是域名。图里只有标题、标签、域名和字标，不写任何业务承诺。
// 底色和 design/og-src/og-layout.mjs 的 page() 一致（--bg #FBF8F3），整张图是纯色平面，没有贴片、遮罩或渐变，不会出现边缘光晕。
export const BRAND = { bg: '#FBF8F3', ink: '#1C1C1C', ink2: '#5A5650', accent: '#FF5A36', line: '#E8E2D8' } as const;
export const LABEL = { en: 'Article', ru: 'Статья' } as const;
export const DOMAIN = 'geiom.com';
const PAD_X = 72;

export function ArticleOgImage({ title, locale }: { title: string; locale: 'en' | 'ru' }) {
  const fit = fitTitle(title, locale);
  return (
    <div style={{ width: OG_ARTICLE.width, height: OG_ARTICLE.height, display: 'flex', flexDirection: 'column', background: BRAND.bg, color: BRAND.ink, fontFamily: 'Manrope', position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: `56px ${PAD_X}px 0` }}>
        <div style={{ display: 'flex', fontSize: 36, fontWeight: 800, letterSpacing: '-0.01em' }}>
          <span>Pack</span><span style={{ color: BRAND.accent }}>Joy</span><span>U</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', height: 44, padding: '0 20px', borderRadius: 22, border: `2px solid ${BRAND.line}`, fontSize: 22, fontWeight: 600, color: BRAND.ink2, letterSpacing: '0.02em' }}>
          <div style={{ width: 10, height: 10, borderRadius: 5, background: BRAND.accent, marginRight: 12 }} />
          {LABEL[locale]}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', flexGrow: 1, padding: `0 ${PAD_X}px` }}>
        <div style={{ width: 90, height: 8, borderRadius: 4, background: BRAND.accent, marginBottom: 30 }} />
        <div style={{ display: 'flex', flexDirection: 'column', width: TITLE_WIDTH, fontSize: fit.size, fontWeight: 800, lineHeight: 1.08, letterSpacing: `${LETTER_SPACING_EM}em` }}>
          {fit.lines.map((l, i) => (<div key={i} style={{ display: 'flex', whiteSpace: 'pre' }}>{l}</div>))}
        </div>
      </div>
      <div style={{ display: 'flex', padding: `0 ${PAD_X}px 52px`, fontSize: 24, fontWeight: 600, color: BRAND.ink2 }}>{DOMAIN}</div>
      <div style={{ position: 'absolute', left: 0, bottom: 0, width: OG_ARTICLE.width, height: 10, background: BRAND.accent }} />
    </div>
  );
}
