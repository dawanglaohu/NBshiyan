import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { categoryMeta } from '../src/lib/seo/categoryMeta';
import { categoryOgImage } from '../src/lib/seo/categoryOg';

const OG = path.join(process.cwd(), 'public/og');
const sha8 = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(path.join(OG, f))).digest('hex').slice(0, 8);

test('11 个品类 × EN/RU：og:image 文件存在，?v= = 文件哈希，alt、尺寸正确', () => {
  assert.equal(categoryMeta.length, 11);
  let n = 0;
  for (const c of categoryMeta) for (const l of ['en', 'ru'] as const) {
    const img = categoryOgImage(l, c[l].slug);
    assert.ok(img, `${l}/${c[l].slug}`);
    const file = `category-${c[l].slug}-${l}.jpg`;
    assert.ok(fs.existsSync(path.join(OG, file)), file);
    const u = new URL(img.url);
    assert.equal(u.pathname, `/og/${file}`);
    assert.equal(u.searchParams.get('v'), sha8(file));
    assert.equal(img.width, 1200);
    assert.equal(img.height, 630);
    assert.equal(img.alt, `${c[l].keyword} | PackJoyU`);
    n++;
  }
  assert.equal(n, 22);
});

test('EN slug 在 RU 下查不到（反之亦然）', () => {
  assert.equal(categoryOgImage('ru', 'custom-gift-boxes'), undefined);
  assert.equal(categoryOgImage('en', 'podarochnye-korobki'), undefined);
});

test('原型链/路径/未知 slug 不输出 og:image', () => {
  for (const s of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'length', '../x', '..%2Fx', 'unknown', ''])
    for (const l of ['en', 'ru'] as const) assert.equal(categoryOgImage(l, s), undefined, `${l}/${s}`);
});
