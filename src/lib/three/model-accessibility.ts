/**
 * 模型控制区的键盘、触屏与复位规则（E-101、E-102、E-104）。
 *
 * 与 `model-pointer.ts` 的分工：那边决定「谁拥有这次拖动、滚轮能不能缩放」，
 * 这边决定「键盘怎么改相机、触屏手势归谁、复位回到哪个值」。
 * 两者都是纯函数，真实相机动作与真实手势由浏览器级证据验收，纯函数不冒充。
 */

/** 一次键盘动作改多少弧度 / 多少比例 */
export const KEY_ROTATE_STEP = Math.PI / 12; // 15°
export const KEY_ZOOM_STEP = 0.1;

export type CameraCommand =
  | { type: 'rotate'; azimuth: number; polar: number }
  | { type: 'zoom'; factor: number }
  | { type: 'reset' };

/**
 * 键盘动作表（E-101）。返回 null 表示这个键不归模型控制区管，调用方必须放行浏览器默认行为。
 *
 * 方向键改朝向、加号/减号改距离、Home/0/Reset 复位。
 * Escape 不在这里：它是退出交互，由 `ProductGallery` 的既有退出路径处理（E-100 已覆盖）。
 */
export function keyToCameraCommand(input: {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}): CameraCommand | null {
  // 带任何修饰键都不接管：那是浏览器/操作系统的快捷键（Ctrl+- 是页缩放，Ctrl+0 是复位页缩放）。
  if (input.ctrlKey || input.metaKey || input.altKey) return null;
  switch (input.key) {
    case 'ArrowLeft':
      return { type: 'rotate', azimuth: KEY_ROTATE_STEP, polar: 0 };
    case 'ArrowRight':
      return { type: 'rotate', azimuth: -KEY_ROTATE_STEP, polar: 0 };
    case 'ArrowUp':
      return { type: 'rotate', azimuth: 0, polar: -KEY_ROTATE_STEP };
    case 'ArrowDown':
      return { type: 'rotate', azimuth: 0, polar: KEY_ROTATE_STEP };
    case '+':
    case '=':
      return { type: 'zoom', factor: 1 - KEY_ZOOM_STEP };
    case '-':
    case '_':
      return { type: 'zoom', factor: 1 + KEY_ZOOM_STEP };
    case 'Home':
    case '0':
      return { type: 'reset' };
    default:
      return null;
  }
}

/** 复位目标：该产品已有的初始相机与缩放边界（E-104）。不改产品定义，如实回传同一份初值。 */
export type InitialCamera = {
  position: [number, number, number];
  target: [number, number, number];
  minDistance: number;
  maxDistance: number;
};

/** 复位后的相机值：与初始值逐项相等，不是「接近」。 */
export function resetCamera(initial: InitialCamera): InitialCamera {
  return {
    position: [initial.position[0], initial.position[1], initial.position[2]],
    target: [initial.target[0], initial.target[1], initial.target[2]],
    minDistance: initial.minDistance,
    maxDistance: initial.maxDistance,
  };
}

/** 缩放夹紧：任何入口（键盘、按钮、双指、修饰滚轮）都不得越过该产品的 min/max（E-102、E-104）。 */
export function clampDistance(distance: number, minDistance: number, maxDistance: number): number {
  if (!Number.isFinite(distance)) return minDistance;
  const lo = Math.min(minDistance, maxDistance);
  const hi = Math.max(minDistance, maxDistance);
  return Math.min(hi, Math.max(lo, distance));
}

/** 触控目标下限（E-101、E-102：所有控件点击目标 ≥44×44 CSS px） */
export const TOUCH_TARGET_PX = 44;

/** 给定测量到的矩形，判断是否达到 44×44。测试与自检共用这一份定义，不各写一套。 */
export function meetsTouchTarget(rect: { width: number; height: number }): boolean {
  return rect.width >= TOUCH_TARGET_PX && rect.height >= TOUCH_TARGET_PX;
}

export type GestureOwner = 'model' | 'page';

/**
 * 触屏手势归属（E-102）：只有模型视口接管单指拖动；文字区、按钮、标题一律交回页面滚动。
 * `onControl` 为 true（手指落在工具条按钮或完成按钮上）时同样交回页面，避免按钮被手势吃掉。
 */
export function gestureOwner(input: { inViewport: boolean; onControl: boolean }): GestureOwner {
  if (input.onControl) return 'page';
  return input.inViewport ? 'model' : 'page';
}

/**
 * 双指缩放的许可（E-102）：只有两指都落在同一模型视口内才接管，且缩放必须夹在 min/max 内。
 * 单指不缩放——单指只负责旋转，缩放走按钮、键盘与双指。
 */
export function pinchAdmission(input: { pointers: number; bothInViewport: boolean }): boolean {
  return input.pointers === 2 && input.bothInViewport;
}

export type ModelControlCopy = {
  controls: string;
  rotateLeft: string;
  rotateRight: string;
  rotateUp: string;
  rotateDown: string;
  zoomIn: string;
  zoomOut: string;
  resetView: string;
  pause: string;
  resume: string;
  keyboardHint: string;
};

/**
 * 控件文案：与 M2-T2 的 `controlCopy` 同样不进 `messages/*.json`（那些文件被别的 PR 占用）。
 * 名称说明到对象（12 节：`Reset view: [product name]`），由调用方拼产品名。
 */
