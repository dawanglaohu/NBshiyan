import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeDailyMetrics,
  factKey,
  isIncludedFact,
  isSmokePath,
  meanDurationMs,
  normalizePath,
  partitionTerminals,
  pickTerminalPerStart,
  successRate,
  type AnalyticsFact,
} from '../src/lib/analytics/daily-aggregate';

const at = (iso: string): Date => new Date(iso);

function fact(overrides: Partial<AnalyticsFact> & Pick<AnalyticsFact, 'eventId' | 'kind' | 'browserHash'>): AnalyticsFact {
  return {
    viewId: null,
    occurredAt: at('2026-11-10T10:00:00.000Z'),
    durationMs: null,
    locale: 'en',
    productSlug: null,
    path: null,
    ...overrides,
  };
}

test('normalizePath 去掉 query 与 fragment', () => {
  assert.equal(normalizePath('/en/products/corrugated-boxes?x=1#y'), '/en/products/corrugated-boxes');
  assert.equal(normalizePath('/en/contact'), '/en/contact');
  assert.equal(normalizePath(null), null);
});

test('冒烟谓词：整条或任一段以 nbs-smoke- 开头才排除，NULL 放行', () => {
  assert.equal(isSmokePath(null), false);
  assert.equal(isSmokePath('/nbs-smoke-home'), true);
  assert.equal(isSmokePath('/en/nbs-smoke-about?x=1'), true);
  assert.equal(isSmokePath('/en/products/nbs-smoke-x#h'), true);
  assert.equal(isSmokePath('/en/nbs-smoke-x/child'), true);
  assert.equal(isSmokePath('/en/foo-nbs-smoke-x'), false);
  assert.equal(isSmokePath('/en/products/corrugated-boxes'), false);
});

test('isIncludedFact 只放行六类非冒烟事实', () => {
  assert.equal(isIncludedFact(fact({ eventId: 'e1', kind: 'page_view', browserHash: 'b' })), true);
  assert.equal(
    isIncludedFact(fact({ eventId: 'e2', kind: 'page_view', browserHash: 'b', path: '/en/nbs-smoke-a' })),
    false,
  );
  const foreign = fact({ eventId: 'e3', kind: 'page_view', browserHash: 'b' });
  assert.equal(isIncludedFact({ ...foreign, kind: 'consent_granted' as never }), false);
});

test('终态按 occurredAt<=notAfter 分区，等号计入', () => {
  const notAfter = at('2026-11-10T23:59:59.000Z');
  const { counted, deferred } = partitionTerminals(
    [
      fact({ eventId: 't1', kind: 'model_load_success', browserHash: 'b', occurredAt: notAfter }),
      fact({ eventId: 't2', kind: 'model_load_failure', browserHash: 'b', occurredAt: at('2026-11-11T00:00:00.001Z') }),
    ],
    notAfter,
  );
  assert.deepEqual(counted.map((f) => f.eventId), ['t1']);
  assert.deepEqual(deferred.map((f) => f.eventId), ['t2']);
});

test('同键终态取最早，同刻按 eventId 稳定', () => {
  const picked = pickTerminalPerStart([
    fact({ eventId: 'z', kind: 'model_load_failure', browserHash: 'b', viewId: 'v', occurredAt: at('2026-11-10T12:00:00Z') }),
    fact({ eventId: 'a', kind: 'model_load_success', browserHash: 'b', viewId: 'v', occurredAt: at('2026-11-10T11:00:00Z') }),
  ]);
  assert.equal(picked.get(factKey({ browserHash: 'b', viewId: 'v' })!)?.eventId, 'a');
});

test('站点行：UV/事件计数/配对终态与精确耗时总和', () => {
  const facts: AnalyticsFact[] = [
    fact({ eventId: 's1', kind: 'page_view', browserHash: 'b1' }),
    fact({ eventId: 's2', kind: 'page_view', browserHash: 'b2' }),
    fact({ eventId: 's3', kind: 'product_view', browserHash: 'b1', productSlug: 'box' }),
    fact({ eventId: 's4', kind: 'model_view_start', browserHash: 'b1', viewId: 'v1', productSlug: 'box' }),
    fact({ eventId: 's5', kind: 'chat_start', browserHash: 'b3' }),
  ];
  const terminals: AnalyticsFact[] = [
    fact({ eventId: 't1', kind: 'model_load_success', browserHash: 'b1', viewId: 'v1', durationMs: 1200 }),
    fact({ eventId: 't2', kind: 'model_load_failure', browserHash: 'b1', viewId: 'v9', durationMs: 800 }),
  ];
  const result = computeDailyMetrics(facts, terminals, { localDate: '2026-11-10', notAfter: at('2026-11-10T23:59:59Z') });
  assert.deepEqual(result.site, {
    dimension: 'site',
    visitors: 3,
    pageViews: 2,
    productViews: 1,
    modelStarts: 1,
    modelSuccesses: 1,
    modelFailures: 0,
    chatStarts: 1,
    durationMsSum: 1200n,
    loadDurationSamples: 1,
  });
  assert.deepEqual(result.unattributableTerminals.map((f) => f.eventId), ['t2']);
});

test('产品行：pageViews=NULL、UV 单独 distinct、同产品 en+ru 仍为 1', () => {
  const resolve = (p: string) => (p.includes('/products/box') ? 'box' : null);
  const facts: AnalyticsFact[] = [
    fact({ eventId: 'a', kind: 'page_view', browserHash: 'b1', locale: 'en', path: '/en/products/box' }),
    fact({ eventId: 'b', kind: 'page_view', browserHash: 'b1', locale: 'ru', path: '/ru/products/box' }),
    fact({ eventId: 'c', kind: 'product_view', browserHash: 'b1', productSlug: 'box' }),
    fact({ eventId: 'd', kind: 'model_view_start', browserHash: 'b2', viewId: 'v2', productSlug: 'box' }),
  ];
  const { products } = computeDailyMetrics(facts, [], { localDate: '2026-11-10', notAfter: at('2026-11-10T23:59:59Z'), resolveProductSlugFromPath: resolve });
  const box = products.get('box');
  assert.ok(box);
  assert.equal(box.dimension, 'product:box');
  assert.equal(box.pageViews, null);
  assert.equal(box.visitors, 2);
  assert.equal(box.productViews, 1);
  assert.equal(box.modelStarts, 1);
});

test('均值与成功率：samples=0 → null；有分母零成功 → 0%', () => {
  assert.equal(meanDurationMs(0n, 0), null);
  assert.equal(meanDurationMs(3600n, 3), 1200);
  assert.equal(successRate(0, 0), null);
  assert.equal(successRate(4, 0), 0);
  assert.equal(successRate(4, 1), 0.25);
});

test('拒绝/撤回类事件不进任何计算；冒烟事实与冒烟终态被过滤', () => {
  const facts: AnalyticsFact[] = [
    fact({ eventId: 'x1', kind: 'page_view', browserHash: 'b1', path: '/nbs-smoke-home' }),
    fact({ eventId: 'x2', kind: 'consent_granted' as never, browserHash: 'b2' }),
  ];
  const terminals: AnalyticsFact[] = [
    fact({ eventId: 'x3', kind: 'model_load_success', browserHash: 'b1', viewId: 'v1', durationMs: 500 }),
  ];
  const result = computeDailyMetrics(facts, terminals, { localDate: '2026-11-10', notAfter: at('2026-11-10T23:59:59Z') });
  assert.equal(result.site.visitors, 0);
  assert.equal(result.site.pageViews, 0);
  assert.equal(result.site.modelSuccesses, 0);
  assert.equal(result.site.loadDurationSamples, 0);
});
