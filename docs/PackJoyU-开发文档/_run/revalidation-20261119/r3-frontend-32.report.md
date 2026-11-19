# B10-M4T4-REVAL R3：32 项共享章节只读复验

R3 的 32 项里，**31 项不适用，1 项适用且仍满足，不满足 0 项**。固定对象为文档 `02ea695fbc7d581392d0d29e2fdcb27f1e6b8acb`（tree `0cf4cc2b4f6f8843d3c06c277ec545746aa19579`，唯一父为代码 `a7941062af916119d53e0802d1752b4c1ab02424`）与补丁 `m4t4-retry-contract-20261119`（源版本 `c9509a4948b9…`）。32 项的契约哈希取自 `_run/revalidation.json`，与补丁 evidence、补丁 `changes.after.hash`、[分组表](<D:/xiangmu/.codex-plans/NBShiyan-m4-t4/contract-write-20261119/formal-sync-20261119/AFFECTED-BY-FIELD.tsv>) 逐项相等。[evidence](R3.evidence.json) · [逐项矩阵](MATRIX.tsv)

只读纪律：没有运行 status、verify、build、landed，没有改标记、源码、分支或工作树，没有启动数据库、服务或测试。已落地代码按 Git 对象 `a7941062` 读取，工作树读回仍为固定头且干净。

## 补丁实际改了什么

对 `a7941062..02ea695f` 在 09、15、18 三节的 diff 只有五个 hunk，对应下面四处条款，全部围绕聊天通知出箱。[原 diff](SOURCE-DIFF-09-15-18.txt)

| 条款 | 位置 | 内容 |
| --- | --- | --- |
| 09 ChatNotification 行 | `09-数据模型.md:24` | 首发后最多重试 3 次，每条出箱最多 4 次已标记开始的发送尝试。发送前以有效租约原子写 `requestStartedAt` 并递增 `attempts`。确知失败未达上限回 QUEUED，第 4 次直写 FAILED。UNKNOWN 与过期清扫按 1/5/30 分钟档位处理。写回与清扫用同一服务端时钟，过期＝`lockedUntil<=当前时钟`。缺配置只把从未开始尝试的 QUEUED 置终态 DISABLED。 |
| 09 状态图 | `09-数据模型.md:174-181` | 与上行一致的转移守卫，新增 UNKNOWN 在 attempts=4 时停止自动重试。 |
| 15 聊天通知预算 | `15-性能与容量假设.md:31` | 首发后最多重试 3 次，失败或未知结果写入后依次至少等待 1/5/30 分钟。 |
| 18 聊天可用性/通知策略 | `18-部署与运维.md:94` | 缺配置仅从未开始尝试的出箱置 DISABLED 且为终态，已尝试或 UNKNOWN 的行暂停，配置恢复后按 09 规则处理。 |

按 `changedFields` 分三组：18 项为 09+15+18，13 项为 09+18，M1-T9 仅 18。逐项从补丁 `changes` 的 before/after 复算出实际变化的节，与 `changedFields` 一致。

## 判定方法

- 每项先取任务笔记登记的代码锚点，在 `a7941062` 的 Git 对象里确认文件存在，再按文本定位真实行号。笔记行号已漂移时以现行行号为准。
- 对每项登记的文件，在 `a7941062` 中严格搜索 `ChatNotification`、`stableMessageId`、`requestStartedAt`、`NotificationQueued`、`chat-notifications`。32 项里 31 项零引用，唯一命中是 R3-T86511435 的租约用例，该用例用 `chat-notifications` 作租约 key。[锚点扫描](SCAN.json) · [耦合结果](COUPLING.json)
- 聊天通知相关代码在 `a7941062` 只有入箱：`src/lib/server/chat/repo.ts:233` 写入 ChatNotification，`conversation-service.ts:189` 绑定 `stableMessageId`，没有出箱 worker。
- 第二种方法：PowerShell 复核 32 个哈希、四处条款行首、BOM 和分类前缀，结果一致。[PowerShell 复核](CROSSCHECK-PS.json)

## 32 项矩阵

