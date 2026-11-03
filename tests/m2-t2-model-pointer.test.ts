import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  LEGACY_HOVER_ZOOM_MS,
  assertModelPointerContract,
  createModelPointerState,
  legacyHoverZoomWheel,
  reduceModelPointer,
  shouldAutoRotate,
  wheelAction,
  wheelActionResult,
  wheelAdmission,
} from '../src/lib/three/model-pointer';

/**
 * 「改动前失败、改动后通过」回归。
 *
 * 旧版（6ff4934c）的真实行为：悬停满 500ms 或按下后 setZoomSlug，GalleryScene 里
 * enableZoom={!!i.zoom} 随之打开，OrbitControls 对每一次 wheel 调用 preventDefault。
 * 旧源码里不存在任何 ctrlKey/metaKey 判定。因此旧版在「未聚焦的普通滚轮」这一格
 * 给出 zoom-camera，与当前规则要求的 scroll-page 冲突。
 *
 * 下面不重写新规则，而是把旧版行为当作被检验对象，喂给当前规则的判据。
 */
test('旧版的悬停缩放规则无法通过当前滚轮判据（改动前失败）', () => {
  const plain: { focused: boolean; ctrlKey: boolean; metaKey: boolean } = { focused: false, ctrlKey: false, metaKey: false };

  const legacyAction = legacyHoverZoomWheel({ hoverMs: LEGACY_HOVER_ZOOM_MS, pointerArmed: false });
  assert.equal(legacyAction, 'zoom-camera', '旧版悬停满 500ms 必须开缩放，否则这条回归失去意义');

  assert.equal(
    wheelActionResult(legacyAction, plain),
    false,
    '旧版的动作必须被判为不符合当前规则；若为 true，说明判据退化成恒真',
  );
});

test('当前规则通过同一判据（改动后通过）', () => {
  assertModelPointerContract();

  const plain = { focused: false, ctrlKey: false, metaKey: false };
  assert.equal(wheelAction(plain), 'scroll-page', '未聚焦的普通滚轮必须滚动页面');
  assert.equal(wheelActionResult('scroll-page', plain), true);

  const focusedPlain = { focused: true, ctrlKey: false, metaKey: false };
  assert.equal(wheelAction(focusedPlain), 'scroll-page', '聚焦后普通滚轮仍须滚动页面');

  const focusedCtrl = { focused: true, ctrlKey: true, metaKey: false };
  assert.equal(wheelAction(focusedCtrl), 'zoom-camera', '聚焦且 Ctrl 才缩放');
  assert.equal(wheelActionResult('zoom-camera', focusedCtrl), true);
});

test('判据可证伪：给错动作必须判失败', () => {
  const focusedCtrl = { focused: true, ctrlKey: true, metaKey: false };
  assert.equal(wheelActionResult('scroll-page', focusedCtrl), false, '该缩放时判成滚动必须失败');
  const plain = { focused: false, ctrlKey: false, metaKey: false };
  assert.equal(wheelActionResult('zoom-camera', plain), false, '该滚动时判成缩放必须失败');
});

test('联系页面板提示与 Ctrl/Cmd 滚轮策略一致，不再写普通滚轮或双指缩放', () => {
  const en = JSON.parse(readFileSync('messages/en.json', 'utf8'));
  const ru = JSON.parse(readFileSync('messages/ru.json', 'utf8'));

  for (const [name, copy] of [['en', en.Products.hint], ['ru', ru.Products.hint]] as const) {
    assert.equal(/pinch/i.test(copy), false, `${name} 不应再提双指缩放，触屏没有该实现`);
    assert.equal(/сведите пальцы/i.test(copy), false, `${name} 不应再提双指缩放`);
    assert.match(copy, /Ctrl\/Cmd/, `${name} 必须写出真正的缩放手势`);
  }
  assert.match(en.Products.hint, /plain scroll moves the page/i);
  assert.match(ru.Products.hint, /обычная прокрутка листает страницу/i);
});

