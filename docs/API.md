# 后端接口文档（初稿）

前端在接口完成前可按此结构写模拟数据。所有公开接口都要求 Cloudflare Turnstile token，并按 IP 限流。

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
  "turnstileToken": ""
}
```
返回 `201 { "ref": "PJ-2610-K7Q2MX" }`。会给业务邮箱发通知、给客户发对应语言的自动回复。

### `POST /api/designs` 和 `GET /api/designs/:id`
保存定制方案，返回 `{ "id": "abc123XYZ0", "url": "/s/abc123XYZ0" }`。`/s/*` 页面带 `noindex`。

### `POST /api/uploads/logo`
返回 R2 预签名上传地址。只允许 PNG、SVG、PDF，最大 5MB；服务端按文件头校验，SVG 先清洗，文件不公开、30 天后删除。

### `GET /api/models`
已上架模型列表：`productSlug, category, sortOrder, glbUrl, lodUrl, posterUrl, animated, customizable`。

## 后台登录（Auth.js v5，Credentials + 强制 TOTP）
- 创建账号：`ADMIN_SEED_EMAIL=… ADMIN_SEED_NAME=… ADMIN_SEED_PASSWORD=… [ADMIN_SEED_ROLE=SALES] pnpm admin:create`（密码 ≥12 位，argon2id 哈希；凭据只走环境变量）。
- 绑定 2FA（账号未开 2FA 前不能登录，两步都要同源 `Origin`）：
  1. `POST /api/admin/auth/enroll` `{ email, password }` → `{ otpauthUri }`（每次调用换新密钥；已开启的账号返回 401）。
  2. `POST /api/admin/auth/enroll/confirm` `{ email, password, totp }` → `{ recoveryCodes: [10 个] }`，只返回这一次，服务端只存哈希。
- 登录：Auth.js 标准流程，`GET /api/auth/csrf` 取 token，再 `POST /api/auth/callback/credentials`（表单字段 `csrfToken, email, password, totp` 或 `recoveryCode`）。任何一步失败统一返回 `CredentialsSignin`，不区分原因。
- 会话：JWT，2 小时有效；cookie HttpOnly、SameSite=Lax，生产强制 Secure（`__Secure-` 前缀）。每次请求核对 `User.sessionVersion`、禁用、2FA 状态，不一致即失效（改密码/重置 2FA 时调用 `revokeSessions()`）。
- 防爆破：10 分钟内 IP+账号 5 次、单账号 10 次、单 IP 30 次；同一账号连续 5 次失败锁定 15 分钟。TOTP 同一时间步只能用一次，恢复码用后作废。
- 审计：`auth.login_success / auth.login_fail(reason) / auth.lockout / auth.totp_enroll_start / auth.totp_enabled`，不记密码、验证码、token。

## 后台接口（`/api/admin/*`）
所有路由都调用 `requireAdmin(req, roles)`（`src/lib/server/auth.ts`）：未登录 401，角色不符 403；非 GET 请求还要求 `Origin` 与站点同源，否则 403 `bad_origin`。响应都带 `Cache-Control: private, no-store`，每个操作写 AuditLog（只记 id、状态变化，不记邮件正文）。角色：`ADMIN` 全部可见；`SALES` 只能看和操作分配给自己的询盘，不能改分配；`EDITOR` 无询盘权限。

- `GET /api/admin/inquiries?page=1&pageSize=20&status=NEW&minScore=0&maxScore=100&q=关键词` → `{ page, pageSize, total, items: [{ id, ref, status, source, locale, trustScore, ipCountry, createdAt, assigneeId, contact: { name, email, company, region }, _count: { items, messages } }] }`。`q` 搜编号、留言、联系人姓名/邮箱/公司；`pageSize` ≤100。
- `GET /api/admin/inquiries/:id` → 询盘全部字段（不含 `replyToken`）+ `contact, items, messages, notes, sample, assignee`。
- `PATCH /api/admin/inquiries/:id` `{ status?, assigneeId? }`（`assigneeId` 仅 ADMIN）→ `{ id, status, assigneeId, updatedAt }`。
- `POST /api/admin/inquiries/:id/reply` `{ subject ≤200, body ≤20000 纯文本 }` → 201 新的 `InquiryMessage`。正文全部转义、换行转 `<br>`，主题去换行；配置 `REPLY_DOMAIN` 后 Reply-To 为 `reply+<token>@域名`。发信失败返回 502 `mail_failed`，不入库。
- `POST /api/admin/inquiries/:id/notes` `{ body ≤5000 }` → 201 新备注。

### 规划中
- `PATCH /samples/:id`、`POST /models`、`POST /models/:id/process`、`PATCH /models/:id`、`GET|PUT /settings/:key`、`GET /stats`
- 改密码、重置 2FA、账号管理接口（需调用 `revokeSessions()`）

## 待定
- 客户回信自动归档：需要正式域名后接 Resend 收信。

## 模型处理状态
`GET /api/admin/models/:id` 返回 `status` 和 `checks`：
```json
[{ "key": "format", "ok": true, "detail": "glTF 2.0 binary" }, { "key": "size", "ok": false, "detail": "1.24MB / 1MB" }]
```
`key` 取值 `format | compress | lod | size`，前端按顺序显示。
