import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as shared from '../src/i18n/published-locales';
import * as server from '../src/lib/server/published-locales';
import { routing } from '../src/i18n/routing';
import { MemoryStore, setRateLimitStore } from '../src/lib/server/ratelimit/index';

// 多语言第 0 期：已发布语言的字面清单只在 src/i18n/published-locale-list.ts。
// published-locales.ts 核对它是路由语言和数据库枚举的子集；服务端再 re-export 并加 zod。
const listSrc = readFileSync('src/i18n/published-locale-list.ts', 'utf8');
const sharedSrc = readFileSync('src/i18n/published-locales.ts', 'utf8');
const serverSrc = readFileSync('src/lib/server/published-locales.ts', 'utf8');

test('shared layer: no zod, Prisma only via import type, no server imports', () => {
  assert.ok(!/^import /m.test(listSrc), 'locale list has no imports');
  for (const src of [listSrc, sharedSrc]) {
    assert.ok(!/from ['"]zod['"]/.test(src));
    for (const m of src.matchAll(/^import (.*) from ['"]([^'"]+)['"]/gm)) {
      if (m[2] === '@prisma/client') assert.match(m[1], /^type /, 'Prisma must be import type');
      assert.ok(!m[2].includes('lib/server'), m[2]);
    }
  }
});

test('server layer re-exports the shared list (same array object), never a second literal', () => {
  assert.match(serverSrc, /import \{[^}]*PUBLISHED_LOCALES[^}]*\} from '@\/i18n\/published-locales'/);
  assert.ok(!/\[\s*'en'\s*,\s*'ru'\s*\]/.test(serverSrc), 'no duplicated array literal in server layer');
  assert.equal(server.PUBLISHED_LOCALES, shared.PUBLISHED_LOCALES);
  assert.equal(server.isPublishedLocale, shared.isPublishedLocale);
  assert.equal(server.DEFAULT_PUBLISHED_LOCALE, shared.DEFAULT_PUBLISHED_LOCALE);
  assert.equal(typeof server.PublishedLocaleSchema.safeParse, 'function');
  assert.equal(typeof server.toPublishedLocale, 'function');
});

test('published ⊆ routing.locales; default is en; reserved/unknown/case variants are not published', () => {
  assert.deepEqual([...shared.PUBLISHED_LOCALES], ['en', 'ru']);
  for (const l of shared.PUBLISHED_LOCALES) assert.ok((routing.locales as readonly string[]).includes(l), l);
  assert.equal(shared.DEFAULT_PUBLISHED_LOCALE, 'en');
  assert.equal(routing.defaultLocale, shared.DEFAULT_PUBLISHED_LOCALE);
  for (const v of ['es', 'de', 'fr', 'ja', 'hi', 'ar', 'xx', 'EN', 'Ru', 'en-US', '', null, undefined, 1]) assert.equal(shared.isPublishedLocale(v), false, String(v));
  for (const v of ['en', 'ru']) assert.equal(shared.isPublishedLocale(v), true, v);
});

test('exactly one published-locale array literal', () => {
  const files = [
    'src/lib/server/published-locales.ts',
    'src/i18n/published-locales.ts',
    'src/i18n/published-locale-list.ts',
    'src/lib/contracts/common.ts',
  ];
  const hits = files.flatMap((file) => {
    const n = (readFileSync(file, 'utf8').match(/\['en', 'ru'\] as const/g) ?? []).length;
    return n ? [`${file}:${n}`] : [];
  });
  assert.deepEqual(hits, ['src/i18n/published-locale-list.ts:1']);
});

// 全栈要求：三个公开接口对 ja / es 仍返回 400（在查库之前）
test('public endpoints: inquiries / designs / specs answer 400 for ja and es', async () => {
  setRateLimitStore(new MemoryStore());
  try {
    const inq = (await import('../src/app/api/inquiries/route')).POST;
    const des = (await import('../src/app/api/designs/route')).POST;
    const spec = (await import('../src/app/api/specs/route')).GET;
    const specCat = (await import('../src/app/api/specs/[category]/route')).GET;
    for (const v of ['ja', 'es']) {
      const r1 = await inq(new Request('http://x/api/inquiries', { method: 'POST', body: JSON.stringify({ source: 'FORM', locale: v }) }));
      assert.equal(r1.status, 400, `inquiries ${v}`);
      assert.ok((await r1.json())?.issues?.fieldErrors?.locale?.length, `inquiries ${v} locale error`);
      const r2 = await des(new Request('http://x/api/designs', { method: 'POST', body: JSON.stringify({ productSlug: 'gift-boxes', config: {}, locale: v }) }));
      assert.equal(r2.status, 400, `designs ${v}`);
      assert.ok((await r2.json())?.issues?.fieldErrors?.locale?.length, `designs ${v} locale error`);
      const r3 = await spec(new Request(`http://x/api/specs?locale=${v}`));
      assert.equal(r3.status, 400, `specs ${v}`);
      const r4 = await specCat(new Request(`http://x/api/specs/gift-boxes?locale=${v}`), { params: Promise.resolve({ category: 'gift-boxes' }) } as never);
      assert.equal(r4.status, 400, `specs/[category] ${v}`);
    }
  } finally { setRateLimitStore(undefined); }
});
