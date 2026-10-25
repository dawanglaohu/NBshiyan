import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import en from '../messages/en.json';
import ru from '../messages/ru.json';

test('404: own localized title, not the homepage Meta.title', () => {
  assert.equal(en.NotFound.meta.title, 'Page not found | PackJoyU');
  assert.equal(ru.NotFound.meta.title, 'Страница не найдена | PackJoyU');
  assert.notEqual(en.NotFound.meta.title, en.Meta.title);
  assert.notEqual(ru.NotFound.meta.title, ru.Meta.title);
});

test('404: generateMetadata keeps NotFound.meta.title and does not emit a second robots meta', () => {
  const s = readFileSync('src/app/[locale]/not-found.tsx', 'utf8');
  assert.match(s, /export async function generateMetadata/);
  assert.match(s, /getTranslations\('NotFound'\)/);
  assert.match(s, /title: t\('meta\.title'\)/);
  // notFound() 已由 Next 插入一条 robots meta。这里再声明 robots 字段会变成第二条。
  assert.doesNotMatch(s, /\brobots\s*:/);
  assert.doesNotMatch(s, /redirect\(/);
  assert.doesNotMatch(s, /dangerouslySetInnerHTML/);
  assert.doesNotMatch(s, /<title>/);
  assert.match(s, /<NotFoundTitle\s*\/>/);
  const rest = readFileSync('src/app/[locale]/[...rest]/page.tsx', 'utf8');
  assert.match(rest, /notFound\(\)/);
});

test('product 404 and locale-unavailable 404 do not declare their own robots meta', () => {
  const product = readFileSync('src/app/[locale]/products/[slug]/page.tsx', 'utf8');
  const unavailable = readFileSync('src/app/[locale]/locale-unavailable/not-found.tsx', 'utf8');
  assert.doesNotMatch(product, /\brobots\s*:/);
  assert.doesNotMatch(unavailable, /\brobots\s*:/);
  assert.doesNotMatch(unavailable, /dangerouslySetInnerHTML/);
  assert.doesNotMatch(unavailable, /<title>/);
  assert.match(unavailable, /<NotFoundTitle locale="en"\s*\/>/);
});

test('NotFoundTitle picks the document title by locale and does not render a title element', () => {
  const title = readFileSync('src/components/NotFoundTitle.tsx', 'utf8');
  assert.match(title, /'use client'/);
  assert.match(title, /useLayoutEffect/);
  assert.match(title, /new MutationObserver/);
  assert.match(title, /observer\.disconnect\(\)/);
  assert.match(title, /clearInterval\(timer\)/);
  assert.match(title, /新增语言时要同步这里/);
  assert.match(title, /locale === 'ru' \? ruMessages\.NotFound\.meta\.title : enMessages\.NotFound\.meta\.title/);
  assert.doesNotMatch(title, /<title>/);
  assert.doesNotMatch(title, /dangerouslySetInnerHTML/);
  assert.doesNotMatch(title, /(?<!Layout)useEffect\(/);
});

test('notFoundDocumentTitle uses Russian only for ru and falls back to English', async () => {
  const { notFoundDocumentTitle } = await import('../src/components/NotFoundTitle');
  assert.equal(notFoundDocumentTitle('ru'), ru.NotFound.meta.title);
  assert.equal(notFoundDocumentTitle('en'), en.NotFound.meta.title);
  assert.equal(notFoundDocumentTitle('de'), en.NotFound.meta.title);
  assert.equal(notFoundDocumentTitle(''), en.NotFound.meta.title);
});
