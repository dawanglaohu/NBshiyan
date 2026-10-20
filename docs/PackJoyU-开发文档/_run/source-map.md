# PackJoyU 当前源码事实图

基线：`971b5b46faa0c468fc85372773de612bebd51c3c`；根：`D:/xiangmu/NBshiyan-docs-s2-s6`。只读当前检出；没有检查未合并恢复 PR，没有读取 .env、真实密钥、数据库、生产备份或 .git/codex-reading；没有运行测试、服务或部署。完整路由、方法、测试文件名和引用在 source-map.json。此报告是规格输入，不是验收结果。

## 已存在的栈与入口

- 锁文件版本：Next 15.5.27、React 19.3.0、NextAuth 5.0.0-beta.32、next-intl 4.14.9、Prisma 6.19.3、Three 0.186.1、R3F 9.8.1、drei 10.7.9、TypeScript 5.9.3、Playwright 1.64.0。以 pnpm-lock.yaml 的解析版本为准，不能把 package.json 范围当锁定版本。
- CI 使用 Node 22 / pnpm 10；Docker 使用摘要固定的 Node 22、pnpm 10.34.6。package.json 未声明 engines。
- 前台入口 src/app/[locale]/layout.tsx，middleware 为 src/middleware.ts。路由与公开 API 只发布 en / ru；Prisma 额外枚举值是预留，不能视为已上线。
- 当前共有 27 个 page.tsx 页面、53 个 route handler。完整清单见 JSON 的 entrypoints。后台权限前缀表不是页面存在性清单。

## 现有认证与返回信封

- src/auth.ts：NextAuth Credentials，输入 email/password 以及可选 totp/recoveryCode；authorize 内部成功值是 {id,email,name,role,sv}。JWT 会话 2 小时，session 回调在 NextAuth 原会话上加入顶层 sv 与 user.id/user.role。不是自定义 {ok,data} 认证 REST 协议。证据：src/auth.ts:15；src/auth.ts:32；src/auth.ts:46；src/lib/server/admin/guard.ts:47；src/lib/server/admin/guard.ts:50；src/lib/server/admin-guard.ts:25；src/lib/admin/safe-callback.ts:18。
- API requireAdmin 成功返回内部 {user,ip}；拒绝直接返回 {error}，401 unauthorized、403 account_disabled、403 forbidden；响应 private, no-store。写操作依次 requireAdmin → assertSameOrigin → await enforceAdminRateLimit；同源错误 403 forbidden_origin，限流 429 rate_limited + Retry-After。
- 页面未登录跳 /api/auth/signin?callbackUrl=安全站内路径；停用/角色不符 404。layout 只是首层，页面与 API 仍独立检查。
- /api/auth-admin/enroll 成功 {otpauthUri}；confirm 成功 {recoveryCodes}；失败也是 {error}。不能把现有接口文档改写成统一成功封套。

## 现有设置与定时工作

- SiteSetting = key 主键 + Json value（prisma/schema.prisma:231）。/admin/settings 当前只有 about 与 org 两分区；不是通用设置中心。键：about.enabled、about.<locale>、about.images、site.organization。
- 服务：site-settings-model.ts / site-settings-admin.ts / site-settings-admin-deps.ts / site-settings.ts。只允许 ADMIN；事务行锁 + expectedVersion CAS，冲突 409；审计后使 site-settings 标签和 sitemap 失效，公开读取 revalidate 60 秒。about 是否可见还取决于开关、已发布语言和内容完整度。证据：prisma/schema.prisma:231；src/components/admin/settings/SettingsSections.tsx:6；src/lib/server/site-settings-admin.ts:114；src/lib/server/site-settings.ts:97；src/lib/server/site-settings-admin-deps.ts:11。
- 邮件配置从环境变量读取（src/lib/server/mail/config.ts）；/api/admin/mail/config 只返回 {sendingEnabled}。NEXT_PUBLIC_ADMIN_MAIL=http 才开放后台邮件、webhook 与 mail cron；关闭时先返回 404。
- deploy/cron.nbshiyan 按服务器本地时间每天 03:00 调 cleanup-uploads、04:30 备份；凭证在容器内读取。cleanup 支持 GET/POST、CRON_SECRET、advisory lock、dry run、总截止时间与分批上限。
- **已有 mail-queue 路由，但本 cron 模板没有调用它。** 未检查其他外部调度器，不能据此声称线上完全未调度。
- 当前无 Job 模型、/admin/jobs 页面或 /api/admin/jobs 路由。model process 是请求内 await processModel，写 PROCESSING → READY/FAILED；不是已存在的通用后台作业系统。

