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
  assert.match(s, /<title>/);
  // notFound() 已由 Next 插入一条 robots meta。这里再声明 robots 字段会变成第二条。
  assert.doesNotMatch(s, /\brobots\s*:/);
  assert.doesNotMatch(s, /redirect\(/);
  const rest = readFileSync('src/app/[locale]/[...rest]/page.tsx', 'utf8');
  assert.match(rest, /notFound\(\)/);
});

test('product 404 and locale-unavailable 404 do not declare their own robots meta', () => {
  const product = readFileSync('src/app/[locale]/products/[slug]/page.tsx', 'utf8');
  const unavailable = readFileSync('src/app/[locale]/locale-unavailable/not-found.tsx', 'utf8');
  assert.doesNotMatch(product, /\brobots\s*:/);
  assert.doesNotMatch(unavailable, /\brobots\s*:/);
  assert.match(unavailable, /<title>/);
});
