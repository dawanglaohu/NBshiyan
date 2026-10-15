import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lightRig, RIM_LIGHT } from '../src/components/three/lights';

test('浅色卡片：灯光不变（无轮廓光）', () => {
  const r = lightRig(false);
  assert.equal(r.ambient, 0.25);
  assert.equal(r.directional.length, 2);
  assert.ok(!r.directional.includes(RIM_LIGHT));
});

test('深色卡片：多一盏轮廓光，其余不变，环境光不加（不冲灰）', () => {
  const l = lightRig(false), d = lightRig(true);
  assert.equal(d.ambient, l.ambient);
  assert.deepEqual(d.directional.slice(0, 2), l.directional);
  assert.equal(d.directional.length, 3);
  assert.equal(d.directional[2], RIM_LIGHT);
});

test('轮廓光在盒子后上方，与默认相机方向相反', () => {
  const cam = [2.4, 1.6, 2.6];
  const [x, y, z] = RIM_LIGHT.position;
  assert.ok(y > 0);
  // 水平分量与相机方向夹角大于 90°
  assert.ok(x * cam[0] + z * cam[2] < 0);
});

test('.theme-premium 有自己的 --placeholder 和 --stage-bg', () => {
  const css = readFileSync('src/styles/tokens.css', 'utf8');
  const prem = css.match(/\.theme-premium\{[^}]*\}/)?.[0] ?? '';
  assert.match(prem, /--placeholder:#26262C/);
  assert.match(prem, /--stage-bg:#1D1D22/);
  assert.match(css, /:root[^}]*--placeholder:#FBF8F3/);
});

test('卡片深色样式与 3D 轮廓光用同一份 PREMIUM 判断', () => {
  const src = readFileSync('src/components/three/ProductGallery.tsx', 'utf8');
  assert.match(src, /PREMIUM\.has\(p\.slug\) \? ' theme-premium'/);
  assert.match(src, /dark: PREMIUM\.has\(p\.slug\)/);
});
