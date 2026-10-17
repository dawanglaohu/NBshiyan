# PackJoyU 上线手册（launch runbook）

代码和 `.env.example` 里引用的 `launch-runbook.md` 就是这份。只写流程和约束，**不写任何真实连接串、密钥、主机名或账号**；这些只放在 Vercel / Cloudflare / Upstash 等平台的环境变量里，由 Ryan 本人配置。基础设施方案见 #74。

## 1. 部署顺序（硬性）

1. **先** 对生产库执行 `prisma db push`，**再** 部署代码。顺序反过来的话，新代码读不到新列（例如登录缺 `User.lastLoginAt` 会报 Prisma P2022）。
2. 生产库的 `db push` **只能是新增（additive-only）**：只加可为空的列、新表、新枚举、新索引。
   - 仓库用 `db push`，没有 migrations 目录。只能 Ryan 本人或部署流水线连生产库，其他人一律不连。
   - 执行前先看清 `db push` 打印的变更列表。出现任何删除列/表、改类型、加 NOT NULL 无默认值的提示，**立即停下**，不要加 `--accept-data-loss`，单独评审。
3. db push 完成后确认新增的结构都已存在，再部署代码。例如本次上线需要：
   - `User.lastLoginAt`、`User.reactivatedAt`
   - `Contact.normalizedEmail`（及其索引）、`Inquiry.anonymizedAt`（及 `[retainUntil, anonymizedAt]` 索引）
   - 新表 `CategorySpec`、枚举 `Incoterm`
   - [ ] **上线前检查项**：在首次生产部署前，用 `prisma db push` 的输出（或 `\d "Inquiry"`）逐项确认 `Inquiry.anonymizedAt`、`[retainUntil, anonymizedAt]` 索引以及上面列出的其他新列/表都已存在。缺 `anonymizedAt` 时到期匿名化、回信/改状态的 409 检查都会报 P2022。
4. 部署后跑一次 `scripts/backfill-normalized-email.ts`（隐私/retention 依赖规范化邮箱）。

## 2. 回滚：只回滚代码

1. **Vercel 立即回滚**：Vercel → Deployments → 上一个正常的部署 → Instant Rollback（Ryan 操作）。
2. **代码回滚**：`git revert -m 1 <合并提交>`，普通 push，再开 PR 走正常流程。不 force push，不改 main 的历史。
3. **数据库不回滚**：新加的列、索引、表都**保留，不要删**（全部可空或独立表，旧代码不读它们）。
   - ⚠️ **永远不要用旧 schema 再跑 `prisma db push`。** 演练确认：那样会 DROP `Contact.normalizedEmail`、`Inquiry.anonymizedAt`、`User.lastLoginAt`/`reactivatedAt`、`CategorySpec` 表和 `Incoterm` 枚举，数据丢失。真要回退 schema，先备份，再单独评审。
4. **停掉 cron**：最快的是在 Vercel 里删掉或换掉 `CRON_SECRET`，cron 请求会全部 401（代码已验证：没有密钥就一律 401）；或者在 `vercel.json` 里去掉 `crons`，走 PR 重新部署。
5. **按功能单独关闭**（代码里有的开关）：
   - IndexNow：推送失败不影响发布，**不用做任何处理**。
   - FAQ JSON-LD：`NEXT_PUBLIC_FAQ_JSONLD_ENABLED` 不设成 `true` 就是关的。
   - 品类页进 sitemap：代码常量 `CATEGORY_PAGES_LIVE`，改了要走 PR。
   - 保留期限：调大 `INQUIRY_RETAIN_DAYS` 等变量只影响**之后新写入**的 `retainUntil`；已有的询盘要停止匿名化，只能停 cron。
   - 闲置账号停用：可以调大 `ADMIN_INACTIVE_DAYS`（最大 3650），或者停 cron；被误停用的账号由 ADMIN 用 `PATCH /api/admin/users/:id {"disabled": false}` 重新启用。
   - 后台、限流、Turnstile、隐私接口：**代码里没有单独的关闭开关**（待确认是否需要）。

