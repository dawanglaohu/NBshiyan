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

test('404: generateMetadata uses NotFound.meta.title + noindex, follow; status stays 404 via notFound()', () => {
  const s = readFileSync('src/app/[locale]/not-found.tsx', 'utf8');
  assert.match(s, /export async function generateMetadata/);
  assert.match(s, /getTranslations\('NotFound'\)/);
  assert.match(s, /title: t\('meta\.title'\)/);
  assert.match(s, /robots: \{ index: false, follow: true \}/);
  assert.doesNotMatch(s, /redirect\(/);
  const rest = readFileSync('src/app/[locale]/[...rest]/page.tsx', 'utf8');
  assert.match(rest, /notFound\(\)/);
});