| # | 任务 | 契约哈希 | 实际变化的节 | 结论 | 依据 |
| --- | --- | --- | --- | --- | --- |
| 1 | CATALOG-MERGE | `110cdc602da0` | 09+15+18 | 不适用 | 本任务交付按品类合并 3D 目录并让分析白名单与可见 key 对齐；`src/lib/catalog/catalog.ts:37` |
| 2 | CITY-STILL-WEBP | `9587f77b9800` | 09+15+18 | 不适用 | 本任务把首页城市场景暂停静帧改为 1384w/2000w 响应式 WebP；`src/components/layout/BrandScene.tsx:17` |
| 3 | CLIENT-API-DEADLINE | `0316f48a0579` | 09+15+18 | 不适用 | 本任务让每次请求的 15 s deadline 与用户取消打断挂起的响应正文读取，只动客户端请求层；`src/lib/client/api.ts:217` |
| 4 | FE-404-TITLE | `f2de5adce867` | 09+15+18 | 不适用 | 本任务把 404 标题放进 head 并保持渲染后 document.title；`src/app/[locale]/not-found.tsx:53` |
| 5 | FE-FAB-390 | `c43a41400aec` | 09+15+18 | 不适用 | 本任务让 390px 下收起的浮动按钮容器不再接收点击；`src/app/globals.css:85` |
| 6 | GIFT-CARD-ASSETS | `f426c962d522` | 09+15+18 | 不适用 | 本任务替换贺卡品类的 D 方案模型/海报并把后台中文标签改为「贺卡」；`src/data/products.ts:16` |
| 7 | GIFT-CARDS-RENAME | `f03ad4445631` | 09+15+18 | 不适用 | 本任务把礼品卡品类的对外名称、slug 与 SEO 元数据改为贺卡；`src/lib/seo/categoryMeta.ts:74` |
| 8 | R3-T09233008 | `8ef5df1a1031` | 09+15+18 | 不适用 | 本任务在适用平台执行存储权限与符号链接安全验收；`tests/prod-env-check.test.ts:11` |
| 9 | R3-T09598683 | `4cf473e650fd` | 09+15+18 | 不适用 | 本任务让首页扣除 publicBrand 边距后铺满宽度，--container 仍为 1240px、桌面边距 24px；`src/styles/tokens.css:14` |
| 10 | R3-T12074461 | `f19203b8daf0` | 09+15+18 | 不适用 | 本任务只改 11 节 UI 文档中的首页铺满门槛与 48px/24px 目标值；`docs/PackJoyU-开发文档/02-设计/11-UI.md:197` |
| 11 | R3-T21757567 | `733d06237cc4` | 09+15+18 | 不适用 | 本任务让内容导入用例改用实际可用的 Python 并执行全部保护断言；`tests/sanity-import.test.ts:21` |
| 12 | R3-T22883505 | `11f6b9f87b96` | 09+15+18 | 不适用 | 本任务补受支持 Linux 构建的 standalone 产物、真实主冒烟与后台密度实证；`.github/workflows/ci.yml:32` |
| 13 | R3-T56876634 | `48bc6063fc84` | 09+15+18 | 不适用 | 本任务给公司图稿逐件登记选定输入 path、SHA-256 与用途；`docs/brand-content/company-visuals.json:91` |
| 14 | R3-T71889698 | `9b6dc5565240` | 09+15+18 | 不适用 | 本任务保留令牌签发审计并修正重置并发测试预期；`scripts/admin-reset-initial-password-lib.mjs:22` |
| 15 | R3-T75625096 | `24618d25c334` | 09+15+18 | 不适用 | 本任务修正已登录后台适用工作面的密度失败；`src/components/admin/settings/settings.css:2` |
| 16 | R3-T86511435 | `a6c029430393` | 09+15+18 | 适用且仍满足 | 租约等号即过期语义仍成立（lease-repo.ts:177/:428，job-leases.db.test.ts:167-195）；`src/lib/server/jobs/types.ts:7` |
| 17 | R3-T87287564 | `a38184d419a9` | 09+15+18 | 不适用 | 本任务统一文件身份比较，使 lint 脚本与测试通过 Windows 路径负例；`scripts/lint-ru-yo.mjs:17` |
| 18 | R3-T92231765 | `36ded88fd096` | 09+15+18 | 不适用 | 本任务统一检出换行策略并让源码断言与 Shell 验证在实际检出下可靠执行；`.gitattributes:3` |
| 19 | M1-T1 | `cf38e3ad38fd` | 09+18 | 不适用 | 本任务接入 8 个核心品牌变量并完成既有路径真实冒烟；`src/styles/tokens.css:27` |
| 20 | M1-T4 | `c13cde19d852` | 09+18 | 不适用 | 本任务接好选定视频与分区 PNG/GIF 场景及首页入口；`src/components/layout/HeroVideo.tsx:15` |
| 21 | M1-T5 | `9db58d2bc9f7` | 09+18 | 不适用 | 本任务集成己方公司内容与选定图稿，白名单只输出 Web 路径、宽高与 alt；`src/lib/brand/company-media.ts:57` |
| 22 | M1-T6 | `c3e3be762b70` | 09+18 | 不适用 | 本任务核验已确认的 GIF 与发布媒体集合；`public/brand/packjoyu-industrial-city-v3-loop-poster.png:1` |
| 23 | M1-T7 | `2ea2c954f57b` | 09+18 | 不适用 | 本任务补齐共享视觉变量与原生 UI 包装；`src/styles/tokens.css:92` |
| 24 | M1-T8 | `227b50c8057a` | 09+18 | 不适用 | 本任务接通统一 fetch 取消与错误适配；`src/lib/client/api.ts:24` |
| 25 | M1-T9 | `00d01a510b09` | 18 | 不适用 | 本任务复用已确认素材交付公司图稿工程；`docs/brand-content/company-visuals.json:20` |
| 26 | M2-T1 | `7582af656272` | 09+18 | 不适用 | 本任务扩展产品卡视口并精简信息区；`src/app/[locale]/products/page.tsx:15` |
| 27 | M2-T2 | `ecad74f45490` | 09+18 | 不适用 | 本任务修正模型直接拖动与滚轮焦点；`src/lib/three/model-pointer.ts:43` |
| 28 | M2-T3 | `0a278786d0f4` | 09+18 | 不适用 | 本任务接通模型键盘、触屏与复位控件；`src/lib/three/model-accessibility.ts:24` |
| 29 | M2-T4 | `2411b42f21da` | 09+18 | 不适用 | 本任务定义模型分析事件生命周期的纯规则；`src/lib/analytics/model-events.ts:118` |
| 30 | M2-T5 | `fa146e4f3e1f` | 09+18 | 不适用 | 本任务把产品上下文接到既有询盘表单；询盘通知走 sendSafely 邮件发送路径，不经 ChatNotification 出箱；`src/app/api/inquiries/route.ts:8` |
| 31 | M2-T6 | `2ed710639679` | 09+18 | 不适用 | 本任务接通真实模型失败与海报回退；手动重试上限 MAX_MODEL_RETRIES=3 是 GLB 重试，不是通知出箱重试；`src/lib/three/model-fallback.ts:15` |
| 32 | M2-T7 | `becb1054b4fd` | 09+18 | 不适用 | 本任务把真实 GLB 生命周期接入分析采集；其重试为新 viewId 的模型加载尝试；`src/components/analytics/model-events-producer.ts:114` |

