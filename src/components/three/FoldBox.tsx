'use client';
import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { DoubleSide, MathUtils, type Group } from 'three';

export type BoxView = 'closed' | 'open' | 'dieline';
const HALF_PI = Math.PI / 2;

/**
 * 程序化占位盒：同一套面板结构表达“合盖 / 开盖 / 展开刀模”三种状态。
 * fold：0 = 平铺刀模，1 = 折成盒子；open：0 = 盖子合上，1 = 盖子打开。
 * frameloop 为 demand，只在动画进行中 invalidate，静止时不渲染。
 */
export default function FoldBox({ view = 'closed', size = [1.6, 1, 1.2], color = '#c9a77c', lidColor }: { view?: BoxView; size?: [number, number, number]; color?: string; lidColor?: string }) {
  const [W, H, D] = size;
  const invalidate = useThree((s) => s.invalidate);
  const target = { fold: view === 'dieline' ? 0 : 1, open: view === 'open' ? 1 : 0 };
  const cur = useRef({ ...target });
  const root = useRef<Group>(null);
  const walls = useRef<(Group | null)[]>([]);
  const lid = useRef<Group>(null);
  const reduce = useRef(false);

  const apply = () => {
    const { fold, open } = cur.current;
    walls.current.forEach((g) => g && (g.rotation.x = -fold * HALF_PI));
    // 盖子挂在后壁顶边：合盖时再折 90° 盖住开口，开盖时向后翻开约 110°
    if (lid.current) lid.current.rotation.x = -fold * HALF_PI * (1 - open) + open * 0.35;
    if (root.current) {
      const s = MathUtils.lerp(0.5, 1, fold);
      root.current.scale.setScalar(s);
      root.current.position.set(0, -H / 2 * fold * s, (D / 2 + H / 2) * (1 - fold) * s * 0.6);
    }
  };

  useEffect(() => {
    reduce.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce.current) cur.current = { ...target };
    apply();
    invalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  useFrame((_, dt) => {
    const c = cur.current;
    const k = Math.min(1, dt * 5);
    c.fold = MathUtils.lerp(c.fold, target.fold, k);
    // 先展开盖子再平铺，过渡更自然
    c.open = MathUtils.lerp(c.open, target.open, k);
    const done = Math.abs(c.fold - target.fold) < 0.001 && Math.abs(c.open - target.open) < 0.001;
    if (done) { c.fold = target.fold; c.open = target.open; }
    apply();
    if (!done) invalidate();
  });

  const mat = <meshStandardMaterial color={color} roughness={0.8} side={DoubleSide} />;
  const panel = (w: number, len: number, m = mat) => (
    <mesh position={[0, 0, len / 2]} rotation={[-HALF_PI, 0, 0]}>
      <planeGeometry args={[w, len]} />
      {m}
    </mesh>
  );
  // 四个侧壁：铰链在底板四边，展开时向外平铺成十字形
  const sides: { pos: [number, number, number]; yaw: number; w: number }[] = [
    { pos: [0, 0, D / 2], yaw: 0, w: W },
    { pos: [0, 0, -D / 2], yaw: Math.PI, w: W },
    { pos: [W / 2, 0, 0], yaw: HALF_PI, w: D },
    { pos: [-W / 2, 0, 0], yaw: -HALF_PI, w: D }
  ];
  return (
    <group ref={root}>
      <mesh rotation={[-HALF_PI, 0, 0]}>
        <planeGeometry args={[W, D]} />
        {mat}
      </mesh>
      {sides.map((s, i) => (
        <group key={i} position={s.pos} rotation={[0, s.yaw, 0]}>
          <group ref={(g) => { walls.current[i] = g; }}>
            {panel(s.w, H)}
            {i === 1 && (
              <group ref={lid} position={[0, 0, H]}>
                {panel(W, D, <meshStandardMaterial color={lidColor ?? color} roughness={0.6} metalness={lidColor ? 0.4 : 0} side={DoubleSide} />)}
              </group>
            )}
          </group>
        </group>
      ))}
    </group>
  );
}
