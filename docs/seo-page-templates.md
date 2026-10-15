# SEO page templates: category and article pages

Code: `src/lib/seo/templates/index.ts`, `src/lib/seo/breadcrumbs.ts`. Tests: `tests/seo-templates.test.ts`.
These templates only clean up and shorten copy that already exists (categoryMeta, Sanity fields). They never add facts, figures, certifications or claims.

## Title (target 30–60 characters)
1. If the editor's SEO title (`categoryMeta[locale].title` or Sanity `seo.title`) is usable and 30–60 characters long, use it. Append ` | PackJoyU` when the brand is missing and the result still fits.
2. Otherwise use `<name / H1> | PackJoyU`. When that's over 60 characters, cut the name at a word boundary and add `…`. The ` | PackJoyU` suffix always stays whole.
3. If the name is missing or contains a `{{` placeholder, use the section name: `Products | PackJoyU` / `Продукция | PackJoyU`, or `Articles | PackJoyU` / `Статьи | PackJoyU`.
4. A title under 30 characters is not padded with filler words. The audit reports it as a warning instead.

## Description (target 70–160 characters)
- Sources, in order: category pages use `categoryMeta[locale].description`. Article pages use Sanity `seo.description`, then `excerpt`.
- Any source containing `{{` is skipped, and whitespace is collapsed.
- Over 160 characters: cut at a word boundary, drop any trailing punctuation, and add `…`.
- Under 70 characters: used as-is (no padding), and the audit reports a warning. If there's no source at all, no meta description is output.

## BreadcrumbList JSON-LD
- Category: Home (`/{locale}`) > Products (`/{locale}/products`) > category. The category URL comes **only** from `categoryHref()` (#195).
- Article: Home > Articles (`/{locale}/articles`) > article (`/{locale}/articles/{slug}`), following the actual routes.
- Item URLs are absolute and same-site (`SITE_URL`). A non-relative path throws an error. Output goes only through `src/components/seo/JsonLd.tsx`.
- Labels: Home/Главная, Products/Продукция, Articles/Статьи. RU awaiting Ryan proofreading.

## Category pages and CATEGORY_PAGES_LIVE
`src/app/[locale]/products/[slug]/page.tsx` is only an SEO shell: H1, metadata and breadcrumb. It returns 404 while `CATEGORY_PAGES_LIVE` is false. The real landing page content comes from #198.

## Audit mock mode
To build and run locally with `SEO_AUDIT_MOCK=1`, run `pnpm seo:audit --mock --ignore-env-noindex`. Mock mode:
- turns category pages on;
- serves mock articles from `src/lib/server/sanityMock.ts` with no network access;
- is always off when `VERCEL_ENV=production`.

The audit also checks for BreadcrumbList on category and article detail pages, and validates it.
