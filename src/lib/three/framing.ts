import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js';
import { AnimationMixer, Box3, Matrix4, Vector3, type AnimationClip, type Object3D, type Mesh, type BufferGeometry, type BufferAttribute, type InterleavedBufferAttribute } from 'three';

/** 取景用的方向：沿用原来的默认相机方向（右前上方） */
export const VIEW_DIR: [number, number, number] = [2.4, 1.6, 2.6];

export type Framing = { center: [number, number, number]; distance: number; near: number; far: number; position: [number, number, number] };

/**
 * 让半径为 radius 的包围球完整落在视锥内所需的相机距离。
 * 竖直方向按 fov，水平方向按 aspect 换算出的水平 fov，取两者中更远的那个；margin 是额外留白倍数。
 */
export function fitDistance(radius: number, fovDeg: number, aspect: number, margin = 1.08): number {
  const v = (fovDeg * Math.PI) / 180 / 2;
  const h = Math.atan(Math.tan(v) * Math.max(aspect, 1e-3));
  const half = Math.min(v, h);
  return (radius * margin) / Math.sin(half);
}

/** 按包围盒算出相机位置、近/远裁剪面（近面过小会有深度闪烁，过大会切掉模型） */
export function frameBox(min: [number, number, number], max: [number, number, number], fovDeg: number, aspect: number, margin = 1.08, dir: [number, number, number] = VIEW_DIR): Framing {
  const center: [number, number, number] = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const radius = Math.max(1e-4, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2);
  const distance = fitDistance(radius, fovDeg, aspect, margin);
  const len = Math.hypot(...dir) || 1;
  const position: [number, number, number] = [0, 1, 2].map((i) => center[i] + (dir[i] / len) * distance) as [number, number, number];
  // 留出缩放（maxDistance = 2 倍）和旋转的余量
  const near = Math.max(1e-3, (distance - radius * 2) * 0.5, distance / 200);
  const far = distance * 2 + radius * 4;
  return { center, distance, near: Math.min(near, distance - radius), far, position };
}

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const corners = (min: V3, max: V3): V3[] => [0, 1, 2, 3, 4, 5, 6, 7].map((i) => [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]]);

/** 画面里的范围（NDC，-1…1）：相机放在 target + dir * distance，看向 target */
export type ScreenExtents = { x0: number; x1: number; y0: number; y1: number };

/** 把包围盒 8 个角投影到画面上（透视投影，NDC） */
export function projectBox(min: V3, max: V3, target: V3, distance: number, fovDeg: number, aspect: number, dir: V3 = VIEW_DIR): ScreenExtents {
  return projectPoints(corners(min, max), target, distance, fovDeg, aspect, dir);
}

/** 把一组点（模型顶点采样）投影到画面上（透视投影，NDC） */
export function projectPoints(points: V3[], target: V3, distance: number, fovDeg: number, aspect: number, dir: V3 = VIEW_DIR): ScreenExtents {
  const back = norm(dir);
  const fwd: V3 = [-back[0], -back[1], -back[2]];
  const right = norm(cross(fwd, [0, 1, 0]));
  const up = cross(right, fwd);
  const eye: V3 = [target[0] + back[0] * distance, target[1] + back[1] * distance, target[2] + back[2] * distance];
  const tv = Math.tan((fovDeg * Math.PI) / 360);
  const th = tv * Math.max(aspect, 1e-3);
  const e = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
  for (const c of points) {
    const v = sub(c, eye);
    const z = Math.max(1e-6, dot(v, fwd));
    const x = dot(v, right) / (z * th);
    const y = dot(v, up) / (z * tv);
    e.x0 = Math.min(e.x0, x); e.x1 = Math.max(e.x1, x); e.y0 = Math.min(e.y0, y); e.y1 = Math.max(e.y1, y);
  }
  return e;
}

/** 合盖取景的默认参数（#291，UX 定稿） */
export const FILL = 0.7; // 产品（合盖包围盒）占画面高度的比例，目标 65–75%
export const MARGIN = 1.08; // 四边最少留白：任何方向都不超过画面的 1/1.08
export const OPEN_DOLLY_MAX = 1.1; // 开盖时镜头最多拉远 10%
export const OPEN_DOLLY_MS = 300;

