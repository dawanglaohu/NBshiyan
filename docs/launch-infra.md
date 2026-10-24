# 上线基础设施方案（Refs #74）

对应 PRD 第 11 节上线前清单。**以下所有涉及账号登录、付费、域名、密钥生成的步骤都必须由 Ryan 本人在自己的账号里完成**，我们（bot）不登录、不代管任何账号；需要协助时请在与“全栈工程师/安全工程师”的 1:1 私聊里进行，不在群里传密钥。

**部署方式（Ryan 已定）**：自建服务器。Docker 镜像在服务器上从公开仓库（固定到已合并的 commit SHA）构建，Next.js standalone 输出；本地 Postgres 容器，不开对外端口；上传文件存服务器本地磁盘（`STORAGE_DRIVER=local` + `UPLOAD_DIR` 挂载数据卷）。前面是 Cloudflare → nginx → app。

密钥只放进服务器上应用的环境文件（`env_file`，权限 600）或 compose secrets，在容器启动时注入；不进镜像、不在构建阶段注入，不要提交到仓库，不要发到群里。

---

## 0. 总顺序（Ryan 操作）

1. 确定正式域名和询盘邮箱（见第 6 节）
2. 上传文件存储：服务器本地磁盘的挂载数据卷（第 1 节）；Cloudflare R2 只作为可选驱动保留，当前不建桶
3. Upstash Redis：建数据库，拿 REST URL/Token（第 2 节）
4. 数据库：服务器上的 Postgres 容器（只在内部网络，不开对外端口），密码随机生成，`DATABASE_URL` 只放 app 的环境文件
5. 发信：Gmail SMTP，Ryan 在自己的 Gmail 账号里开应用专用密码（第 3 节）
6. Cloudflare Turnstile：建正式站点，拿 site key / secret
7. Tawk.to：拿 property ID / widget ID（英、俄）
8. 服务器部署：从公开仓库 dawanglaohu/NBshiyan 拉已合并的 commit，服务器上 `docker build`（构建只需要公开值），按第 4 节在运行时注入环境变量；Cloudflare DNS 指向服务器，nginx 反代并绑定域名
9. Cron（第 5 节）
10. 上线后：GSC / Yandex Webmaster / Bing 验证并提交 sitemap（第 6 节）
11. 管理员账号：`docker compose exec app node scripts/admin-create.mjs` 创建首个管理员并绑定 2FA（第 7 节）

---

## 1. 私有文件存储：服务器本地磁盘（Logo、模型源文件）

Ryan 已定：`STORAGE_DRIVER=local`，`UPLOAD_DIR` 指向挂载数据卷的绝对路径（属主为容器内应用用户 uid 1001，权限 700；容器 `read_only` 时这个卷单独挂成可写）。

- 代码：`src/lib/server/storage.ts` 的 `LocalStorage`：key 只能是服务端生成的随机 id（`png/webp/glb`），解析后必须在 `UPLOAD_DIR` 内，不跟随符号链接，写入前校验文件头与扩展名一致，文件 0600、目录 0700、不覆盖。
- 这个目录**不**经 nginx 或任何静态服务暴露。Logo、模型只经现有接口按权限提供；关于页图片见第 1.2 节。两类都由应用读出字节再返回（`src/lib/server/file-response.ts` 统一设 Content-Type、`nosniff`、`sandbox` CSP、`Content-Disposition`）。
- 启动时检查：`UPLOAD_DIR` 缺失、不是绝对路径、在 `public/`/`.next/` 下、不存在或不可写 → 拒绝启动。
- 备份：数据卷要和数据库备份放在同一时间点。`deploy/backup-postgres.sh` 只备份 Postgres，不含 `UPLOAD_DIR`；`UPLOAD_DIR`（含 `public-assets/`）是运维的单独步骤（第 1.2 节）。孤儿 Logo 由定时任务 `/api/admin/cron/cleanup-uploads` 清理（第 5 节）；`public-assets/` 不参与这次清理。

