'use client';
import { useEffect, useState } from 'react';
import { useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { useNeedleProgressive, setDracoDecoderLocation, setKTX2TranscoderLocation } from '@needle-tools/gltf-progressive';

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

export default function ProductModel({ src, onReady }: { src?: string; onReady: () => void }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!src) { onReady(); return; }
    import('./modelCache').then(({ cachedModelUrl }) => cachedModelUrl(src)).then(setUrl);
  }, [src, onReady]);
  useEffect(() => { if (url) onReady(); }, [url, onReady]);
  if (!src) return <PlaceholderBox />;
  return url ? <Gltf url={url} /> : null;
}
