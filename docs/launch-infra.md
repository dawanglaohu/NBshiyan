# 上线基础设施方案（Refs #74）

对应 PRD 第 11 节上线前清单。**以下所有涉及账号登录、付费、域名、密钥生成的步骤都必须由 Ryan 本人在自己的账号里完成**，我们（bot）不登录、不代管任何账号；需要协助时请在与“全栈工程师/安全工程师”的 1:1 私聊里进行，不在群里传密钥。

密钥只填进 Vercel 环境变量（Production / Preview 分开），不要提交到仓库，不要发到群里。

---

## 0. 总顺序（Ryan 操作）

1. 确定正式域名和询盘邮箱（见第 6 节）
2. Cloudflare R2：建私有桶 + 只限该桶的 API Token（第 1 节）
3. Upstash Redis：建数据库，拿 REST URL/Token（第 2 节）
4. 数据库（Postgres，如 Neon / Supabase / Vercel Postgres）：拿 `DATABASE_URL`
5. 发信：Gmail SMTP，Ryan 在自己的 Gmail 账号里开应用专用密码（第 3 节）
6. Cloudflare Turnstile：建正式站点，拿 site key / secret
7. Tawk.to：拿 property ID / widget ID（英、俄）
8. Vercel：导入仓库 dawanglaohu/NBshiyan，按第 4 节填全部环境变量，绑定域名
9. Cron（第 5 节）
10. 上线后：GSC / Yandex Webmaster / Bing 验证并提交 sitemap（第 6 节）
11. 管理员账号：`pnpm admin:create` 创建首个管理员并绑定 2FA（第 7 节）

---

## 1. Cloudflare R2（私有文件存储：Logo、模型源文件）

代码：`src/lib/server/storage.ts`（#110 的 `S3Storage`，SigV4 签名，`If-None-Match: *` 防覆盖，`assertKey` 校验路径）。

Ryan 操作：
1. 登录 Cloudflare → R2 → Create bucket，名字如 `packjoyu-private`，区域 Automatic。
2. **不要**打开 Public access / r2.dev 子域名 / 自定义公开域名。文件只通过后台鉴权接口读出。
3. R2 → Manage R2 API Tokens → Create API Token：
   - 权限：**Object Read & Write**（不要选 Admin）
   - 作用范围：**Apply to specific buckets only** → 只选上面这个桶
   - TTL 可不设；IP 限制不设（Vercel 出口 IP 不固定）
4. 记下 Access Key ID、Secret Access Key、Account ID（只显示一次）。
5. 目前**不**配置生命周期规则：Logo 上传的对象 key 没有 `tmp/` 之类的前缀，按前缀的规则匹配不到任何文件。未绑定询盘的孤儿文件由定时任务 `/api/admin/cron/cleanup-uploads` 清理（见下文 Cron 一节）。以后如需桶级兜底，可先改代码让未绑定的上传写到单独前缀，再对该前缀加规则。

环境变量：`STORAGE_DRIVER=r2`、`R2_ACCOUNT_ID`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`、`R2_BUCKET`，`R2_ENDPOINT` 留空（默认 `https://<account>.r2.cloudflarestorage.com`）。

## 2. Upstash Redis（多实例共享限流）

代码：`src/lib/server/ratelimit/index.ts`（#110 的 `UpstashStore`：INCR + PEXPIRE NX，1.5 秒超时，连不上时退回单实例内存计数）。

Ryan 操作：
1. 登录 upstash.com → Redis → Create Database，Region 选离 Vercel 函数区域最近的（默认 iad1 → us-east-1），开启 TLS（默认）。
2. 详情页 REST API 区域复制 `UPSTASH_REDIS_REST_URL` 和 `UPSTASH_REDIS_REST_TOKEN`（用完整权限 token，**不要**用 read-only token，限流需要写）。
3. 免费额度足够；可设每日请求上限防止被刷爆账单。

环境变量：`RATE_LIMIT_STORE=upstash`、`UPSTASH_REDIS_REST_URL`、`UPSTASH_REDIS_REST_TOKEN`。

## 3. 发信：Gmail SMTP（询盘通知、自动回复）

Ryan 已确认：

