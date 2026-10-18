# 后端接口文档（初稿）

前端在接口完成前可按此结构写模拟数据。除 logo 上传外，所有公开提交接口都要求 Cloudflare Turnstile token，并按 IP 限流。

## 公开接口

### `POST /api/inquiries`
询价表单、询价向导、询价清单、定制器、样品申请共用。
```json
{
  "source": "FORM | WIZARD | CART | CUSTOMIZER | SAMPLE",
  "locale": "en | ru",
  "contact": { "name": "", "email": "", "company": "", "phone": "", "region": "US" },
  "message": "",
  "items": [{ "productSlug": "corrugated-box", "quantity": 5000, "config": {}, "notes": "", "designId": "", "shareUrl": "/s/AbCdEfGh23456789" }],
  "shippingAddress": { "line1": "", "line2": "", "city": "", "state": "", "postalCode": "", "country": "DE" }, // 仅 SAMPLE，必填
  "attribution": { "page": "/en/products/corrugated-box", "utm": {} },
  "website": "",            // 诱饵字段，必须为空
  "turnstileToken": "",
  "logoUploadId": ""       // 可选，见下方 logo 上传
}
```
返回 `201 { "ref": "PJ-2610-K7Q2MX" }`。会给业务邮箱发通知、给客户发对应语言的自动回复。所有来源都要 Turnstile，都走同一套可信度评分（产品备注和留言一起评分）。

- **询价清单（`CART`）**：一个清单提交成一条询盘。`items` 1–20 个，服务端校验；`quantity` 正整数 ≤ 1 亿，`notes` ≤ 500 字，`config` 是严格白名单 `{ size（≤200 字文本或 {length,width,height,unit}）, material, timeline: 2w|1m|2m|3m, finishes[], colors{名称:#hex}, printing }`，未知字段 400；同一产品 + 方案不能重复。
- **分享链接**：`shareUrl` 只接受本站 `/{en|ru}/s/<id>`（兼容 `/s/<id>`；相对路径或 `NEXT_PUBLIC_SITE_URL` 开头），解析成 `designId`；外站链接返回 400 `share_url_invalid`。引用的方案必须存在且没过期，否则 `422 { "error": "design_invalid" }`。被询盘引用后方案不再过期。
- **样品申请（`SAMPLE`）**：`items` 1–5 个，`shippingAddress` 必填（禁止控制字符和 `<>`）。限制：
  - 每个规范化邮箱 30 天 1 次（小写、去 `+后缀`、Gmail 去点，googlemail 归一为 gmail），数据库判断并加锁。超限返回 `429 { "error": "sample_recent" }`，**不带** `retryAfter` / `Retry-After`，避免借此探测邮箱。
  - 每 IP 30 天 3 次（Turnstile 通过后才计数），超限返回带 `retryAfter` 的标准 429。
- **429 格式**（IP 类限流）：`{ "error": "rate_limited", "retryAfter": 秒 }` + `Retry-After` 头；`retryAfter` 是窗口长度，属上限值。内存限流存储只保留 24 小时内的记录，30 天窗口需要 `RATE_LIMIT_STORE=upstash` 才完全生效（邮箱限制在数据库里，不受影响）。

**收货地址（PII）**：后台询盘列表不返回地址；详情 `GET /api/admin/inquiries/:id` 永远返回脱敏地址（国家、城市首字母、邮编前 2 位），`canRevealAddress` 告诉前端是否显示“查看完整地址”按钮。完整地址只能 `POST /api/admin/samples/:id/address`（`:id` 是 `sample.id`，没有 GET）：同源校验 → 登录（ADMIN/SALES）→ 限流 → 只有 ADMIN 和被分配的 SALES，否则 404 → 写审计 `sample.address.view`（不记录地址内容）→ 返回 `{ shippingAddress }`，`Cache-Control: no-store`。EDITOR 无权访问。目前没有导出功能，以后加导出时也要写审计。

