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

## 后台接口（`/api/admin/*`，需登录，按角色校验）
- `GET /inquiries?status=&region=&product=&minScore=`，业务员只能看到分给自己的
- `GET /inquiries/:id`，`PATCH /inquiries/:id`（状态、分配）
- `POST /inquiries/:id/reply`（按客户语言发信，存入往来记录）
- `POST /inquiries/:id/notes`
- `PATCH /samples/:id`
- `POST /models`（拿上传地址）、`POST /models/:id/process`、`PATCH /models/:id`
- `GET|PUT /settings/:key`
- `GET /stats`
- `GET /uploads/:id`：查看询盘 logo（重新编码后的 PNG），响应头 `Content-Disposition: inline`、`X-Content-Type-Options: nosniff`、`Cache-Control: private, no-store`。后台登录还没做，现在生产环境一律 401；开发环境设置 `ADMIN_DEV_TOKEN` 后带请求头 `x-admin-dev-token` 可访问（TODO：接 Auth.js）。

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
