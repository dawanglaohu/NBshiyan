import { getLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { companyArtwork } from '@/lib/brand/company-media';
import './about.css';

const CLAIMS = ['ownFactory', 'supplyChain', 'customization', 'sampling', 'quality'] as const;

/**
 * Attested company summary. The same plate is used on the home page and, once about is published, on /about.
 * The more-link stays off unless the about route is actually published, so a closed switch does not leave a dead link.
 */
export default async function CompanySummary({ aboutVisible = false, showMore = true }: { aboutVisible?: boolean; showMore?: boolean }) {
  const locale = await getLocale();
  const art = companyArtwork(locale);
  if (!art) return null;
  const t = await getTranslations('Company');
  return (
    <section className="pj-company" data-testid="company-summary" aria-labelledby="company-summary-h">
      <div className="container pj-company-grid">
        <div className="pj-company-copy">
          <p className="pj-company-kicker">{t('kicker')}</p>
          <h2 id="company-summary-h">{t('title')}</h2>
          <ul className="pj-company-claims">
            {CLAIMS.map((id) => <li key={id}>{t(`claims.${id}`)}</li>)}
          </ul>
          <p className="pj-company-note">{t('illustrationNote')}</p>
          {showMore && aboutVisible && <Link className="pj-company-more" href="/about">{t('more')}</Link>}
        </div>
        <figure className="pj-company-frame">
          {/* Public brand plate. width and height are the file pixels; the frame keeps that ratio and does not crop. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            data-testid="company-artwork"
            src={art.src}
            width={art.width}
            height={art.height}
            alt={art.alt}
            loading="lazy"
            decoding="async"
          />
        </figure>
      </div>
    </section>
  );
}