### `POST /api/designs`、`GET /api/designs/:id`、`GET /api/designs/:id/logo`
保存定制方案（不可修改），返回 `201 { "id": "AbCdEfGh23456789", "url": "/en/s/AbCdEfGh23456789", "expiresAt": "…" }`（`url` 按方案的 `locale`）。
```json
{
  "productSlug": "mailer-box",
  "category": "gift-boxes",          // 可选，categoryMeta 的 key，用于 canonical
  "locale": "en | ru",
  "logoUploadId": "",               // 可选，未过期、未绑定询盘的 logo 上传
  "turnstileToken": "",
  "config": {
    "modelId": "", "colors": { "body": "#112233" },
    "size": { "length": 200, "width": 150, "height": 50, "unit": "mm | cm | in" },
    "material": "kraft", "finishes": ["foil"], "quantity": 500,
    "logo": { "placement": "lid", "scale": 1, "offset": [0, 0], "rotation": 0 },
    "camera": { "position": [0, 0, 3], "target": [0, 0, 0] }
  }
}
```
- `config` 白名单字段，未知字段 400；请求体 ≤ 16KB，`config` ≤ 8000 字节；每 IP 10 分钟 30 次；需要 Turnstile。
- id：16 位随机字符（拒绝采样，约 93 bit），不可递增；旧的 10 位 id 仍可读取。
- 过期：默认 180 天；被询盘引用后不过期，跟随询盘保留期。过期后 `GET` 返回 `410 { "error": "expired", "categoryUrl": "…" }`，再保留 90 天后由定时任务删除（之后 404）。
- `HEAD /api/designs/:id`：只返回状态码 200 / 404 / 410（限流时 429），没有 body，`Cache-Control: public, max-age=60`；只查 `expiresAt` 和 `category`，410 时带 `X-Design-Category: <categoryMeta key>`（没有分类就不带），不返回其它方案信息；每 IP 10 分钟 600 次，无 IP（服务端内部调用）共用 6000 次。middleware 探测时带 `x-internal-probe: $MIDDLEWARE_PROBE_SECRET`（≥ 32 字节，常量时间比较）和 `x-probe-client-ip: <客户端 IP>`：密钥通过且 IP 格式合法才按该 IP 单独分桶（`design-head:probe:<ip>`，同样 600 次），否则忽略这两个头、按连接 IP 限流。给 middleware 的 410 规则用。
- `GET /api/designs/:id` 返回 `{ id, productSlug, category, locale, config, hasLogo, expiresAt, createdAt, slugs, canonical }`，不返回 logo 上传 id（防止被人拿去绑定询盘）；logo 用 `GET /api/designs/:id/logo` 取（重新编码过的 PNG）。都带 `X-Robots-Tag: noindex, nofollow`。
- 页面 `/{locale}/s/:id`（`/en/s/…`、`/ru/s/…`，文案跟 URL 语言）：`noindex, nofollow`，canonical 指向对应分类落地页 `/{locale}/products/{slug}`（没有分类时指向 `/{locale}/products`）。过期时页面显示“链接已过期”和分类页链接。页面本身没法返回 410：全栈的 middleware 对 `/*/s/` 调 `HEAD /api/designs/:id`，按结果返回 410（调用失败时放行）。

### `POST /api/uploads/logo`
询价时上传 logo。公开接口，不需要登录，也不需要 Turnstile token（人机校验只在提交询盘时做）。
- 请求：`multipart/form-data`，字段 `file`。
- 只接受 PNG、JPEG、WebP，按文件头判断，不看扩展名和 Content-Type。不接受 SVG、PDF。
- 文件最大 2MB。Content-Length 超限时不读请求体直接拒绝，读取过程中也会计数。
- 宽、高都不能超过 4096 像素。服务端用 sharp 重新编码为 PNG，去掉全部元数据（EXIF 等），文件名由服务端随机生成。
- 文件私有存储（服务器本地磁盘 `UPLOAD_DIR`；R2 为可选驱动），不会有公开地址。
- 限流：每个 IP 每小时 10 次，全站每小时 500 次。

返回 `201 { "uploadId": "24位随机串", "width": 200, "height": 100, "bytes": 299 }`（尺寸和字节数是重新编码后的）。

| 状态 | `error` | 含义 |
|---|---|---|
| 400 | `invalid` / `missing_file` | 不是 multipart，或没有 `file` 字段 |
| 413 | `too_large` | 超过 2MB |
| 415 | `unsupported_type` | 不是 PNG/JPEG/WebP |
| 422 | `dimensions_too_large` / `invalid_image` | 尺寸超限，或文件损坏 |
| 429 | `rate_limited` | 超出限流 |

`uploadId` 1 小时内有效，在 `POST /api/inquiries` 里传 `logoUploadId` 绑定到询盘。没有绑定的上传 24 小时后删除。

**询盘里的 `logoUploadId`（可选）**：必须存在、没过期、没绑定过，否则整条询盘不入库，返回 `422 { "error": "logo_invalid" }`，前端应提示重新上传 logo。绑定是原子条件更新，同一个 `uploadId` 只能绑定一次。

### `GET /api/models`
已上架（`published=true` 且 `status=READY`）的模型列表，`Cache-Control: public, max-age=60`：
`{ items: [{ id, productSlug, category, sortOrder, animated, customizable, slugs, glbUrl, lodUrl, posterUrl }] }`。
`slugs` 形如 `{ "en": "custom-gift-boxes", "ru": "podarochnye-korobki" }`，按 `category`（内部 key）从 `src/lib/seo/categoryMeta.ts` 取；`category` 不在 categoryMeta 里时为 `null`，前端回退用 key。ru slug 目前是草稿，等母语审核，可能改动，前端不要把它写死。
文件地址形如 `/api/models/:id/glb?v=版本`（`lod`、`poster` 同理），只对已上架模型返回，否则 404；`Cache-Control: public, max-age=300`。gltf-progressive 按主 GLB 里记录的相对路径请求 `/api/models/:id/<名称>.lod0.glb`，服务端映射到 lod 文件。

