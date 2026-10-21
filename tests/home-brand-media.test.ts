import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, delimiter } from 'node:path';
import { execFileSync } from 'node:child_process';
import { BRAND_MEDIA } from '../src/lib/home/brandMedia';
import * as React from 'react';
(globalThis as { React?: typeof React }).React = React; // tsx uses the classic JSX transform.
import { renderToStaticMarkup } from 'react-dom/server';

const source = (path: string) => readFileSync(path, 'utf8');
const approved = [
  'packjoyu-industrial-city-v3.png',
  'packjoyu-industrial-city-v3-loop.gif',
  'packjoyu-industrial-city-v3-loop-preview.gif',
  'video2-packjoyu-products-v3.mp4',
  'video2-packjoyu-products-web-720p60-v3.mp4',
  'video2-packjoyu-products-v3-poster-12233ms.jpg',
];

test('home media no longer uses reference hero files or a layer obscuring the corrected product logo', () => {
  const hero = source('src/components/layout/HeroVideo.tsx');
  assert.doesNotMatch(hero, /\/video\/hero-115/);
  assert.doesNotMatch(hero, /className="hero-brand"/);
  assert.match(source('src/app/[locale]/page.tsx'), /<BrandScene /);
});

test('every public brand release copy retains the exact approved media bytes', () => {
  const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
  for (const name of approved) {
    assert.equal(hash(`public/brand/${name}`), hash(`docs/brand-media/static/held/${name}`), name);
  }
});

test('brand illustration starts with the approved static image and does not preload an animation', async () => {
  const { default: BrandScene } = await import('../src/components/layout/BrandScene');
  const html = renderToStaticMarkup(React.createElement(BrandScene, { labels: { alt: 'Industrial illustration', play: 'Play animation', pause: 'Pause animation' } }));
  assert.match(html, /packjoyu-industrial-city-v3\.png/);
  assert.doesNotMatch(html, /src="[^"]*\.gif/);
  assert.doesNotMatch(html, /<button/);
});

test('home share-image renderer reads the selected website poster instead of a reference-hero regex', () => {
  const require = createRequire(import.meta.url);
  const playwrightModules = dirname(dirname(require.resolve('playwright/package.json', { paths: [require.resolve('@playwright/test/package.json')] })));
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', "import * as renderer from './design/og-src/render-og.mjs'; process.stdout.write(renderer.HOME_POSTER_SOURCE ?? 'missing-selected-poster');"], {
    encoding: 'utf8', env: { ...process.env, NODE_PATH: [playwrightModules, process.env.NODE_PATH].filter(Boolean).join(delimiter) },
  });
  assert.equal(result, BRAND_MEDIA.video.poster);
});
