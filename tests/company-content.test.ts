import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { companyArtwork, releaseCompanyMedia, releasedCompanyMedia } from '../src/lib/brand/company-media';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const json = (path: string) => JSON.parse(read(path)) as Record<string, unknown>;

const IMAGE_ROLES = new Set(['static_image', 'animated_gif', 'gif_preview', 'gif_pause_still']);
const ART_ALT = {
  en: 'PackJoyU conceptual illustrations of custom packaging and printed products',
  ru: 'Условные иллюстрации PackJoyU: упаковка и печатная продукция на заказ',
};
const PLATE_PNG = '/brand/company/company-introduction-v3-en.png';

function webPath(file: string): string {
  assert.ok(file.startsWith('public/'), file);
  return `/${file.slice('public/'.length)}`;
}

function rasterSize(buf: Buffer): { width: number; height: number } {
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.toString('ascii', 0, 3) === 'GIF') {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  throw new Error('not a png or gif');
}

test('company media is an exact image whitelist and rejects everything else', async () => {
  const release = json('../docs/brand-media/static/selected-media-release.json') as {
    deliverables: { path: string; sha256: string; width: number; height: number; role?: string }[];
  };
  const images = release.deliverables.filter((item) => IMAGE_ROLES.has(item.role ?? ''));
  assert.equal(images.length, 4);
  let presentImages = 0;
  for (const item of images) {
    const src = webPath(item.path);
    assert.equal(releaseCompanyMedia(src), null, item.path);
    const publicFile = new URL(`../${item.path}`, import.meta.url);
    if (!existsSync(publicFile)) {
      const held = new URL(`../docs/brand-media/static/held/${item.path.split('/').pop()}`, import.meta.url);
      const heldBytes = readFileSync(held);
      assert.equal(createHash('sha256').update(heldBytes).digest('hex'), item.sha256, item.path);
      continue;
    }
    presentImages += 1;
    const bytes = readFileSync(publicFile);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), item.sha256, item.path);
    assert.deepEqual(rasterSize(bytes), { width: item.width, height: item.height }, item.path);
  }
  assert.equal(presentImages, 2);
  for (const item of release.deliverables) {
    if (IMAGE_ROLES.has(item.role ?? '')) continue;
    assert.equal(releaseCompanyMedia(webPath(item.path)), null, item.path);
  }
  assert.equal(releaseCompanyMedia(PLATE_PNG), null);

  const released = releasedCompanyMedia();
  assert.equal(released.length, 6);
  assert.deepEqual(
    released.map((item) => [item.width, item.height]).sort((a, b) => a[0] - b[0]),
    [[480, 429], [800, 928], [960, 858], [1440, 1287], [1600, 1856], [2400, 2784]],
  );
  for (const item of released) {
    assert.equal(item.alt.en, ART_ALT.en);
    assert.equal(item.alt.ru, ART_ALT.ru);
    assert.match(item.src, /^\/brand\/company\/company-introduction-v3-en-(?:w|crop-)\d+\.[0-9a-f]{8}\.webp$/);
    const file = readFileSync(new URL(`../public${item.src}`, import.meta.url));
    const digest = createHash('sha256').update(file).digest('hex');
    assert.equal(item.src.includes(`.${digest.slice(0, 8)}.webp`), true, item.src);
    const meta = await sharp(file).metadata();
    assert.equal(meta.width, item.width, item.src);
    assert.equal(meta.height, item.height, item.src);
  }

  const trace = json('../docs/brand-content/company-page-trace.json') as { omittedBecausePublicBytesAbsent: string[] };
  assert.deepEqual(trace.omittedBecausePublicBytesAbsent, [
    'public/brand/packjoyu-industrial-city-v3-loop.gif',
    'public/brand/packjoyu-industrial-city-v3-loop-preview.gif',
  ]);

  for (const blocked of [
    '/brand/packjoyu-industrial-city-v3-loop.gif',
    '/brand/packjoyu-industrial-city-v3-loop-preview.gif',
    '/brand/company/company-packaging-forms.png',
    '/brand/company/company-product-range.png',
    'https://example.com/brand/company/company-introduction-v3-en.png',
    'http://example.com/a.png',
    '//cdn.example/a.png',
    'C:\\public\\brand\\company\\company-introduction-v3-en.png',
    'docs/brand-content/source/dot-v3/PackJoyU-Company-Introduction-v3-EN.svg',
    'public/brand/company/company-introduction-v3-en.png',
    '/brand/company/../packjoyu-logo-master.svg',
    '/brand/packjoyu-logo-master.svg',
    '/brand/video2-packjoyu-products-v3.mp4',
    '/brand/video2-packjoyu-products-v3-poster-12233ms.jpg',
    '/brand/packjoyu-industrial-city-v3-loop-poster-1384.webp',
    '/brand/not-listed.png',
    PLATE_PNG,
    '/brand/company/company-introduction-v3-en-w800.77f0c95d.png',
    '',
  ]) {
    assert.equal(releaseCompanyMedia(blocked), null, blocked);
  }
});

