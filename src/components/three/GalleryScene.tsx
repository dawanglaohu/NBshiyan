'use client';
import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentRef, type RefObject } from 'react';
import { ACESFilmicToneMapping, type PerspectiveCamera as PCam, type Texture } from 'three';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { View, Bounds, Center, OrbitControls, PerspectiveCamera, Environment, ContactShadows, useEnvironment } from '@react-three/drei';
import SceneErrorBoundary from './SceneErrorBoundary';
import { lightRig } from './lights';
import ProductModel, { type BoxView, type AnimationClips, type ModelBounds } from './ProductModel';
import { frameClosedBox, openFraming, easeInOut, OPEN_DOLLY_MS, type OpenView } from '@/lib/three/framing';

export type SceneItem = { slug: string; model?: string; visible: boolean; active: boolean; zoom?: boolean; view?: BoxView; animationClips?: AnimationClips; /** 开合途中按整条弧线取景（openFraming fitArc） */ fitArc?: boolean; /** 深色卡片（.theme-premium） */ dark?: boolean; track: RefObject<HTMLDivElement | null> };

// 整页只用一个 WebGL 画布，用 View 切分到每张卡片，避免超出浏览器的画布数量上限
// frameloop="demand" 只在 invalidate 时出帧：View 按卡片位置裁剪，页面滚动、尺寸变化、卡片增减后都要重新出一帧，
// 否则画布一直是空的，模型也不会跟着卡片滚动（issue #31）
function DemandSync({ deps }: { deps: string }) {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    const on = () => invalidate();
    window.addEventListener('scroll', on, { passive: true });
    window.addEventListener('resize', on);
    return () => { window.removeEventListener('scroll', on); window.removeEventListener('resize', on); };
  }, [invalidate]);
  useEffect(() => { invalidate(); }, [deps, invalidate]);
  return null;
}

// 本地影棚 HDR（#109，同源 /env/，CSP connect-src 'self' 已放行，不用远程 preset）。
// 只加载一次，所有 View 共用同一张贴图；three 按贴图缓存 PMREM，12 个 View 不会重复生成
const ENV_FILE = '/env/studio_small_09_256.hdr';
useEnvironment.preload({ files: ENV_FILE });

function SharedEnvironment({ children }: { children: (env: Texture) => React.ReactNode }) {
  const env = useEnvironment({ files: ENV_FILE });
  return <>{children(env)}</>;
}

/** 每个 View 的灯光，见 lights.ts；dark = 深色卡片，多一盏轮廓光 */
function StudioLights({ dark }: { dark?: boolean }) {
  const rig = lightRig(!!dark);
  return (
    <>
      <ambientLight intensity={rig.ambient} />
      {rig.directional.map((l, k) => <directionalLight key={k} position={l.position} intensity={l.intensity} color={l.color} />)}
    </>
  );
}

/** 真实 GLB 时用自己的取景；刀模视图在没有 unfold 片段时仍是 FoldBox */
function usesGltf(i: SceneItem) { return !!i.model && !(i.view === 'dieline' && !i.animationClips?.unfold); }

const FOV = 40;
/**
 * 真实模型取景（#172 第 1、2、8 点，#291）：
 * - 只按合盖姿态取景：合盖时模型顶点（真实轮廓）投影后占画面高度 70%（目标 65–75%），四边至少留 1.08 倍余量；
 *   窄画面 / 扁平产品自动改按宽度放下（390 竖屏不会左右被切）；
 * - 开盖时镜头沿当前视线拉远，最多 10%、300ms 缓动，盖子仍可能稍微出画；合盖时在盖子落下前 300ms 拉回；
 *   开盖后静止姿态在 10% 内放不下的产品（礼盒竖起的盒盖）放宽上限：按整条开合弧线取景（留 1.08 余量），合盖完成后再拉回；
 *   减少动态效果时直接跳到目标距离；
 * - 模型水平居中、底面落在 y=0；near/far 跟着模型尺寸走，OrbitControls 的缩放范围也按取景距离换算；
 * - 接触阴影按开盖全过程的底面尺寸缩放，开盖后盖子的阴影也不会被切。
 */
