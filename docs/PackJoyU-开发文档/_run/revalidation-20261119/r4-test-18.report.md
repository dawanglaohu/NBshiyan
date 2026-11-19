# B10-M4T4-REVAL R4 只读复验（18 项）

- 执行：测试工程师；全程只读，未运行 `status`/`verify`/`build`/`landed`，未改任何标记、源码、分支或工作树，未起数据库、服务、测试或 CI
- 文档对象：`02ea695fbc7d581392d0d29e2fdcb27f1e6b8acb`（`task/M4-T4`，父 `a7941062`，只改 19 个文档路径）
- 代码对象：main `a7941062af916119d53e0802d1752b4c1ab02424`
- 补丁：`m4t4-retry-contract-20261119`；sourceVersion `c9509a4948b9054805e821289da7c7a59e95f0fb27b4a8b45ef37b1e420a37c4`
- 只写：`D:/xiangmu/.codex-plans/NBShiyan-m4-t4/revalidation-20261119/R4/`

## 1. 补丁差量与适用面

`a7941062..02ea695f` 在三个被标记章节的实际改动：

1. `09-数据模型.md:24` ChatNotification 行：首次发送后最多重试 3 次，每条出箱最多 4 次已标记开始的发送尝试；`requestStartedAt` 与 `attempts` 在发送前同一次原子更新写入；退避 1m/5m/30m 自结果写入时钟起算；清扫与回写 CAS 取行锁后读同一注入时钟，`lockedUntil <=` 当前时钟即视为已释放；SMTP 缺配置只把 `attempts=0` 且 `requestStartedAt` 为空的 QUEUED 置 DISABLED（终态），其余暂停。
2. `09-数据模型.md:174–179` 状态图：QUEUED→SENDING 需已配置且 attempts<4、availableAt 到期；第 4 次确知失败同一 CAS 直写 FAILED；UNKNOWN 在 attempts=4 时停止自动重试；DISABLED 仅针对从未开始尝试的出箱。
3. `15-性能与容量假设.md:31` 聊天通知行：改为首次发送后最多重试 3 次（最多 4 次已标记开始的发送尝试），失败或未知结果写入后依次至少等待 1/5/30 分钟。
4. `18-部署与运维.md:94` 聊天可用性/通知策略行：同上，并补 SMTP 缺配置时 DISABLED 的适用范围与旧 DISABLED 行不自动补发。

另有 `13-边界问题与异常处理.md`（E-91/E-92/E-93）与 `19-模块任务拆分.md`（M4-T4 行）同步改动；这两节不在这 18 项的 changedFields 内，本窗不核。三张边界卡与 M4-T4 任务卡是 `图谱/` 下仅有的变化，本组 18 张任务卡在 `a7941062` 与 `02ea695f` 之间无改动。

## 2. 标记与契约哈希核对

- 18/18 条目：`revalidation.json` 契约哈希、补丁证据模板、`dispatch.json` 的契约版本、`AFFECTED-BY-FIELD.tsv` 的 after 四处一致：**True**；逐项值见 `HASH-CHAIN.tsv`
- 18/18 `previousStatus = done`，未清零、未改任务状态；每条 `patches` 仅 1 条，`changedFields` 同为 `sections:02-设计/09-数据模型.md,03-质量/15-性能与容量假设.md,04-执行/18-部署与运维.md`
- 这 18 项都不是 M4-T4 的前置或下游；SEO-3（hold，不在本组、也没有待复验标记）未纳入

## 3. 逐项结论

