# SEO 规范与关键词地图（v0.1）

> 本版**没有搜索量数据**，优先级（P1/P2/P3）按商业意图和竞争程度人工判断。接入关键词工具（如 Ahrefs、Semrush、Yandex Wordstat）后再补数据、调整分配。

## 1. 网址与多语言
- 语言子目录：`/en/`、`/ru/`；`x-default` 指向 `/en/`。
- **每个页面**都要输出自己的 hreflang（en、ru、x-default）和指向自身的 canonical，不能全站共用首页的地址。
- 俄语页面的网址用拉丁字母音译（如 `/ru/products/gofrokorobki`），标题、描述、正文用俄语原生撰写，不直译英文。
- 网址全部小写，用连字符，不带参数；`/s/`、`/admin`、`/api/` 不收录。
- 非正式环境（`VERCEL_ENV !== 'production'`）整站 `noindex` 并在 robots.txt 中全部屏蔽。

## 2. 页面模板要求
| 页面类型 | title 模板 | H1 | 结构化数据 |
|---|---|---|---|
| 首页 | `Custom Packaging Manufacturer \| PackJoyU` | 品牌定位一句话 | Organization、WebSite |
| 3D 展示页 | `3D Packaging Showroom \| PackJoyU` | 展示页标题 | ItemList（链接到各产品页）、BreadcrumbList |
| 产品落地页 | `{主关键词} Manufacturer & Supplier \| PackJoyU` | 主关键词 | Product（不填价格）、FAQPage、BreadcrumbList |
| 行业方案页 | `{行业} Packaging Solutions \| PackJoyU` | 行业 + packaging | BreadcrumbList、FAQPage |
| 文章 | 问题式标题 | 同标题 | Article、BreadcrumbList |

- title ≤ 60 字符，description 120–155 字符，每页唯一。
- 产品页正文 300–500 字以上：介绍、材质与工艺、规格表、MOQ 与交期、应用场景、FAQ（3–6 条）、询价按钮。
- 图片：WebP/AVIF，文件名用关键词，alt 用描述性文字；3D 模型旁边必须有可抓取的文字说明。
- 每页至少 3 条内链：相关产品、相关行业页、相关文章。

## 3. 关键词地图（英语）
| 页面 | 主关键词 | 辅助/长尾关键词 | 优先级 |
|---|---|---|---|
| /en/products/corrugated-boxes | custom corrugated boxes | corrugated shipping boxes manufacturer, printed mailer boxes, corrugated box supplier China | P1 |
| /en/products/color-boxes | custom printed boxes | color printed packaging boxes, retail product boxes, folding carton manufacturer | P1 |
| /en/products/gift-boxes | custom gift boxes | rigid gift boxes wholesale, luxury gift box manufacturer, magnetic gift box | P1 |
| /en/products/pulp-molding | molded pulp packaging | molded pulp trays, sugarcane pulp packaging, eco-friendly pulp inserts | P1 |
| /en/products/paper-cups | custom paper cups | printed coffee cups wholesale, disposable paper cups manufacturer | P1 |
| /en/products/eco-paper-cups | compostable paper cups | biodegradable coffee cups, PLA-free paper cups, plastic-free cups supplier | P1 |
| /en/products/wine-boxes | custom wine boxes | wine gift box packaging, bottle packaging boxes, luxury wine box manufacturer | P2 |
| /en/products/party-supplies | custom party supplies | paper party tableware wholesale, printed paper plates and cups | P2 |
| /en/products/christmas-merchandise | christmas packaging | christmas gift boxes wholesale, custom christmas merchandise, advent calendar boxes | P2（季节性，9 月前上线） |
| /en/products/gift-cards | custom gift card printing | gift card packaging, printed greeting cards manufacturer | P3 |
| /en/products/color-printing | packaging printing services | CMYK printing packaging, custom label and box printing | P3 |
| /en/products/offset-printing | offset printing packaging | offset printed boxes, offset printing manufacturer China | P3 |

### 行业方案页（第一期）
| 页面 | 主关键词 |
|---|---|
| /en/solutions/food-beverage | food packaging solutions, coffee shop packaging |
| /en/solutions/wine-spirits | wine and spirits packaging |
| /en/solutions/ecommerce | ecommerce packaging, subscription box packaging |
| /en/solutions/holiday-gifts | holiday gift packaging, seasonal packaging |

### 首批文章选题（5–10 篇）
1. How to Choose the Right Corrugated Flute Type (A, B, C, E, F)
2. Sustainable Packaging Certifications Explained: What Buyers Ask For (generic explainer; no PackJoyU certification claims until Ryan confirms — #218 F18)
3. EU Single-Use Plastics Directive: What It Means for Paper Cups
4. Molded Pulp vs. Plastic Inserts: Cost, Protection and Sustainability
5. Rigid Box vs. Folding Carton: Which Is Right for Your Product?
6. Packaging MOQ and Lead Time Explained for Importers
7. How to Prepare Artwork Files for Custom Box Printing
8. Offset vs. Digital Printing for Packaging

## 4. 关键词地图（俄语，初稿，需俄语母语者校对）
| 页面 | 主关键词 | 优先级 |
|---|---|---|
| /ru/products/gofrokorobki | гофрокороба на заказ, производство гофрокоробов | P1 |
| /ru/products/podarochnye-korobki | подарочные коробки оптом, жесткие подарочные коробки | P1 |
| /ru/products/bumazhnye-stakany | бумажные стаканы с логотипом, бумажные стаканчики оптом | P1 |
| /ru/products/ekologichnye-stakany | биоразлагаемые стаканы, эко стаканы | P1 |
| /ru/products/izdeliya-iz-tsellyulozy | упаковка из формованной целлюлозы | P2 |
| /ru/products/upakovka-dlya-vina | коробки для вина на заказ | P2 |
| /ru/products/tsvetnye-korobki | картонные коробки с печатью | P2 |
| 其余产品 | 按英语页结构对应，内容上线前补齐 | P3 |

## 5. 上线检查清单
- [ ] 每页独立 canonical 和 hreflang（en、ru、x-default）
- [ ] 每种语言单独 sitemap，并在 robots.txt 中声明
- [ ] Organization、Product、FAQPage、BreadcrumbList 用 Rich Results Test 校验通过
- [ ] Google Search Console、Bing Webmaster、Yandex Webmaster 验证并提交 sitemap
- [ ] LCP < 2.5s、CLS < 0.1、INP < 200ms（真实用户数据）
- [ ] 开屏视频和 Cookie 条不遮挡正文，HTML 中直接包含标题和正文
- [ ] 404 页面、301 重定向规则、无死链
- [ ] 正式环境移除 noindex，预览环境保持 noindex

## 6. Sanity 内容结构需要的 SEO 字段
每种语言分别有：`slug`、`seoTitle`、`seoDescription`、`h1`、`ogImage`、`faq[]`（问题、答案）、`relatedProducts[]`、`relatedSolutions[]`，图片带 `alt`。
