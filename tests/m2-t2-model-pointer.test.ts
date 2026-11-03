import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  LEGACY_HOVER_ZOOM_MS,
  assertModelPointerContract,
  createModelPointerState,
  hoverScalesGeometry,
  legacyHoverZoomWheel,
  pageScrollLocked,
  reduceModelPointer,
  wheelAction,
  wheelActionResult,
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

test('悬停与页面滚动的结论来自状态机，不是写死的常量', () => {
  assert.equal(hoverScalesGeometry(), false, '悬停不得置位 owner/dragging');
  assert.equal(pageScrollLocked(), false, 'pointerup 后必须释放 owner 与 dragging');

  // 可证伪：状态机确实会进入锁页状态，说明判定不是永远返回 false。
  let locked = createModelPointerState(false);
  locked = reduceModelPointer(locked, { type: 'visible', slugs: ['a'] });
  locked = reduceModelPointer(locked, { type: 'pointerdown', slug: 'a', pointerType: 'mouse', button: 0 });
  assert.equal(locked.ownerSlug, 'a', '按下期间 owner 存在');
  assert.equal(locked.dragging, true, '按下期间 dragging 为真');

  // 直接证明这两个函数会返回 true：构造一个未释放的状态喂给它们。
  assert.equal(pageScrollLocked(locked), true, '按下未释放时必须判为锁页');
  const hoveredNoCapture = reduceModelPointer(
    reduceModelPointer(createModelPointerState(false), { type: 'visible', slugs: ['a'] }),
    { type: 'pointerenter', slug: 'a', pointerType: 'mouse' },
  );
  assert.equal(hoverScalesGeometry(hoveredNoCapture), false, '纯悬停不得判为缩放');
  assert.equal(hoverScalesGeometry(locked), true, '拖动中必须判为改变几何');
});

test('滚轮监听的宿主覆盖控制按钮区，不再只挂 stage', () => {
  const src = readFileSync('src/components/three/ProductGallery.tsx', 'utf8');
  assert.match(src, /const card = el\?\.closest\('article'\) \?\? el;/, '必须提升到卡片容器');
  assert.match(src, /card\.addEventListener\('wheel', onWheel, \{ passive: false \}\)/, '监听挂在卡片上');
  assert.equal(/el\.addEventListener\('wheel'/.test(src), false, '不得再只挂 stage');
});

test('不再保留依赖 OrbitControls 的 pointer capture 守卫', () => {
  const src = readFileSync('src/components/three/ProductGallery.tsx', 'utf8');
  assert.equal(src.includes('hasPointerCapture'), false, 'OrbitControls 从不 setPointerCapture，该守卫是死代码');
  assert.match(src, /dispatchEvent\(new PointerEvent\('pointerup'/, '释放仍靠合成 pointerup');
});