### 1.1 可选：Cloudflare R2（代码仍支持，当前不用）

以后如果改用 R2（`STORAGE_DRIVER=r2`），按下面配置。代码：`src/lib/server/storage.ts`（#110 的 `S3Storage`，SigV4 签名，`If-None-Match: *` 防覆盖，`assertKey` 校验路径）。

Ryan 操作：
1. 登录 Cloudflare → R2 → Create bucket，名字如 `packjoyu-private`，区域 Automatic。
2. **不要**打开 Public access / r2.dev 子域名 / 自定义公开域名。文件只通过后台鉴权接口读出。
3. R2 → Manage R2 API Tokens → Create API Token：
   - 权限：**Object Read & Write**（不要选 Admin）
   - 作用范围：**Apply to specific buckets only** → 只选上面这个桶
   - TTL 可不设；可按服务器出口地址限制（可选）
4. 记下 Access Key ID、Secret Access Key、Account ID（只显示一次）。
5. 目前**不**配置生命周期规则：Logo 上传的对象 key 没有 `tmp/` 之类的前缀，按前缀的规则匹配不到任何文件。未绑定询盘的孤儿文件由定时任务 `/api/admin/cron/cleanup-uploads` 清理（见下文 Cron 一节）。以后如需桶级兜底，可先改代码让未绑定的上传写到单独前缀，再对该前缀加规则。

环境变量：`STORAGE_DRIVER=r2`、`R2_ACCOUNT_ID`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`、`R2_BUCKET`，`R2_ENDPOINT` 留空（默认 `https://<account>.r2.cloudflarestorage.com`）。

### 1.2 关于页公开图片（PublicAsset，`/media/`）

关于页图片写在 `UPLOAD_DIR/public-assets/<年-月>/`。原图不保存。这些文件不参与 24 小时上传清理（`cleanup-uploads` 只删未绑定询盘的 Logo）。`deploy/backup-postgres.sh` 只备份 Postgres。`UPLOAD_DIR`（含 `public-assets/`）由运维按和数据库备份同一时间点单独备份，本仓库不把这一步写进该脚本。

应用对还在的 `/media/<id>-800.webp`、`/media/<id>-1600.webp` 下发 `Cache-Control: public, max-age=300, s-maxage=3600`（不加 `immutable`）：浏览器 5 分钟，共享缓存 1 小时。删除不清 Cloudflare 缓存，已缓存的副本会留到这一小时结束。不存在或已删除的名字是 `404`，`Cache-Control: no-store`。这一版之前发出的响应是 `public, max-age=31536000, immutable`。新版上线后，经 Ryan 批准，清一次 Cloudflare 上 `/media/` 前缀的边缘缓存。边缘上的旧副本会没掉；访客浏览器里已经缓存的旧副本收不回来。所以「删图后 1 小时内访问不到」只对这一版上线之后才被访问过的图成立。若 Cloudflare 给 `/media/` 单独配了 Edge TTL 或 Browser TTL，不得长于这个新头。改 Cloudflare 配置需 Ryan 批准。

nginx 必须把下面两个路径反代到应用。不能默认现有 vhost 已经配好。下面只用占位符。

```nginx
location = /api/admin/site-settings/assets {
    client_max_body_size 11m;   # 全局 4m 不够；应用单文件 10 MB，整个请求 10 MB + 64 KB，超出返回 413
    proxy_pass http://<应用上游>;
    proxy_set_header Host $host;
    proxy_set_header X-Edge-Auth "<与其他反代 location 相同的值>";
}
# ^~：带点路径的正则 404 不能先于 /media/*.webp 命中。不要把这个前缀当静态目录。
location ^~ /media/ {
    proxy_pass http://<应用上游>;
    proxy_set_header Host $host;
    proxy_set_header X-Edge-Auth "<与其他反代 location 相同的值>";
}
```

