# geiom.com 上线后：验证、提交和收录检查

> 适用：**部署成功、验收通过以后**（[`seo-cutover-geiom.md`](./seo-cutover-geiom.md) 第 1、2 节全部通过）。本文不挡上线。
> 依据代码：`origin/main` `19739db`。文中的 URL、规则和开关都按代码核对过，对应文件写在括号里。代码里查不到的事项标 **待 Ryan 决定**。
> 本文不写任何源站 IP、密钥、`X-Edge-Auth` 的值或验证 TXT 的值。验证值一律写成 `{{待Ryan确认}}`。

```bash
S=https://geiom.com
```

## 0. 谁做什么

- 🔑 **GSC、Yandex 只能由 Ryan 用自己的账号操作**，在私聊里进行，不在群里做。其他人（包括所有机器人）都**不登录 Ryan 的账号**，也**不保存他的账号或密码**。
- 验证值由 Ryan 从自己的账号里取，**私信**发给运维。运维把它作为一次**单独的** DNS 变更加上 TXT，不和 `_dmarc` 或其他 DNS 改动放在同一批。
- SEO 不改 DNS，只负责第 3、4 节的检查和第 5 节的观察。
- 顺序：第 1 节验证 GSC → 第 2 节验证 Yandex → 两边都验证通过后，再按第 3 节提交 sitemap → 第 4 节每次提交前后都跑一遍 → 第 5 节在第 1、3、7 天各看一次。

## 1. Google Search Console 验证 🔑

1. Ryan 登录 GSC → 添加资源 → 选「**网域**」（Domain property）→ 填 `geiom.com`。网域资源会自动覆盖 http/https 和 www/裸域，不用另外加网址前缀资源。
2. GSC 给出一条 TXT 记录：`google-site-verification={{待Ryan确认}}`。Ryan 把这个值**私信**发给运维。
3. 运维单独做一次 DNS 变更，在 `geiom.com`（主机名 `@`）**新增**这条 TXT。已有的 TXT（SPF 等）只新增、不覆盖，同一主机名下可以有多条 TXT。
4. 检查 TXT 是否已经生效（只看有没有这条记录，不把值发到群里）：
   ```bash
   dig +short TXT geiom.com | grep -c google-site-verification   # ≥ 1
   ```
5. Ryan 回 GSC 点「验证」。**验证通过以后不要删这条 TXT**，删了会掉验证。
6. 代码也支持 meta 验证（`NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION` → `src/app/[locale]/layout.tsx` 的 `verification.google`），但要在构建时设值，而且只能验证网址前缀资源。这里统一用 DNS TXT。

## 2. Yandex Webmaster 验证 🔑

1. Ryan 登录 Yandex Webmaster → 添加站点 `https://geiom.com`。这个地址要和 `NEXT_PUBLIC_SITE_URL` 完全一致。
2. 验证方式：**DNS TXT**。Yandex 给出 `yandex-verification: {{待Ryan确认}}`，Ryan 私信发给运维，运维单独做一次 DNS 变更，给 `geiom.com` 新增。验证后不要删。
   ```bash
   dig +short TXT geiom.com | grep -c yandex-verification   # ≥ 1
   ```
   - **为什么首选 DNS TXT**：代码也支持 meta 方式（`NEXT_PUBLIC_YANDEX_VERIFICATION` → `<meta name="yandex-verification">`），但这个标签只在 `/en`、`/ru` 页面上输出。根路径 `/` 会 307 跳到 `/en`，而 Yandex 的 meta 验证查首页，首页有跳转就会失败（[`yandex-webmaster-setup.md`](./yandex-webmaster-setup.md) §2 第 5 条）。另外，改 meta 值要重新构建。
3. **只加裸域 `https://geiom.com`。** Yandex 把 www 和裸域当成两个站，但 `www` 和 `http://` 都由 nginx 一跳 301 到 `https://geiom.com`（[`seo-cutover-geiom.md`](./seo-cutover-geiom.md) 第 0、2.5 节），主镜像由这个 301 决定，不需要另外设置。
   - **待 Ryan 决定**：只有在 `https://www.geiom.com` 或 `http://` 版本已经被 Yandex 收录时，才需要把它也加进来、验证，再在 Indexing → Relocate site 提交搬迁（[`yandex-webmaster-setup.md`](./yandex-webmaster-setup.md) §3）。新站一般不需要。