## 重点结论

**R3-T86511435（适用且仍满足）**：09 L24 新写的「与 jobs 租约仓储一致，等于即视为已释放，与 M5-T1 一致」引用了该任务验证的租约原语。`lease-repo.ts:177`、`:216` 的领取条件是 `lockedUntil <= now`，`:256`、`:332`、`:391` 要求 `lockedUntil > now`，`:428` 以 `<=` 判过期。`tests/job-leases.db.test.ts:185-193` 在推进整 90 s 后让旧 owner 的续租和完成都返回 expired。这里只核该引用，不对出箱 worker 的次数、档位或 DISABLED 转移作通过声明，因为 worker 尚未落地。

**名称相近但不同层面的项**：M1-T8 和 CLIENT-API-DEADLINE 的 `api.ts` 有每次尝试 15 s 的截止（`:24`）、1/2/4 s 的消息写退避（`:25`）和 HTTP `attempts`（`:43`），属客户端请求层。M2-T6/M2-T7 的 `MAX_MODEL_RETRIES=3`（`model-fallback.ts:15`）是 GLB 加载重试。M2-T5 的 `requestStartedAt`/`attempts` 属 MailMessage（`send.ts:148`、`schema.prisma:521`），ChatNotification 同名列在 `schema.prisma:738`。这些项都标不适用并写明了区分。

## 观察（非阻断，不属本补丁条款）

- R3-T09233008、R3-T22883505：测试断言 `SMTP_PORT=25` 的生产启动会失败（`tests/standalone-start.test.ts:84`、`tests/prod-env-check.test.ts:132`），启动测试也断言缺 SMTP_PASS 会失败（`:82`）。18 L94 的「缺配置→DISABLED」是出箱运行期语义，二者不冲突。M4-T4 实施时按 09 规则落实即可。
- M1-T6：笔记登记的 `public/brand/…-loop.gif` 和 `…-loop-preview.gif` 在 `a7941062` 已不存在，首页改用 mp4 与 WebP（`src/lib/home/brandMedia.ts:11-13`）。这属后续任务演进，与本补丁条款无关，未据此判不满足。

## 范围与未做

本卡只判断 09、15、18 实际改动的条款对这 32 项的影响，不重审任务验收，不构成代码验收、发布许可或清除待复验标记。标记清除、`verify` 与 `--landed` 由运维按已定流程集成。没有运行任何测试，命中零引用的结论来自对 `a7941062` Git 对象的静态文本搜索。
