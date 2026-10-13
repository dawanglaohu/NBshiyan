'use client';
import { Suspense, useEffect, type RefObject } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { View, Bounds, Center, OrbitControls, PerspectiveCamera, Environment, Lightformer } from '@react-three/drei';
import SceneErrorBoundary from './SceneErrorBoundary';
import ProductModel, { type BoxView, type AnimationClips } from './ProductModel';

export type SceneItem = { slug: string; model?: string; visible: boolean; active: boolean; zoom?: boolean; view?: BoxView; animationClips?: AnimationClips; track: RefObject<HTMLDivElement | null> };

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

export default function GalleryScene({ items, eventSource, onReady, onError }: { items: SceneItem[]; eventSource: RefObject<HTMLElement | null>; onReady: (slug: string) => void; onError?: (slug: string) => void }) {
  return (
    <Canvas
      className="three-canvas"
      eventSource={eventSource as RefObject<HTMLElement>}
      dpr={[1, 1.75]}
      frameloop="demand"
      gl={{ antialias: true, powerPreference: 'high-performance' }}
    >
      <DemandSync deps={items.filter((i) => i.visible).map((i) => `${i.slug}:${i.view ?? ''}`).join(',')} />
      {/* View 必须放在 Canvas 里面才会使用 track 跟踪卡片；放在外面时 drei 会走 HtmlView，忽略 track，
          改为跟踪自己生成的空 div（高度 0），所有模型都画不出来（issue #31） */}
      {items.filter((i) => i.visible).map((i) => (
        <View key={i.slug} track={i.track as RefObject<HTMLElement>}>
          <PerspectiveCamera makeDefault position={[2.4, 1.6, 2.6]} fov={40} />
          <ambientLight intensity={0.6} />
          <directionalLight position={[3, 5, 2]} intensity={1.2} />
          <Suspense fallback={null}>
            {/* 真实模型按米建模（0.1–0.4 m），相机在约 4 m 外：居中并自动取景，否则模型只有几个像素 */}
              <SceneErrorBoundary onError={() => onError?.(i.slug)}>
              <Bounds fit clip observe margin={1.2}>
                <Center>
                  <ProductModel src={i.model} slug={i.slug} view={i.view} animationClips={i.animationClips} onReady={() => onReady(i.slug)} />
                </Center>
              </Bounds>
              </SceneErrorBoundary>
            {/* 用 Lightformer 在本地生成影棚环境光，不下载外部 HDR，CSP 无需放行 */}
            <Environment resolution={256}>
              <Lightformer intensity={2} position={[0, 4, 2]} scale={[6, 2, 1]} />
              <Lightformer intensity={1} position={[-4, 1, 0]} rotation-y={Math.PI / 2} scale={[4, 2, 1]} />
              <Lightformer intensity={1} position={[4, 1, 0]} rotation-y={-Math.PI / 2} scale={[4, 2, 1]} />
            </Environment>
          </Suspense>
          {/* 显式绑定到卡片自身的 DOM：View 里 events.connected 可能还指向 pointer-events:none 的画布，导致滚轮事件收不到 */}
          <OrbitControls domElement={i.track.current ?? undefined} enabled={i.active} enableZoom={!!i.zoom} enablePan={false} minDistance={1.8} maxDistance={6} />
        </View>
      ))}
    </Canvas>
  );
}