## 3. 每一步之后的验证

所有 PR 都要 CI 全绿（单元测试 `node --import tsx --test`、tsc、lint、build、e2e；具体有哪些检查以 PR 页面为准），没过的不合并。功能冒烟（在 Preview 或正式环境）：

| 功能 | 怎么验证 |
|---|---|
| #171 邮件 | 提交一次测试询价：业务邮箱收到通知，客户收到自动回复（英文和俄语各一次），邮件里的链接是正式域名 |
| #219 规格 | `GET /api/specs/<category>?locale=en` 返回 200，带 `Cache-Control: public, s-maxage=3600, stale-while-revalidate=600`；不存在的品类返回 404 |
| 后台鉴权（admin-specs-page / layout-guard / #95） | 没登录：后台接口 401 `unauthorized`，页面跳到登录页。停用的账号：403 `account_disabled`（页面 404）。角色不对：403 `forbidden`（页面 404）。SALES 打开 `/admin/specs` 被拒 |
| #95 账号管理 | 停用、降级最后一个 ADMIN 返回 409 `last_admin`；停用后对方旧会话立刻失效；列表显示最近登录时间 |
| #139 | 同一邮箱 30 天内第二次申请样品：429 `{"error":"sample_recent"}`，**不带 `Retry-After`**；同一 IP 超过 3 次：429 带 `Retry-After`；SALES 查看没分配给自己的地址：404，审计里有 `sample.address.denied`，ip 不是空的 |
| /s/<id> | 正常方案 200，过期 410；数据库不可用时 503 带 `Retry-After`（只在 Preview 环境模拟） |
| #200 隐私导出/删除 | ADMIN `POST /api/admin/privacy/export`：200，是附件，`no-store`；delete 时两个邮箱不一致 400 `confirm_mismatch`；生产缺 `PRIVACY_HASH_SECRET` 时 503。审计里只有邮箱的哈希 |
| retention cron | 正在跑的时候再触发一次应返回 409 `cleanup_running`（试运行也一样）。`curl -H "Authorization: Bearer $CRON_SECRET" https://<域名>/api/admin/cron/cleanup-uploads` 返回各步骤的条数（designs、deleted、sampleCounters、inquiries、inactiveUsers、auditLogs），没带密钥返回 401。**第一次真正清理之前先试运行**：Ryan 在 Vercel 设 `RETENTION_DRY_RUN=1`，触发一次 cron，核对返回的各项条数（designs、orphanLogos、sampleCounters、auditLogs、inquiries、inquiryLogos、inactiveUsers、skippedLastAdmin），确认合理后**删掉这个变量**，之后的 cron 才会真正清理 |
| Sanity webhook | 在 Sanity 发布一篇文章：页面刷新了，webhook 返回 200（不是 401 或 503）；签名错误时拒绝 |
| sitemap / noindex | 生产（`APP_ENV=production`）下 `/sitemap.xml` 是 200、`/robots.txt` 不屏蔽前台页面；Preview 是 noindex。品类页由代码常量 `CATEGORY_PAGES_LIVE`（#198）控制，没打开前 sitemap 里不应该有品类页 |
| 隐私页 | `/en/privacy`、`/ru/privacy` 返回 200；还是草稿的时候带 noindex、不进 sitemap |
| IndexNow / #192 | 发布后只推本站的地址；JSON-LD 里没有 `{{` 占位符，没有 offers 或价格 |
| Sanity 导入（#188 合并后，由 SEO 做） | 在已合并 #188 的分支上（#205 合并后的 main 或集成分支）：1）`python3 docs/content/sanity-import/linkmap.py`；2）`python3 docs/content/sanity-import/build.py`，输出应为「wrote 14 docs (0 kept)」，不能出现“keeping … committed product docs”的警告；3）检查 `import.ndjson` 和 `internal-links.*` 的改动只来自 #188 正文和 categoryMeta 的已知改动，然后普通提交；4）`node --import tsx --test tests/sanity-import.test.ts` 必须通过（重新生成的文件和已提交的逐字节一致）。之后才往 Sanity 导入 |

