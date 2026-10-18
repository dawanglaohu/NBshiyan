import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { MemoryStore, setRateLimitStore } from '../src/lib/server/ratelimit/index';
import { PUBLISHED_LOCALES, PublishedLocaleSchema, isPublishedLocale, toPublishedLocale } from '../src/lib/server/published-locales';
import { parseLocale } from '../src/lib/server/specs';
import { DesignBody } from '../src/lib/server/designs';
import { routing } from '../src/i18n/routing';

// 多语言第 0 期前置：DB 枚举只追加预留值；公开接口仍只接受已发布语言（未发布 → 400，不是 500）
const RESERVED = ['es', 'de', 'fr', 'ja', 'hi', 'ar'];
const schema = readFileSync('prisma/schema.prisma', 'utf8');
const enumValues = () => {
  const m = schema.match(/enum Locale \{([^}]*)\}/);
  assert.ok(m, 'enum Locale missing');
  return m[1].split('\n').map((l) => l.replace(/\/\/.*$/, '').trim()).filter(Boolean);
};

test('schema: enum Locale keeps en, ru first (order unchanged) and appends es/de/fr/ja/hi/ar', () => {
  assert.deepEqual(enumValues(), ['en', 'ru', ...RESERVED]);
});

test('generated Prisma client knows the new values', async () => {
  const { Locale } = await import('@prisma/client');
  for (const v of ['en', 'ru', ...RESERVED]) assert.equal((Locale as Record<string, string>)[v], v);
});

test('review-only SQL contains only ALTER TYPE "Locale" ADD VALUE for the reserved values, and passes the deploy plan gate', () => {
  const f = 'prisma/sql/locale-enum-values.sql';
  const sql = readFileSync(f, 'utf8');
  assert.match(sql, /review-only/);
  const stmts = sql.split('\n').map((l) => l.replace(/--.*$/, '').trim()).filter(Boolean);
  assert.deepEqual(stmts, RESERVED.map((v) => `ALTER TYPE "Locale" ADD VALUE '${v}';`));
  const out = execFileSync('bash', ['-c', '. deploy/plan-check.sh; plan_problems "$1"', '_', f], { encoding: 'utf8' });
  assert.equal(out.trim(), '', out);
});

test('published list: only en, ru; subset of routing locales; reserved values are not published', () => {
  assert.deepEqual([...PUBLISHED_LOCALES], ['en', 'ru']);
  for (const l of PUBLISHED_LOCALES) assert.ok((routing.locales as readonly string[]).includes(l), l);
  for (const v of RESERVED) {
    assert.equal(isPublishedLocale(v), false, v);
    assert.equal(PublishedLocaleSchema.safeParse(v).success, false, v);
    assert.equal(toPublishedLocale(v), 'en', v);
  }
  assert.equal(toPublishedLocale('ru'), 'ru');
  assert.equal(toPublishedLocale(null), 'en');
});

test('spec validation: en/ru (and missing → en) accepted; ja/es/unknown rejected (route answers 400)', () => {
  assert.equal(parseLocale(null), 'en');
  assert.equal(parseLocale('en'), 'en');
  assert.equal(parseLocale('ru'), 'ru');
  for (const v of ['ja', 'es', 'de', 'zz', 'EN', '']) assert.equal(parseLocale(v), null, v);
  for (const f of ['src/app/api/specs/route.ts', 'src/app/api/specs/[category]/route.ts'])
    assert.match(readFileSync(f, 'utf8'), /if \(!locale\) return NextResponse\.json\(\{ error: 'invalid_locale' \}, \{ status: 400 \}\)/, f);
});

test('spec GET route: ?locale=ja / ?locale=es → 400 invalid_locale before touching the DB', async () => {
  const { GET } = await import('../src/app/api/specs/route');
  for (const v of ['ja', 'es']) {
    const res = await GET(new Request(`http://x/api/specs?locale=${v}`));
    assert.equal(res.status, 400, v);
    assert.deepEqual(await res.json(), { error: 'invalid_locale' });
  }
});

test('design body: reserved locales rejected, en/ru accepted', () => {
  const base = { productSlug: 'x', config: {} };
  for (const v of ['ja', 'es']) assert.equal(DesignBody.safeParse({ ...base, locale: v }).success, false, v);
  for (const v of ['en', 'ru']) {
    const r = DesignBody.safeParse({ ...base, locale: v });
    assert.ok(r.success || !r.error.flatten().fieldErrors.locale, v);
  }
});

test('inquiry POST: locale ja/es → 400 with a locale field error; en/ru produce no locale error', async () => {
  const { POST } = await import('../src/app/api/inquiries/route');
  setRateLimitStore(new MemoryStore());
  // 其余字段故意不完整：请求在 zod 校验处就返回 400，不会走到数据库；只看 locale 有没有被单独判错
  const post = async (locale: string) => {
    const res = await POST(new Request('http://x/api/inquiries', { method: 'POST', body: JSON.stringify({ source: 'FORM', locale }) }));
    const body = await res.json();
    return { status: res.status, localeErr: body?.issues?.fieldErrors?.locale };
  };
  try {
    for (const v of ['ja', 'es']) {
      const r = await post(v);
      assert.equal(r.status, 400, v);
      assert.ok(r.localeErr?.length, `${v} should fail on locale`);
    }
    for (const v of ['en', 'ru']) {
      const r = await post(v);
      assert.equal(r.status, 400, v); // contact 缺失
      assert.equal(r.localeErr, undefined, `${v} must pass locale validation`);
    }
  } finally { setRateLimitStore(undefined); }
});

test('inquiry route validates locale only via the shared published list', () => {
  const src = readFileSync('src/app/api/inquiries/route.ts', 'utf8');
  assert.match(src, /locale: PublishedLocaleSchema/);
  assert.ok(!/nativeEnum\(\s*Locale/.test(src));
  assert.ok(!/z\.enum\(\['en', 'ru'\]\)/.test(src + readFileSync('src/lib/server/designs.ts', 'utf8')));
});