function FramedGltf({ item: i, env, onReady, onError }: { item: SceneItem; env: Texture; onReady: (slug: string) => void; onError?: (slug: string) => void }) {
  const [b, setB] = useState<ModelBounds>();
  const onBounds = useCallback((nb: ModelBounds) => setB(nb), []);
  const camera = useThree((s) => s.camera) as PCam;
  const aspect = useThree((s) => s.size.width / Math.max(1, s.size.height));
  const invalidate = useThree((s) => s.invalidate);
  const controls = useRef<ComponentRef<typeof OrbitControls>>(null);
  // 模型平移：按合盖姿态 xz 居中，底面落地
  const offset: [number, number, number] = b ? [-(b.min[0] + b.max[0]) / 2, -b.min[1], -(b.min[2] + b.max[2]) / 2] : [0, 0, 0];
  const size: [number, number, number] = b ? [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]] : [1, 1, 1];
  const ob = b?.open ?? b;
  const openMin: [number, number, number] = ob ? [ob.min[0] + offset[0], ob.min[1] + offset[1], ob.min[2] + offset[2]] : [0, 0, 0];
  const openMax: [number, number, number] = ob ? [ob.max[0] + offset[0], ob.max[1] + offset[1], ob.max[2] + offset[2]] : [1, 1, 1];
  // 顶点采样平移到取景坐标（和模型 group 同样的 offset）
  const shift = (a?: [number, number, number][]) => a?.map((p) => [p[0] + offset[0], p[1] + offset[1], p[2] + offset[2]] as [number, number, number]);
  // 取景只在包围盒 / 画面比例变化时重算（顶点采样最多几千个点，二分求距离）
  const { f, openV } = useMemo(() => {
    if (!b) return { f: undefined, openV: undefined };
    const fr = frameClosedBox([-size[0] / 2, 0, -size[2] / 2], [size[0] / 2, size[1], size[2] / 2], FOV, aspect, { points: shift(b.points?.closed) });
    return { f: fr, openV: openFraming(fr, openMin, openMax, FOV, aspect, { points: shift(b.points?.open), end: shift(b.points?.end), fitArc: i.fitArc }) };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [b, aspect, i.fitArc]);
  // 镜头状态：当前 / 起点 / 终点（target + 距离），0…1 进度按 300ms 缓动
  type Cam = { c: [number, number, number]; d: number };
  const closedCam = (): Cam | undefined => (f ? { c: f.center, d: f.distance } : undefined);
  const viewCam = (v: OpenView): Cam => ({ c: v.center, d: v.distance });
  const zoom = useRef<{ cur?: Cam; from?: Cam; to?: Cam; t0: number; dur: number; done: boolean }>({ t0: 0, dur: OPEN_DOLLY_MS, done: true });
  // 保持用户当前的观察方向，只改 target 和距离
  const placeAt = (cam: Cam) => {
    const t = controls.current?.target;
    const cx = t ? t.x : cam.c[0], cy = t ? t.y : cam.c[1], cz = t ? t.z : cam.c[2];
    const dx = camera.position.x - cx, dy = camera.position.y - cy, dz = camera.position.z - cz;
    const len = Math.hypot(dx, dy, dz) || 1;
    camera.position.set(cam.c[0] + (dx / len) * cam.d, cam.c[1] + (dy / len) * cam.d, cam.c[2] + (dz / len) * cam.d);
    if (t) t.set(...cam.c);
  };
  useLayoutEffect(() => {
    if (!f) return;
    camera.position.set(...f.position);
    camera.near = f.near;
    camera.far = f.far;
    camera.lookAt(...f.center);
    camera.updateProjectionMatrix();
    if (controls.current) { controls.current.target.set(...f.center); controls.current.update(); }
    const start = i.view === 'open' && openV ? viewCam(openV) : closedCam()!;
    zoom.current = { ...zoom.current, cur: start, from: start, to: start, done: true };
    if (i.view === 'open') { placeAt(start); controls.current?.update(); }
    invalidate();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f?.distance, f?.center[1], camera, invalidate]);
  // 开 / 合盖时拉远 / 拉回镜头
  const lastView = useRef(i.view);
  useEffect(() => {
    if (!f || !openV || lastView.current === i.view) return;
    lastView.current = i.view;
    const to = i.view === 'open' ? viewCam(openV) : closedCam()!;
    const reduced = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const z = zoom.current;
    if (reduced) { z.cur = z.from = z.to = to; z.done = true; placeAt(to); controls.current?.update(); invalidate(); return; }
    // 合盖：一般在片段最后 300ms 拉回；放宽了上限的产品（盖子弧线很大）等盖子完全合上再拉回，避免中途被切
    const dur = (b?.openDuration ?? 0) * 1000;
    const delay = i.view === 'open' ? 0 : openV.extended ? dur : Math.max(0, dur - OPEN_DOLLY_MS);
    z.from = z.cur ?? to; z.to = to; z.t0 = performance.now() + delay; z.done = false;
    invalidate();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i.view, openV]);
  useFrame(() => {
    const z = zoom.current;
    if (z.done || !z.from || !z.to) return;
    const now = performance.now();
    if (now >= z.t0) {
      const t = (now - z.t0) / z.dur;
      const k = t >= 1 ? 1 : easeInOut(t);
      const a = z.from, bb = z.to;
      z.cur = { c: [0, 1, 2].map((j) => a.c[j] + (bb.c[j] - a.c[j]) * k) as [number, number, number], d: a.d + (bb.d - a.d) * k };
      placeAt(z.cur);
      controls.current?.update();
      if (t >= 1) z.done = true;
    }
    invalidate();
  });
  const footprint = Math.max(openMax[0] - openMin[0], openMax[2] - openMin[2], size[0], size[2]);
  const shadowH = Math.max(openMax[1] - openMin[1], size[1]);
  return (
    <>
      <Suspense fallback={null}>
        <SceneErrorBoundary onError={() => onError?.(i.slug)}>
          {/* 包围盒算出来之前先隐藏，避免第一帧按默认相机露出半个模型 */}
          <group position={offset} visible={!!b}>
            <ProductModel src={i.model} slug={i.slug} view={i.view} animationClips={i.animationClips} onReady={() => onReady(i.slug)} onBounds={onBounds} />
          </group>
        </SceneErrorBoundary>
        <Environment map={env} environmentIntensity={1} />
        {b && (
          // 静态接触阴影：按底面尺寸缩放（含开盖后的盖子），比原来更深、更实，盒子贴地
          <ContactShadows key={`${footprint.toFixed(4)}:${i.view ?? ''}`} position={[0, 0.0005, 0]} opacity={0.6} blur={1.8} scale={footprint * 2.4} far={Math.max(shadowH, footprint) * 0.6} resolution={512} frames={1} />
        )}
      </Suspense>
      <OrbitControls ref={controls} domElement={i.track.current ?? undefined} enabled={i.active} enableZoom={!!i.zoom} enablePan={false}
        target={f?.center} minDistance={f ? f.distance * 0.6 : 0.01} maxDistance={f ? f.distance * 2 : 100} />
    </>
  );
}