应用自己的带点路径 rewrite 已经跳过 `media` 前缀。nginx 仍要把 `/media/` 交给应用。用不存在的 id 核对：

```sh
curl -sI "https://<域名>/media/aaaaaaaaaaaaaaaaaaaaaaaa-800.webp"
```

应是应用的 404：`Cache-Control: no-store`，且 `Content-Security-Policy` 含 `sandbox`。没有这些头的静态 404 说明 location 没指到应用。

运维在服务器上核对后勾选：

- [ ] `location = /api/admin/site-settings/assets` 设了 `client_max_body_size 11m`
- [ ] `/media/` 反代到应用并带 `X-Edge-Auth`；不存在的 `/media/<24位id>-800.webp` 是应用的 404（`no-store`，CSP 含 `sandbox`）
- [ ] `UPLOAD_DIR`（含 `public-assets/`）已单独备份，不依赖 `backup-postgres.sh`
- [ ] Cloudflare 上 `/media/` 的 Edge TTL / Browser TTL 不长于新头（浏览器 5 分钟，边缘 1 小时，无 `immutable`）
- [ ] 新版上线后清一次 `/media/` 前缀的边缘缓存（需 Ryan 批准）

## 2. Upstash Redis（多实例共享限流）

代码：`src/lib/server/ratelimit/index.ts`（#110 的 `UpstashStore`：INCR + PEXPIRE NX，1.5 秒超时，连不上时退回单实例内存计数）。

Ryan 操作：
1. 登录 upstash.com → Redis → Create Database，Region 选离服务器最近的区域，开启 TLS（默认）。
2. 详情页 REST API 区域复制 `UPSTASH_REDIS_REST_URL` 和 `UPSTASH_REDIS_REST_TOKEN`（用完整权限 token，**不要**用 read-only token，限流需要写）。
3. 免费额度足够；可设每日请求上限防止被刷爆账单。

环境变量：`RATE_LIMIT_STORE=upstash`、`UPSTASH_REDIS_REST_URL`、`UPSTASH_REDIS_REST_TOKEN`。

## 3. 发信：Gmail SMTP（询盘通知、自动回复）

Ryan 已确认：

1. **发信**用免费 Gmail SMTP：From = Ryan 的 Gmail 地址，Reply-To = geiom.com 地址。Ryan 在自己的 Google 账号里开两步验证并生成应用专用密码，只填进部署环境变量；不提交到仓库，不发到群里，任何文档里都不写。
2. **收信**仍走 Cloudflare Email Routing，MX 不改。
3. **DNS**：信从 gmail.com 发出，geiom.com 的 SPF / DKIM / DMARC 不参与外发校验，所以不为发信新增 SPF `include:` 或 DKIM；现有 SPF `v=spf1 include:_spf.mx.cloudflare.net ~all` 保持。DMARC：上线时新增 `_dmarc` `p=none`，放进运维 DNS 批次，只新增不改现有记录，安全+运维共审。不用 `p=quarantine`。
4. 代码现状：#315（#74）合并后，`src/lib/server/mail.ts` 通过 nodemailer 走 Gmail SMTP 发信，已不再使用 Resend，也不读 `RESEND_API_KEY`。发信变量是 `SMTP_HOST`、`SMTP_PORT`、`SMTP_USER`、`SMTP_PASS`、`MAIL_FROM`，生产还要设 `MAIL_SEND_ADAPTER=smtp`，详见 4.2。收信仍走 Cloudflare Email Routing。

## 4. 环境变量清单（自建服务器）

运行时变量放服务器上 app 的环境文件（权限 600），compose 在容器启动时注入；构建阶段只给 `APP_ENV`、`NODE_ENV` 和 `NEXT_PUBLIC_*` 公开值。本地 / 测试环境用测试值（Turnstile 测试密钥、`STORAGE_DRIVER=local`、单独的数据库）。

生成随机密钥：`openssl rand -base64 32`（在 Ryan 自己电脑上运行）。

