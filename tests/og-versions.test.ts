import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ogVersions from '../src/data/og-versions.json';
import { ogImageUrl } from '../src/lib/seo/pageMeta';

const OG = path.join(process.cwd(), 'public/og');
const files = fs.readdirSync(OG).filter((f) => f.endsWith('.jpg')).sort();
const sha8 = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(path.join(OG, f))).digest('hex').slice(0, 8);
const versions = ogVersions as Record<string, string>;

test('og-versions.json 覆盖 public/og 的每张图，且 v = 文件 sha256 前 8 位（换图后要重跑 design/og-src/og-versions.mjs）', () => {
  assert.deepEqual(Object.keys(versions).sort(), files);
  for (const f of files) assert.equal(versions[f], sha8(f), f);
});

test('og:image URL 都带 ?v=，且与文件内容哈希一致', () => {
  const slugs = ['home', 'products', 'contact', 'privacy'];
  for (const s of slugs) for (const l of ['en', 'ru']) {
    const u = new URL(ogImageUrl(s, l));
    assert.equal(u.pathname, `/og/${s}-${l}.jpg`);
    assert.match(u.searchParams.get('v') ?? '', /^[0-9a-f]{8}$/);
    assert.equal(u.searchParams.get('v'), sha8(`${s}-${l}.jpg`));
  }
});

test('没有 eco-paper-cups 分享图（#296）', () => {
  assert.deepEqual(files.filter((f) => /eco/i.test(f)), []);
});
