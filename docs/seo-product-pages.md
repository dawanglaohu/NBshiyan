# 产品详情页 SEO 方案（Refs #76）

## 1. 网址规则
- 英语：`/en/products/{slug}`，slug 用主关键词，例如 `custom-corrugated-boxes`、`custom-gift-boxes`、`eco-paper-cups`。
- 俄语：`/ru/products/{slug}`，slug 用拉丁音译，见 `docs/seo-keywords-ru.md`，例如 `gofrokorobki`。
- 每种语言的 slug 存在 Sanity（或产品数据）里，`alternatesFor` 按产品读取各语言 slug 输出 hreflang，不能拼同一个路径。
- 3D 展示页 `/products` 的卡片链接到详情页，链接文字用品类名（如 “Custom corrugated boxes”），不用单独的 “Learn more”。
- slug 一旦上线不要改；必须改时做 301 重定向。

## 2. 页面结构（服务端渲染，爬虫可读）
1. H1：主关键词（如 “Custom Corrugated Boxes”）
2. 首段 2–3 句：是什么、给谁用、PackJoyU 的优势
3. 主图（WebP，文件名带关键词）+ 3D 模型（客户端增强）
4. 规格表：材质、尺寸范围、印刷方式、表面工艺、MOQ、打样周期、量产交期
5. 应用场景：3–4 个行业，各链接到行业方案页
6. FAQ：3–6 条真实采购问题
7. 询价按钮 + 相关产品（3 个内链）
- 正文总量不少于 300 字。

## 3. 元信息模板
| 字段 | 英语 | 俄语 |
|---|---|---|
| title | `{主关键词} Manufacturer & Supplier \| PackJoyU` | `{主关键词} — производство на заказ \| PackJoyU` |
| description | `{一句卖点}. Custom sizes, printing and finishes. MOQ from {moq}. Request a quote.` | `{一句卖点}. Любые размеры, печать и отделка. Тираж от {moq}. Запросите расчет.` |
- title ≤ 60 字符，description 120–155 字符；俄语直接撰写，不机翻。
- Open Graph 图用该品类主图，1200×630。

## 4. 结构化数据
- `Product`：name、description、image、brand（PackJoyU）、category、sku 可选。**不写 offers/价格**（不做在线交易），也不写虚构的 aggregateRating 或 review。
- `FAQPage`：与页面上可见的 FAQ 完全一致。
- `BreadcrumbList`：首页 → Products → 当前品类。
- 上线前用 Google Rich Results Test 和 Yandex 的结构化数据校验工具检查。

## 5. 图片
- 文件名：`posters/custom-corrugated-boxes.88879bdf.webp` 这类带关键词的名字，不用哈希。
- alt：描述画面，例如 “Printed kraft corrugated mailer box with logo”。

## 6. Yandex 与搜索平台接入准备
- 代码已支持站点验证：设置环境变量 `NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION`、`NEXT_PUBLIC_YANDEX_VERIFICATION`、`NEXT_PUBLIC_BING_VERIFICATION` 后会输出对应的 meta 标签。
- 上线并有正式域名后：
  1. 在 Yandex Webmaster 添加站点、填入验证码、提交 `sitemap.xml`。
  2. 在 Yandex Webmaster 的“地区”设置中不绑定单一城市（面向全俄）。
  3. Google Search Console、Bing Webmaster 同样验证并提交 sitemap。
- 这些平台需要 Ryan 用自己的账号登录，届时在私聊里完成。