export function accessibilityCopy(locale: string): ModelControlCopy {
  if (locale === 'ru') {
    return {
      controls: 'Управление моделью',
      rotateLeft: 'Повернуть влево',
      rotateRight: 'Повернуть вправо',
      rotateUp: 'Повернуть вверх',
      rotateDown: 'Повернуть вниз',
      zoomIn: 'Приблизить',
      zoomOut: 'Отдалить',
      resetView: 'Сбросить вид',
      pause: 'Пауза вращения',
      resume: 'Продолжить вращение',
      keyboardHint: 'Стрелки — поворот, плюс и минус — масштаб, Home — сброс, Escape — выход.',
    };
  }
  return {
    controls: 'Model controls',
    rotateLeft: 'Rotate left',
    rotateRight: 'Rotate right',
    rotateUp: 'Rotate up',
    rotateDown: 'Rotate down',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    resetView: 'Reset view',
    pause: 'Pause rotation',
    resume: 'Resume rotation',
    keyboardHint: 'Arrow keys rotate, plus and minus zoom, Home resets, Escape leaves.',
  };
}

function fail(message: string): never {
  throw new Error(message);
}

/**
 * 自检：把这几个规则的期望写死在这里，实现漂移时直接失败。
 * 与 `assertModelPointerContract` 一样是纯断言，不证明真实相机或真实手势。
 */
export function assertModelAccessibilityContract(): void {
  // 方向键：四个方向都给出非零向量，且左右、上下各自相反。
  const left = keyToCameraCommand({ key: 'ArrowLeft' });
  const right = keyToCameraCommand({ key: 'ArrowRight' });
  const up = keyToCameraCommand({ key: 'ArrowUp' });
  const down = keyToCameraCommand({ key: 'ArrowDown' });
  if (!left || left.type !== 'rotate' || left.azimuth <= 0) fail('left arrow must rotate +azimuth');
  if (!right || right.type !== 'rotate' || right.azimuth >= 0) fail('right arrow must rotate -azimuth');
  if (!up || up.type !== 'rotate' || up.polar >= 0) fail('up arrow must rotate -polar');
  if (!down || down.type !== 'rotate' || down.polar <= 0) fail('down arrow must rotate +polar');

  // 修饰键一律不接管，把 Ctrl+- / Ctrl+0 这类浏览器快捷键还给浏览器。
  if (keyToCameraCommand({ key: '+', ctrlKey: true }) !== null) fail('ctrl+plus must not be captured');
  if (keyToCameraCommand({ key: '0', ctrlKey: true }) !== null) fail('ctrl+0 must not reset the model');
  if (keyToCameraCommand({ key: 'ArrowLeft', shiftKey: false, altKey: true }) !== null) fail('alt+arrow must not be captured');

  // 未列出的键必须放行（Tab 不能被抓走，E-101）。
  if (keyToCameraCommand({ key: 'Tab' }) !== null) fail('tab must never be captured');
  if (keyToCameraCommand({ key: 'Escape' }) !== null) fail('escape is release, not a camera command');

  // 缩放正负号：加号拉近（factor<1），减号拉远（factor>1）。
  const plus = keyToCameraCommand({ key: '+' });
  const minus = keyToCameraCommand({ key: '-' });
  if (!plus || plus.type !== 'zoom' || plus.factor >= 1) fail('plus must zoom in');
  if (!minus || minus.type !== 'zoom' || minus.factor <= 1) fail('minus must zoom out');
  if (keyToCameraCommand({ key: '=' })?.type !== 'zoom') fail('unshifted equals is the plus key on many layouts');

  // 复位目标逐项等于初值。
  const initial: InitialCamera = { position: [1, 2, 3], target: [0, 0.5, 0], minDistance: 1.2, maxDistance: 4.8 };
  const back = resetCamera(initial);
  if (back.position.join() !== '1,2,3') fail('reset must restore the initial camera position');
  if (back.target.join() !== '0,0.5,0') fail('reset must restore the initial target');
  if (back.minDistance !== 1.2 || back.maxDistance !== 4.8) fail('reset must restore the product bounds');
  if (back === initial) fail('reset must hand back a copy, not alias the stored initial value');

  // 夹紧：双侧都夹，且不因 min>max 的脏输入抛出。
  if (clampDistance(9, 1, 4) !== 4) fail('distance above max must clamp');
  if (clampDistance(0.1, 1, 4) !== 1) fail('distance below min must clamp');
  if (clampDistance(2, 1, 4) !== 2) fail('distance inside bounds must pass through');
  if (clampDistance(Number.NaN, 1, 4) !== 1) fail('non-finite distance must fall back to min');

  // 44px 目标。
  if (!meetsTouchTarget({ width: 44, height: 44 })) fail('44x44 must pass');
  if (meetsTouchTarget({ width: 43.9, height: 44 })) fail('43.9px width must fail');
  if (meetsTouchTarget({ width: 44, height: 43 })) fail('43px height must fail');

  // 手势归属：只有视口内、且不落在控件上时才归模型。
  if (gestureOwner({ inViewport: true, onControl: false }) !== 'model') fail('viewport drag belongs to the model');
  if (gestureOwner({ inViewport: false, onControl: false }) !== 'page') fail('text area must scroll the page');
  if (gestureOwner({ inViewport: true, onControl: true }) !== 'page') fail('controls must keep page behaviour');

  // 双指缩放只认两指且同属一个视口。
  if (!pinchAdmission({ pointers: 2, bothInViewport: true })) fail('two fingers in one viewport may pinch');
  if (pinchAdmission({ pointers: 1, bothInViewport: true })) fail('one finger must not pinch');
  if (pinchAdmission({ pointers: 2, bothInViewport: false })) fail('cross viewport pinch must be refused');

  // 文案：en/ru 都要有名称，且不能相同。
  const en = accessibilityCopy('en');
  const ru = accessibilityCopy('ru');
  for (const key of ['rotateLeft', 'zoomIn', 'resetView'] as const) {
    if (!en[key]) fail(`english ${key} must be present`);
    if (!ru[key] || ru[key] === en[key]) fail(`russian ${key} must differ`);
  }
}
