import { getLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { companyArtwork } from '@/lib/brand/company-media';
import './about.css';
import '@/components/sections/sections.css';

const CLAIMS = ['ownFactory', 'supplyChain', 'customization', 'sampling', 'quality'] as const;

/**
 * Attested company summary. Home and Russian about render the crop only.
 * English about keeps the full plate above 767px, with the crop as the narrow source.
 * The more-link stays off unless the about route is actually published, so a closed switch does not leave a dead link.
 */
export default async function CompanySummary({
  aboutVisible = false,
  showMore = true,
  placement = 'home',
}: {
  aboutVisible?: boolean;
  showMore?: boolean;
  placement?: 'home' | 'about';
}) {
  const locale = await getLocale();
  const art = companyArtwork(locale);
  if (!art) return null;
  const t = await getTranslations('Company');
  const useFull = placement === 'about' && locale === 'en';
  return (
    <section className="pj-company" data-testid="company-summary" aria-labelledby="company-summary-h">
      <div className="container pj-company-grid">
        <div className="pj-company-copy">
          <p className="sx-eyebrow">{t('kicker')}</p>
          <h2 id="company-summary-h" className="sx-h">{t('title')}</h2>
          <ul className="pj-company-claims">
            {CLAIMS.map((id) => <li key={id}>{t(`claims.${id}`)}</li>)}
          </ul>
          <p className="pj-company-note">{t('illustrationNote')}</p>
          {showMore && aboutVisible && <Link className="pj-company-more" href="/about">{t('more')}</Link>}
        </div>
        <figure className="pj-company-frame">
          {useFull ? (
            <picture>
              <source
                media="(max-width:767px)"
                srcSet={art.crop.srcSet}
                width={art.crop.width}
                height={art.crop.height}
                sizes="100vw"
              />
              {/* English about: full plate. width and height keep the source ratio. */}
              <img
                data-testid="company-artwork"
                src={art.full.src}
                srcSet={art.full.srcSet}
                sizes="(max-width:1023px) 100vw, 45vw"
                width={art.full.width}
                height={art.full.height}
                alt={art.alt}
                loading="lazy"
                decoding="async"
              />
            </picture>
          ) : (
            /* Home and Russian about: crop only, so the response does not carry the full-plate URLs. */
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              data-testid="company-artwork"
              src={art.crop.src}
              srcSet={art.crop.srcSet}
              sizes="(max-width:1023px) 100vw, 45vw"
              width={art.crop.width}
              height={art.crop.height}
              alt={art.alt}
              loading="lazy"
              decoding="async"
            />
          )}
        </figure>
      </div>
    </section>
  );
}
