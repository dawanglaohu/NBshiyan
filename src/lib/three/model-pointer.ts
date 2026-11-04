/**
 * 产品卡模型的指针、滚轮和自转规则。
 * OrbitControls 在 enableZoom 时会对每一次 wheel 调用 preventDefault。
 * 因此普通滚轮不能靠「悬停后再打开 enableZoom」交给控件：那一次手势会把页面滚走。
 */

export const LEGACY_HOVER_ZOOM_MS = 500;

export type WheelAction = 'scroll-page' | 'zoom-camera';

export type WheelInput = { focused: boolean; ctrlKey: boolean; metaKey: boolean };

/** 旧悬停策略：悬停满 500ms 或按下后，普通滚轮缩放相机。测试用它证明这条策略不符合当前滚轮规则。 */
export function legacyHoverZoomWheel(input: { hoverMs: number; pointerArmed: boolean }): WheelAction {
  if (input.pointerArmed || input.hoverMs >= LEGACY_HOVER_ZOOM_MS) return 'zoom-camera';
  return 'scroll-page';
}

/** 当前规则：控制区已聚焦，且按住 Ctrl 或 Cmd 时，滚轮才缩放相机。 */
export function wheelAction(input: WheelInput): WheelAction {
  if (input.focused && (input.ctrlKey || input.metaKey)) return 'zoom-camera';
  return 'scroll-page';
}

export type WheelAdmissionInput = {
  /** 真实 DOM 焦点是否落在本模型的视口或命名工具条内；不用缓存的 focusedSlug 代替。 */
  focusBelongsToModel: boolean;
  /** 指针是否命中本模型的实际视口元素。 */
  pointerHitsViewport: boolean;
  /** 指针是否命中本模型的命名工具条或其按钮。 */
  pointerHitsToolbar: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
};

/**
 * 桌面修饰键滚轮的准入判定（E-98）。
 *
 * 焦点归属与指针命中必须分别成立且属于同一模型；整张卡片、DOM 包含关系或几何叠入都不扩大范围。
 * 普通滚轮在任何情形都返回 scroll-page：调用方据此不调用 preventDefault，页面照常滚动。
 * 本函数只表达规则，不证明浏览器默认行为——页缩放与真实相机变化由浏览器级证据验收。
 */
export function wheelAdmission(input: WheelAdmissionInput): WheelAction {
  if (!input.focusBelongsToModel) return 'scroll-page';
  if (!input.pointerHitsViewport && !input.pointerHitsToolbar) return 'scroll-page';
  if (!input.ctrlKey && !input.metaKey) return 'scroll-page';
  return 'zoom-camera';
}

/**
 * 给定一个（可能来自旧规则的）动作，判断它在当前规则下是否被允许。
 * 这里不拿新规则和它自己比，而是拿下面的期望表核对，
 * 所以旧规则给出的 'zoom-camera' 在普通滚轮上会被判为不允许。
 */
export function wheelActionResult(action: WheelAction, input: WheelInput): boolean {
  const expected: WheelAction = WHEEL_TRUTH_TABLE[rowOf(input)];
  return action === expected;
}

function rowOf(input: WheelInput): string {
  return `${input.focused ? 'f' : 'u'}|${input.ctrlKey ? 'c' : '-'}|${input.metaKey ? 'm' : '-'}`;
}

/**
 * 当前滚轮规则的真值表，写死在这里作为独立于实现的可证伪期望。
 * 只有「已聚焦 + Ctrl 或 Cmd」才缩放相机；其余一律交回页面滚动。
 */
const WHEEL_TRUTH_TABLE: Record<string, WheelAction> = {
  'u|-|-': 'scroll-page',
  'u|c|-': 'scroll-page',
  'u|-|m': 'scroll-page',
  'u|c|m': 'scroll-page',
  'f|-|-': 'scroll-page',
  'f|c|-': 'zoom-camera',
  'f|-|m': 'zoom-camera',
  'f|c|m': 'zoom-camera',
};

export type ModelPointerState = {
  ownerSlug: string | null;
  focusedSlug: string | null;
  hoveredSlug: string | null;
  dragging: boolean;
  /** 用户按下暂停后一直保留，离开视区或回到前台都不会清掉。 */
  userPaused: string[];
  reducedMotion: boolean;
  foreground: boolean;
  visible: string[];
};

export type ModelPointerEvent =
  | { type: 'pointerdown'; slug: string; pointerType: string; button: number }
  | { type: 'pointerup' }
  | { type: 'pointercancel' }
  | { type: 'pointerenter'; slug: string; pointerType: string }
  | { type: 'pointerleave'; slug: string }
  | { type: 'focus'; slug: string }
  | { type: 'blur-region'; slug: string }
  | { type: 'escape' }
  | { type: 'window-blur' }
  | { type: 'unmount' }
  | { type: 'user-pause'; slug: string; paused: boolean }
  | { type: 'visible'; slugs: string[] }
  | { type: 'foreground'; on: boolean }
  | { type: 'reduced'; on: boolean };