## 后台登录（Auth.js v5，Credentials + 强制 TOTP）
- 创建账号：`ADMIN_SEED_EMAIL=… ADMIN_SEED_NAME=… ADMIN_SEED_PASSWORD=… [ADMIN_SEED_ROLE=SALES] pnpm admin:seed`（测试 / 本地 / CI；密码 ≥12 位，argon2id 哈希；凭据只走环境变量）。
- 生产首个管理员：`node scripts/admin-create.mjs --email … [--name …]`（`pnpm admin:create`；镜像里 `docker compose exec app node scripts/admin-create.mjs …`）。密码只从终端（不回显）或标准输入读，不进命令行参数；`ADMIN_CREATE_PASSWORD` 只给 CI 用，`APP_ENV=production` 时拒绝；已有管理员时需 `--allow-additional-admin`；邮箱已存在直接失败；写一条 `user.create` 审计（不含密码）。
- 未绑定 2FA 的 ADMIN 重设初始密码：`node scripts/admin-reset-initial-password.mjs (--email … | --id …) [--clear-pending-enroll]`（`pnpm admin:reset-initial-password`）。只有命令行；密码只从终端或标准输入读；TOTP 已启用、非 ADMIN、已停用一律拒绝；有未完成的绑定或绑定窗口已关闭时需加参数；同一事务里改密码、会话失效、写 `user.password_reset`（+ `user.pending_enroll_cleared`）审计（不含密码、哈希、密钥、邮箱）。
- 绑定 2FA（账号未开 2FA 前不能登录，两步都要同源 `Origin`；接口在 `/api/auth-admin/` 下，不在 `/api/admin/` 下，因为这是登录前流程）：
  1. `POST /api/auth-admin/enroll` `{ email, password }` → `{ otpauthUri }`。已开启的账号返回 401 `bad_credentials`。待确认密钥 10 分钟内有效，有效期内再调返回 429 `rate_limited`（不会覆盖正在扫的密钥），过期后再调换新密钥、旧的作废（#347）。
  2. `POST /api/auth-admin/enroll/confirm` `{ email, password, totp }` → `{ recoveryCodes: [10 个] }`，只返回这一次，服务端只存哈希。码错 401 `bad_totp`；待确认密钥已过期 401 `bad_totp`（需重新 enroll）。
  - 绑定窗口（#347）：账号创建（或最近一次重置 2FA）起 72 小时内才能 enroll/confirm，过期返回 401 `bad_credentials`，需 ADMIN 重置 2FA（`POST /api/admin/users/:id/reset-2fa`）重新打开窗口。
  - 按账号的错码上限（#348）：只统计密码正确、6 位码错的 confirm（不管 IP）。同一个待确认密钥错满 5 次即作废，返回 401 `enroll_reset`（之后 confirm 也返回 `enroll_reset`，直到重新 enroll）；作废后冷却 10 分钟，期间 enroll 返回 429 `rate_limited`。密码错的请求不计入、不作废密钥（仍按下面的登录防爆破处理）。绑定成功或发新密钥时清零。
  - `bad_totp` / `rate_limited` / `enroll_reset` 这几种区分只有密码正确才看得到；密码错或账号不存在一律 401 `bad_credentials`。
  - 两个接口各自另有按 IP 的限流：每 IP 10 分钟 20 次（在同源检查之后、解析请求体之前），超限 429 `rate_limited`。
- 登录：Auth.js 标准流程，`GET /api/auth/csrf` 取 token，再 `POST /api/auth/callback/credentials`（表单字段 `csrfToken, email, password, totp` 或 `recoveryCode`）。任何一步失败统一返回 `CredentialsSignin`，不区分原因。
- 会话：JWT，2 小时有效；cookie HttpOnly、SameSite=Lax，生产强制 Secure（`__Secure-` 前缀）。每次请求核对 `User.sessionVersion`、禁用、2FA 状态，不一致即失效（改密码/重置 2FA 时调用 `revokeSessions()`）。
- 防爆破：10 分钟内 IP+账号 5 次、单账号 10 次、单 IP 30 次；同一账号连续 5 次失败锁定 15 分钟。TOTP 同一时间步只能用一次，恢复码用后作废。
- 审计：`auth.login_success / auth.login_fail(reason) / auth.lockout / auth.totp_enroll_start / auth.totp_enroll_blocked(reason: pending|cooldown|window_expired) / auth.totp_enroll_fail / auth.totp_enroll_voided / auth.totp_enabled`，不记密码、验证码、密钥、token，邮箱只记 HMAC。

