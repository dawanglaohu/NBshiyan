'use client';
import { useEffect, useRef, useState } from 'react';
import { LoopOnce, Matrix4, Vector3, type Group } from 'three';
import { unionAnimatedBox, closedPoseBox, sampleAnimatedPoints, boxToTuple } from '@/lib/three/framing';
import { useFrame, useThree } from '@react-three/fiber';
import { useGLTF, useAnimations } from '@react-three/drei';
import { useNeedleProgressive, setDracoDecoderLocation, setKTX2TranscoderLocation, LODsManager } from '@needle-tools/gltf-progressive';
import FoldBox, { type BoxView } from './FoldBox';

export type { BoxView };
/** 真实 GLB 里对应“开盖 / 展开刀模”的动画片段名 */
export type AnimationClips = { open?: string; unfold?: string };
/**
 * 取景用包围盒（#291）：min/max = 合盖姿态（相机只按它取景）；
 * open = 开盖全过程的并集（只用来算开盖时镜头拉远多少、接触阴影多大）；openDuration = 开盖片段时长（秒）。
 */
export type ModelBounds = { min: [number, number, number]; max: [number, number, number]; open?: { min: [number, number, number]; max: [number, number, number] }; openDuration?: number; /** 顶点采样：按真实轮廓取景 */ points?: { closed: [number, number, number][]; open: [number, number, number][] } };
const PALETTE: Record<string, { color: string; lid?: string }> = {
  'gift-boxes': { color: '#1d1d22', lid: '#d4af6a' },
  'wine-boxes': { color: '#6b1f2a', lid: '#d4af6a' },
  'corrugated-boxes': { color: '#c9a77c' }
};

// 解码器本地托管，不依赖 gstatic / cdn.needle.tools（issue #31）
setDracoDecoderLocation('/draco/');
setKTX2TranscoderLocation('/basis/');

/**
 * 按需渲染下让 LOD 升级生效：
 * - gltf-progressive 只在渲染后的帧里检查 LOD（lods.manager.js onAfterRender），updateInterval 'auto' 在低帧率时会拉长到每 10 帧才查一次；
 *   demand 模式下帧很少，改为 0（每个渲染帧都查，本身不额外产生帧）。
 * - 更高一级贴图/网格加载完成时库会派发 "changed"（lods.manager.js assignTextureLOD/assignMeshLOD 的 then 里），
 *   这时 invalidate() 补一帧：既把新贴图画出来，也让下一级 LOD 的检查继续进行，直到 lod0。之后不再有帧，不耗电。
 * 每个 renderer 只注册一次监听（多个模型共用一个画布，避免一次加载触发多帧）。
 */
const lodHooks = new WeakMap<object, { count: number; off: () => void }>();
function useLodUpgradeRedraw() {
  const gl = useThree((s) => s.gl);
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    const lods = LODsManager.get(gl);
    lods.updateInterval = 0;
    let hook = lodHooks.get(gl);
    if (!hook) {
      hook = { count: 0, off: lods.addEventListener('changed', () => invalidate()) };
      lodHooks.set(gl, hook);
    }
    hook.count += 1;
    return () => {
      const h = lodHooks.get(gl);
      if (h && --h.count <= 0) { h.off(); lodHooks.delete(gl); }
    };
  }, [gl, invalidate]);
}

