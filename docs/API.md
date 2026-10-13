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
- 文件私有存储（本地 `storage/uploads/`，以后换 R2），不会有公开地址。
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
- 创建账号：`ADMIN_SEED_EMAIL=… ADMIN_SEED_NAME=… ADMIN_SEED_PASSWORD=… [ADMIN_SEED_ROLE=SALES] pnpm admin:create`（密码 ≥12 位，argon2id 哈希；凭据只走环境变量）。
- 绑定 2FA（账号未开 2FA 前不能登录，两步都要同源 `Origin`；接口在 `/api/auth-admin/` 下，不在 `/api/admin/` 下，因为这是登录前流程）：
  1. `POST /api/auth-admin/enroll` `{ email, password }` → `{ otpauthUri }`（每次调用换新密钥；已开启的账号返回 401）。
  2. `POST /api/auth-admin/enroll/confirm` `{ email, password, totp }` → `{ recoveryCodes: [10 个] }`，只返回这一次，服务端只存哈希。
- 登录：Auth.js 标准流程，`GET /api/auth/csrf` 取 token，再 `POST /api/auth/callback/credentials`（表单字段 `csrfToken, email, password, totp` 或 `recoveryCode`）。任何一步失败统一返回 `CredentialsSignin`，不区分原因。
- 会话：JWT，2 小时有效；cookie HttpOnly、SameSite=Lax，生产强制 Secure（`__Secure-` 前缀）。每次请求核对 `User.sessionVersion`、禁用、2FA 状态，不一致即失效（改密码/重置 2FA 时调用 `revokeSessions()`）。
- 防爆破：10 分钟内 IP+账号 5 次、单账号 10 次、单 IP 30 次；同一账号连续 5 次失败锁定 15 分钟。TOTP 同一时间步只能用一次，恢复码用后作废。
- 审计：`auth.login_success / auth.login_fail(reason) / auth.lockout / auth.totp_enroll_start / auth.totp_enabled`，不记密码、验证码、token。

## 后台接口（`/api/admin/*`）
每个路由先调用 `requireAdmin(req, roles)`（`src/lib/server/auth.ts`，只管登录、会话、角色）：未登录 401 `unauthorized`，角色不符 403 `forbidden`。之后改动类请求调用 `assertSameOrigin(req)`（`Origin` 必须等于请求 origin 或 `APP_ORIGIN`，否则 403 `forbidden_origin`），所有请求调用 `await enforceAdminRateLimit(req, key)`（按接口+IP，默认每分钟 120 次，超限 429 `rate_limited`）。CI 的 `check-admin-guard` 会检查每个路由都调了鉴权。响应都带 `Cache-Control: private, no-store`；每个操作写 AuditLog（只记 id、状态变化，不记邮件正文和搜索词）。
角色：`ADMIN` 全部可见；`SALES` 只能看和操作分配给自己的询盘，不能改分配；`EDITOR` 无询盘权限。

- `GET /api/admin/users` → `{ items: [{ id, name, email, role }] }`。ADMIN 拿到所有未禁用的 ADMIN/SALES（分配下拉框用）；SALES 只拿到自己。
- `GET /api/admin/inquiries` → `{ items, total, page, pageSize }`，每条带 `sample: { status } | null`（不含地址）。参数（都可选）：
  - `type`：`general`（FORM/WIZARD/CUSTOMIZER）| `quote_list`（CART）| `sample`（SAMPLE），其它值 400
  - `page`（默认 1）、`pageSize`（默认 20，最大 100）
  - `q`：搜编号、留言、联系人姓名/邮箱/公司
  - `from`、`to`：创建时间区间，ISO 日期或时间；`to` 只给日期（如 `2026-10-13`）时包含当天
  - `status`：`NEW | FOLLOWING | QUOTED | WON | INVALID`
  - `minScore`、`maxScore`：可信度 0–100
  - `product`：产品 slug，询盘任一产品匹配即可
  - `assignee`：`me` | `none`（未分配）| 用户 id。SALES 无论传什么都只看到自己的
  - `items[]`：`{ id, ref, status, source, locale, trustScore, ipCountry, createdAt, assigneeId, contact: { name, email, company, region }, _count: { items, messages } }`。参数非法返回 400 `invalid`。