## 后台接口（`/api/admin/*`）
每个路由先调用 `requireAdmin(req, roles)`（`src/lib/server/auth.ts`，只管登录、会话、角色）：未登录（或锁定、会话失效、未开 2FA）401 `unauthorized`，账号已停用 403 `account_disabled`（与未登录区分，重新登录也无效），角色不符 403 `forbidden`。后台页面用同一规则（`checkAdminSession`）。之后改动类请求调用 `assertSameOrigin(req)`（`Origin` 必须等于请求 origin 或 `APP_ORIGIN`，否则 403 `forbidden_origin`；生产必须设置 `APP_ORIGIN` = `NEXT_PUBLIC_SITE_URL` 的 origin，standalone 下请求 origin 是监听地址），所有请求调用 `await enforceAdminRateLimit(req, key)`（按接口+IP，默认每分钟 120 次，超限 429 `rate_limited`）。CI 的 `check-admin-guard` 会检查每个路由都调了鉴权。响应都带 `Cache-Control: private, no-store`；每个操作写 AuditLog（只记 id、状态变化，不记邮件正文和搜索词）。
角色：`ADMIN` 全部可见；`SALES` 只能看和操作分配给自己的询盘，不能改分配；`EDITOR` 无询盘权限。

- `GET /api/admin/users` → `{ items: [{ id, name, email, role }] }`。ADMIN 拿到所有未禁用的 ADMIN/SALES（分配下拉框用）；SALES 只拿到自己。
- `GET /api/admin/inquiries` → `{ items, total, page, pageSize }`，每条带 `sample: { status } | null`（不含地址）和 `anonymizedAt`。参数（都可选）：
  - `includeAnonymized=true|false|1|0`：默认 false，服务端过滤 `anonymizedAt IS NULL`（`total` 和分页一致），仍受 inquiryScope 限制；其他值 400
  - `type`：`general`（FORM/WIZARD/CUSTOMIZER）| `quote_list`（CART）| `sample`（SAMPLE），其它值 400
  - `page`（默认 1）、`pageSize`（默认 20，最大 100）
  - `q`：搜编号、留言、联系人姓名/邮箱/公司
  - `from`、`to`：创建时间区间，ISO 日期或时间；`to` 只给日期（如 `2026-10-13`）时包含当天
  - `status`：`NEW | FOLLOWING | QUOTED | WON | INVALID`
  - `minScore`、`maxScore`：可信度 0–100
  - `product`：产品 slug，询盘任一产品匹配即可
  - `assignee`：`me` | `none`（未分配）| 用户 id。SALES 无论传什么都只看到自己的
  - `items[]`：`{ id, ref, status, source, locale, trustScore, ipCountry, createdAt, assigneeId, contact: { name, email, company, region }, _count: { items, messages } }`。参数非法返回 400 `invalid`。
- `GET /api/admin/inquiries/:id` → 询盘全部字段（不含 `replyToken`）+ `contact, items, messages, notes, sample, assignee, logoUploads: [{ id, width, height, bytes, createdAt }]`，以及 `anonymizedAt`、`logoUploadId`（第一个 logo 的 id，没有为 `null`）、`canRevealAddress`。
- `GET /api/admin/inquiries/:id/history?limit=10&before=<cursor>` → `{ items: [{ type: created|status|assignment|reply|inbound, at, actorKind: customer|user|deleted_user|system, actor: { name, role } | { name, role: null } | null, summary, cursor }], total }`。新的在前；`limit` 默认 10、最多 50；下一页把最后一条的 `cursor` 传给 `before`，非法游标 400 `bad_cursor`（游标格式不变，新表记录的 key 前缀是 `mm:`）。数据来自询盘创建时间、审计里的状态/分配变更、旧表 `InquiryMessage` 和 #74 新表 `MailMessage`（只取 QUEUED/SENDING/SENT/FAILED/RECEIVED；出站按状态写「已回复客户 / 回复客户（发送失败）/（排队待发）/（发送中）」）。`actorKind`：创建和来信是 `customer`（`actor = { name: 客户名, role: null }`）；现有账号 `user`（`{ name, role }`）；账号已删除 `deleted_user`（`actor: null`）；没有操作人的自动操作 `system`（`actor: null`）。邮件主题和客户名按 §18 转纯文本（去标签、去控制/双向字符），邮箱换成 `***@***`、收货地址片段（街道、城市、州、邮编）换成 `***`，截到 80 字；询盘已匿名化时客户名和主题都是 `[deleted]`。不含正文、附件、对方邮箱、Message-ID、IP 和用户 id；新旧两表之间没有关联字段，不去重。SALES 只能看分配给自己的询盘，但能看到该询盘的完整时间线（包括分配前的记录）。
- `POST /api/admin/inquiries/:id/mail`、`POST /api/admin/mail/:id/retry` 成功 201 → `{ id, status: "SENT", sentAt, retryCount, maxRetries }`（#344：不再返回 `messageId`）。
- `GET /api/admin/uploads/:id` → logo 图片（PNG）。`Content-Disposition: inline`、`X-Content-Type-Options: nosniff`、`Cache-Control: private, no-store`，带会话 cookie 直接用作 `<img src>`。ADMIN 都能看；SALES 只能看分配给自己的询盘上的 logo，其他一律 404。
- `PATCH /api/admin/inquiries/:id` `{ status?, assigneeId? }`（`assigneeId` 仅 ADMIN，可为 `null`）→ `{ id, status, assigneeId, updatedAt }`。询盘已匿名化返回 409 `anonymized`；`status` 有变化时 `retainUntil` 顺延到 now + `INQUIRY_RETAIN_DAYS`。
- `POST /api/admin/inquiries/:id/reply` `{ subject ≤200, body ≤20000 纯文本 }` → 201 新的 `InquiryMessage`。正文全部转义、换行转 `<br>`，主题去换行；配置 `REPLY_DOMAIN` 后 Reply-To 为 `reply+<token>@域名`。发信失败返回 502 `mail_failed`，不入库。询盘已匿名化返回 409 `anonymized`（不发信）；成功时 `retainUntil` 顺延到 now + `INQUIRY_RETAIN_DAYS`。
- `POST /api/admin/inquiries/:id/notes` `{ body ≤5000 }` → 201 新备注。