test('the runtime mapping does not carry private paths, hashes or source files', () => {
  const src = read('../src/lib/brand/company-media.ts');
  assert.doesNotMatch(src, /^\s*import /m);
  for (const needle of ['docs/', 'sha256', '.svg', '.png', 'company-visuals', 'company-facts', 'http://', 'https://', 'C:\\']) {
    assert.equal(src.includes(needle), false, needle);
  }
  const en = companyArtwork('en');
  const ru = companyArtwork('ru');
  assert.ok(en && ru);
  assert.equal(en.alt, ART_ALT.en);
  assert.equal(ru.alt, ART_ALT.ru);
  assert.equal(en.crop.width, 1440);
  assert.equal(en.crop.height, 1287);
  assert.equal(en.full.width, 5000);
  assert.equal(en.full.height, 5800);
  assert.match(en.crop.srcSet, / 480w, .* 960w, .* 1440w$/);
  assert.match(en.full.srcSet, / 800w, .* 1600w, .* 2400w$/);
  assert.equal(en.crop.srcSet.includes('.png'), false);
  assert.equal(en.full.srcSet.includes('.png'), false);
  assert.equal(companyArtwork('ja'), null);
  assert.notEqual(en.alt, ru.alt);
  const summary = read('../src/components/about/CompanySummary.tsx');
  assert.equal(summary.includes('.png'), false);
  assert.match(summary, /placement === 'about' && locale === 'en'/);
  assert.match(summary, /media="\(max-width:767px\)"/);
  assert.match(summary, /sizes="100vw"/);
  assert.match(summary, /sizes="\(max-width:1023px\) 100vw, 45vw"/);
  assert.match(summary, /width=\{art\.full\.width\}/);
  assert.match(summary, /height=\{art\.full\.height\}/);
  assert.match(summary, /className="sx-eyebrow"/);
  assert.match(summary, /className="sx-h"/);
});

test('published company copy matches the attested fact table and skips unowned hard facts', () => {
  const en = json('../messages/en.json') as { Company: Record<string, unknown> & { claims: Record<string, string> } };
  const ru = json('../messages/ru.json') as { Company: Record<string, unknown> & { claims: Record<string, string> } };
  const keys = (value: unknown, prefix = ''): string[] => (
    value && typeof value === 'object'
      ? Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => keys(child, prefix ? `${prefix}.${key}` : key))
      : [prefix]
  );
  assert.deepEqual(keys(en.Company).sort(), keys(ru.Company).sort());
  assert.equal(en.Company.title, 'Our own factory and an integrated supply chain');
  assert.equal(ru.Company.title, 'Своя фабрика и единая цепочка поставок');
  assert.equal(en.Company.illustrationNote, 'Illustrations are conceptual.');
  assert.equal(ru.Company.illustrationNote, 'Иллюстрации условные.');
  assert.equal(en.Company.claims.ownFactory, 'PackJoyU works from its own factory.');
  assert.equal(ru.Company.claims.ownFactory, 'PackJoyU работает на своей фабрике.');
  assert.equal(en.Company.claims.supplyChain, 'An integrated supply chain covers packaging, paper and print.');
  assert.equal(ru.Company.claims.supplyChain, 'Единая цепочка поставок охватывает упаковку, бумагу и печать.');
  assert.equal(en.Company.claims.customization, 'We customize products across multiple categories.');
  assert.equal(ru.Company.claims.customization, 'Изготавливаем на заказ продукцию нескольких категорий.');
  assert.equal(en.Company.claims.sampling, 'Design and sampling are included.');
  assert.equal(ru.Company.claims.sampling, 'Дизайн и изготовление образцов входят в работу.');
  assert.equal(en.Company.claims.quality, 'Quality control is built into the process.');
  assert.equal(ru.Company.claims.quality, 'Контроль качества — часть производственного процесса.');
  const attestation = json('../docs/brand-content/source/company-facts-attestation.json') as { confirmedClaims: string[] };
  const factMap = json('../docs/brand-content/company-fact-map.json') as {
    fields: { pageField: string; claim: string; evidencePointer: string }[];
    blockedWithoutOwnEvidence: string[];
  };
  assert.equal(factMap.fields.length, attestation.confirmedClaims.length);
  factMap.fields.forEach((field, index) => {
    assert.equal(field.claim, attestation.confirmedClaims[index]);
    assert.equal(field.evidencePointer, `confirmedClaims[${index}]`);
    const key = field.pageField.replace(/^Company\./, '');
    const pick = (tree: Record<string, unknown>) => key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], tree);
    const enText = pick(en.Company);
    const ruText = pick(ru.Company);
    assert.equal(typeof enText, 'string');
    assert.equal(typeof ruText, 'string');
    assert.ok(String(enText).trim() && String(ruText).trim());
  });
  const blob = `${JSON.stringify(en.Company)}\n${JSON.stringify(ru.Company)}\n${companyArtwork('en')?.alt}\n${companyArtwork('ru')?.alt}`;
  assert.doesNotMatch(blob, /yuhao|宇豪/i);
  assert.doesNotMatch(blob, /\bISO\s*\d+/i);
  assert.doesNotMatch(blob, /\d/);
  assert.ok(factMap.blockedWithoutOwnEvidence.includes('YUHAO certification'));
});

