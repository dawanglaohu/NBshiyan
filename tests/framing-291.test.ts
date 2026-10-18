import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Box3, Mesh, BoxGeometry, Group, AnimationClip, VectorKeyframeTrack } from 'three';
import { frameClosedBox, openDollyFactor, openFraming, projectBox, projectPoints, closedPoseBox, sampleAnimatedPoints, samplePoints, hullPoints, easeInOut, FILL, MARGIN, OPEN_DOLLY_MAX, OPEN_DOLLY_MS } from '../src/lib/three/framing';
import { readFileSync } from 'node:fs';

type V3 = [number, number, number];
const box = (s: V3): [V3, V3] => [[-s[0] / 2, 0, -s[2] / 2], [s[0] / 2, s[1], s[2] / 2]];
const SHAPES: Record<string, V3> = { cube: [1, 1, 1], tall: [0.6, 1.4, 0.6], flat: [2, 0.15, 1.4], wide: [2.4, 0.5, 0.4] };

test('#291: UX 定稿的取景参数', () => {
  assert.equal(FILL, 0.7);
  assert.equal(MARGIN, 1.08);
  assert.equal(OPEN_DOLLY_MAX, 1.1);
  assert.equal(OPEN_DOLLY_MS, 300);
});

test('#291: 4:3 卡片上合盖包围盒占画面高度 70%（不被宽度限制时）', () => {
  for (const s of [SHAPES.cube, SHAPES.tall, SHAPES.wide]) {
    const [mn, mx] = box(s);
    const f = frameClosedBox(mn, mx, 40, 4 / 3);
    assert.ok(Math.abs(f.fill - 0.7) < 1e-3, `fill ${f.fill}`);
    assert.ok(f.widthFill <= 1 / 1.08 + 1e-6);
  }
});

test('#291: 任何画面比例下四边都至少留 1.08 余量；窄画面按宽度放下', () => {
  for (const s of Object.values(SHAPES)) for (const aspect of [16 / 9, 4 / 3, 1, 0.75, 0.6]) {
    const [mn, mx] = box(s);
    const f = frameClosedBox(mn, mx, 40, aspect);
    const e = projectBox(mn, mx, f.center, f.distance, 40, aspect);
    const m = 1 / 1.08 + 1e-6;
    assert.ok(e.x0 >= -m && e.x1 <= m && e.y0 >= -m && e.y1 <= m, `${s} @${aspect}`);
    // 要么高度刚好 70%，要么宽度顶到余量（按宽度放下）
    assert.ok(Math.abs(f.fill - 0.7) < 1e-3 || Math.abs(f.widthFill - 1 / 1.08) < 1e-3, `${s} @${aspect}: ${f.fill}/${f.widthFill}`);
    assert.ok(f.fill <= 0.7 + 1e-3);
  }
});

test('#291: 投影后的包围盒居中', () => {
  const [mn, mx] = box(SHAPES.tall);
  const f = frameClosedBox(mn, mx, 40, 4 / 3);
  const e = projectBox(mn, mx, f.center, f.distance, 40, 4 / 3);
  assert.ok(Math.abs(e.x0 + e.x1) < 1e-3 && Math.abs(e.y0 + e.y1) < 1e-3);
});

test('#291: 合盖产品占画面高度在 65–75% 之间', () => {
  // 原来按开合并集的包围球取景，合盖时产品偏小；现在合盖包围盒落在 UX 要求的 65–75%
  const [mn, mx] = box(SHAPES.cube);
  const f = frameClosedBox(mn, mx, 40, 4 / 3);
  assert.ok(f.fill >= 0.65 && f.fill <= 0.75);
});

test('#291: 开盖拉远倍数在 1…1.1 之间；开盖范围放得下时不拉远', () => {
  const [mn, mx] = box(SHAPES.cube);
  const f = frameClosedBox(mn, mx, 40, 4 / 3);
  assert.equal(openDollyFactor(f, mn, mx, 40, 4 / 3), 1);
  const small = openDollyFactor(f, mn, [0.5, 1.3, 0.5], 40, 4 / 3);
  assert.ok(small > 1 && small < 1.1, `${small}`);
  // 刚好放下：拉远后并集包围盒落在 1/1.08 以内
  const e = projectBox(mn, [0.5, 1.3, 0.5], f.center, f.distance * small, 40, 4 / 3);
  assert.ok(e.y1 <= 1 / 1.08 + 1e-6);
  // 放不下时封顶 10%（盖子允许稍微出画）
  assert.equal(openDollyFactor(f, [-0.5, 0, -1.2], [0.5, 2.2, 0.5], 40, 4 / 3), 1.1);
});