### 账号
所有接口：`requireAdmin` → `assertSameOrigin` → `await enforceAdminRateLimit`；每个操作都让受影响账号的全部会话失效（`sessionVersion+1`，等同 `revokeSessions()`），并写 AuditLog（不记密码、验证码、恢复码）。密码 argon2id，策略：12–200 位，不能等于邮箱。

**自己的账号（ADMIN / SALES / EDITOR）**
- `POST /api/admin/account/password` `{ currentPassword, newPassword, totp | recoveryCode }` → `{ ok: true, reauthRequired: true }`。当前会话也失效，需重新登录。错误：401 `bad_credentials`，422 `weak_password` / `same_password`。
- `POST /api/admin/account/2fa/reset` `{ currentPassword, totp | recoveryCode }` → `{ ok: true, reenrollRequired: true }`。清空 TOTP 密钥和所有恢复码，会话失效；之后走 `/api/auth-admin/enroll` 重新绑定。
- 两个接口的验证失败与登录共用失败计数：连续 5 次锁定 15 分钟，锁定期间会话被拒（401）。每 IP 每分钟 5 次。

**账号管理（仅 ADMIN）**
- `GET /api/admin/users?all=1` → `{ items: [{ id, email, name, role, disabled, totpEnabled, locked, createdAt }] }`（不带 `all` 时是分配下拉框用的精简列表，见上）。
- `POST /api/admin/users` `{ email, name, role: ADMIN|SALES|EDITOR, password }` → 201。新账号需先绑定 2FA 才能登录。409 `email_taken`，422 `weak_password`。
- `PATCH /api/admin/users/:id` `{ role?, disabled?, name?, unlock?: true }` → 用户对象。停用或改为 EDITOR 时取消其名下询盘的分配。
- `POST /api/admin/users/:id/reset-2fa` → 用户对象。用于对方丢失手机和恢复码，或新账号 72 小时内没绑定（绑定窗口过期）；重新打开 72 小时绑定窗口，对方需重新绑定。
- `DELETE /api/admin/users/:id` → 204。名下询盘取消分配；审计记录保留。
- 保护规则：不能修改/停用/删除/重置自己（409 `cannot_modify_self`，自己用上面的自助接口）；不能让系统里没有有效管理员（role=ADMIN 且未停用），否则 409 `last_admin`。账号变更在事务里用 advisory lock 串行执行，防止两个管理员同时互相停用。

### 规划中
- `PATCH /samples/:id`、`GET|PUT /settings/:key`、`GET /stats`

## 定时任务
- `GET|POST /api/admin/cron/cleanup-uploads`：先删除过期超过 90 天、且没被询盘引用的方案（以及询盘已删除后留下的方案），再删除超过 24 小时未绑定询盘、也没被有效方案引用的 logo（文件和记录）。返回 `{ deleted, designs }`。需 `Authorization: Bearer $CRON_SECRET`，未配置 `CRON_SECRET` 时一律 401。由服务器上的定时任务（crontab / systemd timer）调用，见 launch-infra.md 第 5 节。

## 邮件（Gmail SMTP 发信）
模板来源 `design/emails/`，用 `pnpm email:build` 生成 `src/lib/server/email/templates.generated.ts`（提交生成结果，运行时不读 design 目录）。