test('home and about consume the plate, and the publish gate still owns the about route', () => {
  const home = read('../src/app/[locale]/page.tsx');
  const about = read('../src/app/[locale]/about/page.tsx');
  const header = read('../src/components/layout/SiteHeader.tsx');
  const footer = read('../src/components/layout/SiteFooter.tsx');
  const route = read('../src/app/api/site-settings-revalidate/route.ts');
  const spec = read('../e2e/company-content.spec.ts');
  assert.match(home, /<CompanySummary aboutVisible=\{aboutVisible\} \/>/);
  assert.match(home, /\{aboutVisible \? null : <AboutHomeBlock content=\{about\} aboutVisible=\{aboutVisible\} \/>\}/);
  assert.match(about, /<CompanySummary aboutVisible showMore=\{false\} placement="about" \/>/);
  assert.match(about, /if \(!c\) notFound\(\)/);
  assert.match(about, /dangerouslySetInnerHTML=\{\{ __html: c\.bodyHtml \}\}/);
  assert.match(header, /\{aboutVisible && <Link href="\/about"/);
  assert.match(header, /data-testid=\{PUBLIC_ROUTES\.about\.entryId\}/);
  assert.match(footer, /\{aboutVisible && <Link href="\/about">/);
  assert.match(footer, /id="footer-contact-link"/);
  assert.match(footer, /PUBLIC_ROUTES\.privacy\.entryId/);
  assert.match(route, /E2E_SITE_REVALIDATE !== '1'/);
  assert.match(route, /status: 404/);
  assert.match(route, /revalidateTag\(SITE_SETTINGS_TAG\)/);
  assert.doesNotMatch(route, /site-settings-admin-deps/);
  assert.match(spec, /\/api\/site-settings-revalidate/);
  assert.doesNotMatch(spec, /\/api\/e2e\//);
  assert.equal(home.includes(PLATE_PNG), false);
  assert.equal(about.includes(PLATE_PNG), false);
});

test('the company plate, wordmark and listed image files match their recorded bytes', async () => {
  const trace = json('../docs/brand-content/company-page-trace.json') as {
    webPath: string;
    logoMaster: { path: string; sha256: string };
    artwork: { webFile: string; webSha256: string; sourceSha256: string; width: number; height: number };
  };
  const visuals = json('../docs/brand-content/company-visuals.json') as {
    logoMaster: { sha256: string };
    artworks: { web: { sha256: string; width: number; height: number }; source: { sha256: string } }[];
    status: string;
  };
  assert.equal(visuals.status, 'complete');
  assert.equal(trace.webPath, PLATE_PNG);
  const logo = readFileSync(new URL(`../${trace.logoMaster.path}`, import.meta.url));
  assert.equal(createHash('sha256').update(logo).digest('hex'), trace.logoMaster.sha256);
  assert.equal(trace.logoMaster.sha256, visuals.logoMaster.sha256);
  const web = readFileSync(new URL(`../${trace.artwork.webFile}`, import.meta.url));
  assert.equal(createHash('sha256').update(web).digest('hex'), trace.artwork.webSha256);
  assert.equal(trace.artwork.webSha256, visuals.artworks[0].web.sha256);
  assert.equal(trace.artwork.sourceSha256, visuals.artworks[0].source.sha256);
  const size = rasterSize(web);
  assert.deepEqual(size, { width: trace.artwork.width, height: trace.artwork.height });
  assert.equal(size.width, visuals.artworks[0].web.width);
  assert.equal(size.height, visuals.artworks[0].web.height);
  for (const item of releasedCompanyMedia()) {
    const file = readFileSync(new URL(`../public${item.src}`, import.meta.url));
    const meta = await sharp(file).metadata();
    assert.equal(meta.width, item.width, item.src);
    assert.equal(meta.height, item.height, item.src);
  }
});

test('the export script reproduces the committed plate bytes', () => {
  const result = spawnSync(process.execPath, ['scripts/export-company-plate.mjs', '--check'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