### 4.1 后端 / 安全

| 变量 | 生产值 | 说明 |
|---|---|---|
| `DATABASE_URL` | Postgres 连接串（带 `sslmode=require`） | 必填 |
| `AUTH_SECRET` | `openssl rand -base64 32` | Auth.js 会话签名，必填 |
| `PRIVACY_HASH_SECRET` | `openssl rand -base64 32`（≥ 32 字节） | 隐私导出/删除审计里的邮箱 HMAC 密钥，必填；未设置时 `/api/admin/privacy/*` 返回 503。不要随 AUTH_SECRET 一起轮换 |
| `AUTH_URL` | `https://<正式域名>` | 必填 |
| `APP_ORIGIN` | **生产必填**：等于 `NEXT_PUBLIC_SITE_URL` 的 origin（`https://geiom.com`，裸 https origin，不带路径/查询/账号）；缺失或不一致时启动检查 exit 1（只报变量名）。standalone 下请求自身 origin 是 `http://0.0.0.0:<端口>`，不设会让后台改动请求 403 | 后台 Origin 校验 |
| `ADMIN_TOTP_KEY` | `openssl rand -base64 32`（32 字节 base64） | 2FA 密钥加密；**设置后不要更换**，换了已绑定的 2FA 全部失效 |
| `CRON_SECRET` | `openssl rand -base64 32` | 定时任务鉴权，见第 5 节 |
| `MIDDLEWARE_PROBE_SECRET` | `openssl rand -base64 32`（≥ 32 字节） | middleware 探测短链状态（`HEAD /api/designs/:id`）时带在 `x-internal-probe` 头里，服务端据此信任 `x-probe-client-ip` 做分桶限流；不配置则探测按连接 IP 限流 |
| `EDGE_AUTH_SECRET` | `openssl rand -hex 32`（≥ 32 字节） | geiom.com（Cloudflare → nginx → Next）取客户端 IP 用，**生产必填，只在运行时设**（`next build` 不需要也不检查；`next start` 时缺了拒绝启动；middleware 和 API 都在运行时读取，不会内联进构建产物）。nginx 每个反代的 location 都要加 `proxy_set_header X-Edge-Auth "<同一个值>";`（会覆盖客户端自己带的同名头）。只有这个头和密钥常量时间比较一致时才信任 `CF-Connecting-IP`（并校验是合法 IP）；没设、不足 32 字节、头不对或没带时，所有请求都按不可信来源进同一个 `untrusted` 限流桶，审计 ip 记 `unknown`。不读 `X-Real-IP` / `X-Forwarded-For`。值只放在服务器环境变量和 nginx 配置里，不要写进日志格式、不要提交、不要发群里 |
| ~~`BEHIND_CLOUDFLARE`~~ / ~~`TRUSTED_PROXY_HOPS`~~ | 不要再设 | 已废弃，代码不再读取（设了只会在日志里提示一次）。客户端 IP 只由 `EDGE_AUTH_SECRET` + `CF-Connecting-IP` 决定 |
| `RATE_LIMIT_STORE` | `upstash` | 生产必须，不能用 memory |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | 第 2 节 | |
| `STORAGE_DRIVER` | `local`（Ryan 已定） | 生产必须显式设置。`local`：文件放服务器挂载数据卷（配 `UPLOAD_DIR`，第 1 节）；`r2` 只是代码仍支持的可选驱动（第 1.1 节） |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` | 不设 | 仅可选的 `STORAGE_DRIVER=r2` 时必填（第 1.1 节） |
| `R2_ENDPOINT` | 留空 | |
| `UPLOAD_DIR` | 挂载数据卷的绝对路径 | 仅 `STORAGE_DRIVER=local` 时必填：绝对路径、存在且应用用户可读写、不在 `public/` 或 `.next/` 下，否则拒绝启动。不对外静态服务。Logo 和模型只经现有接口按权限提供；关于页图片在其下 `public-assets/`，由应用的 `/media/` 公开读出，见第 1.2 节 |

> 自建 standalone：`next build` 只需要 `APP_ENV`、`NODE_ENV` 和 `NEXT_PUBLIC_*` 公开值，不需要任何密钥；上表其余变量只在容器启动时注入，`src/instrumentation.ts` 启动时检查，缺了 exit 1（只报变量名）。健康检查：`GET /api/health`（见 launch-runbook.md 第 4.2 节）。

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

`SANITY_API_READ_TOKEN`（Viewer 权限）、`SANITY_WEBHOOK_SECRET`（`openssl rand -base64 32`，同时填进 Sanity webhook 的 Secret），以及 #100 新增的 project ID / dataset 变量。

部署签名校验版本时同步更新应用与 Sanity 的 Secret，验证 webhook 返回 200 后再清理旧 `SANITY_REVALIDATE_SECRET`。配置步骤见 [上线清单：Sanity webhook 签名迁移](./launch-checklist.md#8-sanity-webhook-签名迁移)。

### 4.7 建议：生产配置自检（后续单独 PR）

建议加一个 `scripts/check-prod-env.mjs`，在 `APP_ENV=production` 时于构建前运行，满足任一条件就让构建失败：
- 任何 `*_MOCK` 变量为真（如 `NEXT_PUBLIC_LOGO_UPLOAD_MOCK=1`）
- `NEXT_PUBLIC_ADMIN_API` 不等于 `http`
- `RATE_LIMIT_STORE` 不是 `upstash`；`STORAGE_DRIVER` 不是 `local` / `r2`（local 时 `UPLOAD_DIR` 不是可写的绝对路径）
- `TURNSTILE_SECRET_KEY` 仍是测试密钥 `1x0000…`
- `AUTH_SECRET` / `ADMIN_TOTP_KEY` / `CRON_SECRET` 缺失或长度不足，`ADMIN_TOTP_KEY` 解码后不是 32 字节

## 5. 定时任务（服务器上的 cron）

现有任务：`/api/admin/cron/cleanup-uploads` —— 删除 24 小时未绑定询盘的 Logo 上传，以及数据保留期清理。接口要求 `Authorization: Bearer $CRON_SECRET`。

自建部署不读 `vercel.json` 的 `crons`（文件保留，只对 Vercel 生效）。在服务器上用 crontab 或 systemd timer 每天 03:00 UTC 调一次，直接请求容器内地址（不经过 nginx），例如：

```
curl -fsS --max-time 330 -X POST -H @<只有 root 可读的文件，内容是 Authorization 头> http://localhost:3000/api/admin/cron/cleanup-uploads
```

- 密钥放在只有 root 可读的文件里，用 `-H @文件` 读入，不写进命令行参数（会出现在进程列表里）或 crontab 正文。
- 每天一次已满足 24 小时保留要求。
- 验证：手动执行一次返回 200 和各步骤条数；不带头访问返回 401。运行时长见 launch-runbook.md 第 6 节。
- 以后新增 cron（如样品申请/短链过期清理）同样走 `CRON_SECRET`。

## 6. 域名与搜索平台验证

Ryan 操作：
1. 购买/确定正式域名（PRD 待定）。DNS 建议放 Cloudflare。
2. Cloudflare DNS 把 `<域名>` 和 `www.<域名>` 指向服务器（橙云代理，SSL 模式 Full (strict)）；nginx 做 www → 主域、http → https 的 301。客户端 IP 由 `EDGE_AUTH_SECRET` + nginx 的 `X-Edge-Auth` 头决定（`BEHIND_CLOUDFLARE` 已废弃，不要设）。
3. 更新 `NEXT_PUBLIC_SITE_URL`（构建时内联，改了要重新构建镜像）/ `AUTH_URL` 为正式域名，重新部署。
4. **Google Search Console**：添加资源 → 网址前缀 → HTML 标记 → 复制 `content` 值填 `NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION` → 重新部署 → 点验证 → 提交 `https://<域名>/sitemap.xml`。（也可用 DNS TXT 的“网域”资源。）
5. **Yandex Webmaster**：添加站点 → Meta 标签 → 值填 `NEXT_PUBLIC_YANDEX_VERIFICATION` → 部署后验证 → 提交 sitemap；俄语市场重点平台。
6. **Bing Webmaster**：可直接从 GSC 导入；或 Meta 标签 `msvalidate.01` 值填 `NEXT_PUBLIC_BING_VERIFICATION` → 验证 → 提交 sitemap。
7. 非生产环境已全站 `X-Robots-Tag: noindex`，只有 `APP_ENV=production` 才允许收录。