1. **发信**用免费 Gmail SMTP：From = Ryan 的 Gmail 地址，Reply-To = geiom.com 地址。Ryan 在自己的 Google 账号里开两步验证并生成应用专用密码，只填进部署环境变量；不提交到仓库，不发到群里，任何文档里都不写。
2. **收信**仍走 Cloudflare Email Routing，MX 不改。
3. **DNS**：信从 gmail.com 发出，geiom.com 的 SPF / DKIM / DMARC 不参与外发校验，所以不为发信新增 SPF `include:` 或 DKIM；现有 SPF `v=spf1 include:_spf.mx.cloudflare.net ~all` 保持。DMARC：上线时新增 `_dmarc` `p=none`，放进运维 DNS 批次，只新增不改现有记录，安全+运维共审。不用 `p=quarantine`。
4. 代码现状：`src/lib/server/mail.ts` 仍按 Resend 接口发信（`RESEND_API_KEY`），改成 SMTP 由后端另开 PR，SMTP 相关变量名在那个 PR 里定。

## 4. Vercel 项目与环境变量清单

Ryan 操作：Vercel → Add New Project → 导入 GitHub 仓库 → Framework 自动识别 Next.js → Settings → Environment Variables 逐条添加。Production 填正式值；Preview 用测试值（Turnstile 测试密钥、`STORAGE_DRIVER=local` 或单独的预览桶、单独的数据库）。

生成随机密钥：`openssl rand -base64 32`（在 Ryan 自己电脑上运行）。

### 4.1 后端 / 安全