test('#291: 合盖包围盒取 Open 片段首帧，不含开盖后的盖子', () => {
  const root = new Group();
  root.add(new Mesh(new BoxGeometry(1, 1, 1)));
  const lid = new Mesh(new BoxGeometry(1, 0.1, 1));
  lid.name = 'Lid';
  lid.position.set(0, 3, 0); // 静止姿态和首帧不同：以首帧为准
  root.add(lid);
  const clip = new AnimationClip('Open', 1, [new VectorKeyframeTrack('Lid.position', [0, 1], [0, 0.55, 0, 0, 2, -1])]);
  const b = closedPoseBox(root, [clip]);
  assert.ok(Math.abs(b.max.y - 0.6) < 1e-6);
  assert.ok(Math.abs(b.min.z + 0.5) < 1e-6);
  // 没有片段时就是静止姿态
  const s = closedPoseBox(root, []);
  assert.ok(Math.abs(s.max.y - new Box3().setFromObject(root).max.y) < 1e-6);
});

test('#291: 缓动两端固定、单调', () => {
  assert.equal(easeInOut(0), 0);
  assert.equal(easeInOut(1), 1);
  assert.equal(easeInOut(-1), 0);
  assert.equal(easeInOut(2), 1);
  let prev = 0;
  for (let i = 1; i <= 20; i++) { const v = easeInOut(i / 20); assert.ok(v >= prev); prev = v; }
});

