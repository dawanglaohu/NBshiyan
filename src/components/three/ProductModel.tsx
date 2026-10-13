'use client';
import { useEffect, useState } from 'react';
import { useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { useNeedleProgressive, setDracoDecoderLocation, setKTX2TranscoderLocation } from '@needle-tools/gltf-progressive';
import FoldBox, { type BoxView } from './FoldBox';

export type { BoxView };
/** 真实 GLB 里对应“开盖 / 展开刀模”的动画片段名 */
export type AnimationClips = { open?: string; unfold?: string };
const PALETTE: Record<string, { color: string; lid?: string }> = {
  'gift-boxes': { color: '#1d1d22', lid: '#d4af6a' },
  'wine-boxes': { color: '#6b1f2a', lid: '#d4af6a' },
  'corrugated-boxes': { color: '#c9a77c' }
};

// 解码器本地托管，不依赖 gstatic / cdn.needle.tools（issue #31）
setDracoDecoderLocation('/draco/');
setKTX2TranscoderLocation('/basis/');

function Gltf({ url }: { url: string }) {
  const gl = useThree((s) => s.gl);
  // Draco 解码器和渐进式加载：先出轻量版本，细节后台静默替换
  const { scene } = useGLTF(url, '/draco/', false, (loader) => {
    useNeedleProgressive(loader as never, gl);
  });
  return <primitive object={scene} />;
}

// 还没有真实模型时的占位盒子
function PlaceholderBox() {
  return (
    <mesh>
      <boxGeometry args={[1.6, 1, 1.2]} />
      <meshStandardMaterial color="#c9a77c" roughness={0.8} />
    </mesh>
  );
}

/**
 * view：合盖 / 开盖 / 展开刀模。没有真实模型时用程序化的 FoldBox 演示。
 * TODO: 有真实 GLB 后，用 drei 的 useAnimations 按 animationClips.open / animationClips.unfold
 * 播放对应片段（clampWhenFinished，反向播放回到合盖），替换 FoldBox。
 */
export default function ProductModel({ src, onReady, slug, view, animationClips }: { src?: string; onReady: () => void; slug?: string; view?: BoxView; animationClips?: AnimationClips }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!src) { onReady(); return; }
    import('./modelCache').then(({ cachedModelUrl }) => cachedModelUrl(src)).then(setUrl);
  }, [src, onReady]);
  useEffect(() => { if (url) onReady(); }, [url, onReady]);
  // 当前 GLB 只有 'Open' 片段、没有展开刀模片段：刀模视图继续用 FoldBox 演示
  if (!src || (view === 'dieline' && !animationClips?.unfold)) {
    if (view && slug) { const c = PALETTE[slug] ?? { color: '#c9a77c' }; return <FoldBox view={view} color={c.color} lidColor={c.lid} />; }
    return <PlaceholderBox />;
  }
  return url ? <Gltf url={url} /> : null;
}
