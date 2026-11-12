---
batch: 9
tasks: M2-T5, M2-T7, M3-T5, M4-T1, M4-T12, M5-T11, M5-T4
date: 2026-11-11
verdict: fixed
tests: pass
pr: https://github.com/dawanglaohu/NBshiyan/pull/554
repair_schema: 1
---

基线：main `15b18e8967a3cb4d599b16d423ea4585275dcd7e`（tree `723c92309decc7e39b28a14e2492722dda8c02b2`，PR554 合并后的最终头 L）。本记录是第 9 批在 R9 修复真正落地后的收口；原记录 `batch-9-20261111.md`（`verdict: open`）保持原字节不改。

`date` 取实际发生日 **2026-11-11（America/Los_Angeles）**，此刻 UTC 已为 2026-11-12；同日两条记录按文件名排序，本记录（下划线后缀）排在原名之后，成为该批最新记录。`pr` 填实际关闭 Found-1 的**修复 PR #554**，不是本记录自身的 PR；本记录自身的 head、CI 与最终合并/FF 都是创建之后发生的事实，放外置收据，正文不自我引用。

## 交付了什么

原 7 项任务保持 `done`，任务集合不变：

- M2-T5：产品卡询盘入口 → `/[locale]/contact?product=<slug>`，表单按静态目录显示产品名/规格。
- M2-T7：真实 GLB 生命周期接入分析采集（同 `viewId`、未同意不发事件）。
- M3-T5：受限恢复 `enroll`/`confirm` 原子重绑与旧凭据撤销。
- M4-T1：会话 + 首消息 + `ChatNotification(QUEUED)` 同事务。
- M4-T12：`mail-queue` cron 与 JobState 租约、预算/收尾窗。
- M5-T11：分析保留 dry-run/显式删除与共用 `analytics-aggregate` 租约。
- M5-T4：分析设置四字段 DTO、`expectedVersion` CAS、审计与作业终态。

修复轮 `R9-T71605271`（PR554）把唯一未闭合项 Found-1 收口：contact 操作面由 640 居中卡改为现行 `11-UI.md:217` 的左对齐 `minmax(0,800px)` 表单 + 320px 联系方式旁栏；窄屏顺序堆叠，产品名 + 3 规格保留在表单内，唯一询盘 POST 与无同意不写库行为未变。最终头 L `935cc3c81369b53a65c91095231835fd5e7d04f1` / tree `723c9230…` / parent `0c04917e` 已随 PR554 合入 main（merge `15b18e89`，父 `5b012bc3` 与 L），main 中任务笔记为 `status: done`。

## 测试

`tests: pass` 的依据是 **Linux 规范环境在最终头 L 的运行**；Windows 本地平台性失败照实单列，不合并成全绿。

