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
返回 `201 { "ref": "PJ-2026-0001" }`。会给业务邮箱发通知、给客户发对应语言的自动回复。

### `POST /api/designs` 和 `GET /api/designs/:id`
保存定制方案，返回 `{ "id": "abc123XYZ0", "url": "/s/abc123XYZ0" }`。`/s/*` 页面带 `noindex`。

### `POST /api/uploads/logo`
返回 R2 预签名上传地址。只允许 PNG、SVG、PDF，最大 5MB；服务端按文件头校验，SVG 先清洗，文件不公开、30 天后删除。

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

## 待定
- 客户回信自动归档：需要正式域名后接 Resend 收信。
