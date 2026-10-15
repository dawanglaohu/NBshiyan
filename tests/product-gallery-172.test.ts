import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Box3, Mesh, BoxGeometry, Group, AnimationClip, VectorKeyframeTrack } from 'three';
import { hintText } from '../src/components/three/hint';
import { fitDistance, frameBox, unionAnimatedBox } from '../src/lib/three/framing';
import en from '../messages/en.json';
import ru from '../messages/ru.json';

const L = { tap: 'Tap', drag: 'Drag', loading: 'Loading' };
const base = { failed: false, started: false, ready: false, interacting: false, coarse: false };

test('#172-3: 3D 未开始加载时不显示“加载中”', () => {
  assert.equal(hintText(base, L), null);
  assert.equal(hintText({ ...base, started: true }, L), 'Loading');
  assert.equal(hintText({ ...base, failed: true, started: true }, L), null);
});

test('#172-10: 鼠标显示拖动、触屏显示点击', () => {
  assert.equal(hintText({ ...base, ready: true }, L), 'Drag');
  assert.equal(hintText({ ...base, ready: true, coarse: true }, L), 'Tap');
  assert.equal(hintText({ ...base, ready: true, interacting: true }, L), '↻');
});

test('#172-10: EN/RU 都有 dragToRotate 文案', () => {
  assert.equal(en.Products.dragToRotate, 'Drag to rotate');
  assert.equal(ru.Products.dragToRotate, 'Потяните, чтобы повернуть');
});

test('fitDistance: 窄卡片（手机竖屏）要退得更远', () => {
  const wide = fitDistance(1, 40, 1.5);
  const narrow = fitDistance(1, 40, 0.6);
  assert.ok(narrow > wide);
  // 包围球在竖直方向刚好放下（含 15% 留白）
  assert.ok(Math.abs(wide - 1.15 / Math.sin((20 * Math.PI) / 180)) < 1e-9);
});

test('frameBox: near/far 包住整个模型', () => {
  const f = frameBox([-0.1, 0, -0.1], [0.1, 0.3, 0.1], 40, 1);
  const r = Math.hypot(0.2, 0.3, 0.2) / 2;
  assert.ok(f.near > 0 && f.near < f.distance - r);
  assert.ok(f.far > f.distance * 2 + r);
  assert.deepEqual(f.center.map((x) => +x.toFixed(6)), [0, 0.15, 0]);
});

test('#172-1/2: 包围盒包含 Open 片段的末帧（盖子抬起）', () => {
  const root = new Group();
  root.add(new Mesh(new BoxGeometry(1, 1, 1)));
  const lid = new Mesh(new BoxGeometry(1, 0.1, 1));
  lid.name = 'Lid';
  lid.position.set(0, 0.55, 0);
  root.add(lid);
  const clip = new AnimationClip('Open', 1, [new VectorKeyframeTrack('Lid.position', [0, 1], [0, 0.55, 0, 0, 2, -1])]);
  const closed = new Box3().setFromObject(root);
  const u = unionAnimatedBox(root, [clip]);
  assert.ok(Math.abs(closed.max.y - 0.6) < 1e-6);
  assert.ok(Math.abs(u.max.y - 2.05) < 1e-6);
  assert.ok(u.min.z <= -1.5 + 1e-6);
  // 采样后姿态复位到首帧
  assert.ok(Math.abs(lid.position.y - 0.55) < 1e-6);
});