export function createModelPointerState(reducedMotion = false): ModelPointerState {
  return {
    ownerSlug: null,
    focusedSlug: null,
    hoveredSlug: null,
    dragging: false,
    userPaused: [],
    reducedMotion,
    foreground: true,
    visible: [],
  };
}

function sameSlugs(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((slug, index) => slug === right[index]);
}

function withoutInteraction(state: ModelPointerState): ModelPointerState {
  if (!state.ownerSlug && !state.focusedSlug && !state.hoveredSlug && !state.dragging) return state;
  return { ...state, ownerSlug: null, focusedSlug: null, hoveredSlug: null, dragging: false };
}

export function reduceModelPointer(state: ModelPointerState, event: ModelPointerEvent): ModelPointerState {
  switch (event.type) {
    case 'pointerdown': {
      // 触屏仍走原有的点按激活。PC 的第一下按下就拥有这张卡，不需要事先再点一次。
      if (event.pointerType !== 'mouse' || event.button !== 0) return state;
      return { ...state, ownerSlug: event.slug, focusedSlug: event.slug, hoveredSlug: event.slug, dragging: true };
    }
    case 'pointerup':
      if (!state.dragging && state.ownerSlug == null) return state;
      return { ...state, dragging: false, ownerSlug: null };
    case 'pointerenter':
      if (event.pointerType !== 'mouse') return state;
      if (state.hoveredSlug === event.slug) return state;
      return { ...state, hoveredSlug: event.slug };
    case 'pointerleave':
      if (state.hoveredSlug !== event.slug) return state;
      if (state.dragging && state.ownerSlug === event.slug) return state;
      return { ...state, hoveredSlug: null };
    case 'focus':
      if (state.focusedSlug === event.slug) return state;
      return { ...state, focusedSlug: event.slug };
    case 'blur-region':
      // 焦点留在这张卡里，或已经交给另一张正在拖的卡时，不要把新的捕获清掉。
      if (state.focusedSlug !== event.slug) return state;
      if (state.dragging && state.ownerSlug !== event.slug) return state;
      return withoutInteraction(state);
    case 'pointercancel':
    case 'escape':
    case 'window-blur':
    case 'unmount':
      return withoutInteraction(state);
    case 'user-pause': {
      const has = state.userPaused.includes(event.slug);
      if (event.paused === has) return state;
      const userPaused = event.paused ? [...state.userPaused, event.slug] : state.userPaused.filter((slug) => slug !== event.slug);
      return { ...state, userPaused };
    }
    case 'visible':
      if (sameSlugs(state.visible, event.slugs)) return state;
      return { ...state, visible: [...event.slugs] };
    case 'foreground':
      if (state.foreground === event.on) return state;
      return { ...state, foreground: event.on };
    case 'reduced':
      if (state.reducedMotion === event.on) return state;
      return { ...state, reducedMotion: event.on };
    default:
      return state;
  }
}

export function shouldAutoRotate(state: ModelPointerState, slug: string): boolean {
  if (state.reducedMotion || !state.foreground) return false;
  if (state.userPaused.includes(slug)) return false;
  if (!state.visible.includes(slug)) return false;
  if (state.hoveredSlug === slug) return false;
  if (state.dragging && state.ownerSlug === slug) return false;
  return true;
}

export type ModelControlCopy = {
  controls: string;
  zoomIn: string;
  zoomOut: string;
  pause: string;
  resume: string;
};

/** 文案不进 messages：那些文件正被别的 PR 占用。en/ru 以外沿用英文。 */
export function controlCopy(locale: string): ModelControlCopy {
  if (locale === 'ru') {
    return {
      controls: 'Управление моделью',
      zoomIn: 'Приблизить',
      zoomOut: 'Отдалить',
      pause: 'Пауза вращения',
      resume: 'Продолжить вращение',
    };
  }
  return {
    controls: 'Model controls',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    pause: 'Pause rotation',
    resume: 'Resume rotation',
  };
}

function fail(message: string): never {
  throw new Error(message);
}

