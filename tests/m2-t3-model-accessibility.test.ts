import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  accessibilityCopy,
  assertModelAccessibilityContract,
  clampDistance,
  gestureOwner,
  keyToCameraCommand,
  meetsTouchTarget,
  pinchAdmission,
  resetCamera,
  TOUCH_TARGET_PX,
  type InitialCamera,
} from '../src/lib/three/model-accessibility';

const gallery = readFileSync('src/components/three/ProductGallery.tsx', 'utf8');
const scene = readFileSync('src/components/three/GalleryScene.tsx', 'utf8');

test('可访问性契约自检通过（方向键、缩放、复位、夹紧、44px、手势归属）', () => {
  assertModelAccessibilityContract();
});

test('E-101 方向键改朝向，且不抓走 Tab 与带修饰键的浏览器快捷键', () => {
  const left = keyToCameraCommand({ key: 'ArrowLeft' });
  const right = keyToCameraCommand({ key: 'ArrowRight' });
  const up = keyToCameraCommand({ key: 'ArrowUp' });
  const down = keyToCameraCommand({ key: 'ArrowDown' });
  assert.deepEqual([left?.type, right?.type, up?.type, down?.type], ['rotate', 'rotate', 'rotate', 'rotate']);
  // 左右相反、上下相反：方向键必须给出可区分的朝向变化，否则「方向键调整朝向」是假的。
  const az = (c: ReturnType<typeof keyToCameraCommand>) => (c && c.type === 'rotate' ? c.azimuth : undefined);
  const po = (c: ReturnType<typeof keyToCameraCommand>) => (c && c.type === 'rotate' ? c.polar : undefined);
  assert.ok((az(left) ?? 0) * (az(right) ?? 0) < 0, '左右方向键的方位角必须相反');
  assert.ok((po(up) ?? 0) * (po(down) ?? 0) < 0, '上下方向键的极角必须相反');

  // Tab 与 Shift+Tab 一律不接管，否则会把焦点锁在控制区里（E-101 明确禁止）。
  assert.equal(keyToCameraCommand({ key: 'Tab' }), null);
  assert.equal(keyToCameraCommand({ key: 'Tab', shiftKey: true }), null);
  // Escape 是退出交互，不是相机动作（M2-T2 的退出路径拥有它）。
  assert.equal(keyToCameraCommand({ key: 'Escape' }), null);
  // 带修饰键交给浏览器：Ctrl/Cmd + 加号是页缩放，Ctrl+0 是复位页缩放。
  assert.equal(keyToCameraCommand({ key: '+', ctrlKey: true }), null);
  assert.equal(keyToCameraCommand({ key: '0', metaKey: true }), null);
  assert.equal(keyToCameraCommand({ key: 'ArrowLeft', altKey: true }), null);
});

test('E-101 加号拉近、减号拉远，两种键盘布局都认', () => {
  for (const key of ['+', '=']) {
    const cmd = keyToCameraCommand({ key });
    assert.equal(cmd?.type, 'zoom');
    assert.ok(cmd && cmd.type === 'zoom' && cmd.factor < 1, `${key} 应拉近（factor < 1）`);
  }
  for (const key of ['-', '_']) {
    const cmd = keyToCameraCommand({ key });
    assert.equal(cmd?.type, 'zoom');
    assert.ok(cmd && cmd.type === 'zoom' && cmd.factor > 1, `${key} 应拉远（factor > 1）`);
  }
});

test('E-104 复位回到该产品的初值，且返回副本而不是共享引用', () => {
  const initial: InitialCamera = { position: [1.5, 2, 3.5], target: [0, 0.4, 0], minDistance: 1.1, maxDistance: 5.2 };
  const back = resetCamera(initial);
  assert.deepEqual(back, initial);
  assert.notStrictEqual(back, initial, 'reset 必须返回副本');
  assert.notStrictEqual(back.position, initial.position, 'position 也必须是新数组');
  // 改回去不影响源初值：复位后再操作不会把「初值」本身改掉。
  back.position[0] = 99;
  assert.equal(initial.position[0], 1.5);
  assert.equal(keyToCameraCommand({ key: 'Home' })?.type, 'reset');
  assert.equal(keyToCameraCommand({ key: '0' })?.type, 'reset');
});

test('E-102 缩放受产品 min/max 约束，任何入口都不越界', () => {
  assert.equal(clampDistance(10, 1, 4), 4);
  assert.equal(clampDistance(0, 1, 4), 1);
  assert.equal(clampDistance(2.5, 1, 4), 2.5);
  assert.equal(clampDistance(Number.NaN, 1, 4), 1);
  assert.equal(clampDistance(Number.POSITIVE_INFINITY, 1, 4), 1);
  // 脏输入（min > max）不抛异常，仍然给出范围内的值。
  const dirty = clampDistance(5, 4, 1);
  assert.ok(dirty <= 4 && dirty >= 1);
});