4. **站点地区：待 Ryan 决定，可以不设。** 是否申请地区、选哪个地区由 Ryan 决定，要和网站上写明的服务范围、联系方式一致，不能为了通过审核编造地址或电话（[`yandex-webmaster-setup.md`](./yandex-webmaster-setup.md) §4）。地区要设在主地址 `https://geiom.com` 上。

## 3. 提交 sitemap 🔑（两边都验证通过之后）

代码实际输出的 sitemap 只有一个：`https://geiom.com/sitemap.xml`（`src/app/sitemap.ts`，`revalidate = 3600`，没有 sitemap index）。

提交前先跑第 4.1 节的 robots.txt 检查，确认 `Sitemap:` 那一行正确。

- **GSC**：站点地图 → 提交 `https://geiom.com/sitemap.xml`，状态应为「成功」，「已发现的网页」数应等于第 4.2 节数出来的 URL 数。
  - 网址检查：`https://geiom.com/en`、`https://geiom.com/ru` → 「测试实际网址」应显示可以编入索引 → 「请求编入索引」。可以再加 `/en/products`、`/ru/products`。
- **Yandex**：Индексирование → Файлы Sitemap → 添加 `https://geiom.com/sitemap.xml`。可选：Переобход страниц 提交 `/en`、`/ru`。
- **以后什么时候要重新提交**：sitemap 内容有变化时，例如 `/solutions`、`/factory` 去掉 noindex、`CATEGORY_PAGES_LIVE` 或 `PRIVACY_PAGE_COMPLETE` 打开、有了第一篇可索引文章。

## 4. 线上检查（每条都有 PASS / FAIL 标准）

> 仓库外有一个脚本可以一次跑完本节（SEO 本地保管，不进仓库）：`seo-indexing-check.sh https://geiom.com`，它只输出 PASS / FAIL / SKIP，不打印响应正文和响应头。下面是逐条的手动命令，结果以手动命令为准。

### 4.1 robots.txt（`src/app/robots.ts`）

生产环境（构建时 `APP_ENV=production`）应该**正好**是：

```
User-Agent: *
Allow: /
Disallow: /admin
Disallow: /*/admin
Disallow: /s/
Disallow: /*/s/
Disallow: /api/

Sitemap: https://geiom.com/sitemap.xml
```

```bash
curl -s -o /dev/null -w '%{http_code}\n' $S/robots.txt              # 200
curl -s $S/robots.txt | grep -cx 'Disallow: /'                     # 0（有就是非生产构建）
curl -s $S/robots.txt | grep -x 'Sitemap: https://geiom.com/sitemap.xml'
curl -s $S/robots.txt | grep -Eci 'localhost|vercel|staging|http://|www\.'   # 0
```

- **PASS**：200；有 `Allow: /`；Disallow 正好是上面 5 条；只有一行 `Sitemap:`，而且是绝对地址 `https://geiom.com/sitemap.xml`；没有 localhost、vercel、staging、http://、www。
- **FAIL**：出现 `Disallow: /`，说明构建时 `APP_ENV` 不是 `production`（`isProdEnvFrom()`，`src/lib/site.ts`），按 [`seo-cutover-geiom.md`](./seo-cutover-geiom.md) §6.1 重新构建。`Sitemap:` 是别的域名，说明构建时 `NEXT_PUBLIC_SITE_URL` 不对。

### 4.2 sitemap.xml 的 URL 列表（`src/lib/seo/sitemapEntries.ts`）

**按当前代码，生产 sitemap 应该正好是这 6 个 URL**（`STATIC_PAGES`），加上 Sanity 里有可索引文章时的文章 URL：

| URL | 来源 |
|---|---|
| `https://geiom.com/en`、`https://geiom.com/ru` | `STATIC_PAGES` 首页 |
| `https://geiom.com/en/products`、`https://geiom.com/ru/products` | `STATIC_PAGES` |
| `https://geiom.com/en/contact`、`https://geiom.com/ru/contact` | `STATIC_PAGES` |
| `https://geiom.com/{en,ru}/articles` | 该语言至少有一篇可索引文章时才有（`buildCmsEntries`） |
| `https://geiom.com/{en,ru}/articles/<slug>` | Sanity 文章，`seo.noindex` 的跳过，每种语言只在该语言 slug 存在时输出 |

Sanity 没配置或请求失败时，`sanityFetch` 返回 null，sitemap 里就没有文章条目，只剩 6 个固定 URL。