| 任务 | 本任务职责 | 结论 | 依据 |
|---|---|---|---|
| CI-DB-TESTS | 把 analytics/chat 数据库测试接进 PG17，TAP skipped/fail/todo/cancelled=0、pass≥1 | **不适用** | 条款不改 CI 步骤；步骤仍在 `ci.yml:376`，清单含 chat 三个用例，门禁 `:516–520`；出箱初值 QUEUED 未变（`chat-first-message.db.test.ts:308`、`repo.ts:241`）。卡内 `ci.yml:93` 已漂移到 :376 |
| CI-DEVICE-SERIAL | 设备会话回归串行、失败打印后退出 1、成功要求 todo=0 | **不适用** | 与出箱无关；`ci.yml:282` 步骤、`:320` 串行、`:328` 失败退出、`:331` todo 0 均在；卡内行号漂移 |
| DEP-AUDIT-1 | 依赖审计豁免与生产审计入口 | **不适用** | 与出箱无关；4 个文件在 main 全在 |
| DEPLOY-FIX-1 | 首页品牌媒体与海报修复 | **不适用** | 与出箱无关；3 个文件在 main 全在 |
| DOCKER-UPLOADS-1 | `.dockerignore` 排除上传目录 | **不适用** | 与出箱无关；文件在 main 存在 |
| E2E-CONSENT-FIX | 分析同意 e2e 的路由截取与重放断言 | **不适用** | 属事件采集/去重，不涉及出箱；7 处位置在 main 全在（行号以卡内所注提交为准） |
| GATE-HARDEN | 安全审查 gate 不执行 PR head、路径规则覆盖 | **不适用** | 与出箱无关；附漂移：三个 security-review 工作流已由 `82f74bcc` 删除 |
| GATE-HARDEN-2 | CODEOWNERS 指定 workflows 与自身审查请求人 | **不适用** | 与出箱无关；`CODEOWNERS:1–2` 两条规则仍在 |
| GATE-PATHS-1 | 安全审查 gate 路径规则 | **不适用** | 与出箱无关；附漂移：工作流已由 `82f74bcc` 删除 |
| GATE-PATHS-2 | 安全审查 gate 路径规则 | **不适用** | 与出箱无关；附漂移：工作流已由 `82f74bcc` 删除 |
| MAIN-E2E-FIX | 只改测试：ingest READY/published、121 字符 slug、catalog merge | **不适用** | 摄入/目录合并测试，不涉及出箱；3 个测试文件在 main 全在 |
| POST-LAUNCH-P3 | 缓存头、媒体清理、/og 404、限流 Retry-After、smoke、BrandScene 重试 | **不适用** | 卡内 retry 指登录桶 Retry-After 与播放重试；两处 GIF 为卡内既定删除；其余 36 处位置路径存在 |
| SEO-1 | 关于页 sitemap/hreflang/lastModified | **不适用** | 与出箱无关；4 处位置在 main 全在 |
| SEO-2 | 静态 /og jpg 缓存头与单测 | **不适用** | 与出箱无关；`next.config.ts` 未被补丁改动 |
| SEO-4 | 去掉 VERCEL_ENV 生产兜底 | **不适用** | 有效路径含 `mail/config.ts`，但只涉及 mock 的 APP_ENV（:124）；SMTP 是否配置的判定在 :104/:114，不在本任务范围 |
| SEO-5 | 404 页 robots 单条 noindex | **不适用** | 与出箱无关；11 处位置在 main 全在 |
| SEO-6 | 3D 城市场景 GIF→video 与播放控制 | **不适用** | 卡内「重试」是视频播放重试，与出箱无关 |
| SEO-7 | SEO 复核条目（关于页） | **不适用** | 与出箱无关；5 处位置在 main 全在 |

**汇总：适用且仍满足 0；不适用 18；不满足 0。**

适用面判据：这些条款只描述 M4-T4 将要实现的聊天通知消费行为；`a7941062` 上 `git grep ChatNotification|requestStartedAt|stableMessageId` 只命中 10 个文件（`prisma/schema.prisma`、`prisma/sql/74-mail-backend.sql`、`deploy/tests/fixtures/first-deploy-91db98e.sql`、`src/lib/server/chat/conversation-service.ts`、`src/lib/server/chat/repo.ts`、`src/lib/server/mail/send.ts`、`tests/analytics-retention.db.test.ts`、`tests/chat-first-message.db.test.ts`、`tests/mail-thread.test.ts`、`tests/fixtures/mail-db.ts`），本组 18 项的有效路径与其交集为 0。

## 4. 横向观察（不阻断，不改）

- `ci.yml` 的 PostgreSQL 清单里有 `chat-first-message.db.test.ts`（:496），它是 18 项里唯一经 CI 间接走到出箱写入的用例；它只断言初值 QUEUED，本次条款不改初值。M4-T4 实施后新增的 attempts/租约用例是否进该清单，由 M4-T4 的实施卡决定，不属本组。
- GATE-HARDEN、GATE-PATHS-1、GATE-PATHS-2 的卡内代码位置指向已退役的工作流（`82f74bcc`），这是原任务的文档漂移，与本补丁无关；沿第 9 批的处理，登记在报告里，不在本窗改卡。
- 卡内行号漂移：CI-DB-TESTS（93→376）、CI-DEVICE-SERIAL（125/133/136→320/328/331）、`admin-session-activity.http.test.ts`（351→348）；内容仍在。
- 旧邮件队列常量 `MAX_RETRIES = 5` 在 `src/lib/server/mail/config.ts:16`，属既有邮件队列，不受聊天通知改动影响。

## 5. 边界与未做

- 只核变化条款对这 18 项的适用性；未重新验收各任务的全部原条款，未运行任何测试或 CI。其余任务的代码位置只核路径存在与行号未越界，没有逐行语义核对。
- 清除标记不在本窗：evidence 的 `verdict=pass` 只登记文档契约复核，不证明代码验收或 CI 通过；`--landed` 由非复验人的运维统一集成。

## 6. 交付物

- `R4.evidence.json`（scope、note、sourceVersion、patch、docsCommit、codeObject、tasks×18）
- `R4.report.md`（本报告）
- `HASH-CHAIN.tsv`（18 项四处哈希核对）、`LOC-CHECK.txt`（131 行代码位置实读）、`FACTS.json`（有效路径与关键词命中）
- `SHA256SUMS-LF.txt` 与 `.sha256` 侧车