test('E-102 触控目标 44×44 的判定只有一份定义', () => {
  assert.equal(TOUCH_TARGET_PX, 44);
  assert.equal(meetsTouchTarget({ width: 44, height: 44 }), true);
  assert.equal(meetsTouchTarget({ width: 44, height: 43.9 }), false);
  assert.equal(meetsTouchTarget({ width: 43.9, height: 44 }), false);
});

test('E-102 只有模型视口接管单指拖动，控件与文字区交回页面', () => {
  assert.equal(gestureOwner({ inViewport: true, onControl: false }), 'model');
  assert.equal(gestureOwner({ inViewport: false, onControl: false }), 'page');
  assert.equal(gestureOwner({ inViewport: true, onControl: true }), 'page');
  // 双指缩放：必须两指且都在同一模型视口内。
  assert.equal(pinchAdmission({ pointers: 2, bothInViewport: true }), true);
  assert.equal(pinchAdmission({ pointers: 1, bothInViewport: true }), false);
  assert.equal(pinchAdmission({ pointers: 2, bothInViewport: false }), false);
  assert.equal(pinchAdmission({ pointers: 3, bothInViewport: true }), false);
});

test('控件有可辨名称：en/ru 都齐，且名称指到具体产品', () => {
  const en = accessibilityCopy('en');
  const ru = accessibilityCopy('ru');
  for (const key of ['controls', 'rotateLeft', 'rotateRight', 'zoomIn', 'zoomOut', 'resetView', 'pause', 'resume', 'keyboardHint'] as const) {
    assert.ok(en[key] && en[key].trim().length > 0, `en.${key} 不能为空`);
    assert.ok(ru[key] && ru[key].trim().length > 0, `ru.${key} 不能为空`);
  }
  // 名称必须拼上产品名，否则每张卡的控制区在无障碍树里无法区分（12 节 `Reset view: [product name]`）。
  assert.match(gallery, /aria-label=\{`\$\{keys\.resetView\}: \$\{p\.name\}`\}/, 'Reset 名称必须含产品名');
  assert.match(gallery, /role="group"/, '视口必须是命名分组');
  assert.match(gallery, /aria-label=\{`\$\{copy\.controls\}: \$\{p\.name\}`\}/, '视口分组名必须含产品名');
  assert.match(gallery, /aria-describedby=\{`\$\{p\.slug\}-model-keys`\}/, '视口必须关联键盘说明');
  assert.match(gallery, /id=\{`\$\{p\.slug\}-model-keys`\}/, '键盘说明必须有对应 id');
});

test('E-101/E-102 每个工具条按钮都是真实 button 且达到 44×44', () => {
  const toolbar = /<div className="views"[\s\S]*?\n            <\/div>/.exec(gallery)?.[0] ?? '';
  assert.ok(toolbar, '必须能找到工具条');
  const buttons = toolbar.match(/<button[\s\S]*?>/g) ?? [];
  assert.ok(buttons.length >= 5, `工具条至少有旋转左右、缩放、复位与暂停，实际 ${buttons.length}`);
  for (const tag of buttons) {
    assert.match(tag, /type="button"/, `每个按钮都要显式 type=button：${tag}`);
    assert.match(tag, /style=\{TOUCH_TARGET_STYLE\}/, `每个按钮都要用 44px 目标：${tag}`);
  }
  // 触控目标常量必须 44，且与样式逐项一致。
  assert.match(gallery, /minWidth: TOUCH_TARGET_PX, minHeight: TOUCH_TARGET_PX/);
  assert.match(gallery, /import \{ accessibilityCopy, keyToCameraCommand, TOUCH_TARGET_PX \}/);
});