## 4. 环境变量

「Ryan」= Ryan 提供的密钥或账号信息，只在 Vercel 里配，不写进仓库、PR 或群聊。

| 变量 | 用途 | 默认值 | 生产必填 | 谁提供 |
|---|---|---|---|---|
| DATABASE_URL | Postgres（带 sslmode=require） | — | 是 | **Ryan** |
| AUTH_SECRET | Auth.js 会话签名 | — | 是 | **Ryan**（随机生成） |
| AUTH_URL | 正式域名 | — | 是 | Ryan |
| APP_ORIGIN | 后台 Origin 校验用的对外域名 | 空 | 否 | — |
| ADMIN_TOTP_KEY | 2FA 密钥加密（设好以后不要换） | — | 是 | **Ryan** |
| ADMIN_ALERT_EMAIL | 后台告警（发信失败、定时任务失败、账号锁定）的收件人；同类告警 30 分钟最多 1 封 | 没设就发给 `INQUIRY_NOTIFY_EMAIL` | 否 | 由 Ryan 提供 |
| ADMIN_SEED_EMAIL / _NAME / _PASSWORD / _ROLE | 初始化管理员的脚本 | — | 只在初始化时用 | **Ryan**，自己私下操作 |
| ADMIN_SEED_TOTP_SECRET | 只在测试里用 | — | **生产不能设** | — |
| PROD_DATABASE_HOST | 让初始化脚本拒绝连生产库 | — | 待确认 | Ryan |
| CRON_SECRET | 定时任务鉴权 | 没设的话 cron 一律 401 | 是 | **Ryan** |
| MIDDLEWARE_PROBE_SECRET | middleware 探测短链状态，≥ 32 字节 | — | 是 | **Ryan** |
| EDGE_AUTH_SECRET | nginx 用 `proxy_set_header X-Edge-Auth` 带上同一个值，头正确时才信任 CF-Connecting-IP；≥ 32 字节 | — | 是 | **Ryan**（值只给运维，不进群） |
| ~~BEHIND_CLOUDFLARE~~ / ~~TRUSTED_PROXY_HOPS~~ | 已废弃，不再读取 | — | 不要设 | — |
| RATE_LIMIT_STORE | `upstash` | memory | 是（必须是 upstash） | — |
| UPSTASH_REDIS_REST_URL / _TOKEN | 限流存储 | — | 是 | **Ryan** |
| STORAGE_DRIVER | `r2` | local | 是 | — |
| R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET | 私有存储 | — | 是 | **Ryan** |
| R2_ENDPOINT | 留空（由账号 ID 推出来） | 推导值 | 否 | — |
| UPLOAD_DIR | 只有 local 驱动用 | — | 否 | — |
| SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS | 发邮件（Gmail SMTP，465 或 587；SMTP_PASS 为 Gmail 应用专用密码） | — | 是 | **Ryan** |
| MAIL_FROM | 发件人 | — | 是 | Ryan |
| INQUIRY_NOTIFY_EMAIL | 询盘通知收件人 | — | 是 | Ryan |
| REPLY_DOMAIN | 客户回信的域名 | — | 否 | Ryan |
| CONTACT_EMAIL | 邮件模板里的对外联系邮箱 | 空；**要和 CONTACT_WHATSAPP 都设了**，邮件才会显示联系方式那一块 | 否（建议填） | 由 Ryan 提供 |
| CONTACT_WHATSAPP | 邮件模板里的 WhatsApp 号码（国际格式） | 空；规则同上 | 否（建议填） | 由 Ryan 提供 |
| CONTACT_REPLY_TIME | 邮件里承诺的回复时间，单位是小时（`24` 或 `24h`，有效范围 1–720） | **没有默认值**（`0285be3` 起）：没设或无效时，客户确认邮件不写回复时长那句，改用中性说法 | 否 | 由 Ryan 决定（问卷 Q16） |
| NEXT_PUBLIC_SITE_URL | canonical、hreflang、sitemap、OG、邮件里的链接；**必须是生产环境的 https 正式域名** | — | 是 | Ryan |
| NEXT_PUBLIC_TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY | 人机验证（生产不能用测试密钥） | — | 是 | **Ryan** |
| TURNSTILE_VERIFY_URL | 只在测试里用；生产会被忽略 | — | 否 | — |
| NEXT_PUBLIC_TAWK_PROPERTY_ID / _WIDGET_ID / _WIDGET_ID_RU | 在线客服 | — | 待确认 | Ryan |
| NEXT_PUBLIC_ADMIN_API | 设成 `http`，否则后台用 mock 数据 | — | 是 | — |
| NEXT_PUBLIC_LOGO_UPLOAD_MOCK | 生产不设，或设成 0 | — | 不能开 | — |
| NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION / _YANDEX_ / _BING_ | 搜索引擎站点验证 | — | 待确认 | Ryan / SEO |
| NEXT_PUBLIC_FAQ_JSONLD_ENABLED | 设成 `true` 才输出 FAQ 的 JSON-LD | 关闭 | 否（**上线时先不开**，FAQ 定稿后再开） | — |
| CATALOG_STRICT_API | 设成 `1`：数据库里没有已上架的模型时，产品页显示空状态 | 没设时退回到本地目录 `src/data/products.ts`（上线初期页面不会是空的）；读数据库失败时也一样退回 | 否 | 由 Ryan 提供（上线初期不设） |
| INDEXNOW_KEY | IndexNow 推送 | — | 是 | **Ryan 在 Vercel 里设** |
| SANITY_PROJECT_ID / SANITY_DATASET / SANITY_API_READ_TOKEN | CMS | — | 待确认 | **Ryan** |
| SANITY_WEBHOOK_SECRET | webhook 签名；**Ryan 在 Vercel 和 Sanity 两边各设一次，值相同**；旧的 Bearer token 作废 | 生产没设时拒绝请求 | 是 | **Ryan** |
| SANITY_REVALIDATE_SECRET | 旧的 Bearer token；`3094658` 合入后代码不再读它 | — | **要删掉**：`3094658` 部署成功、Sanity 改用签名之后，Ryan 删掉 Vercel 上的这个变量 | Ryan |
| PRIVACY_HASH_SECRET | 隐私审计里的邮箱哈希，≥ 32 字节 | 生产没设时 503 | 是 | **Ryan** |
| INQUIRY_RETAIN_DAYS | 询盘保留天数 | 730（30–3650） | 否 | 按隐私政策定 |
| AUDIT_RETAIN_DAYS | 审计日志保留天数 | 365（30–3650） | 否 | 同上 |
| DESIGN_TTL_DAYS / DESIGN_GRACE_DAYS | 方案有效期 / 过期后的宽限期 | 180 / 90 | 否 | 同上 |
| SAMPLE_COUNTER_RETAIN_DAYS | 样品申请的邮箱计数保留天数 | 30 | 否 | — |
| RETENTION_MAX_PER_RUN | 每次 cron 最多处理多少条 | 20000 | 否 | — |
| RETENTION_RUN_DEADLINE_MS | 整次定时清理共用的截止时间（毫秒，从开始算）；过了就不再开始新批次，后面的步骤跳过 | 270000（范围 10000–280000） | 否 | 平台时限 60s 时设 50000 |
| ~~RETENTION_STEP_BUDGET_MS~~ | 已废弃，代码不再读取；如果在 Vercel 上设过可以删掉 | — | 否 | — |
| RETENTION_DRY_RUN | 设成 `1`：cron 只返回各步骤的待处理条数，不写库、不删文件、不写审计 | 没设时正常清理 | 否（只在上线前试运行时临时设一次，用完删掉） | Ryan |
| ADMIN_INACTIVE_DAYS | 后台账号闲置多少天自动停用 | 90（7–3650） | 否 | — |
| SHORTLINK_PROBE_ORIGIN | middleware 探测短链状态（过期返回 410）时用的固定 origin，不用请求里的 Host | 没设时用 `NEXT_PUBLIC_SITE_URL`；两个都没设就不探测，直接放行 | 否 | 由 Ryan 提供（一般留空） |
| APP_ENV | 正式环境必须设为 `production`；预览/本地不设 | `production` | 必须手动设，未设一律按非生产（整站 noindex、关闭 IndexNow、跳过生产自检） | — |
| NODE_ENV / CI | 平台自动注入 | — | 不用手动设 | — |
| E2E_PORT, SEO_AUDIT_*, PREVIEW_*, REVIEWER_APP | 只在 CI 和脚本里用 | — | 否 | — |
| GitHub `vars.SECURITY_REVIEWER_APP` | 安全审查 bot 的 workflow 配置 | — | CI 用 | 待确认 |
| GitHub App 私钥 | 代码里没有引用，应该是在 bot 或 CI 那边配置 | — | 待确认 | **Ryan**，只能在私聊里给 |

