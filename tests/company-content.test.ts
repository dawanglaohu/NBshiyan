import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { companyArtwork, COMPANY_ARTWORK_SRC, releaseCompanyMedia, releasedCompanyMedia } from '../src/lib/brand/company-media';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const json = (path: string) => JSON.parse(read(path)) as Record<string, unknown>;

const IMAGE_ROLES = new Set(['static_image', 'animated_gif', 'gif_preview', 'gif_pause_still']);

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

test('company media is an exact image whitelist and rejects everything else', () => {
  const release = json('../docs/brand-media/static/selected-media-release.json') as {
    deliverables: { path: string; sha256: string; width: number; height: number; role?: string }[];
  };
  const images = release.deliverables.filter((item) => IMAGE_ROLES.has(item.role ?? ''));
  assert.equal(images.length, 4);
  let presentImages = 0;
  for (const item of images) {
    const src = webPath(item.path);
    const media = releaseCompanyMedia(src);
    const publicFile = new URL(`../${item.path}`, import.meta.url);
    if (!existsSync(publicFile)) {
      assert.equal(media, null, item.path);
      const held = new URL(`../docs/brand-media/static/held/${item.path.split('/').pop()}`, import.meta.url);
      const heldBytes = readFileSync(held);
      assert.equal(createHash('sha256').update(heldBytes).digest('hex'), item.sha256, item.path);
      continue;
    }
    presentImages += 1;
    assert.ok(media, item.path);
    assert.equal(media.src, src);
    assert.equal(media.width, item.width);
    assert.equal(media.height, item.height);
    assert.ok(media.alt.en.trim() && media.alt.ru.trim());
    const bytes = readFileSync(publicFile);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), item.sha256, item.path);
    assert.deepEqual(rasterSize(bytes), { width: item.width, height: item.height }, item.path);
  }
  assert.equal(presentImages, 2);
  for (const item of release.deliverables) {
    if (IMAGE_ROLES.has(item.role ?? '')) continue;
    assert.equal(releaseCompanyMedia(webPath(item.path)), null, item.path);
  }
  const visuals = json('../docs/brand-content/company-visuals.json') as {
    artworks: { web: { path: string; width: number; height: number }; alt: { en: string; ru: string } }[];
  };
  const plate = visuals.artworks[0];
  const artwork = releaseCompanyMedia(webPath(plate.web.path));
  assert.ok(artwork);
  assert.equal(artwork.src, COMPANY_ARTWORK_SRC);
  assert.equal(artwork.width, plate.web.width);
  assert.equal(artwork.height, plate.web.height);
  assert.equal(artwork.alt.en, plate.alt.en);
  assert.equal(artwork.alt.ru, plate.alt.ru);
  assert.equal(releasedCompanyMedia().length, presentImages + 1);
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
    '',
  ]) {
    assert.equal(releaseCompanyMedia(blocked), null, blocked);
  }
});

test('the runtime mapping does not carry private paths, hashes or source files', () => {
  const src = read('../src/lib/brand/company-media.ts');
  assert.doesNotMatch(src, /^\s*import /m);
  for (const needle of ['docs/', 'sha256', '.svg', 'company-visuals', 'company-facts', 'http://', 'https://', 'C:\\']) {
    assert.equal(src.includes(needle), false, needle);
  }
  assert.equal(companyArtwork('en')?.src, COMPANY_ARTWORK_SRC);
  assert.equal(companyArtwork('ru')?.alt.length > 0, true);
  assert.equal(companyArtwork('ja'), null);
  assert.notEqual(companyArtwork('en')?.alt, companyArtwork('ru')?.alt);
});

test('published company copy matches the attested fact table and skips unowned hard facts', () => {
  const en = json('../messages/en.json') as { Company: Record<string, unknown> };
  const ru = json('../messages/ru.json') as { Company: Record<string, unknown> };
  const keys = (value: unknown, prefix = ''): string[] => (
    value && typeof value === 'object'
      ? Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => keys(child, prefix ? `${prefix}.${key}` : key))
      : [prefix]
  );
  assert.deepEqual(keys(en.Company).sort(), keys(ru.Company).sort());
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

test('home and about consume the same plate, and the publish gate still owns the about route', () => {
  const home = read('../src/app/[locale]/page.tsx');
  const about = read('../src/app/[locale]/about/page.tsx');
  const header = read('../src/components/layout/SiteHeader.tsx');
  const footer = read('../src/components/layout/SiteFooter.tsx');
  assert.match(home, /<CompanySummary aboutVisible=\{aboutVisible\} \/>/);
  assert.match(about, /<CompanySummary aboutVisible showMore=\{false\} \/>/);
  assert.match(about, /if \(!c\) notFound\(\)/);
  assert.match(about, /dangerouslySetInnerHTML=\{\{ __html: c\.bodyHtml \}\}/);
  assert.match(header, /\{aboutVisible && <Link href="\/about"/);
  assert.match(header, /data-testid=\{PUBLIC_ROUTES\.about\.entryId\}/);
  assert.match(footer, /\{aboutVisible && <Link href="\/about">/);
  assert.match(footer, /id="footer-contact-link"/);
  assert.match(footer, /PUBLIC_ROUTES\.privacy\.entryId/);
});

test('the company plate, wordmark and listed image files match their recorded bytes', () => {
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
  assert.equal(trace.webPath, COMPANY_ARTWORK_SRC);
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
    assert.deepEqual(rasterSize(file), { width: item.width, height: item.height }, item.src);
  }
});