| 变量 | 生产值 | 说明 |
|---|---|---|
| `DATABASE_URL` | Postgres 连接串（带 `sslmode=require`） | 必填 |
| `AUTH_SECRET` | `openssl rand -base64 32` | Auth.js 会话签名，必填 |
| `PRIVACY_HASH_SECRET` | `openssl rand -base64 32`（≥ 32 字节） | 隐私导出/删除审计里的邮箱 HMAC 密钥，必填；未设置时 `/api/admin/privacy/*` 返回 503。不要随 AUTH_SECRET 一起轮换 |
| `AUTH_URL` | `https://<正式域名>` | 必填 |
| `APP_ORIGIN` | 通常留空；有反向代理/对外域名与请求 origin 不一致时填 `https://<正式域名>` | 后台 Origin 校验 |
| `ADMIN_TOTP_KEY` | `openssl rand -base64 32`（32 字节 base64） | 2FA 密钥加密；**设置后不要更换**，换了已绑定的 2FA 全部失效 |
| `CRON_SECRET` | `openssl rand -base64 32` | 定时任务鉴权，见第 5 节 |
| `MIDDLEWARE_PROBE_SECRET` | `openssl rand -base64 32`（≥ 32 字节） | middleware 探测短链状态（`HEAD /api/designs/:id`）时带在 `x-internal-probe` 头里，服务端据此信任 `x-probe-client-ip` 做分桶限流；不配置则探测按连接 IP 限流 |
| `EDGE_AUTH_SECRET` | `openssl rand -hex 32`（≥ 32 字节） | geiom.com（Cloudflare → nginx → Next）取客户端 IP 用，**生产必填，只在运行时设**（`next build` 不需要也不检查；`next start` 时缺了拒绝启动；middleware 和 API 都在运行时读取，不会内联进构建产物）。nginx 每个反代的 location 都要加 `proxy_set_header X-Edge-Auth "<同一个值>";`（会覆盖客户端自己带的同名头）。只有这个头和密钥常量时间比较一致时才信任 `CF-Connecting-IP`（并校验是合法 IP）；没设、不足 32 字节、头不对或没带时，所有请求都按不可信来源进同一个 `untrusted` 限流桶，审计 ip 记 `unknown`。不读 `X-Real-IP` / `X-Forwarded-For`。值只放在服务器环境变量和 nginx 配置里，不要写进日志格式、不要提交、不要发群里 |
| ~~`BEHIND_CLOUDFLARE`~~ / ~~`TRUSTED_PROXY_HOPS`~~ | 不要再设 | 已废弃，代码不再读取（设了只会在日志里提示一次）。客户端 IP 只由 `EDGE_AUTH_SECRET` + `CF-Connecting-IP` 决定 |
| `RATE_LIMIT_STORE` | `upstash` | 生产必须，不能用 memory |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | 第 2 节 | |
| `STORAGE_DRIVER` | `r2` | 生产必须（Vercel 文件系统不持久） |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` | 第 1 节，桶级 token | |
| `R2_ENDPOINT` | 留空 | |
| `UPLOAD_DIR` | 留空（仅 local 驱动使用） | |

### 4.2 邮件

| 变量 | 生产值 | 说明 |
|---|---|---|
| `SMTP_HOST` | `smtp.gmail.com` | #74 §16：所有发信（询盘回复、自动回复、通知、告警）都走免费 Gmail SMTP（nodemailer），不再用 Resend |
| `SMTP_PORT` | `465`（隐式 TLS）或 `587`（STARTTLS，强制） | 只接受这两个端口；其他端口或 `NODE_TLS_REJECT_UNAUTHORIZED=0` 时发信关闭，生产配置自检报错 |
| `SMTP_USER` | 发信用的 Gmail 地址 | 值只由 Ryan 私信给运维放服务器环境变量 |
| `SMTP_PASS` | 该 Gmail 账号的应用专用密码（需开两步验证） | **只**放环境变量；不进仓库、日志、群聊 |
| `MAIL_FROM` | `PackJoyU <该 Gmail 地址>` | 必须是 Gmail 地址（或 Gmail 已验证的别名），**不能**是 `REPLY_DOMAIN` 的地址（SPF/DMARC 对不齐） |
| `REPLY_DOMAIN` | `geiom.com` | 询盘回复的 Reply-To 是 `reply+<token>@REPLY_DOMAIN`，Message-ID 也用这个域名；不配则后台「发送」不可用（`sendingEnabled:false`） |
| `MAIL_DAILY_CAP` | 默认 `450` | 询盘回复每日上限（免费 Gmail 约 500 封/天，余量留给自动回复和通知）；超出的信排队，下次重置后自动发送（`daily_cap_deferred`） |
| `MAIL_DAILY_CAP_RESET` | 默认 `00:00` | 每日上限的重置时间（UTC，HH:MM） |
| `MAIL_RATE_ADMIN_PER_HOUR` / `MAIL_RATE_GLOBAL_PER_HOUR` | 默认 `30` / `200` | 询盘回复按管理员 / 全站的每小时上限 |
| `MAIL_WEBHOOK_SECRET` | `openssl rand -base64 32`（≥ 32 字节） | **生产必填**：收信 webhook（`POST /api/mail/inbound-webhook`）的 HMAC 密钥，同一个值配到收信 Worker 的 Secret。生产缺失或少于 32 字节 → 配置自检拒绝启动（非生产不配则 webhook 返回 404）。不与其他密钥复用 |
| `MAIL_SEND_ADAPTER` | `smtp` | **生产必填且只能是 `smtp`**：未设置、`mock`、`log` 等任何其他值 → 配置自检拒绝启动。本地/预览可设 `mock`（不真的发信） |
| `NEXT_PUBLIC_ADMIN_MAIL` | 后端上线后设 `http` | 邮件开关（#303）：不是 `http` 时所有 `/api/admin/mail/*`、发信接口和收信 webhook 都返回 404 |
| `INQUIRY_NOTIFY_EMAIL` | Ryan 的询盘收件邮箱 | 待 Ryan 提供 |
| `siteUrl` → `NEXT_PUBLIC_SITE_URL` | `https://<正式域名>`（不带结尾 `/`） | 邮件里后台链接、canonical、OG 都用它，**不读请求 Host 头** |
| `replyTime` | 如 `24h` | #122 邮件模板变量，后端接入时在 `.env.example` 补正式变量名 |
| `contactEmail` | 对外联系邮箱 | 同上，待 Ryan 提供 |
| `whatsapp` | WhatsApp 号码（国际格式） | 同上，待 Ryan 提供 |

> **部署前提（收信，Q7）**：在 Ryan 批准 Q7、且收信 Worker 已上线并按契约签名（`X-Geiom-Timestamp` / `X-Geiom-Mail-Id` / `X-Geiom-Signature`，HMAC-SHA256，密钥为 `MAIL_WEBHOOK_SECRET`）**之前**，Cloudflare Email Routing **不得**切到 Worker，来信继续投递到现在的收件邮箱。
> 原因：webhook 对没有有效签名的请求一律返回 401。提前切换会让**每一封来信都被 401 拒收，邮件丢失**。
> 切换顺序：Ryan 批准 Q7 → 部署签名 Worker（Worker Secret 与应用的 `MAIL_WEBHOOK_SECRET` 是同一个值，只通过私信交给运维，不进群、不进仓库）→ 应用设好 `MAIL_WEBHOOK_SECRET` 和 `NEXT_PUBLIC_ADMIN_MAIL=http` → 用一封测试信确认 webhook 返回 200 并入库 → 最后才把 Email Routing 切到 Worker。任何一步失败就保持投递到现有邮箱。
> nginx：`location = /api/mail/inbound-webhook` 单独设 `client_max_body_size 36m`（webhook 上限 36,700,160 字节；全局 4m 不够）。

### 4.3 人机验证 / 客服

| 变量 | 生产值 |
|---|---|
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | Turnstile 正式 site key（Cloudflare → Turnstile → Add site，域名填正式域名） |
| `TURNSTILE_SECRET_KEY` | Turnstile 正式 secret；**生产不能用 `1x000…AA` 测试密钥** |
| `NEXT_PUBLIC_TAWK_PROPERTY_ID` | Tawk.to → Administration → Chat Widget 里的 property ID |
| `NEXT_PUBLIC_TAWK_WIDGET_ID` | 英文 widget ID |
| `NEXT_PUBLIC_TAWK_WIDGET_ID_RU` | 可选，俄语 widget ID |

### 4.4 前端

| 变量 | 生产值 | 说明 |
|---|---|---|
| `NEXT_PUBLIC_ADMIN_API` | `http` | **必填**，否则后台用 mock 数据 |
| `NEXT_PUBLIC_LOGO_UPLOAD_MOCK` | 不设置，或 `0` | 生产不能开 mock |

### 4.5 SEO（见 #74 中 SEO 的评论）

| 变量 | 生产值 |
|---|---|
| `NEXT_PUBLIC_SITE_URL` | `https://<正式域名>` |
| `NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION` | GSC HTML 标签里 `content` 的值 |
| `NEXT_PUBLIC_YANDEX_VERIFICATION` | Yandex Webmaster meta 标签 `content` 的值 |
| `NEXT_PUBLIC_BING_VERIFICATION` | Bing `msvalidate.01` 的值 |

### 4.6 Sanity（#100，接入时补）

`SANITY_API_READ_TOKEN`（Viewer 权限）、`SANITY_REVALIDATE_SECRET`（`openssl rand -base64 32`），以及 #100 新增的 project ID / dataset 变量。

### 4.7 建议：生产配置自检（后续单独 PR）

建议加一个 `scripts/check-prod-env.mjs`，在 `APP_ENV=production` 时于构建前运行，满足任一条件就让构建失败：
- 任何 `*_MOCK` 变量为真（如 `NEXT_PUBLIC_LOGO_UPLOAD_MOCK=1`）
- `NEXT_PUBLIC_ADMIN_API` 不等于 `http`
- `RATE_LIMIT_STORE` 不是 `upstash`、`STORAGE_DRIVER` 不是 `r2`
- `TURNSTILE_SECRET_KEY` 仍是测试密钥 `1x0000…`
- `AUTH_SECRET` / `ADMIN_TOTP_KEY` / `CRON_SECRET` 缺失或长度不足，`ADMIN_TOTP_KEY` 解码后不是 32 字节

## 5. 定时任务（Vercel Cron）

现有任务：`/api/admin/cron/cleanup-uploads` —— 删除 24 小时未绑定询盘的 Logo 上传。接口要求 `Authorization: Bearer $CRON_SECRET`，Vercel Cron 在设置了 `CRON_SECRET` 环境变量时会自动带上这个头。

需在仓库根目录加 `vercel.json`（单独小 PR，不需要账号操作）：

```json
{ "crons": [ { "path": "/api/admin/cron/cleanup-uploads", "schedule": "0 3 * * *" } ] }
```

- Hobby 套餐每天最多 1 次，Pro 可更频繁；每天一次已满足 24 小时保留要求。
- 验证：Vercel → Project → Settings → Cron Jobs 里能看到并可手动 Run；不带头访问应返回 401。
- 以后新增 cron（如样品申请/短链过期清理）同样走 `CRON_SECRET`。

## 6. 域名与搜索平台验证

Ryan 操作：
1. 购买/确定正式域名（PRD 待定）。DNS 建议放 Cloudflare。
2. Vercel → Project → Domains 添加 `<域名>` 和 `www.<域名>`（www 301 到主域）。按提示加 A/CNAME 记录。如果走 Cloudflare 代理（橙云），SSL 模式设为 Full (strict)，并设 `BEHIND_CLOUDFLARE=1`。
3. 更新 `NEXT_PUBLIC_SITE_URL` / `AUTH_URL` 为正式域名，重新部署。
4. **Google Search Console**：添加资源 → 网址前缀 → HTML 标记 → 复制 `content` 值填 `NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION` → 重新部署 → 点验证 → 提交 `https://<域名>/sitemap.xml`。（也可用 DNS TXT 的“网域”资源。）
5. **Yandex Webmaster**：添加站点 → Meta 标签 → 值填 `NEXT_PUBLIC_YANDEX_VERIFICATION` → 部署后验证 → 提交 sitemap；俄语市场重点平台。
6. **Bing Webmaster**：可直接从 GSC 导入；或 Meta 标签 `msvalidate.01` 值填 `NEXT_PUBLIC_BING_VERIFICATION` → 验证 → 提交 sitemap。
7. 非生产环境已全站 `X-Robots-Tag: noindex`，只有 `APP_ENV=production` 才允许收录。

## 7. 首个管理员

部署后由 Ryan 在自己电脑上，用生产 `DATABASE_URL` 执行 `pnpm admin:create`，登录后台立即绑定 2FA。之后可以从环境变量里移除不需要的临时值。

## 8. CSP 说明（Tawk.to 等第三方）

当前 `security-headers.ts` 已放行 Tawk.to 和 Turnstile 所需的最小范围，**无需再加**：

- `script-src`: `https://embed.tawk.to https://*.tawk.to https://challenges.cloudflare.com`
- `style-src`: `https://*.tawk.to`
- `font-src`: `https://*.tawk.to`
- `connect-src`: `https://*.tawk.to wss://*.tawk.to`
- `frame-src`: `https://*.tawk.to https://challenges.cloudflare.com`

R2 走服务器端签名请求（浏览器不直连），Upstash、Resend 只在服务器端调用，**都不需要加进 CSP**。`connect-src` 里现有的 `https://*.r2.dev` 在私有桶方案下用不到，后续可以去掉。Tawk.to 只在用户同意 Cookie 后加载。

## 9. 上线验收

- [ ] 询盘提交 → 收到通知邮件、客户收到自动回复（英/俄）
- [ ] 上传 Logo → R2 桶里出现对象，桶公开地址不可访问
- [ ] 连续错误登录触发限流，换一个实例（另一个区域请求）计数仍共享
- [ ] Cron 手动运行返回 200，不带密钥返回 401
- [ ] 后台登录需要 2FA；`NEXT_PUBLIC_ADMIN_API=http`，后台显示真实数据
- [ ] GSC / Yandex / Bing 验证通过，sitemap 已提交
- [ ] Lighthouse：桌面 < 2s，手机 < 3s

### 隐私 / 数据保留上线检查
- [ ] 已设置 `PRIVACY_HASH_SECRET`（≥ 32 字节，独立于 AUTH_SECRET）。
- [ ] 部署 #200 后运行一次 `pnpm tsx scripts/backfill-normalized-email.ts`（先 `--dry-run`），回填 Contact.normalizedEmail，否则旧联系人查不到。
- [ ] 保留天数与隐私政策对齐（见 docs/data-retention.md）。
