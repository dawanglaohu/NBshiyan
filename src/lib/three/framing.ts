import { AnimationMixer, Box3, type AnimationClip, type Object3D } from 'three';

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

export function boxToTuple(b: Box3): { min: [number, number, number]; max: [number, number, number] } {
  return { min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] };
}