/** 当前轮滚规则的真值表。旧规则在「未聚焦的普通滚轮」这一格给出 zoom-camera，因此判为不符合。 */
export function assertModelPointerContract(): void {
  const plain: WheelInput = { focused: false, ctrlKey: false, metaKey: false };
  const legacy = legacyHoverZoomWheel({ hoverMs: LEGACY_HOVER_ZOOM_MS, pointerArmed: false });
  if (legacy !== 'zoom-camera') fail('legacy hover of 500ms armed camera zoom');
  if (wheelActionResult(legacy, plain)) fail('legacy hover zoom must fail the plain-wheel contract');

  // 八格穷举全部对照真值表；wheelAction 只要有一格偏离就失败。
  const cases: WheelInput[] = [
    { focused: false, ctrlKey: false, metaKey: false },
    { focused: false, ctrlKey: true, metaKey: false },
    { focused: false, ctrlKey: false, metaKey: true },
    { focused: false, ctrlKey: true, metaKey: true },
    { focused: true, ctrlKey: false, metaKey: false },
    { focused: true, ctrlKey: true, metaKey: false },
    { focused: true, ctrlKey: false, metaKey: true },
    { focused: true, ctrlKey: true, metaKey: true },
  ];
  for (const input of cases) {
    if (!wheelActionResult(wheelAction(input), input)) fail('wheel action drifted from the truth table');
  }
  if (wheelAction({ focused: true, ctrlKey: false, metaKey: false }) !== 'scroll-page') fail('focused plain wheel must scroll');
  if (wheelAction({ focused: true, ctrlKey: true, metaKey: false }) !== 'zoom-camera') fail('ctrl wheel must zoom when focused');
  if (wheelAction({ focused: false, ctrlKey: true, metaKey: false }) !== 'scroll-page') fail('unfocused ctrl wheel must scroll');

  let state = createModelPointerState(false);
  state = reduceModelPointer(state, { type: 'visible', slugs: ['a', 'b'] });
  if (!shouldAutoRotate(state, 'a')) fail('visible model should spin');
  state = reduceModelPointer(state, { type: 'pointerenter', slug: 'a', pointerType: 'mouse' });
  if (state.ownerSlug !== null || state.focusedSlug !== null) fail('hover must not capture or focus');
  if (shouldAutoRotate(state, 'a')) fail('hover must pause spin');

  state = reduceModelPointer(state, { type: 'pointerdown', slug: 'a', pointerType: 'mouse', button: 0 });
  if (state.ownerSlug !== 'a' || !state.dragging) fail('pointerdown must capture the starting model');
  state = reduceModelPointer(state, { type: 'pointerenter', slug: 'b', pointerType: 'mouse' });
  if (state.ownerSlug !== 'a' || state.focusedSlug !== 'a') fail('crossing cards must keep the starting model');
  state = reduceModelPointer(state, { type: 'pointercancel' });
  if (state.ownerSlug || state.focusedSlug || state.dragging) fail('pointercancel must release');

  state = reduceModelPointer(state, { type: 'pointerdown', slug: 'b', pointerType: 'mouse', button: 0 });
  if (state.ownerSlug !== 'b') fail('next gesture must target the card under the pointer');
  state = reduceModelPointer(state, { type: 'escape' });
  if (state.focusedSlug || state.ownerSlug) fail('escape must release');
  state = reduceModelPointer(state, { type: 'pointerdown', slug: 'a', pointerType: 'mouse', button: 0 });
  state = reduceModelPointer(state, { type: 'window-blur' });
  if (state.focusedSlug || state.dragging) fail('window blur must release');
  state = reduceModelPointer(state, { type: 'focus', slug: 'a' });
  state = reduceModelPointer(state, { type: 'unmount' });
  if (state.focusedSlug) fail('unmount must release wheel focus');

  state = reduceModelPointer(createModelPointerState(false), { type: 'visible', slugs: ['a'] });
  state = reduceModelPointer(state, { type: 'user-pause', slug: 'a', paused: true });
  state = reduceModelPointer(state, { type: 'visible', slugs: [] });
  state = reduceModelPointer(state, { type: 'visible', slugs: ['a'] });
  state = reduceModelPointer(state, { type: 'foreground', on: false });
  state = reduceModelPointer(state, { type: 'foreground', on: true });
  if (!state.userPaused.includes('a') || shouldAutoRotate(state, 'a')) fail('user pause must survive hide and show');

  const reduced = reduceModelPointer(createModelPointerState(true), { type: 'visible', slugs: ['a'] });
  if (shouldAutoRotate(reduced, 'a')) fail('reduced motion stays still');
  const dragged = reduceModelPointer(reduced, { type: 'pointerdown', slug: 'a', pointerType: 'mouse', button: 0 });
  if (dragged.ownerSlug !== 'a') fail('reduced motion must still allow a drag');

  const copy = controlCopy('en');
  if (copy.zoomIn !== 'Zoom in' || copy.zoomOut !== 'Zoom out') fail('english zoom labels');
  if (!controlCopy('ru').zoomIn || controlCopy('ru').zoomIn === copy.zoomIn) fail('russian zoom label');
}
