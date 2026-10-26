---
type: task
id: SEO-6
status: done
module: M7
origin: issue-ledger-20261024
---

# SEO-6　首页城市场景 GIF 改为视频

> 来自 `04-执行/遗留issue-20261024.md`。不进入 19 节原批次。状态以该登记为准。

- 所属模块：[[M7]]
- 前置依赖：无
- GitHub：#444
- PR：#453
- 合并提交：`151724cb74ae876c97d6297b169dc7ce49590af9`
- 审查：由 PR 上 bot 审查替代
- 登记状态：已落地

已由 PR #453 于 2026-10-24 合入 main。合并提交 151724cb74ae876c97d6297b169dc7ce49590af9。issue #444 已关闭。旧 GIF 的删除见 POST-LAUNCH-P3。

## 输入 / 产出

- **输入**：首页城市场景现在用 GIF。视频由 3D 从和 still 同一张母版、同一段循环渲染。
- **产出**：BrandScene 用静音循环视频代替 GIF。新文件放 public/brand/，文件名不带 hash，不覆盖现有文件。
- **有效路径**：`src/components/layout/BrandScene.tsx`、`src/lib/home/brandMedia.ts`、`e2e/home-media.spec.ts`、`e2e/brand-smoke.spec.ts`

## 验收标准

等 3D 交出素材后再派。视频 2000 宽，比例保持 1384:720，MP4（H.264），可选 WebM，单个文件不超过 2MB，不含 still。第一帧和暂停帧与 still 是同一帧。BrandScene 用 video muted loop playsinline 代替 GIF 的 img。video 不设 poster，静帧 WebP 作底层。preload 为 none。src 或 source 只在现在允许下载 GIF 的同一条件成立后才挂上，不早于现在的加载时机，也不抢 Hero 视频。播放和暂停改成 play() 和 pause()。视频一旦播放过，暂停时不卸载 video，停在当前帧；恢复时从同一帧继续，不 load()、不重设 currentTime、不重新挂 src。从没播放过、减少动态效果的默认状态、或加载失败时才显示 still。play() 被拒绝时按现有失败逻辑退回 still。aria-hidden 为 true，不加 controls，无音轨。300px 预加载、进入视口、页面可见、用户未暂停才播放，以及 visibilitychange、freeze、resume、prefers-reduced-motion 的行为保持。减少动态效果时默认显示 still、不下载视频，用户点播放后才加载。播放按钮的 aria-pressed 和文案不变。常量名和 data-testid 可改，e2e 同步改，断言语义不放宽。暂停前后 currentTime 差值小于 1 帧，暂停 2 秒后 currentTime 不变，恢复后从该值继续增长。用户暂停、切标签页、离开视口三种暂停都适用。冷加载不滚动时不请求城市场景视频；滚到区块附近 300px 内才请求，且排在 Hero 视频之后。1920、1440、390 布局与现在一致。Lighthouse 移动端首页的 LCP 元素仍是 Hero poster。不改 Hero 视频，不改 CSP，不改其他页面。still 换 1384w/2000w WebP 另派。旧 GIF 和未引用的 preview GIF 在新版本上线、确认没有引用后另开小任务删除。不新增后台登录。单 IP 登录总数不超过 26。poster 方案已改为静帧底层，见实施沉淀。

## 必须处理的边界

无

## 代码位置

<!-- code:begin -->
- `src/lib/home/brandMedia.ts:14` — 1384 宽的城市场景 mp4，文件名不带 hash。
- `src/lib/home/brandMedia.ts:15` — 2000 宽的城市场景 mp4。
- `src/components/layout/BrandScene.tsx:162` — preload 为 none。第一次挂上 src 时 load() 一次。
- `src/components/layout/BrandScene.tsx:169` — 播放用 play()。被拒绝则退回静帧。
- `src/components/layout/BrandScene.tsx:236` — video 为 muted、loop、playsInline、preload none、aria-hidden，无 controls。
- `src/components/layout/BrandScene.tsx:258` — error 时退回静帧，onError 不调用 play()。出错后用户点播放重试先 load() 再 play()，见 POST-LAUNCH-P3。
- `e2e/home-media.spec.ts:222` — 未准入时断言不请求城市场景 GIF 文件名。同文件第 302、377 行是另外两处。改成匹配任意 .gif 见 POST-LAUNCH-P3。
<!-- code:end -->

## 实施沉淀

<!-- notes:begin -->
- PR #453，合并提交 `151724cb74ae876c97d6297b169dc7ce49590af9`。`git show --stat` 是 `BrandScene.tsx`、`brandMedia.ts`、`e2e/home-media.spec.ts`，以及 `public/brand/packjoyu-industrial-city-v3-loop-1384.mp4`、`public/brand/packjoyu-industrial-city-v3-loop-2000.mp4`。`e2e/brand-smoke.spec.ts` 不在这次合并里。
- 城市场景用静音循环 mp4 代替 GIF。两档都在 `public/brand/`，文件名不带 hash。video 不设 poster。静帧 WebP 作为底层 img 留在 video 下面，video 收到 playing 后才从 opacity 0 显示。不要给 video 加 poster，会首帧闪动或下载两张图。
- 视频一旦播放过，暂停不卸载，不再 load()，不重设 currentTime。从没播放、减少动态效果或加载失败时显示静帧。
- 冷加载不滚动时不请求城市场景视频。进入 300px 后才请求，且排在 Hero 视频之后。旧 GIF 还在仓库里，删除条件见 POST-LAUNCH-P3。
<!-- notes:end -->
