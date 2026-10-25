import { test } from 'node:test';
import assert from 'node:assert/strict';
import { landingFor, modelsToProducts, loadCatalog, type CatalogModel } from '../src/lib/catalog/catalog';
import type { Product } from '../src/data/products';

const fallback: Product[] = [
  { slug: 'gift-boxes', model: '/models/gift.glb', poster: '/images/posters/gift.webp', animated: true, animationClips: { open: 'Open' } },
  { slug: 'paper-cups', model: '/models/cup.glb', poster: '/images/placeholder.svg' },
];
const m = (o: Partial<CatalogModel>): CatalogModel => ({ productSlug: 'p', category: 'gift-boxes', published: true, status: 'READY', animated: false, slugs: null, glbUrl: '/api/models/1/glb?v=a', posterUrl: null, ...o });

test('landingFor: 按语言取 slug，null 不出链接', () => {
  const s = { en: 'custom-gift-boxes', ru: 'podarochnye-korobki' };
  assert.equal(landingFor(s, 'en'), '/products/custom-gift-boxes');
  assert.equal(landingFor(s, 'ru'), '/products/podarochnye-korobki');
  assert.equal(landingFor(null, 'en'), undefined);
  assert.equal(landingFor({ en: '../x', ru: 'https://evil' }, 'en'), undefined);
  assert.equal(landingFor({ en: '../x', ru: 'https://evil' }, 'ru'), undefined);
});
test('modelsToProducts: 不合法或不在目录里的 category 不替换，也不拼 /products/null', () => {
  const out = modelsToProducts([m({ category: 'unknown-cat', productSlug: 'x-1', slugs: null })], 'en', fallback);
  assert.deepEqual(out.map((p) => p.slug), ['gift-boxes', 'paper-cups']);
  assert.equal(out[0].model, '/models/gift.glb');
  assert.ok(!JSON.stringify(out).includes('/products/null'));
  assert.ok(!JSON.stringify(out).includes('unknown-cat'));
});
test('modelsToProducts: 同品类只替换一次，海报空则留本地图，片段沿用本地', () => {
  const out = modelsToProducts([
    m({ animated: true, slugs: { en: 'custom-gift-boxes', ru: 'podarochnye-korobki' } }),
    m({ glbUrl: '/api/models/2/glb' }),
    m({ category: 'paper-cups', posterUrl: '/api/models/3/poster?v=b' }),
  ], 'ru', fallback);
  assert.deepEqual(out.map((p) => p.slug), ['gift-boxes', 'paper-cups']);
  assert.equal(out[0].model, '/api/models/1/glb?v=a');
  assert.deepEqual(out[0].animationClips, { open: 'Open' });
  assert.equal(out[0].poster, '/images/posters/gift.webp');
  assert.equal(out[0].landing, undefined);
  assert.equal(out[1].poster, '/api/models/3/poster?v=b');
  assert.equal(out[1].model, '/api/models/1/glb?v=a');
  assert.equal(out[1].animationClips, undefined);
});
test('loadCatalog: 出错回退本地数据，空列表走空状态', async () => {
  const fb = await loadCatalog(async () => { throw new Error('db down'); }, 'en', fallback);
  assert.equal(fb.source, 'fallback');
  assert.deepEqual(fb.products, fallback);
  assert.equal((await loadCatalog(async () => [], 'en', fallback)).source, 'fallback');
  assert.deepEqual(await loadCatalog(async () => [], 'en', fallback, { strictEmpty: true }), { source: 'empty', products: [] });
  assert.deepEqual(await loadCatalog(async () => [], 'en', []), { source: 'empty', products: [] });
  // 回退不改动本地数据
  assert.notEqual(fb.products, fallback);
  const ok = await loadCatalog(async () => [m({})], 'en', fallback);
  assert.equal(ok.source, 'api');
});