test('E-101 键盘动作只在焦点属于某个模型时接管，不被锁在控制区里', () => {
  // 取自 pointerRef 的真实焦点归属，不用「当前有卡片可见」这类更宽的条件。
  assert.match(gallery, /const slug = current\.focusedSlug;\s*\n\s*if \(!slug\) return;/, '必须以真实焦点归属为前提');
  assert.match(gallery, /const cmd = keyToCameraCommand\(/, '必须走共用按键表');
  assert.match(gallery, /if \(!cmd\) return;/, '未列出的键必须放行浏览器默认行为');
  // Escape 分支必须排在键盘相机动作之前，且保留 M2-T2 的四项释放语义。
  const escapeAt = gallery.indexOf("if (event.key === 'Escape')");
  const cameraAt = gallery.indexOf('const cmd = keyToCameraCommand(');
  assert.ok(escapeAt > 0 && cameraAt > escapeAt, 'Escape 必须先于相机动作处理');
  assert.match(gallery, /wheelPermit\.current = null;\s*dispatch\(\{ type: 'escape' \}\)/, 'M2-T2 的 Escape 许可撤销不得回退');
});

test('E-104 复位基准是取景时记录的初始相机，之后不被改写', () => {
  assert.match(scene, /const initialRef = useRef<InitialCameraState \| null>\(null\)/, '必须有初始相机 ref');
  assert.match(scene, /if \(initialRef && !initialRef\.current\) \{/, '只在首次取景记录，之后不覆盖');
  assert.match(scene, /initialRef\.current = \{/, '必须写入初值');
  assert.match(scene, /controls\.target\.set\(\.\.\.init\.target\);/, '复位必须恢复 target');
  assert.match(scene, /controls\.object\.position\.set\(\.\.\.init\.position\);/, '复位必须恢复相机位置');
  // 复位不能被开合盖拉远改写，否则「复位」等于「回到开盖视角」。
  const recordAt = scene.indexOf('initialRef.current = {');
  const openDollyAt = scene.indexOf('const lastView = useRef(i.view);');
  assert.ok(recordAt > 0 && openDollyAt > recordAt, '初值记录必须在开合盖拉远之外，不被其覆盖');
});

test('E-101 旋转走方位角/极角，不改变缩放距离与 target', () => {
  assert.match(scene, /controls\.setAzimuthalAngle\(controls\.getAzimuthalAngle\(\) \+ command\.azimuth\)/);
  assert.match(scene, /controls\.setPolarAngle\(controls\.getPolarAngle\(\) \+ command\.polar\)/);
  const rotateBlock = /command\.kind === 'rotate'[\s\S]*?\n    \} else \{/.exec(scene)?.[0] ?? '';
  assert.ok(rotateBlock, '必须能找到旋转分支');
  assert.equal(rotateBlock.includes('dollyIn'), false, '旋转不得改变缩放距离');
  assert.equal(rotateBlock.includes('dollyOut'), false, '旋转不得改变缩放距离');
  assert.equal(rotateBlock.includes('.target.set'), false, '旋转不得改 target');
});

test('E-101 相机状态发布 polar，供键盘方向键断言读取', () => {
  assert.match(scene, /el\.dataset\.polar = controls\.getPolarAngle\(\)\.toFixed\(4\)/, '必须发布极角');
});

test('M2-T2 已验收的缩放通道与许可语义保持不变', () => {
  // 缩放仍走 requestZoom 与 zoomId，未被新通道吞掉。
  assert.match(gallery, /const requestZoom = useCallback\(\(slug: string, delta: number\) => \{/);
  assert.match(gallery, /zoomId: zoom\?\.slug === p\.slug \? zoom\.id : 0/);
  assert.match(scene, /if \(zoomDelta < 0\) controls\.dollyIn\(scale\);/);
  assert.match(scene, /else if \(zoomDelta > 0\) controls\.dollyOut\(scale\);/);
  // 新通道独立记账，不会覆盖 zoomSeq。
  assert.match(gallery, /const commandSeq = useRef\(0\);/);
  assert.match(gallery, /commandSeq\.current \+= 1;/);
  // E-98 两条准入仍要求许可与真实焦点同时成立。
  assert.match(gallery, /focusBelongsToModel: wheelPermit\.current === slug && surface\.contains\(document\.activeElement\)/);
  // 监听域仍是焦点 wrapper。
  assert.match(gallery, /const surface = viewport\?\.parentElement \?\? null;/);
});

test('两个 ModelOrbit 调用点都必须传 zoomId/zoomDelta（漏传会让所有缩放静默失效）', () => {
  // 这条是实测发现的回归：改接新通道时两处调用点一度只传 commandId，缩放按钮与键盘加减号全部无效，
  // 而当时只断言源码字面量的单测仍然全绿。所以这里直接核对每个调用点都带齐两条通道。
  const calls = scene.match(/<ModelOrbit[\s\S]*?\/>/g) ?? [];
  assert.ok(calls.length >= 2, `应有 GLB 与程序化两条渲染路径，实际 ${calls.length}`);
  for (const call of calls) {
    assert.match(call, /zoomId=\{i\.zoomId\}/, `缩放入口必须接到 zoomId：${call}`);
    assert.match(call, /zoomDelta=\{i\.zoomDelta\}/, `缩放入口必须接到 zoomDelta：${call}`);
    assert.match(call, /commandId=\{i\.commandId\}/, `方向/复位必须接到 commandId：${call}`);
  }
  // 组件自身也必须有对应的执行分支，否则接了 props 也不会动相机。
  assert.match(scene, /zoomId\?: number; zoomDelta\?: number; commandId\?: number; command\?: CameraAction;/);
});