export default function GalleryScene({ items, eventSource, onReady, onError }: { items: SceneItem[]; eventSource: RefObject<HTMLElement | null>; onReady: (slug: string) => void; onError?: (slug: string) => void }) {
  return (
    <Canvas
      className="three-canvas"
      eventSource={eventSource as RefObject<HTMLElement>}
      dpr={[1, 1.75]}
      frameloop="demand"
      gl={{ antialias: true, powerPreference: 'high-performance', toneMapping: ACESFilmicToneMapping }}
    >
      <DemandSync deps={items.filter((i) => i.visible).map((i) => `${i.slug}:${i.view ?? ''}`).join(',')} />
      {/* View 必须放在 Canvas 里面才会使用 track 跟踪卡片；放在外面时 drei 会走 HtmlView，忽略 track，
          改为跟踪自己生成的空 div（高度 0），所有模型都画不出来（issue #31） */}
      <Suspense fallback={null}>
      <SharedEnvironment>{(env) => items.filter((i) => i.visible).map((i) => (
        <View key={i.slug} track={i.track as RefObject<HTMLElement>}>
          <PerspectiveCamera makeDefault position={[2.4, 1.6, 2.6]} fov={40} />
          <StudioLights dark={i.dark} />
          {usesGltf(i) ? <FramedGltf item={i} env={env} onReady={onReady} onError={onError} /> : (<>
          <Suspense fallback={null}>
            {/* 程序化 FoldBox / 占位盒：沿用 Bounds 自动取景 */}
              <SceneErrorBoundary onError={() => onError?.(i.slug)}>
              <Bounds fit clip observe margin={1.2}>
                <Center top>
                  <ProductModel src={i.model} slug={i.slug} view={i.view} animationClips={i.animationClips} onReady={() => onReady(i.slug)} />
                </Center>
              </Bounds>
              </SceneErrorBoundary>
            <Environment map={env} environmentIntensity={1} />
            <ContactShadows position={[0, 0, 0]} opacity={0.35} blur={2.5} scale={1.2} far={0.6} resolution={256} frames={1} />
          </Suspense>
          <OrbitControls domElement={i.track.current ?? undefined} enabled={i.active} enableZoom={!!i.zoom} enablePan={false} minDistance={1.8} maxDistance={6} />
          </>)}
        </View>
      ))}</SharedEnvironment>
      </Suspense>
    </Canvas>
  );
}