/** 在 target 不变的前提下，找满足 ok(distance) 的最小距离（ok 随距离单调） */
function bisect(lo: number, hi: number, ok: (d: number) => boolean): number {
  while (!ok(hi)) hi *= 2;
  for (let i = 0; i < 48; i++) { const m = (lo + hi) / 2; if (ok(m)) hi = m; else lo = m; }
  return hi;
}

/**
 * 只按合盖姿态取景（#291）：
 * - 包围盒投影后的高度占画面 fill（默认 70%）；
 * - 同时宽度、高度都不超过画面的 1/margin（窄画面、扁平产品自动改按宽度放下，390 竖屏也不会左右被切）；
 * - 视线中心对准投影后包围盒的中心，上下左右留白对称。
 */
export function frameClosedBox(min: V3, max: V3, fovDeg: number, aspect: number, opts: { fill?: number; margin?: number; dir?: V3; points?: V3[] } = {}): Framing & { fill: number; widthFill: number } {
  const fill = opts.fill ?? FILL, margin = opts.margin ?? MARGIN, dir = opts.dir ?? VIEW_DIR;
  // 有顶点采样时按真实轮廓取景（圆柱、扁平产品的包围盒角会比轮廓大很多），否则按包围盒 8 个角
  const pts = opts.points?.length ? opts.points : corners(min, max);
  const proj = (t: V3, d: number) => projectPoints(pts, t, d, fovDeg, aspect, dir);
  const back = norm(dir);
  const fwd: V3 = [-back[0], -back[1], -back[2]];
  const right = norm(cross(fwd, [0, 1, 0]));
  const up = cross(right, fwd);
  const radius = Math.max(1e-4, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2);
  let target: V3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  let distance = radius * 3;
  const limit = Math.min(fill, 1 / margin);
  for (let k = 0; k < 6; k++) {
    const t = target;
    distance = bisect(radius * 1.01, radius * 4, (d) => {
      const e = proj(t, d);
      return (e.y1 - e.y0) / 2 <= limit && (e.x1 - e.x0) / 2 <= 1 / margin;
    });
    // 把投影中心移回画面中心（沿相机的右、上方向平移 target）
    const e = proj(target, distance);
    const tv = Math.tan((fovDeg * Math.PI) / 360), th = tv * Math.max(aspect, 1e-3);
    const cx = ((e.x0 + e.x1) / 2) * th * distance, cy = ((e.y0 + e.y1) / 2) * tv * distance;
    target = [0, 1, 2].map((i) => target[i] + right[i] * cx + up[i] * cy) as V3;
  }
  const e = proj(target, distance);
  const position = [0, 1, 2].map((i) => target[i] + back[i] * distance) as V3;
  const near = Math.max(1e-3, (distance - radius * 2) * 0.5, distance / 200);
  const far = distance * 2 + radius * 4;
  return { center: target, distance, near: Math.min(near, distance - radius), far, position, fill: (e.y1 - e.y0) / 2, widthFill: (e.x1 - e.x0) / 2 };
}

/**
 * 开盖时镜头拉远的倍数（#291）：target 不动，找让开盖全过程的并集包围盒落进画面（留白 margin）的最小倍数，
 * 最多 maxFactor（10%）；超过的部分允许盖子稍微出画。
 */
export function openDollyFactor(closed: Pick<Framing, 'center' | 'distance'>, openMin: V3, openMax: V3, fovDeg: number, aspect: number, opts: { margin?: number; maxFactor?: number; dir?: V3; points?: V3[] } = {}): number {
  const margin = opts.margin ?? MARGIN, maxFactor = opts.maxFactor ?? OPEN_DOLLY_MAX, dir = opts.dir ?? VIEW_DIR;
  const pts = opts.points?.length ? opts.points : corners(openMin, openMax);
  const fits = (f: number) => {
    const e = projectPoints(pts, closed.center, closed.distance * f, fovDeg, aspect, dir);
    const m = 1 / margin;
    return e.x0 >= -m && e.x1 <= m && e.y0 >= -m && e.y1 <= m;
  };
  if (fits(1)) return 1;
  if (!fits(maxFactor)) return maxFactor;
  let lo = 1, hi = maxFactor;
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (fits(m)) hi = m; else lo = m; }
  return hi;
}

/** 开盖时的镜头：target（看向的点）和距离 */
export type OpenView = { center: V3; distance: number; /** 是否放宽了 10% 上限 */ extended: boolean };