| 邮件 | 收件人 | 何时发送 |
| --- | --- | --- |
| 询盘确认 `inquiry-ack.{en,ru}` | 客户 | 可信度 ≥ 40 的询盘 |
| 样品申请确认 `sample-ack.{en,ru}` | 客户 | 可信度 ≥ 40 的 `SAMPLE` 询盘（由询盘确认改写文案生成） |
| 新询盘通知 `inquiry-notify.zh` | `INQUIRY_NOTIFY_EMAIL` | 每条询盘；可信度 < 40 时显示“待核实”块 |
| 后台告警（中文） | `ADMIN_ALERT_EMAIL`，没配则 `INQUIRY_NOTIFY_EMAIL` | 发信失败、定时清理失败、后台账号被锁定；同一类（同一账号）30 分钟最多 1 封 |

变量：`name, company, product, quantity, inquiryId`（对外编号）`, locale, score`，以及环境变量 `NEXT_PUBLIC_SITE_URL`（siteUrl，生产必须是 https 域名）、`CONTACT_REPLY_TIME`（小时数 1–720，如 `24` 或 `24h`；按语言显示为 “24 hours” / “24 часа”；未设置或无效时整句改成不带时长的中性说法，不默认 24 小时）、`CONTACT_EMAIL`、`CONTACT_WHATSAPP`（两个都配了才显示联系方式那段，不换行）。

客户确认邮件（询盘、样品）：不含公司名；称呼只在姓名 ≤ 40 字且不像链接/域名/邮箱时使用，否则用 “Hello” / “Здравствуйте”；产品名按语言取 categoryMeta 关键词（匹配不上时把 slug 转成可读文字）。内部通知不变（slug、公司、姓名照常显示）。样品确认在询盘确认基础上改写：主题、预览文字、正文、标签（Sample qty / Номер заявки / Количество образцов）、页脚，并加 “样品免费、运费发货前邮件报价” 一句；每条改写在 html 和 text 里都必须命中，否则 `pnpm email:build` 报错。所有模板暗色模式下卡片正文为浅色，logo 加浅色底。

安全：
- 所有变量 HTML 转义（含 `{ }`，单次替换，用户输入里的 `{{x}}` 不会被展开）；文本版去掉控制字符和双向控制符；主题、收件人、Reply-To 去掉 `\r\n` 并校验为单个地址。
- 客户确认邮件主题只含编号，不回显留言；通知邮件也不含留言正文，只给后台链接 `{siteUrl}/admin/inquiries/{内部 id}`（只用环境变量里的站点地址，不取请求 Host，不带 token，正常登录后台）。
- 发信走 Gmail SMTP（#74 §16，nodemailer）：`SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` 只从环境变量读；只允许 465（隐式 TLS）或 587（STARTTLS 强制），证书校验始终开启，nodemailer 日志关闭。
- 自动回复：限流 key、咨询锁、数据库 24 小时判断都用规范化邮箱（小写、去 +后缀、Gmail 去点），同一人 24 小时 1 封；另加每 IP 24 小时 5 次。
- 告警邮件只含错误类型和错误码（如 `SmtpError` / `SMTP_535`），不含错误 message、SMTP 原始响应或凭据。
- 发信失败不影响询盘提交：记日志并发后台告警。