```bash
curl -s -o /dev/null -w '%{http_code}\n' $S/sitemap.xml     # 200
curl -s $S/sitemap.xml | grep -o '<loc>[^<]*</loc>' | sed 's/<[^>]*>//g' | sort > /tmp/sm.txt
wc -l < /tmp/sm.txt                                          # 6 + 文章数
grep -vc '^https://geiom\.com/' /tmp/sm.txt                  # 0
sort /tmp/sm.txt | uniq -d | wc -l                           # 0（没有重复）
grep -Ec '/(en|ru)/products/.|/solutions|/factory|/cases|/privacy|/api|/admin|/s/|/og(/|$)|\.(jpg|png|webp)$' /tmp/sm.txt   # 0
```

**必须不在 sitemap 里**（出现任何一条都是 FAIL）：

- 品类页 `/{en,ru}/products/<slug>`：`CATEGORY_PAGES_LIVE = false`（`src/lib/seo/categoryPages.ts`），这时 `[locale]/products/[slug]` 一律 404。12 个品类的 en / ru slug 见 `src/lib/seo/categoryMeta.ts`，例如 `custom-gift-boxes` / `podarochnye-korobki`。
- `/{en,ru}/solutions`，以及 6 个 `/{en,ru}/solutions/<slug>`：`color-boxes`、`corrugated-boxes`、`paper-cups`、`party-supplies`、`wine-boxes`、`gift-boxes`（`src/lib/solutions.ts` 的 `INDUSTRIES`）。这些页都是 `index: false`。
- `/{en,ru}/factory`（`index: false`）和 `/{en,ru}/cases`（`index: false, follow: false`）。
- `/{en,ru}/privacy`：`PRIVACY_PAGE_COMPLETE = false`（`src/lib/legal/privacy.ts`）。
- `/api/*`、`/admin`、`/s/*`、`/{en,ru}/s/*`。
- OG 图：现在是静态文件 `/og/<slug>-<locale>.jpg?v=…`（`src/lib/seo/pageMeta.ts`），以后还有文章的 `/{en,ru}/articles/<slug>/og` 路由（见第 4.6 节）。任何 `/og` URL 都不能进 sitemap。

**逐个 URL 检查**（200、可索引、canonical 指向自身）：

```bash
while read u; do
  h=$(curl -s -D - -o /tmp/p -w '%{http_code}' "$u")
  code=${h: -3}
  xr=$(printf '%s' "$h" | grep -ci '^x-robots-tag:.*noindex')
  mr=$(grep -Eo '<meta[^>]+name="robots"[^>]*>' /tmp/p | grep -ci noindex)
  can=$(grep -Eo '<link[^>]+rel="canonical"[^>]+>' /tmp/p | grep -Eo 'href="[^"]+"' | sed 's/href="//;s/"$//')
  [ "$code" = 200 ] && [ "$xr" = 0 ] && [ "$mr" = 0 ] && [ "$can" = "$u" ] && echo "PASS $u" || echo "FAIL $u code=$code xrobots=$xr meta=$mr"
done < /tmp/sm.txt
```

- **PASS**：每个 URL 都是 200（不跟随跳转），没有 `X-Robots-Tag: noindex`，没有 `<meta name="robots" content="noindex">`，而且只有一个 canonical，等于这个 URL 本身。
- **FAIL**：出现 3xx、404 或 noindex，或者 canonical 指向别处。只要 sitemap 里有一个 URL 是 noindex，就是代码问题，报给 SEO，不要只在 GSC 里忽略。
- 注意：Next 15.5 会把动态页的 metadata 流式输出到 `<body>` 里，所以上面是在整页 HTML 里 grep，不只看 `<head>`。

### 4.3 hreflang（`src/i18n/alternates.ts`、`src/lib/seo/sitemapEntries.ts`）

代码输出 hreflang 有两处，两处必须一致：

- **sitemap**：每个 `<url>` 下的 `<xhtml:link rel="alternate" hreflang=…>`。
- **HTML**：`<link rel="alternate" hrefLang="…" href="…"/>`。

**固定页和文章列表页**：每页都是 `en`、`ru`、`x-default` 三条，`x-default` 等于 en 版本，例如 `/ru/products` 是：

```
en        → https://geiom.com/en/products
ru        → https://geiom.com/ru/products
x-default → https://geiom.com/en/products
```

**文章详情页**：只列出 slug 存在的语言。