## 7. 首个管理员

自建部署后在服务器上执行 `docker compose exec app node scripts/admin-create.mjs --email <邮箱> --name "<显示名>"`（等同 `pnpm admin:create`），密码在终端交互输入、不回显；没有终端时只从标准输入读取。密码绝不放在命令行参数或环境变量里（生产下脚本会拒绝环境变量方式）。已有管理员时需显式 `--allow-additional-admin`；邮箱已存在直接失败。只有命令行，没有 HTTP 接口。建好后登录后台立即绑定 2FA。详见 launch-runbook.md 第 4.3 节。`pnpm admin:seed`（旧的环境变量建号脚本）只用于测试 / 本地 / CI。

### 7.1 部署 #361 前：统计未绑定 2FA 的 ADMIN

#361 上线后，绑定窗口从 `enrollIssuedAt`（重置 2FA 时写入）或 `createdAt` 起算 72 小时，过了就不能再自己绑定，只能由另一个 ADMIN 重置 2FA。部署前用镜像里自带的只读脚本统计（规则与 `src/lib/server/admin/enroll-guard.ts` 相同）：

```sh
APP_TAG=candidate docker compose -p nbshiyan -f deploy/docker-compose.yml --env-file $NBSHIYAN_COMPOSE_ENV run --rm -T --no-deps app node scripts/admin-2fa-audit.mjs
```

