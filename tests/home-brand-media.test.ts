import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
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
  'packjoyu-industrial-city-v3-loop-poster.png',
  'packjoyu-industrial-city-v3-loop-preview.gif',
  'video2-packjoyu-products-v3.mp4',
  'video2-packjoyu-products-web-720p60-v3.mp4',
  'video2-packjoyu-products-v3-poster-12233ms.jpg',
];

test('home media no longer uses reference hero files or a layer obscuring the corrected product logo', () => {
  const hero = source('src/components/layout/HeroVideo.tsx');
  assert.doesNotMatch(hero, /\/video\/hero-115/);
  assert.doesNotMatch(hero, /className="hero-brand"/);
  const page = source('src/app/[locale]/page.tsx');
  assert.match(page, /<BrandScene /);
  assert.match(page, /stillSrc=\{BRAND_MEDIA\.scene\.pauseStill\}/);
  assert.equal(BRAND_MEDIA.scene.pauseStill, '/brand/packjoyu-industrial-city-v3-loop-poster-1384.webp');
  assert.doesNotMatch(page, /docs\/brand-media/);
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
  assert.doesNotMatch(html, /srcset=/i);
  assert.doesNotMatch(html, /src="[^"]*\.gif/);
  assert.doesNotMatch(html, /<button/);
});

test('city pause still publishes the delivered responsive webp pair and keeps the png', () => {
  assert.equal(statSync('public/brand/packjoyu-industrial-city-v3-loop-poster-1384.webp').size, 160922);
  assert.equal(statSync('public/brand/packjoyu-industrial-city-v3-loop-poster-2000.webp').size, 294336);
  assert.equal(statSync('public/brand/packjoyu-industrial-city-v3-loop-poster.png').size, statSync('docs/brand-media/static/held/packjoyu-industrial-city-v3-loop-poster.png').size);
});

test('city pause still markup is lazy, sized 1384x720, and has no fetchpriority', async () => {
  const { default: BrandScene } = await import('../src/components/layout/BrandScene');
  const html = renderToStaticMarkup(React.createElement(BrandScene, {
    stillSrc: BRAND_MEDIA.scene.pauseStill,
    labels: { alt: 'Industrial illustration', play: 'Play animation', pause: 'Pause animation' },
  }));
  const img = html.match(/<img\b[^>]*data-testid="brand-scene-still"[^>]*>/)?.[0];
  assert.ok(img);
  const attr = (name: string) => img.match(new RegExp(`\\s${name}="([^"]*)"`, 'i'))?.[1];
  assert.equal(attr('src'), '/brand/packjoyu-industrial-city-v3-loop-poster-1384.webp');
  assert.equal(attr('srcset'), '/brand/packjoyu-industrial-city-v3-loop-poster-1384.webp 1384w, /brand/packjoyu-industrial-city-v3-loop-poster-2000.webp 2000w');
  assert.equal(attr('sizes'), '(min-width:1489px) calc(100vw - 48px), min(1240px, 100vw - 40px)');
  assert.equal(attr('loading'), 'lazy');
  assert.equal(attr('width'), '1384');
  assert.equal(attr('height'), '720');
  assert.equal(attr('alt'), 'Industrial illustration');
  assert.equal(img.includes('fetchpriority') || img.includes('fetchPriority'), false);
  assert.doesNotMatch(html, /src="[^"]*\.gif/);
  assert.doesNotMatch(html, /packjoyu-industrial-city-v3-loop-poster\.png/);
  const legacy = renderToStaticMarkup(React.createElement(BrandScene, {
    stillSrc: '/brand/packjoyu-industrial-city-v3-loop-poster.png',
    labels: { alt: 'Industrial illustration', play: 'Play animation', pause: 'Pause animation' },
  }));
  assert.match(legacy, /src="\/brand\/packjoyu-industrial-city-v3-loop-poster-1384\.webp"/);
  assert.doesNotMatch(legacy, /src="\/brand\/packjoyu-industrial-city-v3-loop-poster\.png"/);
});

test('home share-image renderer reads the selected website poster instead of a reference-hero regex', () => {
  const require = createRequire(import.meta.url);
  const playwrightModules = dirname(dirname(require.resolve('playwright/package.json', { paths: [require.resolve('@playwright/test/package.json')] })));
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', "import * as renderer from './design/og-src/render-og.mjs'; process.stdout.write(renderer.HOME_POSTER_SOURCE ?? 'missing-selected-poster');"], {
    encoding: 'utf8', env: { ...process.env, NODE_PATH: [playwrightModules, process.env.NODE_PATH].filter(Boolean).join(delimiter) },
  });
  assert.equal(result, BRAND_MEDIA.video.poster);
});