```bash
# sitemap 里每个 URL 的 xhtml:link 条数（固定页应为 3）
curl -s $S/sitemap.xml | grep -c 'xhtml:link'
# HTML：
for p in /en /ru /en/products /ru/products /en/contact /ru/contact; do echo "== $p"
  curl -s $S$p | grep -Eo '<link rel="alternate" hrefLang="[^"]+" href="[^"]+"'; done
```

- **PASS**：
  - 每个 URL 在 sitemap 和 HTML 里列出的 hreflang 完全相同；
  - en 和 ru 互相指向对方，而且对方也在 sitemap 里，列出同一组；
  - 列表中当前语言那一条指向自己；
  - `x-default` 等于 en 版本；
  - 所有 href 都是 `https://geiom.com/...`。
- **FAIL**：两边不一致；只有单向指向；指向 404 或 noindex 的页面；出现别的域名或 localhost。
- **没有 HTTP Link 头**：`src/i18n/routing.ts` 设了 `alternateLinks: false`，next-intl 不再发 `Link: …; rel="alternate"; hreflang=…` 响应头。
  ```bash
  for p in /en /ru /en/products; do curl -sI $S$p | grep -i '^link:' | grep -ci hreflang; done   # 都是 0
  ```

### 4.4 跳转

```bash
curl -sI -H 'Accept-Language: en' $S/ | grep -iE '^(HTTP|location)'       # 307，Location: /en 或 https://geiom.com/en
curl -sI -H 'Accept-Language: en' "$S/?q=1" | grep -iE '^(HTTP|location)' # 307，Location: /en?q=1
curl -sI $S/ | grep -Eci 'localhost|127\.0\.|0\.0\.0\.0'                   # 0
curl -sI $S/nope.png | grep -i '^HTTP'                                     # 404，不能是 5xx
curl -sIL 'http://geiom.com/en?a=1'      | grep -iE '^(HTTP|location)'     # 一个 301 → https://geiom.com/en?a=1，然后 200
curl -sIL 'http://www.geiom.com/ru?a=1'  | grep -iE '^(HTTP|location)'     # 一个 301 → https://geiom.com/ru?a=1，然后 200
curl -sIL 'https://www.geiom.com/ru?a=1' | grep -iE '^(HTTP|location)'     # 一个 301 → https://geiom.com/ru?a=1，然后 200
```

- **PASS**：
  - `/` 由 next-intl middleware 按 `NEXT_LOCALE` cookie 或 `Accept-Language` 选语言，返回 307。#328 之后，Location 是相对路径 `/en`（`src/lib/edge/redirect-location.ts`），经过 nginx 后可能是相对路径，也可能是 `https://geiom.com/en`，两种都算 PASS。
  - 任何响应头里都没有本机地址。
  - http 和 www 都只跳一次 301，路径和查询串保留，目标返回 200。
- **FAIL**：Location 里有 localhost、127.x、0.0.0.0 或别的域名；http 或 www 跳了两次以上（比如先 http→https 再 www→裸域）。

### 4.5 sitemap 里的 URL 不能被 X-Robots-Tag 误伤

`next.config.ts` 只在非生产构建时给全站加 `X-Robots-Tag: noindex, nofollow`。生产环境下只有 `/admin`、`/api/admin/*`、`/s/*`，以及 middleware 返回的 `/s/<id>` 410 和 503 带这个头。第 4.2 节的逐个 URL 检查已经覆盖了这一点。

### 4.6 文章 OG 图（**只在 UX 的文章 OG PR 合并、而且生产上已经有文章以后才适用**）

现在 main 上还没有 `/{en,ru}/articles/<slug>/og` 路由，文章页用的是首页的静态 OG 图作为兜底。等那个 PR 合并、生产上有了文章以后：

```bash
A=<sitemap 里的一篇文章路径，例如 /en/articles/xxx>
curl -sI "$S$A/og" | grep -iE '^(HTTP|content-type|x-robots-tag)'
#   200；Content-Type: image/…；X-Robots-Tag 含 noindex
for l in en ru; do curl -sI "$S/$l/articles/__no-such-article__/og" | grep -iE '^(HTTP|location|x-robots-tag|cache-control)'; done
#   302；Location: https://geiom.com/og/home-$l.jpg；X-Robots-Tag 含 noindex；Cache-Control 含 no-store
curl -s "$S$A" | grep -Eo '<meta (property|name)="(og:image|og:image:width|og:image:height|twitter:image)"[^>]*>'
#   只有一个 og:image，等于 https://geiom.com$A/og（可以带 ?v=）；twitter:image 和它相同；宽 1200，高 630
curl -s $S/sitemap.xml | grep -Ec '/og(/|<|\?)'   # 0：sitemap 里不能有任何 /og URL
```

