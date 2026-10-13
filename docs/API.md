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
  "items": [{ "productSlug": "corrugated-box", "quantity": 5000, "config": {}, "designId": "abc123XYZ0" }],
  "attribution": { "page": "/en/products/corrugated-box", "utm": {} },
  "website": "",            // 诱饵字段，必须为空
  "turnstileToken": "",
  "logoUploadId": ""       // 可选，见下方 logo 上传
}
```
返回 `201 { "ref": "PJ-2610-K7Q2MX" }`。会给业务邮箱发通知、给客户发对应语言的自动回复。

### `POST /api/designs` 和 `GET /api/designs/:id`
保存定制方案，返回 `{ "id": "abc123XYZ0", "url": "/s/abc123XYZ0" }`。`/s/*` 页面带 `noindex`。

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
已上架模型列表：`productSlug, category, sortOrder, glbUrl, lodUrl, posterUrl, animated, customizable`。

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
每个路由先调用 `requireAdmin(req, roles)`（`src/lib/server/auth.ts`，只管登录、会话、角色）：未登录 401 `unauthorized`，角色不符 403 `forbidden`。之后改动类请求调用 `assertSameOrigin(req)`（`Origin` 必须等于请求 origin 或 `APP_ORIGIN`，否则 403 `forbidden_origin`），所有请求调用 `adminRateLimit(req, key)`（按接口+IP，默认每分钟 120 次，超限 429 `rate_limited`）。CI 的 `check-admin-guard` 会检查每个路由都调了鉴权。响应都带 `Cache-Control: private, no-store`；每个操作写 AuditLog（只记 id、状态变化，不记邮件正文和搜索词）。
角色：`ADMIN` 全部可见；`SALES` 只能看和操作分配给自己的询盘，不能改分配；`EDITOR` 无询盘权限。

- `GET /api/admin/users` → `{ items: [{ id, name, email, role }] }`。ADMIN 拿到所有未禁用的 ADMIN/SALES（分配下拉框用）；SALES 只拿到自己。
- `GET /api/admin/inquiries` → `{ items, total, page, pageSize }`。参数（都可选）：
  - `page`（默认 1）、`pageSize`（默认 20，最大 100）
  - `q`：搜编号、留言、联系人姓名/邮箱/公司
  - `from`、`to`：创建时间区间，ISO 日期或时间；`to` 只给日期（如 `2026-10-13`）时包含当天
  - `status`：`NEW | FOLLOWING | QUOTED | WON | INVALID`
  - `minScore`、`maxScore`：可信度 0–100
  - `product`：产品 slug，询盘任一产品匹配即可
  - `assignee`：`me` | `none`（未分配）| 用户 id。SALES 无论传什么都只看到自己的
  - `items[]`：`{ id, ref, status, source, locale, trustScore, ipCountry, createdAt, assigneeId, contact: { name, email, company, region }, _count: { items, messages } }`。参数非法返回 400 `invalid`。
- `GET /api/admin/inquiries/:id` → 询盘全部字段（不含 `replyToken`）+ `contact, items, messages, notes, sample, assignee, logoUploads: [{ id, width, height, bytes, createdAt }]`，以及 `logoUploadId`（第一个 logo 的 id，没有为 `null`）。
- `GET /api/admin/uploads/:id` → logo 图片（PNG）。`Content-Disposition: inline`、`X-Content-Type-Options: nosniff`、`Cache-Control: private, no-store`，带会话 cookie 直接用作 `<img src>`。ADMIN 都能看；SALES 只能看分配给自己的询盘上的 logo，其他一律 404。
- `PATCH /api/admin/inquiries/:id` `{ status?, assigneeId? }`（`assigneeId` 仅 ADMIN，可为 `null`）→ `{ id, status, assigneeId, updatedAt }`。
- `POST /api/admin/inquiries/:id/reply` `{ subject ≤200, body ≤20000 纯文本 }` → 201 新的 `InquiryMessage`。正文全部转义、换行转 `<br>`，主题去换行；配置 `REPLY_DOMAIN` 后 Reply-To 为 `reply+<token>@域名`。发信失败返回 502 `mail_failed`，不入库。
- `POST /api/admin/inquiries/:id/notes` `{ body ≤5000 }` → 201 新备注。

### 规划中
- `PATCH /samples/:id`、`POST /models`、`POST /models/:id/process`、`PATCH /models/:id`、`GET|PUT /settings/:key`、`GET /stats`
- 改密码、重置 2FA、账号管理接口（需调用 `revokeSessions()`）

## 定时任务
- `GET|POST /api/admin/cron/cleanup-uploads`：删除超过 24 小时未绑定询盘的 logo（文件和记录）。需 `Authorization: Bearer $CRON_SECRET`，未配置 `CRON_SECRET` 时一律 401。建议每小时跑一次（Vercel Cron 会自动带这个头）。

## 待定
- 客户回信自动归档：需要正式域名后接 Resend 收信。

## 模型处理状态
`GET /api/admin/models/:id` 返回 `status` 和 `checks`：
```json
[{ "key": "format", "ok": true, "detail": "glTF 2.0 binary" }, { "key": "size", "ok": false, "detail": "1.24MB / 1MB" }]
```
`key` 取值 `format | compress | lod | size`，前端按顺序显示。