## 数据与 schema 应用事实

- PostgreSQL 业务模型：User、Contact、Inquiry、InquiryItem、InquiryMessage、InquiryNote、SampleRequest、SharedDesign、Model3D、SiteSetting、AuditLog、LogoUpload、PublicAsset、CategorySpec、MailMessage。产品/文章内容由 Sanity 读取，未配置时部分页面有仓库静态内容回退；不能把全部内容误写为 Prisma 表。
- 当前无 prisma/migrations。deploy/deploy.sh 执行备份 → migrate diff --script → plan-check 破坏性变更闸门 → db push --skip-generate → migrate diff --exit-code → 启动与冒烟；不加 --accept-data-loss。prisma/sql/*.sql 是参考文件，deploy 镜像不复制、不执行。证据：deploy/README.md:58；deploy/deploy.sh:94；Dockerfile:82。
- 本报告未选择新迁移框架、未执行 schema 变更。

## 产品、3D 与同意控件实际落点

- 产品目录：src/app/[locale]/products/page.tsx → src/lib/catalog/catalog.ts → published-models.ts / src/data/products.ts；品类源 src/data/categories.ts。
- 3D：src/components/three/ProductGallery.tsx 管激活、500ms 悬停缩放、视口懒加载、poster 回退与 closed/open/dieline 按钮；GalleryScene.tsx 管单 Canvas / View / OrbitControls（禁平移、按卡片激活缩放）；ProductModel.tsx 管 GLB / LOD / 动画，FoldBox.tsx 是程序化演示回退。关键引用：src/components/three/ProductGallery.tsx:14；src/components/three/ProductGallery.tsx:16；src/components/three/GalleryScene.tsx:161；src/components/three/ProductModel.tsx:133；src/components/three/FoldBox.tsx:6。
- 后台模型：src/components/admin/models/ModelUpload.tsx、ModelPreview.tsx；服务 src/lib/server/model-service.ts 与 models.ts。
- 询盘：src/app/[locale]/contact/page.tsx、src/components/inquiry/InquiryWizard.tsx → POST /api/inquiries；报价列表在 src/components/quote/。
- 同意：CookieConsent.tsx、CookieSettingsLink.tsx、src/lib/consent.ts 与 src/lib/client/consent.ts；localStorage pj-consent v2 分 analytics/chat；useTawk.ts 需要配置、聊天同意及交互/空闲条件，后台不加载；WebVitals.tsx 受统计同意控制。

## 明确未接完的当前事实

- src/app/[locale]/s/[id]/page.tsx:24 明写占位页；有效设计只展示标题、productSlug 与分类链接，3D 预览尚待前端接入。
- src/app/[locale]/products/[slug]/page.tsx:37 当前只是面包屑 JSON-LD、品类标题、3D 目录链接，不能写成已完成丰富详情页。
- 预留语言、权限前缀、已有 API、测试文件存在，都不能替代真实页面/调度/操作链完成证据。哪些待开发事项属于本轮，由 S1 与后续任务契约决定，本报告不替架构师选方案。

## 验证入口（仅盘点，均未执行）

- package.json：pnpm install --frozen-lockfile；pnpm test；pnpm build；pnpm lint；pnpm test:e2e；pnpm smoke --base <测试源站>；pnpm seo:audit。
- .github/workflows/ci.yml：依赖审计、模型大小/引用、check-admin-guard、pnpm test、build、显式 standalone 启动测试、Lighthouse；另有 PostgreSQL 17 的 Chromium E2E job。当前 CI **没有运行 pnpm lint**；声明的 next lint 链在本任务未验证。
- 单测 148 文件，E2E 12 文件（完整名字在 JSON）。E2E 使用专用 DATABASE_URL、先 db push 和 build，e2e/global-setup.ts 会创建测试管理员；playwright.config.ts 固定单 worker、0 重试、Chromium、3100（可 E2E_PORT 覆盖）以及 3999 Turnstile mock。
- 条件 DB 测试：cleanup-lock.db.test.ts / last-admin.db.test.ts 无 DATABASE_URL 会跳过；admin-reset-initial-password.db.test.ts 只认 ADMIN_RESET_TEST_DATABASE_URL。standalone-start.test.ts 需构建后显式 STANDALONE_TEST=1。不能把带跳过的总测试绿灯当 DB 实证。
- deploy/tests/*.test.sh 共 9 文件；入口由 bash 执行。Lighthouse 当前只测 /en、/en/products，3 次，LCP≤2000ms、CLS≤0.1、performance≥0.9。

报告仅建立可引用的现状路径和命令；未修改业务、AGENTS 手册或正式文档。
