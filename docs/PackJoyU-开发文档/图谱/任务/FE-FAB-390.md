---
type: task
id: FE-FAB-390
status: done
module: M1
origin: issue-ledger-20261024
---

# FE-FAB-390　390px 下展开的浮动按钮不再遮挡页脚链接

> 来自 `04-执行/遗留issue-20261024.md`。不进入 19 节原批次。状态以该登记为准。

- 所属模块：[[M1]]
- 前置依赖：无
- GitHub：没有单独的 GitHub issue
- PR：#468
- 合并提交：`2d92d4a72aca2b587b490461380773b20a99ee7b`
- 审查：由 PR 上 bot 审查替代
- 登记状态：已落地

没有单独的 GitHub issue。收起项改成 visibility hidden 后仍占高度，容器不接点击、直接子项接点击。

## 输入 / 产出

- **输入**：窄屏展开的浮动按钮挡住页脚链接。
- **产出**：收起后的容器不再接点击，页脚链接可以点到。
- **有效路径**：`e2e/fab-footer-390.spec.ts`、`src/app/globals.css`、`src/components/quote/FloatingActions.tsx`、`tests/fab-footer-390.test.ts`

## 验收标准

已由 PR #468 于 2026-10-25 合入 main。合并提交 2d92d4a72aca2b587b490461380773b20a99ee7b。390px 下展开的浮动按钮不再遮挡页脚链接。本登记不重做。

## 必须处理的边界

无

## 代码位置

<!-- code:begin -->
- `src/app/globals.css:65` — `.fab{pointer-events:none}.fab>*{pointer-events:auto}`。收起后的容器不再接点击，toggle 和展开后的按钮仍接。
- `src/app/globals.css:68` — `.fab:not(.open) .item` 的 `pointer-events:none` 特异性更高，隐藏项仍然点不到。
- `e2e/fab-footer-390.spec.ts:48` — 记录切换基线前，`expect.poll` 等到 `scrollY` 连续两次相同且已到达目标。
- `e2e/fab-footer-390.spec.ts:59` — `scrollToBottom` 使用 `behavior: 'instant'`，同样等到稳定。
- `e2e/fab-footer-390.spec.ts:244` — 390 与 360 收起时，toggle 上方死区的多个采样点不得命中 `.fab` 或其后代。390 ru 首屏「Пропустить видео」右侧（落在原 `.fab` 区域内）命中该按钮或其后代。390 en「Color Boxes」右侧 48px 内的点命中该链接或其后代。收起时 toggle 可点，展开后各 item 可点。
- `e2e/fab-footer-390.spec.ts:338` — 1440 下每个悬浮按钮的中心点命中该按钮。
- `e2e/fab-footer-390.spec.ts:355` — 「切换不位移」用例先 `emulateMedia({ reducedMotion: 'reduce' })`，中部滚动用 `instant`。展开/收起前后 `scrollY` 必须相等的断言没有放宽，组件没有为这件事改动。
- `tests/fab-footer-390.test.ts:26` — 源码锁定容器的 pointer-events 规则，且写在隐藏项规则之前。
- `src/components/quote/FloatingActions.tsx` — 测量展开高度并写入 `--fab-h`；窄屏收起时 `aria-hidden` 与 `inert`。
- `src/app/globals.css` — ≤767px 收起项改为 visibility 隐藏；≤480px 页脚底边距使用 `--fab-h`，品类链接改为块级。
- `e2e/fab-footer-390.spec.ts` — 390/360/1440 与切换、首次加载的验收。
- `tests/fab-footer-390.test.ts` — 样式与测量写法的源码断言。
<!-- code:end -->

## 实施沉淀

<!-- notes:begin -->
收起项改成 `visibility: hidden` 后仍占展开高度，`.fab` 固定盒大约 52×238。子项自己是 `pointer-events: none`，容器没有设置，点击落在容器上。容器不接点击、直接子项接点击之后，间隙和隐藏项都穿透到页面；toggle 与展开后的按钮仍可点。桌面端没有折叠，直接子项保持可点。

「切换不位移」在 CI 上 `scrollY` 不相等，是因为 `html { scroll-behavior: smooth }`，测试里的 `scrollTo` 在滚动完成前就读了基线。只改了 e2e：减少动态效果、即时滚动，并等到读数稳定。没有放宽断言，也没有改组件。

本地：`npm run lint` 通过。`npx tsc --noEmit` 只有既有的 `tests/analytics-consent.http.test.ts` 报错。`tests/fab-footer-390.test.ts` 4 通过。Playwright 自带 Chromium headless 跑 `e2e/fab-footer-390.spec.ts` 14 通过；「切换不位移」再 `--repeat-each=3`，6 通过。
<!-- notes:end -->