- `GET /api/admin/inquiries/:id` → 询盘全部字段（不含 `replyToken`）+ `contact, items, messages, notes, sample, assignee, logoUploads: [{ id, width, height, bytes, createdAt }]`，以及 `logoUploadId`（第一个 logo 的 id，没有为 `null`）、`canRevealAddress`。
- `GET /api/admin/inquiries/:id/history?limit=10&before=<cursor>` → `{ items: [{ type: created|status|assignment|reply|inbound, at, actor: { name, role } | null, summary, cursor }], total }`。新的在前；`limit` 默认 10、最多 50；下一页把最后一条的 `cursor` 传给 `before`，非法游标 400 `bad_cursor`。数据来自询盘创建时间、审计里的状态/分配变更和往来邮件记录；`summary` 里的邮件主题截到 80 字，出现的收货地址片段（街道、城市、州、邮编）替换成 `***`；不含正文、附件、IP 和用户 id。SALES 只能看分配给自己的询盘，但能看到该询盘的完整时间线（包括分配前的记录）。
- `GET /api/admin/uploads/:id` → logo 图片（PNG）。`Content-Disposition: inline`、`X-Content-Type-Options: nosniff`、`Cache-Control: private, no-store`，带会话 cookie 直接用作 `<img src>`。ADMIN 都能看；SALES 只能看分配给自己的询盘上的 logo，其他一律 404。
- `PATCH /api/admin/inquiries/:id` `{ status?, assigneeId? }`（`assigneeId` 仅 ADMIN，可为 `null`）→ `{ id, status, assigneeId, updatedAt }`。
- `POST /api/admin/inquiries/:id/reply` `{ subject ≤200, body ≤20000 纯文本 }` → 201 新的 `InquiryMessage`。正文全部转义、换行转 `<br>`，主题去换行；配置 `REPLY_DOMAIN` 后 Reply-To 为 `reply+<token>@域名`。发信失败返回 502 `mail_failed`，不入库。
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
- `POST /api/admin/users/:id/reset-2fa` → 用户对象。用于对方丢失手机和恢复码；对方需重新绑定。
- `DELETE /api/admin/users/:id` → 204。名下询盘取消分配；审计记录保留。
- 保护规则：不能修改/停用/删除/重置自己（409 `cannot_modify_self`，自己用上面的自助接口）；不能让系统里没有有效管理员（role=ADMIN 且未停用），否则 409 `last_admin`。账号变更在事务里用 advisory lock 串行执行，防止两个管理员同时互相停用。

### 规划中
- `PATCH /samples/:id`、`GET|PUT /settings/:key`、`GET /stats`

## 定时任务
- `GET|POST /api/admin/cron/cleanup-uploads`：先删除过期超过 90 天、且没被询盘引用的方案（以及询盘已删除后留下的方案），再删除超过 24 小时未绑定询盘、也没被有效方案引用的 logo（文件和记录）。返回 `{ deleted, designs }`。需 `Authorization: Bearer $CRON_SECRET`，未配置 `CRON_SECRET` 时一律 401。建议每小时跑一次（Vercel Cron 会自动带这个头）。

## 邮件（Resend）
模板来源 `design/emails/`，用 `pnpm email:build` 生成 `src/lib/server/email/templates.generated.ts`（提交生成结果，运行时不读 design 目录）。

| 邮件 | 收件人 | 何时发送 |
| --- | --- | --- |
| 询盘确认 `inquiry-ack.{en,ru}` | 客户 | 可信度 ≥ 40 的询盘 |
| 样品申请确认 `sample-ack.{en,ru}` | 客户 | 可信度 ≥ 40 的 `SAMPLE` 询盘（由询盘确认改写文案生成） |
| 新询盘通知 `inquiry-notify.zh` | `INQUIRY_NOTIFY_EMAIL` | 每条询盘；可信度 < 40 时显示“待核实”块 |
| 后台告警（中文） | `ADMIN_ALERT_EMAIL`，没配则 `INQUIRY_NOTIFY_EMAIL` | 发信失败、定时清理失败、后台账号被锁定；同一类（同一账号）30 分钟最多 1 封 |