/**
 * 开盖时镜头怎么动（#291）：
 * - 一般情况：target 不动，只沿视线拉远 openDollyFactor（最多 10%），和之前完全一样；开合中途盖子允许稍微出画。
 * - 如果开盖后静止的姿态（end）在拉远 10% 后仍放不下（例如礼盒竖起来的盒盖），就放宽上限：
 *   按盖子整条开合弧线（open）重新取景——四边留 1.08 余量、投影居中，只拉远不推近。
 *   这样只有真正需要的产品才会超过 10%，其它产品的开盖表现不变。
 * - fitArc=true 的产品（酒盒）：开合途中的弧线在 10% 内放不下（盖子中途从顶部出画）也走上面的整条弧线取景。
 *   默认关闭：瓦楞盒的翻盖中途也略出画，但按要求保持原样。
 */
export function openFraming(closed: Pick<Framing, 'center' | 'distance'>, openMin: V3, openMax: V3, fovDeg: number, aspect: number, opts: { margin?: number; maxFactor?: number; dir?: V3; points?: V3[]; end?: V3[]; fitArc?: boolean } = {}): OpenView {
  const margin = opts.margin ?? MARGIN, maxFactor = opts.maxFactor ?? OPEN_DOLLY_MAX, dir = opts.dir ?? VIEW_DIR;
  const k = openDollyFactor(closed, openMin, openMax, fovDeg, aspect, { margin, maxFactor, dir, points: opts.points });
  const normal: OpenView = { center: closed.center, distance: closed.distance * k, extended: false };
  const m = 1 / margin + 1e-6;
  const inside = (e: ScreenExtents) => e.x0 >= -m && e.x1 <= m && e.y0 >= -m && e.y1 <= m;
  // fitArc（逐产品开启，目前只有酒盒）：开合途中（不只是开盖后静止）盖子出画也按整条弧线取景
  const arcOut = !!opts.fitArc && !!opts.points?.length && !inside(projectPoints(opts.points, closed.center, closed.distance * k, fovDeg, aspect, dir));
  if (!arcOut) {
    if (!opts.end?.length) return normal;
    const endK = openDollyFactor(closed, openMin, openMax, fovDeg, aspect, { margin, maxFactor: maxFactor * 1.0001, dir, points: opts.end });
    if (inside(projectPoints(opts.end, closed.center, closed.distance * endK, fovDeg, aspect, dir))) return normal;
  }
  const fit = frameClosedBox(openMin, openMax, fovDeg, aspect, { fill: 1, margin, dir, points: opts.points });
  if (fit.distance <= closed.distance) return normal;
  return { center: fit.center, distance: fit.distance, extended: true };
}