test('#291: 画廊用合盖取景 + 开盖拉远，并尊重减少动态效果', () => {
  const src = readFileSync('src/components/three/GalleryScene.tsx', 'utf8');
  assert.match(src, /frameClosedBox\(/);
  assert.match(src, /openFraming\(/);
  assert.match(src, /prefers-reduced-motion: reduce/);
  assert.doesNotMatch(src, /frameBox\(/);
});

test('#291: 有顶点采样时按真实轮廓取景（圆柱比包围盒更大）', () => {
  // 圆柱（杯子）：包围盒的角比真实轮廓高 / 宽，按角取景会偏小
  const pts: [number, number, number][] = [];
  for (let k = 0; k < 64; k++) for (const y of [0, 1.2]) { const a = (k / 64) * Math.PI * 2; pts.push([Math.cos(a) * 0.4, y, Math.sin(a) * 0.4]); }
  const mn: V3 = [-0.4, 0, -0.4], mx: V3 = [0.4, 1.2, 0.4];
  const byBox = frameClosedBox(mn, mx, 40, 4 / 3);
  const byPts = frameClosedBox(mn, mx, 40, 4 / 3, { points: pts });
  assert.ok(byPts.distance < byBox.distance);
  assert.ok(Math.abs(byPts.fill - 0.7) < 1e-3);
  const e = projectPoints(pts, byPts.center, byPts.distance, 40, 4 / 3);
  assert.ok(Math.abs((e.y1 - e.y0) / 2 - 0.7) < 1e-3);
});

test('#291: 顶点采样取合盖首帧，并给出开盖过程的点', () => {
  const root = new Group();
  root.add(new Mesh(new BoxGeometry(1, 1, 1)));
  const lid = new Mesh(new BoxGeometry(1, 0.1, 1));
  lid.name = 'Lid';
  root.add(lid);
  const clip = new AnimationClip('Open', 1, [new VectorKeyframeTrack('Lid.position', [0, 1], [0, 0.55, 0, 0, 2, -1])]);
  const { closed, open } = sampleAnimatedPoints(root, [clip]);
  assert.ok(Math.abs(Math.max(...closed.map((p) => p[1])) - 0.6) < 1e-6);
  assert.ok(Math.abs(Math.max(...open.map((p) => p[1])) - 2.05) < 1e-6);
  assert.ok(Math.abs(lid.position.y) < 1e-6); // 采样后恢复原来的姿态
  assert.ok(samplePoints(root, 10).length <= 20);
});

test('#291: 凸包顶点取景和全部顶点结果一致', () => {
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pts: V3[] = [];
  for (let i = 0; i < 3000; i++) pts.push([rnd() * 0.3 - 0.15, rnd() * 0.05, rnd() * 0.3 - 0.15]);
  const h = hullPoints(pts);
  assert.ok(h.length < pts.length / 5);
  const mn: V3 = [-0.15, 0, -0.15], mx: V3 = [0.15, 0.05, 0.15];
  for (const aspect of [4 / 3, 0.6]) {
    const a = frameClosedBox(mn, mx, 40, aspect, { points: h }), b = frameClosedBox(mn, mx, 40, aspect, { points: pts });
    assert.ok(Math.abs(a.distance - b.distance) < 1e-9);
  }
});

// 开盖时盖子竖起来、整条弧线很高的模型（类似礼盒）和只稍微超出的模型
function lidRig(lidTo: V3) {
  const root = new Group();
  root.add(new Mesh(new BoxGeometry(1, 0.4, 1)));
  const lid = new Mesh(new BoxGeometry(1, 0.05, 1));
  lid.name = 'Lid';
  lid.position.set(0, 0.425, 0);
  root.add(lid);
  const clip = new AnimationClip('Open', 1, [new VectorKeyframeTrack('Lid.position', [0, 0.5, 1], [0, 0.425, 0, ...lidTo.map((v, i) => (v + [0, 0.425, 0][i]) / 2), ...lidTo] as number[])]);
  return { root, clip };
}

test('#291 礼盒: 开盖末帧在 10% 内放不下时放宽上限，按整条弧线取景（留 1.08 余量）', () => {
  const { root, clip } = lidRig([0, 1.6, -0.6]);
  const pts = sampleAnimatedPoints(root, [clip]);
  const closed = closedPoseBox(root, [clip]);
  const mn: V3 = [closed.min.x, closed.min.y, closed.min.z], mx: V3 = [closed.max.x, closed.max.y, closed.max.z];
  const f = frameClosedBox(mn, mx, 40, 4 / 3, { points: pts.closed });
  const o = openFraming(f, [-0.5, 0, -1.1], [0.5, 1.65, 0.5], 40, 4 / 3, { points: pts.open, end: pts.end });
  assert.equal(o.extended, true);
  assert.ok(o.distance / f.distance > 1.1);
  const e = projectPoints(pts.open, o.center, o.distance, 40, 4 / 3);
  const m = 1 / 1.08 + 1e-6;
  assert.ok(e.x0 >= -m && e.x1 <= m && e.y0 >= -m && e.y1 <= m);
  // 合盖取景不变
  const f2 = frameClosedBox(mn, mx, 40, 4 / 3, { points: pts.closed });
  assert.equal(f2.distance, f.distance);
});

test('#291: 开盖末帧在 10% 内放得下时，开盖镜头和原来一样（target 不动，最多 10%）', () => {
  const { root, clip } = lidRig([0, 0.15, 0]);
  const pts = sampleAnimatedPoints(root, [clip]);
  const closed = closedPoseBox(root, [clip]);
  const mn: V3 = [closed.min.x, closed.min.y, closed.min.z], mx: V3 = [closed.max.x, closed.max.y, closed.max.z];
  const f = frameClosedBox(mn, mx, 40, 4 / 3, { points: pts.closed });
  const oMin: V3 = [-0.5, 0, -0.5], oMax: V3 = [0.5, 0.6, 0.5];
  const o = openFraming(f, oMin, oMax, 40, 4 / 3, { points: pts.open, end: pts.end });
  assert.equal(o.extended, false);
  assert.deepEqual(o.center, f.center);
  assert.equal(o.distance, f.distance * openDollyFactor(f, oMin, oMax, 40, 4 / 3, { points: pts.open }));
  assert.ok(o.distance / f.distance <= 1.1 + 1e-9);
});

test('#291: 没有动画片段时开盖镜头 = 合盖镜头', () => {
  const [mn, mx] = box(SHAPES.cube);
  const f = frameClosedBox(mn, mx, 40, 4 / 3);
  const o = openFraming(f, mn, mx, 40, 4 / 3, {});
  assert.equal(o.extended, false);
  assert.equal(o.distance, f.distance);
});

// 酒盒式：盖子中途抬得很高（中途出画），开盖后静止的姿态只略高于盒身（10% 内放得下）
function arcRig() {
  const root = new Group();
  root.add(new Mesh(new BoxGeometry(0.5, 1, 0.5)));
  const lid = new Mesh(new BoxGeometry(0.5, 0.05, 0.5));
  lid.name = 'Lid';
  lid.position.set(0, 1.025, 0);
  root.add(lid);
  const clip = new AnimationClip('Open', 1, [new VectorKeyframeTrack('Lid.position', [0, 0.5, 1], [0, 1.025, 0, 0.3, 2.2, 0, 0.55, 1.03, 0])]);
  return { root, clip };
}

test('#291 酒盒: fitArc 时开合途中盖子出画也按整条弧线取景；不开时和原来一样', () => {
  const { root, clip } = arcRig();
  const pts = sampleAnimatedPoints(root, [clip]);
  const closed = closedPoseBox(root, [clip]);
  const mn: V3 = [closed.min.x, closed.min.y, closed.min.z], mx: V3 = [closed.max.x, closed.max.y, closed.max.z];
  const f = frameClosedBox(mn, mx, 40, 4 / 3, { points: pts.closed });
  const oMin: V3 = [-0.25, -0.5, -0.25], oMax: V3 = [0.8, 2.23, 0.25];
  const m = 1 / 1.08 + 1e-6;
  const inside = (e: { x0: number; x1: number; y0: number; y1: number }) => e.x0 >= -m && e.x1 <= m && e.y0 >= -m && e.y1 <= m;
  // 前提：末帧在 10% 内放得下，中途弧线放不下
  const plain = openFraming(f, oMin, oMax, 40, 4 / 3, { points: pts.open, end: pts.end });
  assert.equal(plain.extended, false);
  assert.ok(!inside(projectPoints(pts.open, plain.center, plain.distance, 40, 4 / 3)));
  // 默认（瓦楞盒等）：原样，target 不动，最多 10%
  assert.deepEqual(plain.center, f.center);
  assert.ok(plain.distance / f.distance <= 1.1 + 1e-9);
  // fitArc（酒盒）：整条弧线落在 1.08 余量内，只拉远不推近
  const o = openFraming(f, oMin, oMax, 40, 4 / 3, { points: pts.open, end: pts.end, fitArc: true });
  assert.equal(o.extended, true);
  assert.ok(o.distance > f.distance);
  assert.ok(inside(projectPoints(pts.open, o.center, o.distance, 40, 4 / 3)));
});

test('#291: fitArc 对整条弧线本来就放得下的产品没有影响', () => {
  const { root, clip } = lidRig([0, 0.15, 0]);
  const pts = sampleAnimatedPoints(root, [clip]);
  const closed = closedPoseBox(root, [clip]);
  const mn: V3 = [closed.min.x, closed.min.y, closed.min.z], mx: V3 = [closed.max.x, closed.max.y, closed.max.z];
  const f = frameClosedBox(mn, mx, 40, 4 / 3, { points: pts.closed });
  const oMin: V3 = [-0.5, 0, -0.5], oMax: V3 = [0.5, 0.6, 0.5];
  assert.deepEqual(openFraming(f, oMin, oMax, 40, 4 / 3, { points: pts.open, end: pts.end, fitArc: true }), openFraming(f, oMin, oMax, 40, 4 / 3, { points: pts.open, end: pts.end }));
});

test('#291: 只有酒盒开启 fitArc（礼盒、瓦楞盒保持原样）', () => {
  const src = readFileSync('src/components/three/ProductGallery.tsx', 'utf8');
  assert.match(src, /FIT_ARC = new Set\(\['wine-boxes'\]\)/);
  assert.match(src, /fitArc: FIT_ARC\.has\(p\.slug\)/);
  assert.match(readFileSync('src/components/three/GalleryScene.tsx', 'utf8'), /fitArc: i\.fitArc/);
});