变量：`name, company, product, quantity, inquiryId`（对外编号）`, locale, score`，以及环境变量 `NEXT_PUBLIC_SITE_URL`（siteUrl，生产必须是 https 域名）、`CONTACT_REPLY_TIME`（小时数，如 `24`，默认 24；按语言显示为 “24 hours” / “24 часа”）、`CONTACT_EMAIL`、`CONTACT_WHATSAPP`（两个都配了才显示联系方式那段，不换行）。

客户确认邮件（询盘、样品）：不含公司名；称呼只在姓名 ≤ 40 字且不像链接/域名/邮箱时使用，否则用 “Hello” / “Здравствуйте”；产品名按语言取 categoryMeta 关键词（匹配不上时把 slug 转成可读文字）。内部通知不变（slug、公司、姓名照常显示）。样品确认在询盘确认基础上改写：主题、预览文字、正文、标签（Sample qty / Номер заявки / Количество образцов）、页脚，并加 “样品免费、运费发货前邮件报价” 一句；每条改写在 html 和 text 里都必须命中，否则 `pnpm email:build` 报错。所有模板暗色模式下卡片正文为浅色，logo 加浅色底。

安全：
- 所有变量 HTML 转义（含 `{ }`，单次替换，用户输入里的 `{{x}}` 不会被展开）；文本版去掉控制字符和双向控制符；主题、收件人、Reply-To 去掉 `\r\n` 并校验为单个地址。
- 客户确认邮件主题只含编号，不回显留言；通知邮件也不含留言正文，只给后台链接 `{siteUrl}/admin/inquiries/{内部 id}`（只用环境变量里的站点地址，不取请求 Host，不带 token，正常登录后台）。
- `RESEND_API_KEY` 只从环境变量读，建议用 Resend 的 Sending access key；请求只发往 `https://api.resend.com/emails`。
- 自动回复：限流 key、咨询锁、数据库 24 小时判断都用规范化邮箱（小写、去 +后缀、Gmail 去点），同一人 24 小时 1 封；另加每 IP 24 小时 5 次。
- 告警邮件只含错误类型和错误码（如 `ResendError` / `RESEND_503`），不含错误 message。
- 发信失败不影响询盘提交：记日志并发后台告警。

## 存储与限流（部署配置）
- **私有文件存储**（`src/lib/server/storage.ts`）：`STORAGE_DRIVER=local`（默认，`UPLOAD_DIR`）或 `r2`（Cloudflare R2，S3 API + SigV4，path-style `{endpoint}/{bucket}/{key}`）。R2 需要 `R2_ACCOUNT_ID`（或 `R2_ENDPOINT`）、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`、`R2_BUCKET`；生产环境 endpoint 必须是 https。桶保持私有，文件只经后端接口按权限提供，不生成公开或预签名地址。写入带 `If-None-Match: *`，不覆盖已有对象；key 只能是服务端生成的 `[A-Za-z0-9/_-]+.(png|webp|glb)`。R2 令牌只需对该桶的对象读写权限。
- **限流**（`src/lib/server/ratelimit/`）：`RATE_LIMIT_STORE=memory`（默认，单实例）或 `upstash`（`UPSTASH_REDIS_REST_URL`、`UPSTASH_REDIS_REST_TOKEN`，固定窗口 `INCR` + `PEXPIRE NX`，一次 pipeline 请求，1.5 秒超时）。Upstash 不可用时退回本实例内存计数并记错误日志，既不整站放行也不整站拒绝。代码里用 `await hitRateLimit(...)` / `await enforceAdminRateLimit(...)`（原同步的 `rateLimit` / `adminRateLimit` 已删除，防止漏写 `await`）。
- 单元测试：`pnpm test`（node:test + tsx，Upstash 和 R2 都用本地模拟服务器，不需要真实账号）。

## 待定
- 客户回信自动归档：需要正式域名后接 Resend 收信。

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

安全：只解析 GLB 容器、JSON 和贴图文件头，不解码 Draco/meshopt、不执行任何内容、不访问外部地址；文件存私有存储（`storage/`，以后换 R2），只通过上述接口按状态提供。

### POST /api/admin/privacy/export · POST /api/admin/privacy/delete（仅 ADMIN）
详见 docs/data-retention.md。export 返回 JSON 附件（no-store）；delete 需 `{email, confirmEmail}` 一致，返回 `{ok, contacts, inquiries, samples, logos}`。