## 存储与限流（部署配置）
- **私有文件存储**（`src/lib/server/storage.ts`）：`STORAGE_DRIVER=local`（开发默认；生产采用（Ryan 已定）：`UPLOAD_DIR` 必须是挂载数据卷的可写绝对路径，key 解析后必须在目录内，不跟随符号链接，写入前校验文件头与扩展名一致，文件 0600 / 目录 0700）或 `r2`（Cloudflare R2，S3 API + SigV4，path-style `{endpoint}/{bucket}/{key}`）。R2 需要 `R2_ACCOUNT_ID`（或 `R2_ENDPOINT`）、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`、`R2_BUCKET`；生产环境 endpoint 必须是 https。桶保持私有，文件只经后端接口按权限提供，不生成公开或预签名地址。写入带 `If-None-Match: *`，不覆盖已有对象；key 只能是服务端生成的 `[A-Za-z0-9/_-]+.(png|webp|glb)`。R2 令牌只需对该桶的对象读写权限。
- **健康检查** `GET /api/health`：`200 {"ok":true}` / `503 {"ok":false}`，`Cache-Control: no-store`，只查 `SELECT 1`（1.5 秒超时），按来源限流（进程内存），不带版本或错误信息。
- **限流**（`src/lib/server/ratelimit/`）：`RATE_LIMIT_STORE=memory`（默认，单实例）或 `upstash`（`UPSTASH_REDIS_REST_URL`、`UPSTASH_REDIS_REST_TOKEN`，固定窗口 `INCR` + `PEXPIRE NX`，一次 pipeline 请求，1.5 秒超时）。Upstash 不可用时退回本实例内存计数并记错误日志，既不整站放行也不整站拒绝。代码里用 `await hitRateLimit(...)` / `await enforceAdminRateLimit(...)`（原同步的 `rateLimit` / `adminRateLimit` 已删除，防止漏写 `await`）。
- 单元测试：`pnpm test`（node:test + tsx，Upstash 和 R2 都用本地模拟服务器，不需要真实账号）。

## 待定
- 客户回信自动归档：收信走 Cloudflare Email Routing → 收信 Worker → `/api/mail/inbound-webhook`（#315）。Worker 签名改动等 Q7 批准，批准前 Email Routing 保持现状。

## 后台模型管理（`/api/admin/models`，ADMIN / EDITOR）
流程对应 PRD 第 9 节：**上传 → 处理中 → 预览确认 → 上架**。鉴权、同源、限流同其他后台接口；每步写 AuditLog（`model.upload / update / process / publish / unpublish / delete`）。

1. **上传** `POST /api/admin/models`，`multipart/form-data`：
   - `file`（必填）：GLB，按文件头 `glTF` v2 判断，≤ 1.5MB（超出 413，不是 GLB 415）
   - `lod`（可选）：gltf-progressive 高精度层 `*.lod0.glb`，≤ 1MB。主 GLB 声明了 `NEEDLE_progressive` 时必填
   - `poster`（可选）：PNG/JPEG/WebP ≤ 512KB，重新编码为 WebP（最长边 1024）
   - `productSlug`、`category`（必填），`animated`（`true|false`，默认 false），`sortOrder`
   - 返回 201 模型对象（含 `status`、`checks`）。服务端只做静态检查，**不压缩**，上传的文件需已用 Draco/meshopt + KTX2 处理好。
2. **处理中**：上传后同步跑检查，`status` 由 `PROCESSING` 变为 `READY`（所有 error 级检查通过）或 `FAILED`（`error` 字段列出未通过的 key）。`POST /api/admin/models/:id/process` 可重新检查。
3. **预览** `GET /api/admin/models/:id/file?variant=glb|lod|poster`：后台私有预览（`private, no-store`），未上架也能看。
4. **上架** `POST /api/admin/models/:id/publish` `{ "published": true|false }`。只有 `READY` 能上架，否则 409 `not_ready`；同一 `productSlug` 只保留一个上架版本，上架新版本会自动下架旧版本，返回 `replaced: [旧 id]`。

其他：
- `GET /api/admin/models?status=&product=&published=` → `{ items }`；`GET /api/admin/models/:id` → 模型对象
- `PATCH /api/admin/models/:id` `{ productSlug?, category?, sortOrder?, animated?, customizable? }`；改 `animated` 会自动重新检查
- `DELETE /api/admin/models/:id`：只能删未上架的（否则 409 `published`），文件一起删除

模型对象：`{ id, productSlug, category, sortOrder, published, publishedAt, status, sizeBytes, animated, customizable, checks, triangles, animations, uploadedBy, error, hasLod, hasPoster, createdAt, updatedAt }`（不含存储路径）。

### `checks` 格式
```json
[{ "key": "format", "ok": true, "detail": "glTF 2.0 binary，2 个网格", "severity": "error" },
 { "key": "size", "ok": false, "detail": "1.24MB / 1.00MB", "severity": "error" }]