test('状态机不变量：悬停不抢归属，按下才拥有，松开即释放', () => {
  let state = createModelPointerState(false);
  state = reduceModelPointer(state, { type: 'visible', slugs: ['a', 'b'] });

  // 悬停只改 hoveredSlug，不抢 owner/focused，也不置 dragging。
  state = reduceModelPointer(state, { type: 'pointerenter', slug: 'a', pointerType: 'mouse' });
  assert.equal(state.hoveredSlug, 'a', '悬停应记录 hoveredSlug');
  assert.equal(state.ownerSlug, null, '悬停不得取得归属');
  assert.equal(state.focusedSlug, null, '悬停不得取得焦点');
  assert.equal(state.dragging, false, '悬停不得进入拖动');
  assert.equal(shouldAutoRotate(state, 'a'), false, '悬停应暂停自转');

  // 按下才拥有归属与拖动标志。
  state = reduceModelPointer(state, { type: 'pointerdown', slug: 'a', pointerType: 'mouse', button: 0 });
  assert.equal(state.ownerSlug, 'a', '按下应取得归属');
  assert.equal(state.dragging, true, '按下应进入拖动');

  // 松开必须同时释放 owner 与 dragging，否则下一次滚动会被当成模型手势。
  state = reduceModelPointer(state, { type: 'pointerup' });
  assert.equal(state.ownerSlug, null, '松开必须释放归属');
  assert.equal(state.dragging, false, '松开必须退出拖动');

  // 取消同样必须释放。
  const cancelled = reduceModelPointer(
    reduceModelPointer(
      reduceModelPointer(createModelPointerState(false), { type: 'visible', slugs: ['a'] }),
      { type: 'pointerdown', slug: 'a', pointerType: 'mouse', button: 0 },
    ),
    { type: 'pointercancel' },
  );
  assert.equal(cancelled.ownerSlug, null, '取消必须释放归属');
  assert.equal(cancelled.dragging, false, '取消必须退出拖动');
});

test('滚轮监听挂在焦点 wrapper，不以整张卡片作为准入域', () => {
  const src = readFileSync('src/components/three/ProductGallery.tsx', 'utf8');
  // 规范 E-98：不得因事件冒泡到整张卡片扩大准入范围。
  assert.match(src, /const surface = viewport\?\.parentElement \?\? null;/, '监听必须挂在焦点 wrapper');
  assert.match(src, /surface\.addEventListener\('wheel', onWheel, \{ passive: false \}\)/, '监听挂在 wrapper 上');
  assert.equal(src.includes("el?.closest('article')"), false, '不得再挂整张 article');
  assert.match(src, /wheelAdmission\(\{/, '必须走双重准入判定');
  assert.match(src, /surface\.contains\(document\.activeElement\)/, '焦点归属取真实 DOM 焦点');
});

test('E-98 准入矩阵：焦点归属与指针命中必须分别成立', () => {
  const base = {
    focusBelongsToModel: true,
    pointerHitsViewport: true,
    pointerHitsToolbar: false,
    ctrlKey: true,
    metaKey: false,
  };

  // 第一行：焦点在本模型控制区
  assert.equal(wheelAdmission(base), 'zoom-camera', '视口命中 + Ctrl 应缩放本模型');
  assert.equal(
    wheelAdmission({ ...base, pointerHitsViewport: false, pointerHitsToolbar: true }),
    'zoom-camera',
    '工具条命中 + Ctrl 应缩放本模型',
  );
  assert.equal(
    wheelAdmission({ ...base, pointerHitsViewport: false, pointerHitsToolbar: false }),
    'scroll-page',
    '指针在标题/说明/链接或另一模型时不缩放任一模型',
  );

  // 第二行：无模型控制区焦点，或已解除交互
  for (const hit of [
    { pointerHitsViewport: true, pointerHitsToolbar: false },
    { pointerHitsViewport: false, pointerHitsToolbar: true },
    { pointerHitsViewport: false, pointerHitsToolbar: false },
  ]) {
    assert.equal(
      wheelAdmission({ ...base, ...hit, focusBelongsToModel: false }),
      'scroll-page',
      '焦点不属于本模型时任何命中都不缩放',
    );
  }

  // 普通滚轮在所有格始终滚页，包括 Shift/Ctrl 之外的组合
  for (const hit of [
    { pointerHitsViewport: true, pointerHitsToolbar: false },
    { pointerHitsViewport: false, pointerHitsToolbar: true },
    { pointerHitsViewport: false, pointerHitsToolbar: false },
  ]) {
    assert.equal(
      wheelAdmission({ ...base, ...hit, ctrlKey: false, metaKey: false }),
      'scroll-page',
      '普通滚轮必须滚页',
    );
  }

  // Cmd 与 Ctrl 等价
  assert.equal(
    wheelAdmission({ ...base, ctrlKey: false, metaKey: true }),
    'zoom-camera',
    'Cmd+滚轮应缩放本模型',
  );
});

test('不再保留依赖 OrbitControls 的 pointer capture 守卫', () => {
  const src = readFileSync('src/components/three/ProductGallery.tsx', 'utf8');
  assert.equal(src.includes('hasPointerCapture'), false, 'OrbitControls 从不 setPointerCapture，该守卫是死代码');
  assert.match(src, /dispatchEvent\(new PointerEvent\('pointerup'/, '释放仍靠合成 pointerup');
});