## 5. 上线后步骤

**冒烟检查（`chore/smoke-script`，只读）**：上线后在任意一台机器上跑 `pnpm smoke --base https://<生产域名>`。隐私页的 noindex 常量关掉之后改用 `pnpm smoke --base https://<生产域名> --privacy-indexed`。
- 检查项：首页 200 且没有 noindex（meta robots 和 X-Robots-Tag）；`/en`、`/ru` 200，`lang` 正确，hreflang 有 en/ru/x-default 且同源；robots.txt 屏蔽 `/admin` 和 `/api/` 并写了 Sitemap；sitemap.xml 是合法 XML，所有地址都是同源绝对地址；`/admin` 跳到登录页且不返回后台内容；`/en/privacy`、`/ru/privacy` 200 且 noindex（404 会单独报出来）；Sanity webhook 不带签名的 POST 返回 401（返回 503 表示 `SANITY_WEBHOOK_SECRET` 没设）。
- 只发 GET/HEAD 和一个不带签名的 POST，不带任何密钥或 Cookie，只跟同源跳转。有任一 FAIL 时退出码为 1。

1. **SEO 线上检查**：对生产环境跑 `pnpm seo:audit`，**不要加 `--ignore-env-noindex`**。确认：
   - 首页（`/en`、`/ru`）没有 noindex（meta 和 `X-Robots-Tag` 都要看）；
   - `robots.txt` 屏蔽了 `/admin` 和 `/api/`，没有屏蔽全站；
   - `/sitemap.xml` 能打开。