- 用 candidate 镜像跑一次性容器（当前线上镜像里还没有这个脚本）；用应用自己的 `DATABASE_URL` 和 `@prisma/client`，不开端口，不接受任何参数。只调用 `count`，不写库。
- 输出恰好两行，只有数字：`admins=<n>`（未停用的 ADMIN 数）、`unbound_over_72h=<n>`（其中未绑定 2FA 且窗口已过的数）。不输出邮箱、id、名字。
- #361 的 db push 之前库里还没有 `enrollIssuedAt` 列，脚本自动只按 `createdAt` 统计，结果与部署后一致。
- 出错时 stderr 只有 `error=audit_failed`，退出码 1；带参数时 `error=no_args_accepted`，退出码 2。
- 只报两个数字。如果 `unbound_over_72h` 大于 0 且等于 `admins`，先绑定 2FA 再部署（或部署后马上由另一个 ADMIN 重置）。详见 deploy/README.md「2FA audit」。

### 7.2 未绑定 2FA 的 ADMIN 重设初始密码

`docker compose exec -it app node scripts/admin-reset-initial-password.mjs --email <邮箱> [--clear-pending-enroll]`（或 `--id <账号 id>`；等同 `pnpm admin:reset-initial-password`）。只用于还没绑定 2FA 的 ADMIN。#347：必须在终端里运行（stdout 不是终端时退出 2、什么都不改，所以不能再用标准输入读密码）；同一事务里签发新的一次性绑定令牌，成功后在终端显示一次链接、有效期和「只私信发给本人」，旧链接立即失效。新密码只从终端（不回显，输两次）或标准输入第一行读，不接受命令行参数和环境变量；密码只由 Ryan 本人输入，或私信给本人，不发群里。2FA 已启用、不是 ADMIN、已停用一律拒绝（退出码 3）。有未完成的绑定或 72 小时绑定窗口已关闭时必须加 `--clear-pending-enroll`，它会清掉待确认状态并重新打开绑定窗口。改密码、清待确认状态、所有会话失效、解除锁定、写审计（`user.password_reset`，必要时加 `user.pending_enroll_cleared`，只记 actor=cli 和账号 id）在同一个事务里。提交后只清这个账号能直接算出名字的限流 key：`login-acct:<e>`、`login:untrusted:<e>`、`enroll-confirm:untrusted:<e>`，当前和上一个窗口（按 key 名直接删，不 SCAN/KEYS）；`login-ip` 和真实 IP 的桶不清。详见 deploy/README.md。

