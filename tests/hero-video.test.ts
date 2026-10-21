import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BRAND_MEDIA } from '../src/lib/home/brandMedia';
import { HERO_SEEN_KEY, heroReducer, markSeen, shouldAutoplay, whenIdle } from '../src/lib/home/heroVideo';

const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }; };

test('first visit autoplays; after markSeen later visits show poster only', () => {
  const s = mem();
  assert.equal(shouldAutoplay({ storage: s }), true);
  markSeen(s);
  assert.equal(s.getItem(HERO_SEEN_KEY), '1');
  assert.equal(shouldAutoplay({ storage: s }), false);
});

test('reduced motion and saveData: poster only, even on first visit', () => {
  assert.equal(shouldAutoplay({ storage: mem(), reducedMotion: true }), false);
  assert.equal(shouldAutoplay({ storage: mem(), saveData: true }), false);
});

test('missing or throwing storage: poster only, markSeen does not throw', () => {
  assert.equal(shouldAutoplay({ storage: null }), false);
  const bad = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } };
  assert.equal(shouldAutoplay({ storage: bad }), false);
  assert.doesNotThrow(() => markSeen(bad));
});

test('skip, ended and error all stop on the poster (no loop)', () => {
  for (const ev of ['skip', 'ended', 'error'] as const) assert.equal(heroReducer('playing', ev), 'poster');
  assert.equal(heroReducer('paused', 'skip'), 'poster');
  assert.equal(heroReducer('poster', 'play'), 'playing');
  assert.equal(heroReducer('playing', 'pause'), 'paused');
  assert.equal(heroReducer('paused', 'play'), 'playing');
  assert.equal(heroReducer('poster', 'pause'), 'poster');
});

test('video loads only after page load + idle', () => {
  const calls: string[] = [];
  let onLoad: (() => void) | undefined;
  const win = {
    document: { readyState: 'interactive' },
    addEventListener: (t: string, cb: () => void) => { calls.push(t); onLoad = cb; },
    requestIdleCallback: (cb: () => void) => { calls.push('idle'); cb(); return 1; },
    setTimeout: () => 0,
  };
  let ran = false;
  whenIdle(win, () => { ran = true; });
  assert.equal(ran, false);
  onLoad!();
  assert.deepEqual(calls, ['load', 'idle']);
  assert.equal(ran, true);
});

test('component markup: poster is high-priority img, video muted/playsInline/preload=none, approved mp4 sources, no loop, real button', () => {
  const src = readFileSync(new URL('../src/components/layout/HeroVideo.tsx', import.meta.url), 'utf8');
  assert.match(src, /getImageProps\(\{[^}]*className: 'hero-media-poster'[^}]*priority: true/);
  assert.match(src, /<video[^>]*\bmuted\b[^>]*\bplaysInline\b[^>]*preload="none"/);
  assert.doesNotMatch(src, /\bloop\b|autoPlay/);
  assert.ok(src.indexOf('BRAND_MEDIA.video.compact') < src.indexOf('BRAND_MEDIA.video.full'));
  assert.doesNotMatch(src, /\/video\/hero-115|\.webm/);
  assert.match(src, /<button type="button"/);
  const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');
  assert.match(css, /\.hero-media\{[^}]*aspect-ratio:16\/9/);
  assert.match(css, /max-width:767px\)\{[^@]*\.hero-media\{aspect-ratio:16\/9\}\}/);
  assert.doesNotMatch(css, /object-position:10% 50%/);
  assert.match(css, /prefers-reduced-motion:reduce\)\{\.hero-media-video\{transition:none/);
  assert.match(css, /\.hero-media-btn:focus-visible\{outline:2px solid var\(--ink\);outline-offset:2px;box-shadow:0 0 0 2px #fff/);
  assert.match(css, /\.hero-media-btn\{[^}]*min-width:44px;min-height:44px/);
});

test('all screens use the approved complete 16:9 video and its own poster', () => {
  const src = readFileSync(new URL('../src/components/layout/HeroVideo.tsx', import.meta.url), 'utf8');
  assert.match(src, /COMPACT_MQ = '\(max-width: 767px\)'/);
  assert.match(src, /src: BRAND_MEDIA.video.poster/);
  assert.match(src, /<source media=\{COMPACT_MQ\} src=\{BRAND_MEDIA.video.compact\}/);
  assert.match(src, /<source src=\{BRAND_MEDIA.video.full\}/);
  assert.doesNotMatch(src, /PORTRAIT_MQ|hero-115|className="hero-brand"/);
  for (const path of Object.values(BRAND_MEDIA.video))
    assert.ok(readFileSync(new URL(`../public${path}`, import.meta.url)).length > 0, path);
  const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');
  assert.match(css, /\.hero-media-poster,\.hero-media-video\{[^}]*object-fit:contain/);
});

test('skip/play labels exist in en and ru', () => {
  for (const l of ['en', 'ru']) {
    const h = JSON.parse(readFileSync(new URL(`../messages/${l}.json`, import.meta.url), 'utf8')).Home;
    assert.ok(h.heroVideoSkip && h.heroVideoPlay && h.heroVideoPause && h.heroPosterAlt, l);
  }
});

test('#292 skipped/failed non-last <source> does not stop playback; video or last-source error does', async () => {
  const { isFatalMediaError } = await import('../src/lib/home/heroVideo');
  const s4 = { tagName: 'SOURCE', nextElementSibling: null };
  const s3 = { tagName: 'SOURCE', nextElementSibling: s4 };
  const s1 = { tagName: 'SOURCE', nextElementSibling: { tagName: 'SOURCE', nextElementSibling: s3 } };
  const video = { tagName: 'VIDEO' };
  assert.equal(isFatalMediaError(s1, video), false); // 桌面跳过的竖版 source
  assert.equal(isFatalMediaError(s3, video), false); // webm 失败，还有 mp4
  assert.equal(isFatalMediaError(s4, video), true);  // 所有 source 都失败
  assert.equal(isFatalMediaError(video, video), true); // video 自身解码/网络错误
  const src = readFileSync(new URL('../src/components/layout/HeroVideo.tsx', import.meta.url), 'utf8');
  assert.match(src, /onError=\{\(e\) => \{ if \(isFatalMediaError\(e\.target/);
  assert.doesNotMatch(src, /onError=\{\(\) => stop\('error'\)\}/);
});

test('reduced motion: video never mounts (poster only)', () => {
  const src = readFileSync(new URL('../src/components/layout/HeroVideo.tsx', import.meta.url), 'utf8');
  assert.match(src, /if \(env\.reducedMotion \|\| env\.saveData\) return;/);
  assert.match(src, /\{mounted && \(\s*<video/);
});
