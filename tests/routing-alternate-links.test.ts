import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import createMiddleware from 'next-intl/middleware';
import { routing } from '../src/i18n/routing';

test('routing.alternateLinks is false (hreflang only from HTML metadata)', () => {
  assert.equal(routing.alternateLinks, false);
});

test('next-intl middleware sends no hreflang Link header', async () => {
  const intl = createMiddleware(routing);
  for (const path of ['/en', '/ru', '/en/products', '/']) {
    const res = await intl(new NextRequest(new URL(path, 'http://localhost:3000')));
    const link = res.headers.get('link') ?? '';
    assert.ok(!/hreflang/i.test(link), `${path} has Link hreflang: ${link}`);
    assert.ok(!/localhost/i.test(link), `${path} Link leaks internal host: ${link}`);
  }
});