1. **Linux CI（head L `935cc3c8`）**：run `43154883452`（`pull_request`，PR554 head L）**completed / success**，四 job 全绿：`build-and-audit`、`e2e`、`mail-evidence`、`posix-storage-security`。`build-and-audit` 的原始日志 Unit TAP：**tests 1985 / suites 32 / pass 1955 / fail 0 / cancelled 0 / skipped 30 / todo 0**；同 job 冒烟 `standalone` 3/3、`production 产物 mock` 4/4（两者 fail 0）。该 run 是 L 自身的证据，不是拿 `0c` 冒充 L。
2. **0c 历史来源（不是 L 的检查）**：run `43111467937`（head `0c04917e`，tree `dfb54831…`）四 job success，A3 收集 `all=239 main=208 model=14 consent=14 errors=2 flow=1 disjoint=true complete=true`、五段 `MAIN/MODEL/CONSENT/ERRORS/FLOW` success 且 `RELEASED=true`；封件 `independent-review/ci/pr554-run43111467937/` 8/8 `ad924b16…`。记录只把这组数字标为 0c 历史，不迁移成 L 的结果。
3. **Windows 本地全量（真实失败，原样保留）**：`pnpm test` → **1943 pass / 3 fail / 37 skipped / 1983 tests，exit 1**。3 项失败均在 `tests/sanity-import.test.ts`，已分类为 Windows 行尾（CRLF）平台条件（`build.py:229`、`linkmap.py:91/99` 未指定 `newline`；+11/+468 与 CRLF 数一致，归一后内容相同）。非本批回归、非产品缺陷；未修复前 Windows 仍红，本记录不把它写成通过，本轮也不承诺新的行尾修复任务。
4. **Found-1 修复几何（R9 验收，三视口）**：1920/1440 真实 tracks `800px 320px` / gap 24、表单 x=20 w=800、旁栏 x=844 w=320、`.wizard` 800 左对齐；D2 按总 fill（noRail 原参数）**0.595 / 0.793**、leftGap 20 通过。探针 `--rail` 是左栏语义，右栏被排除出跨度但不调整可用区，1920 会虚报 0.417；原始两模式均保留，不作布局违约。390 单列 350、overflowX 0、控件 44/48，三视口产品名 + 3 规格可见、非 GET 0。封件 `testing-acceptance/ACCEPTANCE-0C` 12/12 `a44795a8…`。
5. **L 最终载体窄核（1440 单视口，独立桥接）**：L 源码/阶段/构建/运行/页面五段绑定成立，tracked 0；`/en/products` 200（12 卡 / 12 询盘入口）、`/en/contact?product=corrugated-boxes` 200；真实几何与 0c/O5 后一致：tracks `800px 320px`、gap 24、表单 w=800、旁栏 w=320、左缘 x=20、`body overflowX=0`；产品名 + 3 规格可见，fill **0.793** / leftGap 20 / D2 pass，浏览器层非 GET 0、console error 0。构建身份：BID 文件 21 B / `059BFD5B3E242B0FC8C181860C72D1A69462ED7D45DA9173B9E1E43FFCD4A10A`（页面 HTML 命中 products/contact），`server.js` 7,534 B `DE50FEC0…`（与 0c 同值，产品代码未变），`.next/static` **174 文件 / 4,878,448 B**（文件求和，Windows 9p 与 WSL 一致）与 Ops `du -sb` **5,451,888 B**（含 140 个目录项各 4 KiB）**分列**；app 15136 `04:45:50Z` / guard 15159 `04:45:55Z`（btime `1794451545` + ticks 换算），env 复用 600/1,900 B 未重生成。封件 `testing-acceptance/final-L935` 7/7 `bff15326…`、`ops-runtime/final-head-935cc3c8` 11/11 `4ece7e35…`。本节只作 1440 桥接，不冒三视口全量重测。
6. **O5 运行配置修复（测试配置，非产品）**：`dbcheck-r3` 6/6 `a19de0eb…`——`dbPresent/parseOk/hostIsLoopback/portIs1/expectedTarget=true`、`strayConnectTimeoutKey=false`、guard 最小 6 键、canary 不继承；`o5-fixed` 10/10 `02b88516…` 仅作 limited 附录（补 schema/query/生成方式），不是第二 PASS。
7. **构建输入**：`build-input-provenance` 10/10 `925195d8…` PASS（限定非生产 UI 载体；tar→git 6187/6187、stage 名称/大小/mtime、15 项内容抽样；本地 pnpm 10.34.6 与 CI 10.34.9、workspace overlay 差异已记录）；`db-url-compile-input` 15/15 `65481149…` 证 `DATABASE_URL` 不属于编译输入，O5 不需重建。
8. **代码/语义**：PR554 代码审 10/10 `94d57e5d…`（正控 10/10、base 负控 9/1，失败点即布局断言）；语义复核 3/3 `92e6fd5b…`（契约 `9a8a92b6…` 可执行、与 `11-UI.md:217` 一致）；L935 终审 `independent-review/final-L935` 6 件成员 + SUMS（509 B）。
9. `tsc --noEmit` exit 0、`lint` exit 0：R9 实现分支既有结果，引用不重跑。文档基线 `test_issue_ledger.py` 1 failed / 8 passed 保留。
10. **本记录自身**：docs-only 登记；其 head 的自然 CI、PR 与最终合并/FF 在创建后另行记录（外置收据），本正文不写成已发生。

## 发现与修复

Found-1 根因：`src/app/globals.css:99` 的 `.wizard` 为 `max-width:640px;margin-inline:auto`（Issue #308 的 owner 验收评论 `issuecomment-6231817626`，2026-10-17T08:36:28Z；实现 `15fecd93`，PR345 于 2026-10-18T03:44:31Z 合并）。当前 `11-UI.md:217` 的 800+320 契约由 `c78cde2e` 于 2026-10-20T02:03:02-07:00 新增，晚于旧实现；旧 640 是当时选择，不等于现在仍有效。M2-T5 只新增 `.iq-product-context`，非本批引入，但本批实际触达且未闭合。

R9 修复（PR554）分层差量：实现层 `5b012bc3` → `201d2d30` = **4 文件 +27/−8**（contact 页、`globals.css`、测试、任务笔记）；verify 登记层 `201d2d30` → `0c04917e` = **3 个文档 +22/−3**（`build-manifest.json`、`task-reviews.json`、`docs-data.js`）；落地层 `0c04917e` → L `935cc3c8` = **3 个文档各 +1/−1**（`build-manifest.json`、`docs-data.js`、`图谱/任务/R9-T71605271.md`）；累计 `5b012bc3` → L = **7 文件 +50/−12**。实现内容：contact 页加 `contact-body` 800+320 栅格与既有 `HumanContactNotice` 旁栏；`.wizard` 改 800 左对齐。测试实际改动为标题改写、640→800 布局断言、**同一布局用例新增 1 条 `.contact-body` 800+320 栅格断言**；焦点/ARIA/隐私/44px 等其它断言不动；`InquiryWizard` 未改，唯一 POST 仍在 `onSubmit` 内且 consent/校验前置。本记录不生成第二返工任务：R9 由原 open 记录定义，此处只收口，不加 `task` 围栏。