2. **站长平台（Ryan 用自己的账号登录，在私聊里做，不在群里做）**：
   - **Google Search Console**：首选网域资源，用 DNS TXT 记录验证（验证后不要删记录）；也可以加一个网址前缀资源，用 `NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION` 验证。然后提交 `sitemap.xml`，确认状态是「成功」，再对关键页面做网址检查。
   - **Bing**：推荐从 GSC 导入，导入后自动算已验证、sitemap 也一起导入；也可以手动用 `NEXT_PUBLIC_BING_VERIFICATION` 验证，然后提交 sitemap。
   - **Yandex**：用 `NEXT_PUBLIC_YANDEX_VERIFICATION` 验证，然后提交 sitemap（步骤见 #209 的 `docs/yandex-webmaster-setup.md`）。
   - 详细步骤见 SEO 分支的 `docs/gsc-bing-setup.md` 和 `docs/launch-checklist.md` 第 6 节。
3. **打开隐私页**：Ryan 提供公司主体和联系邮箱后，前端单独开一个提交，把隐私页的代码常量 `PRIVACY_PAGE_COMPLETE`（`src/lib/legal/privacy.ts`，控制 noindex 和 sitemap）改成 `true`，然后走正常的 PR 流程。
4. **打开品类页**：品类页内容准备好后，单独开一个提交把 `CATEGORY_PAGES_LIVE`（#198）打开；合并后在 GSC 和 Bing 重新提交一次 sitemap。
5. **FAQ JSON-LD**：FAQ 里的事实 Ryan 确认之后，再把 `NEXT_PUBLIC_FAQ_JSONLD_ENABLED` 设成 `true`。