- **PASS**：上面每一条都和注释一致。
- **FAIL**：og:image 有多个，或者还指向首页兜底图；`/og` 返回 HTML 或没有 noindex；不存在的 slug 返回 500、404，或者跳到别的域名；sitemap 里出现 `/og`。

## 5. 第 1、3、7 天的收录检查 🔑（GSC / Yandex 部分由 Ryan 看）

> Google 和 Yandex 都**不保证**多久收录，也不保证一定收录。下面的天数只是我们自己安排的检查时间点，不代表搜索引擎的承诺。「需要关注」不等于出问题，先按说明排查，再决定要不要改代码。

每次检查都先重跑第 4 节（或者脚本）。第 4 节有 FAIL，先修第 4 节，再看收录。

| 检查项 | PASS | 需要关注 | FAIL |
|---|---|---|---|
| GSC「站点地图」 | 状态「成功」，已发现的网页数 = 第 4.2 节的 URL 数 | 「尚未抓取」或数量暂时对不上 | 「无法获取」「有错误」，或者数量长期对不上 |
| GSC「网页 / 编入索引」 | sitemap 里的 URL 逐步变成「已编入索引」 | 「已发现，尚未编入索引」「已抓取，尚未编入索引」 | sitemap 里的 URL 出现在「被 noindex 排除」「被 robots.txt 屏蔽」「重复网页，Google 选择的规范网页与用户指定的不同」「软 404」「服务器错误 (5xx)」「重定向」 |
| GSC 网址检查：`/en`、`/ru`、`/en/products`、`/ru/products`，有文章时再加一篇文章 | 「测试实际网址」显示可编入索引；用户声明的规范网址 = Google 选择的规范网址 = 自身 | 「网址不在 Google 中」但实测可编入索引：正常，等待即可 | 实测显示 noindex、被屏蔽、重定向，或 Google 选了别的规范网址 |
| Yandex「Страницы в поиске」「Диагностика」「Статистика обхода」 | sitemap 已处理；Диагностика 里没有严重问题；抓取统计里没有 4xx/5xx | 收录数为 0，或者还在处理 | Диагностика 报 robots 屏蔽、主镜像问题，或 sitemap 有错误；抓取统计里有 5xx，或 sitemap URL 出现 404 |
| Google 搜 `site:geiom.com` | 能搜到 `geiom.com` 的页面，只有 https 裸域 | 暂时搜不到：`site:` 只是粗略参考，以 GSC 为准 | 搜到 www、http、`/solutions`、`/factory`、`/cases`、`/s/`、`/admin` 之类的地址 |
| Yandex 搜 `site:geiom.com` | 同上 | 同上 | 同上 |

- **第 1 天**：重点看验证、sitemap 状态，以及网址检查里的「测试实际网址」。这时候还没收录是正常的。
- **第 3 天**：看 GSC「网页」报告里有没有 FAIL 列的原因，Yandex 的 Диагностика 和抓取统计。
- **第 7 天**：对照第 4.2 节的 URL 表，逐个确认状态。FAIL 的逐条按 [`seo-cutover-geiom.md`](./seo-cutover-geiom.md) §6 处理，「需要关注」的记下来，下次检查时再看。
- GSC / Yandex 里看到的任何账号信息、验证值，都不发到群里。

## 6. 本地预检（可选）

上线前可以用 standalone 构建在本机跑第 4 节的大部分检查：

- 构建：`APP_ENV=production`、`NODE_ENV=production`、`NEXT_PUBLIC_SITE_URL=https://geiom.com`。
- 启动：`HOSTNAME=0.0.0.0`、`APP_ORIGIN=https://geiom.com`，监听本机端口。
- 只有生产环境才能验证的：http/www 的 301（nginx 和 DNS）、Cloudflare 的头、GSC 和 Yandex 能不能抓到、真实 Sanity 文章、文章 OG（需要 UX 的 PR 合并）。
- 本地启动时如果不设 `APP_ENV=production`，运行时的启动检查会被跳过（缺生产密钥也能起来）。这只适合本地预检，生产必须设，见 [`seo-cutover-geiom.md`](./seo-cutover-geiom.md) 第 1 节。