/** 300ms 缓动（ease-in-out cubic），t 为 0…1 */
export function easeInOut(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/**
 * 动画模型的“所有状态”的并集包围盒：在片段上均匀采样（含首帧和末帧），
 * 开盖后的盖子、抽出的内托都会被算进去，开盖后不会被裁掉（#172 第 1、2 点）。
 * 用临时 mixer 采样，结束后把姿态复位到首帧，不影响页面上的动画状态。
 */
export function unionAnimatedBox(root: Object3D, clips: AnimationClip[], samples = 8): Box3 {
  const box = new Box3();
  root.updateMatrixWorld(true);
  box.expandByObject(root);
  if (!clips.length) return box;
  const mixer = new AnimationMixer(root);
  for (const clip of clips) {
    const a = mixer.clipAction(clip);
    a.play();
    for (let i = 0; i <= samples; i++) {
      a.time = (clip.duration * i) / samples;
      mixer.update(0);
      root.updateMatrixWorld(true);
      box.expandByObject(root);
    }
    a.time = 0;
    mixer.update(0);
    a.stop();
    mixer.uncacheAction(clip);
  }
  mixer.stopAllAction();
  mixer.uncacheRoot(root);
  root.updateMatrixWorld(true);
  return box;
}

/**
 * 合盖包围盒（#291）：片段首帧（合盖）的姿态；没有片段时就是静止姿态。
 * 和 unionAnimatedBox 一样用临时 mixer，结束后复位，不影响页面上的动画状态。
 */
export function closedPoseBox(root: Object3D, clips: AnimationClip[]): Box3 {
  root.updateMatrixWorld(true);
  if (!clips.length) return new Box3().setFromObject(root);
  const mixer = new AnimationMixer(root);
  const actions = clips.map((c) => { const a = mixer.clipAction(c); a.play(); a.time = 0; return a; });
  mixer.update(0);
  root.updateMatrixWorld(true);
  const box = new Box3().setFromObject(root);
  for (const a of actions) a.stop();
  mixer.stopAllAction();
  for (const c of clips) mixer.uncacheAction(c);
  mixer.uncacheRoot(root);
  root.updateMatrixWorld(true);
  return box;
}

/**
 * 当前姿态下模型顶点的世界坐标（超过 max 个时等距抽样），用来按真实轮廓取景（#291）。
 */
export function samplePoints(root: Object3D, max = 60000): V3[] {
  root.updateMatrixWorld(true);
  const meshes: { attr: BufferAttribute | InterleavedBufferAttribute; m: Matrix4 }[] = [];
  let total = 0;
  root.traverse((o) => {
    const g = (o as Mesh).geometry as BufferGeometry | undefined;
    const attr = (o as Mesh).isMesh && o.visible ? g?.getAttribute('position') : undefined;
    if (attr) { meshes.push({ attr, m: o.matrixWorld }); total += attr.count; }
  });
  const step = Math.max(1, Math.ceil(total / max));
  const out: V3[] = [];
  const v = new Vector3();
  for (const { attr, m } of meshes) for (let i = 0; i < attr.count; i += step) { v.fromBufferAttribute(attr, i).applyMatrix4(m); out.push([v.x, v.y, v.z]); }
  return out;
}

/**
 * 只保留凸包顶点：透视投影后画面上的最远点一定是凸包顶点，结果和用全部顶点完全一样，
 * 点数从几千降到几百，取景时的二分计算很快。点太少（< 4）或退化（全在一个平面上）时原样返回。
 */
export function hullPoints(points: V3[]): V3[] {
  if (points.length < 8) return points;
  try {
    const hull = new ConvexHull().setFromPoints(points.map((p) => new Vector3(...p)));
    const seen = new Set<Vector3>();
    for (const face of hull.faces) {
      let e = face.edge;
      do { seen.add(e.head().point); e = e.next; } while (e !== face.edge);
    }
    const out: V3[] = [...seen].map((v) => [v.x, v.y, v.z]);
    return out.length >= 4 ? out : points;
  } catch {
    return points;
  }
}

/**
 * 同时采样合盖首帧、开盖全过程和开盖末帧的顶点（只留凸包顶点）：
 * closed 用于取景；open（含盖子整条开合弧线）和 end（开盖后静止的姿态）用于算开盖时的镜头（#291）。
 */
export function sampleAnimatedPoints(root: Object3D, clips: AnimationClip[], samples = 24, max = 60000): { closed: V3[]; open: V3[]; end: V3[] } {
  const r = sampleAnimatedPointsRaw(root, clips, samples, max);
  const closed = hullPoints(r.closed);
  if (r.open === r.closed) return { closed, open: closed, end: closed };
  return { closed, open: hullPoints(r.open), end: hullPoints(r.end) };
}

function sampleAnimatedPointsRaw(root: Object3D, clips: AnimationClip[], samples: number, max: number): { closed: V3[]; open: V3[]; end: V3[] } {
  const closed = samplePoints(root, max);
  if (!clips.length) return { closed, open: closed, end: closed };
  const open: V3[] = [];
  let end: V3[] = [];
  const mixer = new AnimationMixer(root);
  for (const clip of clips) {
    const a = mixer.clipAction(clip);
    a.play();
    a.time = 0; mixer.update(0);
    closed.length = 0; for (const p of samplePoints(root, max)) closed.push(p);
    for (let i = 1; i <= samples; i++) {
      a.time = (clip.duration * i) / samples; mixer.update(0);
      const h = hullPoints(samplePoints(root, max));
      for (const p of h) open.push(p);
      if (i === samples) end = h;
    }
    a.time = 0; mixer.update(0); a.stop(); mixer.uncacheAction(clip);
  }
  mixer.stopAllAction(); mixer.uncacheRoot(root); root.updateMatrixWorld(true);
  return { closed, open: [...closed, ...open], end };
}

export function boxToTuple(b: Box3): { min: [number, number, number]; max: [number, number, number] } {
  return { min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] };
}
