'use client';
import { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentRef, type RefObject } from 'react';
import { ACESFilmicToneMapping, type PerspectiveCamera as PCam, type Texture } from 'three';
import { Canvas, useThree } from '@react-three/fiber';
import { View, Bounds, Center, OrbitControls, PerspectiveCamera, Environment, ContactShadows, useEnvironment } from '@react-three/drei';
import SceneErrorBoundary from './SceneErrorBoundary';
import { lightRig } from './lights';
import ProductModel, { type BoxView, type AnimationClips, type ModelBounds } from './ProductModel';
import { frameBox } from '@/lib/three/framing';

export type SceneItem = { slug: string; model?: string; visible: boolean; active: boolean; zoom?: boolean; view?: BoxView; animationClips?: AnimationClips; /** 深色卡片（.theme-premium） */ dark?: boolean; track: RefObject<HTMLDivElement | null> };

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
 * 真实模型取景（#172 第 1、2、8 点）：
 * - 包围盒取所有动画状态的并集（合盖 + 开盖），开盖后盖子不会被裁掉，切换视图时相机也不跳；
 * - 模型水平居中、底面落在 y=0，相机按包围球 + 留白算距离，同时考虑卡片宽高比（手机竖卡更窄）；
 * - near/far 跟着模型尺寸走，OrbitControls 的缩放范围也按取景距离换算；
 * - 接触阴影按模型底面尺寸缩放，加深、收紧，盒子不再像悬空。
 */
function FramedGltf({ item: i, env, onReady, onError }: { item: SceneItem; env: Texture; onReady: (slug: string) => void; onError?: (slug: string) => void }) {
  const [b, setB] = useState<ModelBounds>();
  const onBounds = useCallback((nb: ModelBounds) => setB(nb), []);
  const camera = useThree((s) => s.camera) as PCam;
  const aspect = useThree((s) => s.size.width / Math.max(1, s.size.height));
  const invalidate = useThree((s) => s.invalidate);
  const controls = useRef<ComponentRef<typeof OrbitControls>>(null);
  // 模型平移：xz 居中，底面落地
  const offset: [number, number, number] = b ? [-(b.min[0] + b.max[0]) / 2, -b.min[1], -(b.min[2] + b.max[2]) / 2] : [0, 0, 0];
  const size: [number, number, number] = b ? [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]] : [1, 1, 1];
  const f = b ? frameBox([-size[0] / 2, 0, -size[2] / 2], [size[0] / 2, size[1], size[2] / 2], FOV, aspect) : undefined;
  useLayoutEffect(() => {
    if (!f) return;
    camera.position.set(...f.position);
    camera.near = f.near;
    camera.far = f.far;
    camera.lookAt(...f.center);
    camera.updateProjectionMatrix();
    if (controls.current) { controls.current.target.set(...f.center); controls.current.update(); }
    invalidate();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f?.distance, f?.center[1], camera, invalidate]);
  const footprint = Math.max(size[0], size[2]);
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
          <ContactShadows key={`${footprint.toFixed(4)}:${i.view ?? ''}`} position={[0, 0.0005, 0]} opacity={0.6} blur={1.8} scale={footprint * 2.4} far={Math.max(size[1], footprint) * 0.6} resolution={512} frames={1} />
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
