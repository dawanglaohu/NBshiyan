# 品类落地页 SEO 验收清单（Refs #99）

范围：`/{locale}/products/{slug}`，共 12 个品类，每个有英俄两版，合计 24 个地址。slug 以 `src/lib/seo/categoryMeta.ts` 为准。
相关 PR：#188 文案，#192 JSON-LD，#198 sitemap 和 `CATEGORY_PAGES_LIVE` 开关，#201 `pageMeta.ts`，#205 内链地图和 Sanity 导入。

## 1. 标题结构
- [ ] 每页**只有一个 `<h1>`**，文字是 #188 里的 H1（英文例如 “Custom Corrugated Boxes”，俄文例如 «Гофрокороба на заказ»），不带品牌名。品牌名只出现在 `<title>` 里。
- [ ] H2 按下面的顺序：卖点（Why PackJoyU / Почему PackJoyU）→ 规格与选项 → 流程 → FAQ（定稿后才有）→ 相关产品 → 延伸阅读。规格表是 `<table>` 或 `<dl>`，不能用图片代替。
- [ ] 标题不跳级（没有 H2 不出现 H3），Logo、导航、页脚里不用 H1 或 H2。
- [ ] 所有正文在服务端渲染的 HTML 里（看 `curl` 拿到的源码，不看 DevTools），3D 模型只是在客户端追加的增强。

## 2. 内链（按 `docs/content/internal-links.json`）
- [ ] 筛选 `from` 等于当前地址的条目：`category→category` 放在“相关产品 / Похожие товары”，`category→article` 放在“延伸阅读 / Полезные статьи”，锚文本照抄 `anchor`。
- [ ] 链接是 `<a href="/{locale}/...">` 相对路径，只链同语言页面，不加 `nofollow`。
- [ ] 面包屑：首页 → Products → 当前品类，每级都能点（不含当前页）。
- [ ] `/products` 3D 展示页的卡片链接到对应语言的落地页，锚文本用品类名。

## 3. 结构化数据（`src/lib/seo/jsonld/`，#192）
- [ ] 输出 `buildProductJsonLd(key, locale)`。默认**不带** offers、价格、aggregateRating、review、additionalProperty；只有真实数据存在时才传可选参数。`image` 传主图的地址。
- [ ] 输出 BreadcrumbList，和页面上可见的面包屑一致。
- [ ] `buildFaqJsonLd` 默认关闭（`NEXT_PUBLIC_FAQ_JSONLD_ENABLED` 不设）。打开后，JSON-LD 的问答必须和页面上看得到的 FAQ 逐字一致，答案里不能有 TBD。
- [ ] 用 Google Rich Results Test 和 Yandex 结构化数据校验工具各抽查 2 页，没有错误。

## 4. 图片
- [ ] 主图用 `next/image`，设置 `priority`、明确的 `width` 和 `height`（避免布局偏移），格式 WebP，文件名 `posters/custom-<内部 key>.webp`。
- [ ] `alt` 按语言写，描述画面内容（例如 “Printed kraft corrugated mailer box with logo” / «Почтовая коробка из крафт-гофрокартона с логотипом»），不堆关键词。俄语 alt 要 Ryan 校对。
- [ ] 主图以外的图片懒加载，都带 width、height 和 alt。纯装饰图用 `alt=""`。
- [ ] 首屏 LCP：桌面不超过 2 秒，手机不超过 3 秒（真机或 Lighthouse 移动端测试）。

## 5. 元信息（`pageMeta.ts`，#201）
- [ ] 用 `pageMetadata()` 生成。title 和 description 来自 `categoryMeta.ts`，title 不超过 60 个字符，description 120 到 160 个字符。
- [ ] canonical 是当前语言的完整地址，开头是 `NEXT_PUBLIC_SITE_URL`。
- [ ] hreflang 有三条：en、ru、x-default（指向 en），每条都指向**各自语言的 slug**，不能把同一个 slug 套到两种语言上。
- [ ] `og:url` 等于 canonical。`og:image` 是完整网址、1200×630，带按语言写的 alt，图片用 `og/<en-slug>-<locale>.jpg`，没有就退回首页图。`og:locale` 是 en_US 或 ru_RU，再加上 `og:locale:alternate`。
- [ ] `<html lang>` 和当前语言一致。

## 6. noindex 规则
- [ ] 页面上还有 **TBD**、占位文案或者没校对的俄语时，设 `robots: noindex, follow`，sitemap 里也不放这页。Sanity 的 `seo.noindex` 和 #205 导入时的默认值都是 true。
- [ ] 去掉 noindex 需要 Ryan 确认这一页的内容。
- [ ] 非生产环境（`isProdEnv` 为 false）整站 noindex，robots.txt 禁止抓取，这一条不变。
- [ ] 带参数的地址（`?utm=`、`?color=` 等）canonical 指向不带参数的地址。

## 7. `CATEGORY_PAGES_LIVE` 开关（#198）
### 打开前（在预览环境检查）
- [ ] 24 个地址全部返回 200，没有一个经过重定向，用 `curl -o /dev/null -w '%{http_code}'` 逐个查。
- [ ] 第 1 到 6 节都通过；FAQ 没定稿就不显示，也不输出 FAQ 的 JSON-LD。
- [ ] 用内部 key 的旧地址（例如 `/en/products/color-boxes`），以及用错语言的 slug（例如 `/en/products/gofrokorobki`）都要 **301** 到正确的语言 slug。不能 302，也不能变成 404。
- [ ] 不存在的 slug 返回真正的 404 状态码，404 页上有品类链接。
- [ ] 站内没有坏链：从首页和 `/products` 一路抓下去，没有任何 404。
- [ ] 前端过期页的链接改成对应语言的 slug（#164）。

### 打开后（生产环境）
- [ ] `/sitemap.xml` 里有这 24 个地址，每条都带 en、ru、x-default 三个 alternates，开头是正式的 https 域名。被 noindex 的页面不在里面。
- [ ] 抽查几个页面，确认没有 noindex 的 meta 标签和 `X-Robots-Tag`，robots.txt 允许抓取 `/en/products/` 和 `/ru/products/`。
- [ ] 在 GSC、Yandex Webmaster、Bing 重新提交 sitemap（需要 Ryan 登录，见 #74 和 `docs/yandex-webmaster-setup.md`）。如果 IndexNow 已经做了，推送这 24 个地址。
- [ ] 一周后看三个平台的抓取错误和收录情况。