function Gltf({ url, view, clip, onBounds }: { url: string; view?: BoxView; clip?: string; onBounds?: (b: ModelBounds) => void }) {
  const gl = useThree((s) => s.gl);
  const root = useRef<Group>(null);
  // Draco 解码器和渐进式加载：先出轻量版本，细节后台静默替换
  const { scene, animations } = useGLTF(url, '/draco/', false, (loader) => {
    useNeedleProgressive(loader as never, gl);
  });
  useLodUpgradeRedraw();
  // 取景用合盖姿态的包围盒；开盖全过程的并集另外给出（只用于开盖时拉远镜头），在播放任何动画之前算好（#172、#291）
  useEffect(() => {
    if (!onBounds) return;
    const used = clip ? animations.filter((a) => a.name === clip) : [];
    const closed = closedPoseBox(scene, used);
    const union = unionAnimatedBox(scene, used).union(closed);
    // 转到外层 group 的局部坐标：外层取景 group 只做平移，结果与它的局部空间一致
    const pts = sampleAnimatedPoints(scene, used);
    if (scene.parent) {
      const inv = new Matrix4().copy(scene.parent.matrixWorld).invert();
      closed.applyMatrix4(inv); union.applyMatrix4(inv);
      const v = new Vector3();
      const tx = (a: [number, number, number][]) => a.map((p) => { v.set(...p).applyMatrix4(inv); return [v.x, v.y, v.z] as [number, number, number]; });
      pts.closed = tx(pts.closed); pts.open = tx(pts.open);
    }
    if (!closed.isEmpty()) onBounds({ ...boxToTuple(closed), open: boxToTuple(union), openDuration: used[0]?.duration, points: pts });
  }, [scene, animations, clip, onBounds]);
  const { actions } = useAnimations(animations, root);
  const first = useRef(true);
  useEffect(() => {
    const action = clip ? actions[clip] : undefined;
    if (!action || !view) return;
    const open = view === 'open';
    const reduced = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const dur = action.getClip().duration;
    action.setLoop(LoopOnce, 1);
    action.clampWhenFinished = true;
    if (!action.isRunning() && !action.enabled) action.reset();
    action.enabled = true;
    action.play();
    if (reduced || first.current) {
      // 减少动态效果 / 首次挂载：直接跳到目标帧
      action.time = open ? dur : 0;
      action.timeScale = 1;
      action.paused = true;
    } else {
      action.paused = false;
      action.timeScale = open ? 1 : -1;
      if (open && action.time >= dur) action.time = 0;
      if (!open && action.time <= 0) action.time = dur;
    }
    first.current = false;
  }, [actions, clip, view]);
  // 画布按需渲染（frameloop="demand"）：模型解析完成后出一帧；动画播放期间逐帧 invalidate，否则动画不前进
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => { invalidate(); }, [scene, invalidate]);
  useFrame(() => { const a = clip ? actions[clip] : undefined; if (a && a.isRunning()) invalidate(); });
  return <group ref={root}><primitive object={scene} /></group>;
}

// 还没有真实模型时的占位盒子
function PlaceholderBox() {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => { invalidate(); }, [invalidate]);
  return (
    <mesh>
      <boxGeometry args={[1.6, 1, 1.2]} />
      <meshStandardMaterial color="#c9a77c" roughness={0.8} />
    </mesh>
  );
}

/**
 * view：合盖 / 开盖 / 展开刀模。没有真实模型时用程序化的 FoldBox 演示。
 */
export default function ProductModel({ src, onReady, slug, view, animationClips, onBounds }: { src?: string; onReady: () => void; slug?: string; view?: BoxView; animationClips?: AnimationClips; onBounds?: (b: ModelBounds) => void }) {
  const [url, setUrl] = useState<string>();
  const [loadError, setLoadError] = useState<Error>();
  // 抛给外层 SceneErrorBoundary，卡片退回静态图
  if (loadError) throw loadError;
  useEffect(() => {
    if (!src) { onReady(); return; }
    import('./modelCache').then(({ cachedModelUrl }) => cachedModelUrl(src)).then(setUrl).catch((e) => setLoadError(e instanceof Error ? e : new Error(String(e))));
  }, [src, onReady]);
  useEffect(() => { if (url) onReady(); }, [url, onReady]);
  // 当前 GLB 只有 'Open' 片段、没有展开刀模片段：刀模视图继续用 FoldBox 演示
  if (!src || (view === 'dieline' && !animationClips?.unfold)) {
    if (view && slug) { const c = PALETTE[slug] ?? { color: '#c9a77c' }; return <FoldBox view={view} color={c.color} lidColor={c.lid} />; }
    return <PlaceholderBox />;
  }
  return url ? <Gltf url={url} view={view} clip={animationClips?.open} onBounds={onBounds} /> : null;
}