## 8. CSP 说明（Tawk.to 等第三方）

当前 `security-headers.ts` 已放行 Tawk.to 和 Turnstile 所需的最小范围，**无需再加**：

- `script-src`: `https://embed.tawk.to https://*.tawk.to https://challenges.cloudflare.com https://static.cloudflareinsights.com`（#346，CF Web Analytics）
- `style-src`: `https://*.tawk.to`
- `font-src`: `https://*.tawk.to`
- `connect-src`: `https://*.tawk.to wss://*.tawk.to https://cloudflareinsights.com`（#346）
- `frame-src`: `https://*.tawk.to https://challenges.cloudflare.com`

上传文件存服务器本地磁盘，只经本站接口（同源，`'self'`）提供，这些接口自己返回 `default-src 'none'; sandbox`（全站 CSP 对它们排除）；可选的 R2 驱动也是服务器端签名请求，浏览器不直连。Upstash 只在服务器端调用；发信是服务器经 Gmail SMTP 发出，收信走 Cloudflare Email Routing，浏览器都不直连，**都不需要加进 CSP**。

`https://*.r2.dev` 和 `https://*.vercel-insights.com` 已在 #346 从 `connect-src` 去掉（不开 R2 公开地址；自建部署没有 Vercel Analytics）。Tawk.to 只在用户同意 Cookie 后加载。

## 9. 上线验收

- [ ] 询盘提交 → 收到通知邮件、客户收到自动回复（英/俄）
- [ ] 上传 Logo → `UPLOAD_DIR` 下出现 0600 的 `<随机id>.png`；该文件没有任何静态地址可以直接访问，只能经后台接口（带 `nosniff`、`sandbox` CSP）查看
- [ ] 关于页图片按第 1.2 节核对：上传 location 的 `client_max_body_size 11m`；`/media/` 反代并带 `X-Edge-Auth`，不存在的 `/media/<24位id>-800.webp` 由应用返回 404 + `no-store` + CSP `sandbox`；`UPLOAD_DIR`（含 `public-assets/`）另做备份；Cloudflare 上 `/media/` 的 Edge/Browser TTL 不长于新缓存头；新版上线后经 Ryan 批准清一次 `/media/` 前缀缓存
- [ ] 连续错误登录触发限流；重启 app 容器后计数仍在（Upstash 共享存储）
- [ ] 服务器 cron 手动运行返回 200，不带密钥返回 401
- [ ] `GET /api/health` 返回 200 `{"ok":true}`；停掉 Postgres 容器时返回 503
- [ ] 后台登录需要 2FA；`NEXT_PUBLIC_ADMIN_API=http`，后台显示真实数据
- [ ] GSC / Yandex / Bing 验证通过，sitemap 已提交
- [ ] Lighthouse：桌面 < 2s，手机 < 3s

### 隐私 / 数据保留上线检查
- [ ] 已设置 `PRIVACY_HASH_SECRET`（≥ 32 字节，独立于 AUTH_SECRET）。
- [ ] 部署 #200 后运行一次 `pnpm tsx scripts/backfill-normalized-email.ts`（先 `--dry-run`），回填 Contact.normalizedEmail，否则旧联系人查不到。
- [ ] 保留天数与隐私政策对齐（见 docs/data-retention.md）。
