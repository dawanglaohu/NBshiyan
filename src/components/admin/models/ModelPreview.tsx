'use client';
import { Suspense } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { Bounds, Center, Environment, Lightformer, OrbitControls, useGLTF } from '@react-three/drei';
import SceneErrorBoundary from '@/components/three/SceneErrorBoundary';

function Model({ url }: { url: string }) {
  const gl = useThree((s) => s.gl);
  // 本地文件预览：Draco / meshopt / KTX2 解码器都用站内文件。不接 gltf-progressive——
  // 它会按相对路径找 .lod0.glb，blob 地址下找不到，所以这里只预览主文件（首屏版本）
  const { scene } = useGLTF(url, '/draco/', false, (loader) => {
    loader.setMeshoptDecoder(MeshoptDecoder);
    loader.setKTX2Loader(new KTX2Loader().setTranscoderPath('/basis/').detectSupport(gl) as never); // three 与 three-stdlib 的类型定义不一致，运行时兼容
  });
  return <primitive object={scene} />;
}

/** 与前台相同的加载方式（Draco 本地解码 + 自动取景 + Lightformer 环境光） */
export default function ModelPreview({ url, dark }: { url: string; dark: boolean }) {
  return (
    <SceneErrorBoundary fallback={<p className="muted" style={{ padding: 16 }}>预览加载失败</p>}>
      <Canvas camera={{ position: [2.4, 1.6, 2.6], fov: 40 }} style={{ background: dark ? '#121214' : '#FBF8F3' }} dpr={[1, 1.75]}>
        <ambientLight intensity={0.6} />
        <directionalLight position={[3, 5, 2]} intensity={1.2} />
        <Suspense fallback={null}>
          <Bounds fit clip observe margin={1.2}><Center><Model url={url} /></Center></Bounds>
          <Environment resolution={256}>
            <Lightformer intensity={2} position={[0, 4, 2]} scale={[6, 2, 1]} />
            <Lightformer intensity={1} position={[-4, 1, 0]} rotation-y={Math.PI / 2} scale={[4, 2, 1]} />
          </Environment>
        </Suspense>
        <OrbitControls enablePan={false} />
      </Canvas>
    </SceneErrorBoundary>
  );
}