运行中发现并修复的是 **O5 测试配置缺陷**（非产品）：`make-env.sh:19` 的 `DATABASE_URL=...&connect_timeout=1` 未加引号，`set -a; .` 被 `&` 拆开，app 缺 `DATABASE_URL`、多出 `connect_timeout`；Ops 修复后由 `dbcheck-r3` 复验。实际修复为整体重生成 env（24 行不同 = 23 个随机合成值轮换 + URL 加引号 77→79 B；键集合 46→46；旧 env 600/1,874 B 完整备份；全合成值，无真实凭据），此偏差按 Chief 裁决接受，不二次重启。

接缝：S1/S2/S3/S5 闭合；S4 为设计内未闭合依赖（M4-T1 只插入 `ChatNotification(QUEUED)`，消费者 M4-T4 仍 `todo`）。不写通知已投递、不写 E-94 已验证。

## 媒体（L 最终头）

- L 演示 GIF：`media-L935/r9-L935-product-inquiry-1440x900.gif`，**359,244 B**，1200×750、11.2 s、112 帧、4 个源状态帧，SHA-256 `B0F9BE53EAE93FD3A843914C5A654ACF946E3E0E15294B8C6A04B7CD7656DC0C`；assets 分支 commit `3864db94b83ed89d68b2b4a8a9a6e111c3904634`（父 `a0920925`，非 force、未删旧文件），文件 `r9-L935-product-inquiry.gif`、blob `6d216ea2…`；远端回读 200 / `image/gif` / 359,244 B、SHA 一致；PR554 正文改前改后 head 均 L。
- 载体：仓库已声明并安装的 `@playwright/test` 1.64.0 + 隔离 headless Chromium 156.0.8078.4（chromium-1248），单 context、新空帧目录、一次连续运行；**564 请求全 GET、nonGet 0、失败 0**；未点同意、未登录、未提交、未切聊天开关，向导停 Step 1；未隐藏 DOM、未改 CSS、未合成响应、未 build/安装/起停服务。
- 0c 轮 GIF（362,442 B `69a39582…`、assets `a0920925`）保留为历史，不覆盖、不混用；L 是 docs-only 落地，`01`–`03` 帧与 0c 对应帧字节相同（确定性渲染），`00` 帧因构建/BID 不同而不同，均为本轮新 context 现场截图。媒体 owner 报首次截图 PNG 损坏未保存，该帧未纳入证据。

## 遗留

- Windows `sanity-import` 3 项 CRLF 平台失败：保留分类，不改写为全绿；本轮未新建修复任务，最小修复仍需单独立项。
- 文档 `test_issue_ledger` 1 failed / 8 passed：既有基线，不扩修。
- S4：M4-T4 未交付，出箱只增不消；M4-T4 落地后按 §17 补真实 cron 重启消费证据。
- O5 合成 env 偏差：23 个随机合成值轮换已接受；`o5-fixed` 是 limited（旧字节随发布刷新未另存），仅作附录；`dbcheck-r3` 是主终验。
- 构建来源限定：非生产 UI 载体；本地 pnpm 10.34.6 与 CI 10.34.9、workspace overlay、stage 未全量逐字节（tar 侧全量 + stage 名称/大小/mtime + 15 抽样）已披露，不冒生产资格。
- 媒体限定：4 个离散状态摘录（非连续交互视频）、Playwright fallback（非 ego）、headless 渲染差异、合成配置/无真实 DB/模型/API 提交轮。
- L 实例在 `05:19` 观测已退出（原预计 hold 至 06:45），退出原因未从原 job 输出证实、未重启；不影响 `05:19` 前已封的录制与 L935 桥接证据。

## 返工任务

none（原 R9-T71605271 已由原 open 记录定义并在 main 标记 `status: done`；本记录不新增返工、不加 `task` 围栏）

## 给下一批的提醒

- M4-T4 落地前，不得把「出箱已建」当「通知已投递」；需补 `chat-notifications` job 的 registry/适配器与每分钟 cron（不复用旧 mail UI）。
- contact 布局按 `11-UI.md:217`；不要回到 640 居中；若主张旧选择，先交 Chief 与规范修订证据。
- `analytics-retention` 与 `analytics-aggregate` 共用租约，409 是正常占用跳过，不要改成重试或并发。
- Windows CRLF 3 项以同树 Linux 规范运行为准，不要为过红改断言或工具链。
- 本记录是 docs-only 登记：媒体源 head 是 L `935cc3c8`；未来登记头 tree 不同不等于产品不同，判据是产品/构建输入路径 diff；产品路径变了才重录，未实际录新头不冒新头。
