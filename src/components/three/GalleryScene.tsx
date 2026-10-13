'use client';
import { Suspense, type RefObject } from 'react';
import { Canvas } from '@react-three/fiber';
import { View, OrbitControls, PerspectiveCamera, Environment, Lightformer } from '@react-three/drei';
import ProductModel from './ProductModel';

export type SceneItem = { slug: string; model?: string; visible: boolean; active: boolean; zoom?: boolean; track: RefObject<HTMLDivElement | null> };

// 整页只用一个 WebGL 画布，用 View 切分到每张卡片，避免超出浏览器的画布数量上限
export default function GalleryScene({ items, eventSource, onReady }: { items: SceneItem[]; eventSource: RefObject<HTMLElement | null>; onReady: (slug: string) => void }) {
  return (
    <>
      {items.filter((i) => i.visible).map((i) => (
        <View key={i.slug} track={i.track as RefObject<HTMLElement>}>
          <PerspectiveCamera makeDefault position={[2.4, 1.6, 2.6]} fov={40} />
          <ambientLight intensity={0.6} />
          <directionalLight position={[3, 5, 2]} intensity={1.2} />
          <Suspense fallback={null}>
            <ProductModel src={i.model} onReady={() => onReady(i.slug)} />
            {/* 用 Lightformer 在本地生成影棚环境光，不下载外部 HDR，CSP 无需放行 */}
            <Environment resolution={256}>
              <Lightformer intensity={2} position={[0, 4, 2]} scale={[6, 2, 1]} />
              <Lightformer intensity={1} position={[-4, 1, 0]} rotation-y={Math.PI / 2} scale={[4, 2, 1]} />
              <Lightformer intensity={1} position={[4, 1, 0]} rotation-y={-Math.PI / 2} scale={[4, 2, 1]} />
            </Environment>
          </Suspense>
          <OrbitControls enabled={i.active} enableZoom={!!i.zoom} enablePan={false} minDistance={1.8} maxDistance={6} />
        </View>
      ))}
      <Canvas
        className="three-canvas"
        eventSource={eventSource as RefObject<HTMLElement>}
        dpr={[1, 1.75]}
        frameloop="demand"
        gl={{ antialias: true, powerPreference: 'high-performance' }}
      >
        <View.Port />
      </Canvas>
    </>
  );
}