## 6. 定时清理的运行时长（Vercel 函数时限）

- 清理路由 `maxDuration = 300` 秒，持锁事务超时 290 秒。整次运行共用一个截止时间 `RETENTION_RUN_DEADLINE_MS`（默认 270 秒，最大 280 秒），开始时算一次，传给全部 6 个步骤。
- 实际行为：每个步骤只在开始新批次之前检查截止时间，已过就不再开始新批次，但正在执行的那一批会执行完，所以结束时间可能比截止时间晚一批的耗时（询盘匿名化一批估计最多十几秒）。截止时间后还没开始的步骤跳过，结果里有 `skipped`（被跳过的步骤）和 `deadlineReached: true`，并有一条 warn 日志；剩下的留给下一天。
- 锁事务和各步骤的工作事务是分开的。如果持锁事务撞到 290 秒超时，锁可能在最后一批还没做完时就释放，下一次触发可能和它重叠。可以接受：所有操作都是幂等的（按 id 删除并再带一次条件；清空字段重复执行结果一样；匿名化和停用在事务里重新确认状态）。最坏情况是同一账号多一条停用审计，或已作废的回信 token 被换两次。
- Vercel 时限（https://vercel.com/docs/functions/configuring-functions/duration ，2026-10-13 查）：开 Fluid compute（默认开）时 Hobby 默认和上限都是 300 秒，Pro/Enterprise 默认 300、上限 800 秒（beta 最长 1800 秒）。没开 Fluid compute 的旧项目时限更低（Hobby 最多 60 秒）。**待 Ryan 确认：套餐和 Fluid compute 是否开启。**
- 如果实际上限是 60 秒：在 Vercel 设 `RETENTION_RUN_DEADLINE_MS=50000`，并单独提一个提交把路由的 `maxDuration` 改成 60、`LOCK_TX_TIMEOUT_MS` 改成 55000（锁事务超时要大于截止时间、小于 maxDuration）。
- 实测（本机开发库，5000 条到期询盘，每条带产品配置、备注、邮件、logo）：每批 500 条 1.4–1.7 秒（中位 1.6 秒），约 3.1 毫秒/条。生产库在远端，每条有 2 次逐行更新，网络往返多，预计慢 5–10 倍（每批约 8–16 秒），所以靠整次运行的截止时间兜底，没跑完的留给下一天。积压很多时先用 `RETENTION_DRY_RUN=1` 看条数。
- 两次清理同时触发：第二次返回 409 `cleanup_running`，属正常。

## 7. 个人数据删除请求（手动步骤）

收到客户的删除请求时，除了后台 `POST /api/admin/privacy/delete`（数据库记录立即删除或匿名化）之外，还要做：
1. **通知收件箱**：在 `INQUIRY_NOTIFY_EMAIL` 指向的收件箱里，按客户邮箱（和询盘编号 PJ-…）搜索，删除所有匹配的询盘通知邮件和往来邮件，并清空“已删除”文件夹。**必须在收到请求后 30 天内完成**（隐私页已承诺）。完成后在内部记录里写日期和处理人，不写客户邮箱明文。
2. **Resend 日志**：Resend 后台保存的发信记录按 Resend 自己的保留期限过期，我们不手动删除；隐私页写的是“按服务商各自的保留期限删除”。
3. 其他服务商日志（Vercel 请求日志等）同样按服务商保留期限处理。

## 8. 安全规则（长期有效）

- **客户回信（inbound reply）**：以后新增的任何客户回信处理接口，**必须**用 `findInquiryForReply`（`src/lib/server/privacy.ts`）按 token 查找询盘，它会拒绝已匿名化的询盘；**绝不能**对 `anonymizedAt` 不为空的询盘做任何写入（新增往来邮件、改状态、存附件等）。目前还没有这个接口；新增的 PR 属于安全路径，全栈和 `packjoyu-security-reviewer[bot]` 审查时要核对这两条。