```
`severity`：`error` 未通过时不能上架；`warn` 只提示。`key` 按以下顺序返回：

| key | 内容 | 规则 |
|---|---|---|
| `format` | GLB 容器和 JSON | glTF 2.0；只允许白名单扩展（Draco、meshopt、KTX2、WebP 贴图、常用材质扩展、`NEEDLE_progressive`）；buffers/images 的 `uri` 只允许 `data:`，其他（http、相对路径等）在解析前即拒绝 |
| `compress` | 几何、贴图压缩 | 几何必须 Draco 或 meshopt；贴图非 KTX2 时在 detail 里提示 |
| `size` | 体积 | ≤ 1MB，`animated` 时 ≤ 1.5MB |
| `triangles` | 三角面数（按 accessor 声明） | 1 – 100,000 |
| `textures` | 贴图数量和尺寸（读 KTX2/图片文件头） | 每边 ≤ 2048；有非 KTX2 贴图时为 warn |
| `animation` | 动画名称 | `animated` 时必须有 `Open`；否则仅提示（warn） |
| `bounds` | 包围盒（POSITION min/max，未计节点缩放） | 最长边 0.01–5 m，否则 warn（单位可能不对） |
| `lod` | 高精度层 | 有则检查格式、≤ 1MB、贴图；没有且主文件用了 `NEEDLE_progressive` 时 error，否则 warn |

安全：只解析 GLB 容器、JSON 和贴图文件头，不解码 Draco/meshopt、不执行任何内容、不访问外部地址；文件存私有存储（服务器本地磁盘 `UPLOAD_DIR`；R2 为可选驱动），只通过上述接口按状态提供（响应头由 `file-response.ts` 统一设置）。

### POST /api/admin/privacy/export · POST /api/admin/privacy/delete（仅 ADMIN）
详见 docs/data-retention.md。export 返回 JSON 附件（no-store）；顺序 requireAdmin → assertSameOrigin → 限流；生产未设置 PRIVACY_HASH_SECRET 时 503 `privacy_hash_secret_missing`。delete 需 `{email, confirmEmail}` 一致，返回 `{ok, contacts, inquiries, samples, logos}`。

## 产品规格（CategorySpec）

每个品类一行（`category` 必须是 `src/lib/seo/categoryMeta.ts` 里的 key）。所有字段可选。数值字段统一为「值 + 单位」对象，本地化文本为 `{ en, ru }`。

### 后台：GET / PUT /api/admin/specs/:category（EDITOR、ADMIN；SALES 403）
- 顺序：requireAdmin → assertSameOrigin（仅 PUT）→ enforceAdminRateLimit；未知品类 404；`Cache-Control: no-store`。
- PUT 为整体替换（省略或 `null` = 清空），严格 zod（多余字段 400）：
```json
{
  "size": { "min": { "l": 50, "w": 50, "h": 20 }, "max": { "l": 600, "w": 400, "h": 400 }, "unit": "mm" },
  "material": { "en": "Kraft paper", "ru": "Крафт-бумага" },
  "moq": { "value": 500, "unit": "pcs" },
  "sampleFee": { "amount": 30, "currency": "USD" },          // 或 { "free": true }；currency: USD/EUR/CNY/RUB
  "leadTime": { "min": 10, "max": 15, "unit": "day" },
  "certifications": [{ "name": "FSC", "certNo": "FSC-C123456" }, { "name": "ISO 9001", "url": "https://..." }],
  "tradeTerms": ["FOB", "EXW"],                                // Incoterms 2020
  "notes": { "en": "...", "ru": "..." }
}
```
- 校验：尺寸 min ≤ max（逐维），leadTime min ≤ max，tradeTerms 不重复；每条认证至少有 `certNo` 或 `url`；`url` 必须能被 `new URL()` 解析且协议正好是 `https:`（拒绝 `javascript:`、`data:`、`http:` 等），最长 2048。
- 审计 `spec.update`，meta 含 before / after（后台视图）；保存后 `revalidateTag('category-specs')`。

### 公开：GET /api/specs · GET /api/specs/:category（`?locale=en|ru`，默认 en，其他值 400）
- 未知品类 404；`Cache-Control: public, s-maxage=3600, stale-while-revalidate=600`。后台保存时 `revalidateTag` 只清 Next 的数据缓存，**不会清 CDN**：CDN 上的旧响应在 s-maxage（3600 秒）内仍可能返回，之后最多 600 秒内可能先返回旧数据再后台刷新。所以修改通常 1 小时内生效，最长约 70 分钟，不是立即生效。
- 显式白名单序列化：只输出已填写的字段，null / 空数组 / 空字符串的键整个省略；本地化文本只给当前语言（该语言没填就省略，不回退）。每个有内容的品类带 `updatedAt`。审计数据、`updatedById` 等内部字段不会出现在任何公开接口。
- `/api/specs` 返回 `{ locale, specs: [...] }`，只含有内容的品类，按 categoryMeta 顺序。
- 前端渲染认证链接时必须加 `rel="noopener noreferrer"`（并 `target="_blank"`）。

### 与 schema.org Product 的映射
| 字段 | schema.org（Product 不输出 offers / 价格 / 评分） |
|---|---|
| `material` | `Product.material`（当前语言的字符串） |
| `size` | 每个维度一条 `additionalProperty`：`PropertyValue{ name: "Length" / "Width" / "Height", value: QuantitativeValue{ minValue: min.l, maxValue: max.l, unitCode: "MMT" } }`（w、h 同理）。表示尺寸范围，**不要**写进 `Product.depth/width/height`（那是单一尺寸）。只填了 min 或 max 时只输出对应的一项 |
| `moq` | `additionalProperty`：`PropertyValue{ name: "Minimum order quantity", value: QuantitativeValue{ minValue: moq.value, unitCode: "H87" } }`。**不要**映射到 `Offer.eligibleQuantity` |
| `certifications[]` | `Product.hasCertification`：`Certification{ name, certificationIdentification: certNo, url }`。**JSON-LD 只输出带 https `url` 的证书**；只有 `certNo` 的证书只在正文展示，不进 JSON-LD；不使用 `award` 等背书语义 |
| `updatedAt` | 可作 `dateModified` / sitemap `lastmod`（与页面内容更新时间取较晚者） |
| `notes` | 不放进 JSON-LD，只在正文展示 |

**`sampleFee`、`leadTime`、`tradeTerms` 不要放进 JSON-LD 的 `offers`**：样品费不是产品售价，交期和贸易术语也不是 Offer 的标准报价属性，放进去会被 Google 当成价格/配送信息，导致富结果错误。它们只在页面正文展示。
