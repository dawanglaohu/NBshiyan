# geiom.com 上线当天 SEO 清单

> 适用：自建服务器（standalone 镜像 + nginx，前面是 Cloudflare 代理）。部署流程以 [`launch-runbook.md`](../launch-runbook.md) §4–§5 和 PR #321（`fix/deploy-readiness`）为准；环境变量表见 [`launch-runbook.md`](../launch-runbook.md) §4、[`launch-infra.md`](./launch-infra.md)。本文只写 SEO 相关的检查和 Ryan 本人要做的步骤，不重复部署细节。
> 依据代码：`origin/main` `5b79ec6`。文中的路径、变量名、robots 内容都按代码核对过；代码里查不到的（nginx / Cloudflare 规则等）标为 **待确认**。
> 规则：本文和仓库里**不写源站 IP**、不写任何 token / 密钥 / 账号；不写 MOQ、交期、认证、环保、"工厂/制造商"之类未确认说法。

## 0. 主域名

- **主域名是裸域 `https://geiom.com`**（不带 www）。代码里所有绝对地址（canonical、hreflang、sitemap、robots 的 `Sitemap:`、OG 图、JSON-LD）只来自构建时的 `NEXT_PUBLIC_SITE_URL`（`src/lib/site.ts` 的 `SITE_URL`，去掉结尾 `/`），不读请求的 Host。所以"哪个是主域"由 `NEXT_PUBLIC_SITE_URL=https://geiom.com` 决定；代码里没有 www 判断。
- `www.geiom.com` 和 `http://` 的 301 **全部由 nginx 做**（运维已定）：http 裸域、http www、https www 都一跳 301 到 `https://geiom.com$request_uri`。Cloudflare 侧 Always Use HTTPS 关闭，没有 Redirect Rules，也没有 Page Rules。
- ⚠️ 切换时**不要**在 Cloudflare 加重定向规则，**不要**打开 Always Use HTTPS，否则会和 nginx 的 301 叠成两跳或者循环。
- 语言前缀：`src/i18n/routing.ts` 是 `locales: ['en', 'ru']`、`defaultLocale: 'en'`、`localePrefix: 'always'`，所有页面都在 `/en/...` 或 `/ru/...` 下。
- geiom.com 之前是 Squarespace「Coming Soon」+ noindex，没有旧 URL 收录，不需要做旧地址 301 映射。

```bash
S=https://geiom.com
```

## 1. 上线前（构建）

这些值都是**构建时**写进产物的，只在运行时设置不起作用（`NEXT_PUBLIC_*` 会被内联；`next.config.ts` 里的 `isProd` 和 `src/app/robots.ts`、sitemap 也在构建时确定）。

- [ ] 构建时 `APP_ENV=production`、`NODE_ENV=production`。`isProdEnvFrom()`（`src/lib/site.ts`）只认 `APP_ENV === 'production'`（过渡期另认 `VERCEL_ENV`）。没设 → `next.config.ts` 给全站加 `X-Robots-Tag: noindex, nofollow`，`robots.txt` 变成 `Disallow: /`，IndexNow 关闭。
- [ ] **运行时** env_file 里也必须有 `APP_ENV=production`。启动检查（`src/instrumentation.ts` → `runStartupEnvCheck()`）只在 `APP_ENV=production` 时执行；没设就整段跳过，缺密钥、缺数据库也照样启动。
  部署后由运维在服务器上确认启动检查确实跑了（只看变量名和退出码，不打印任何值）：
  - ⚠️ **不要**直接跑不带参数的 `printenv`、`env` 或 `docker compose config`：它们会把所有变量连同密钥一起打印出来（屏幕、终端记录、日志）。只能按单个变量查，例如 `printenv APP_ORIGIN`，而且只查本文列出的非密钥变量。是否通过以 `deploy.sh` 检查的退出码为准，单变量查看只作辅助。
  - 容器里 `APP_ENV` 是 `production`，例如 `docker compose exec <app> printenv APP_ENV`。
  - 检查通过时没有日志输出，所以要做一次反向验证：用一次性容器、同一镜像、同一 env_file，故意让一项必填配置失效（比如 `UPLOAD_DIR` 指向不可写目录），应输出「生产环境配置检查未通过，拒绝启动」加变量名，并 exit 1。测完删掉这个容器，正式容器不动。
- [ ] **运行时** env_file 里必须有 `APP_ORIGIN=https://geiom.com`（不是可选项，不能留空）。后端 PR #328（`fix/root-redirect-location`）加了启动检查，下面任一条不满足就 exit 1：
  - 必须设置，且是 `https://`；
  - 只能是 origin：不带 path、query、userinfo（结尾也不带 `/`）；
  - 主机不能是 IP 或 localhost；
  - 按 origin 规范化后必须等于 `NEXT_PUBLIC_SITE_URL`。
  没设的话，standalone 会把自己的 origin 当成 `http://0.0.0.0:<port>`，后台的同源 POST（登录、改密码等）全部 403。部署后验证：
  - 容器里 `APP_ORIGIN` 是 `https://geiom.com`，例如 `docker compose exec <app> printenv APP_ORIGIN`。
  - 浏览器打开 `https://geiom.com/admin` 登录，登录 POST 成功、不是 403；登录后做一次后台里的改动类操作，也不能 403 `forbidden_origin`（见第 2 节）。
  - #328 同时更新了 `deploy/env.template` 和 `deploy/init-secrets.sh`，生成的 env_file 会写入 `APP_ORIGIN=https://geiom.com`。部署前仍要核对实际 env_file 里的值。
- [ ] **运行时** 生产容器必须保持 `HOSTNAME=0.0.0.0`。改成 `127.0.0.1` 的话，`/s/*` 的 rewrite 会在 `x-middleware-rewrite` 响应头里带出 localhost（这个问题 #328 之前就有）。第二个原因：`HOSTNAME=127.0.0.1` 时，#328 的跳转修复可能生成简写地址 `127.0.1`，而 nginx 兜底的 `proxy_redirect`（第 2.5 节）只匹配完整的 `127.0.0.1`，会漏掉。运维已在 compose 里写死 `HOSTNAME=0.0.0.0`，`deploy.sh` 也会检查这一项（`ops/app-origin-required`）。部署后验证：
  - 容器里 `HOSTNAME` 是 `0.0.0.0`，例如 `docker compose exec <app> printenv HOSTNAME`。
  - 任何响应头里都不能出现 localhost，例如 `curl -sI $S/en | grep -ci localhost` 和 `curl -sI $S/s/<任意 id> | grep -ci localhost` 都应为 0（第 2.4、2.5 节）。
- [ ] 构建时 `NEXT_PUBLIC_SITE_URL=https://geiom.com`（不带结尾 `/`）。缺省值是 `http://localhost:3000`，漏传会让 canonical / sitemap / OG 全部指向 localhost。
- [ ] 构建检查（`prod-env-check.ts`，`next build` 时执行）：
  - 当前 main：`NEXT_PUBLIC_SITE_URL` 缺失或不是 `https://` 时构建失败。
  - PR #321 合并后：另外拒绝 localhost / 127.x / ::1 / 0.0.0.0 / `*.localhost`。上线必须用合并了 #321 的 commit 构建。
- [ ] 站长验证 meta（可选，见第 4 节）：`NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION`、`NEXT_PUBLIC_YANDEX_VERIFICATION`、`NEXT_PUBLIC_BING_VERIFICATION` 也是 `NEXT_PUBLIC_*`，要用的话必须在**构建时**给，改值要重新构建。走 DNS TXT 验证就不用设。
- [ ] standalone 镜像（`output: 'standalone'`，PR #321）：除 `.next/standalone/` 外，必须把 `public/` 复制到 `.next/standalone/public/`、`.next/static/` 复制到 `.next/standalone/.next/static/`（`launch-runbook.md` §4.1）。漏了会导致 OG 图、favicon、poster、JS/CSS 全部 404。安全已核对运维 Dockerfile 里有这两步。
- [ ] 限流 / IndexNow 去重：上线用运维 v1.6 的本地 Redis + SRH（Upstash 兼容 REST），`RATE_LIMIT_STORE=upstash`，`UPSTASH_REDIS_REST_URL` 为 https。`src/lib/seo/indexnow.ts` 只在 `RATE_LIMIT_STORE=upstash`、URL 是 https、token 已设、生产环境、`INDEXNOW_KEY` 合法（8–128 位 `[a-zA-Z0-9-]`）时启用，缺一项就**静默关闭**。
- [ ] 上线时 sitemap 里只会有（`src/lib/seo/sitemapEntries.ts`）：`/en`、`/ru`、`/{en,ru}/products`、`/{en,ru}/contact`；另外 Sanity 里有可索引文章时才有 `/{en,ru}/articles` 和文章详情。**不会有**：品类页（`CATEGORY_PAGES_LIVE = false`，`src/lib/seo/categoryPages.ts`，此时 `/products/<slug>` 一律 404）、隐私页（`PRIVACY_PAGE_COMPLETE = false`）、`/solutions`、`/factory`、`/cases`、`/s/*`、`/admin`、`/api`。

## 2. 上线后立即自检

DNS 生效、Cloudflare 代理打开后马上跑。也可以先跑仓库自带的两个只读脚本：`pnpm smoke --base https://geiom.com` 和 `pnpm seo:audit https://geiom.com`（**不要**加 `--ignore-env-noindex`），见 `launch-runbook.md` §5。

- [ ] 后台登录：`https://geiom.com/admin` 登录的 POST 成功，不是 403（403 多半是运行时没设 `APP_ORIGIN=https://geiom.com`，见第 1 节）。由 Ryan 或运维用自己的后台账号测，账号密码不写进任何地方。

### 2.1 没有 noindex

```bash
for p in /en /ru /en/products /ru/products /en/contact /ru/contact /robots.txt /sitemap.xml; do
  printf '%s ' "$p"; curl -sI "$S$p" | grep -i '^x-robots-tag' || echo OK; done
curl -s $S/en | grep -o '<meta name="robots"[^>]*'   # 应无输出
curl -s $S/ru | grep -o '<meta name="robots"[^>]*'   # 应无输出
```

### 2.2 robots.txt

```bash
curl -sI $S/robots.txt | grep -iE '^(HTTP|content-type)'   # 200, text/plain
curl -s $S/robots.txt
```

应**完全**等于（`src/app/robots.ts` 生产分支的输出，已本地核对）：

```text
User-Agent: *
Allow: /
Disallow: /admin
Disallow: /*/admin
Disallow: /s/
Disallow: /*/s/
Disallow: /api/

Sitemap: https://geiom.com/sitemap.xml
```

如果看到 `Disallow: /`，说明构建时不是生产环境，按第 6 节处理。

### 2.3 sitemap.xml

```bash
curl -sI $S/sitemap.xml | grep -iE '^(HTTP|content-type)'   # 200, application/xml
curl -s $S/sitemap.xml | grep -o '<loc>[^<]*' | cut -c6- | sort -u
curl -s $S/sitemap.xml | grep -Ec 'localhost|vercel\.app|http://|www\.geiom'   # 应为 0
# 每个 URL：200、无 noindex、canonical 等于自身
for u in $(curl -s $S/sitemap.xml | grep -o '<loc>[^<]*' | cut -c6-); do
  c=$(curl -s -o /tmp/p -D /tmp/h -w '%{http_code}' "$u")
  can=$(grep -o 'rel="canonical" href="[^"]*' /tmp/p | cut -d'"' -f4)
  nx=$(grep -ci '^x-robots-tag' /tmp/h; grep -c '<meta name="robots"[^>]*noindex' /tmp/p)
  [ "$c" = 200 ] && [ "$can" = "$u" ] && [ "$(echo $nx | tr -d ' 0')" = "" ] || echo "FAIL $c $u -> $can noindex=$nx"; done
```

- 所有地址以 `https://geiom.com/en` 或 `https://geiom.com/ru` 开头，en、ru 成对出现。
- 不能出现 `/solutions`、`/factory`、`/cases`、`/privacy`、`/s/`、`/admin`、`/api`，也不能出现 `/products/<slug>`（品类页未上线）。

### 2.4 canonical + hreflang

```bash
for p in /en /ru /en/products /ru/products /en/contact; do echo "== $p"
  curl -s $S$p | grep -oE '<link rel="(canonical|alternate)"[^>]*>'; done
```

- canonical 指向自身，是 `https://geiom.com/...` 绝对地址（`src/i18n/alternates.ts` 生成相对路径，由 `metadataBase = SITE_URL` 补全）。
- hreflang 有 `en`、`ru`、`x-default`，`x-default` 指向 en 版本。
- hreflang 只由 HTML 输出。`src/i18n/routing.ts` 设了 `alternateLinks: false`，next-intl 不再发 `Link: rel="alternate"; hreflang=…` 响应头（那个头的 x-default 指向 `/`，和 HTML 的 `/en` 不一致，域名还取自请求）：
  ```bash
  curl -sI $S/en | grep -i '^link:' | grep -ci hreflang   # 应为 0
  ```

**转发头（nginx → 容器）——已批准**

安全已批准运维的新版 nginx，上线用的就是这一版。头部一律在 nginx 里用 `proxy_set_header` 显式设置，不透传客户端发来的值：

```nginx
proxy_set_header Host geiom.com;              # 固定值
proxy_set_header X-Forwarded-Host geiom.com;  # 固定值
proxy_set_header X-Forwarded-Proto https;     # 固定值
proxy_set_header X-Forwarded-For $remote_addr;   # 不用 $proxy_add_x_forwarded_for
proxy_set_header X-Real-IP "";                # 清空
proxy_set_header X-Edge-Auth <由 nginx 注入，值不写在这里>;
proxy_set_header CF-Connecting-IP $remote_addr;   # 只信任 Cloudflare 来源（前提：下面的 444 规则保留）
```

- 443 的 `geiom.com` server 用精确的 `server_name geiom.com`，Host 不对直接返回 **421**。canonical、hreflang、Location 都不会被伪造的 Host 污染。
- `X-Edge-Auth` 由 nginx 注入，会覆盖客户端自己带的同名头。它的值不能出现在日志、仓库和聊天里。
- `CF-Connecting-IP` 用 `$remote_addr` 显式设置，不读、不透传客户端带来的同名头。只有在「非 Cloudflare 来源 → 444」这条规则保留时，`$remote_addr` 才一定是 Cloudflare 节点，这条规则**不能删**。
- **以最终 `nginx -t` 通过的文件为准。** 本文不写任何密钥值或源站 IP。
- nginx 改动只限安全批准的 NBshiyan 站点配置，服务器上其他 nginx 配置一律不动。
- 上线后自检：
  ```bash
  curl -sI $S/en | grep -ci localhost   # 应为 0，任何响应头里都不能有 localhost
  ```

### 2.5 跳转

```bash
curl -sIL 'http://geiom.com/en?a=1'      | grep -iE '^(HTTP|location)'   # 一个 301 → https://geiom.com/en?a=1，然后 200
curl -sIL 'http://www.geiom.com/ru?a=1'  | grep -iE '^(HTTP|location)'   # 一个 301 → https://geiom.com/ru?a=1，然后 200
curl -sIL 'https://www.geiom.com/ru?a=1' | grep -iE '^(HTTP|location)'   # 一个 301 → https://geiom.com/ru?a=1，然后 200
curl -sI https://geiom.com/ | grep -iE '^(HTTP|location)'              # 307，Location 是 /en 或 https://geiom.com/en，绝不能是 localhost
curl -sI 'https://geiom.com/?q=1' | grep -iE '^(HTTP|location)'        # 307 → /en?q=1
curl -sI 'https://geiom.com//evil.com' | grep -iE '^(HTTP|location)'   # 308 → 站内 /evil.com（不是 //evil.com），再跟进是 404
curl -sI 'https://geiom.com/\evil.com' | grep -iE '^(HTTP|location)'   # 308 → 站内 /evil.com，再跟进是 404
curl -s -o /dev/null -w '%{http_code}\n' 'https://geiom.com/%2F%2Fevil.com'   # 404
curl -sI https://geiom.com/ | grep -ci localhost                       # 0
curl -sI -H 'Accept-Language: ru' $S/ | grep -iE '^(HTTP|location)'  # 307 → /ru
curl -sI -H 'Accept-Language: en' $S/ | grep -iE '^(HTTP|location)'  # 307 → /en
curl -sI $S/en/products/ | grep -iE '^(HTTP|location)'            # 308 → /en/products（去掉结尾 /）
```

- `/` 的跳转由 next-intl middleware 做：按 `NEXT_LOCALE` cookie / `Accept-Language` 选语言，状态码 **307**（本地实测）。根路径不进 sitemap，正常。
- 三种（http 裸域、http www、https www）都必须是 nginx 的**一个** 301，直接到 `https://geiom.com$request_uri`（路径和 query 都保留），不能有链式跳转。
- 根路径 Location（#321 standalone 检查的 P1-1）：代码侧由后端 PR #328（`fix/root-redirect-location`）修，站内跳转的 Location 改成相对路径：`/` → 307 `/en`，`/?q=1` → 307 `/en?q=1`；`//evil.com`、`/\evil.com` → 308 到站内 `/evil.com` 再 404，不会变成开放跳转；`/%2F%2Fevil.com` 现在是 404（以前是 500）。nginx 再兜底，只改写本地地址，**不是**通配所有域名的正则：
  ```nginx
  proxy_redirect ~^https?://(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::[0-9]+)?(/.*)$ $1;
  proxy_redirect http://geiom.com/ https://geiom.com/;
  ```
  注意：路径分组 `(/.*)` 必须是**必选**的，不能写成可选。否则 `http://localhost:3000` 会被改写成空的 Location。
  第二条把容器返回的 `http://geiom.com/...` 绝对跳转改成 `https://`。以上两条照抄安全批准的版本，以最终 `nginx -t` 通过的文件为准。
  验收：`curl -sI https://geiom.com/` 的 Location 是 `/en` 或 `https://geiom.com/en`，且没有任何响应头含 localhost。
  升级 Next 时：#328 的修法依赖 Next 内部行为（由测试锁定），升级后要在 standalone 下重跑那 39 条跳转探测，全部通过才能上线。

### 2.6 404

```bash
curl -s -o /tmp/p -w '%{http_code}\n' $S/en/no-such-page   # 404
grep -o '<meta name="robots"[^>]*' /tmp/p                  # 含 noindex
curl -s -o /dev/null -w '%{http_code}\n' $S/en/products/no-such   # 404
curl -sI $S/no-such-page | grep -iE '^(HTTP|location)'     # 307 → /en/no-such-page（或 /ru/…），再跟进是 404
curl -sI https://geiom.com/nope.png | grep -i '^HTTP'      # 404，不能是 5xx
```

- `/{locale}/...` 未匹配路径由 `src/app/[locale]/[...rest]/page.tsx` → `notFound()`，`src/app/[locale]/not-found.tsx` 输出 noindex，真实 404，不跳首页。
- 不带语言前缀的地址会先 307 到带前缀的地址，再 404，这是 next-intl 的行为，不算软 404。
- 不存在的带扩展名路径（如 `/nope.png`）和 `/%2F%2Fevil.com` 以前返回 500，已在 #328 修好，现在是 404。

### 2.7 og:image

```bash
for p in /en /ru /en/products /ru/contact; do
  for img in $(curl -s $S$p | grep -oE '<meta property="og:image" content="[^"]*' | cut -d'"' -f4); do
    echo "$p $img $(curl -s -o /dev/null -w '%{http_code} %{content_type}' "$img")"; done; done
```

- 地址是 `https://geiom.com/og/<slug>-<locale>.jpg?v=<8 位>`（`src/lib/seo/pageMeta.ts`），返回 `200 image/jpeg`，en 页用 `-en.jpg`、ru 页用 `-ru.jpg`。

### 2.8 /api/health 不对外

```bash
for u in /api/health '/api/health?x=1' /api/health/ /api/health/x; do
  echo "$u $(curl -s -o /dev/null -w '%{http_code}' "$S$u")"; done   # 全部 404
curl -s -o /dev/null -w '%{http_code}\n' $S/api/healthz           # 正常代理给应用（不是 nginx 的 404）
```

**已批准，待上线**：安全已批准。运维在上线前把配置上到服务器，DNS 切换后再从外部复测一遍。

```nginx
location = /api/health { return 404; }
location ^~ /api/health/ { return 404; }
```

- 外部请求带 query string、结尾 `/`、子路径都是 404。
- `/api/healthz` 不受影响，照常代理（`= /api/health` 是精确匹配，`^~ /api/health/` 要带 `/`）。
- 容器自己的健康检查走 `127.0.0.1:3000`，不经过 nginx。
- 具体配置以运维答复为准。

### 2.9 Cloudflare / 爬虫

- [ ] HTML 不被缓存：`curl -sI $S/en | grep -i cf-cache-status` → `DYNAMIC` 或 `BYPASS`，不能是 `HIT`。`/_next/static/*` 可以 `HIT`。
- [ ] 爬虫不被挑战：Bot Fight Mode / WAF 放行已验证爬虫（Googlebot、YandexBot、bingbot）。以 GSC「网址检查 → 测试实际网址」和 Yandex「Проверка ответа сервера」返回 200 为准，不能只靠改 UA 的 curl。这两项要等第 4 节的站点验证完成后才能用，所以放在第 4 节验证通过后补做；在那之前先看 Cloudflare Security Events 有没有拦截已验证爬虫。

## 3. 上线时开放索引的页面（SEO 单独开代码 PR）

**当前代码状态（`5b79ec6`）：还没开放。** 以下页面都是 noindex，也都不在 sitemap 里：

| 页面 | 文件 | 现在的 robots |
|---|---|---|
| `/{en,ru}/solutions` | `src/app/[locale]/solutions/page.tsx` | `index: false, follow: true`（注释：文案/图片仍是占位） |
| `/{en,ru}/solutions/<slug>` | `src/app/[locale]/solutions/[slug]/page.tsx` | `index: false, follow: true`；`dynamicParams = false`，只接受 `src/lib/solutions.ts` 的 `INDUSTRIES` |
| `/{en,ru}/factory` | `src/app/[locale]/factory/page.tsx` | `index: false, follow: true` |
| `/{en,ru}/cases` | `src/app/[locale]/cases/page.tsx` | `index: false, follow: false` |

6 个 solutions slug（`INDUSTRIES`，en/ru 共用同一 slug）：`color-boxes`、`corrugated-boxes`、`paper-cups`、`party-supplies`、`wine-boxes`、`gift-boxes`。

上线时由 SEO 单独开一个代码 PR（不在本文档 PR 里），一次做完：

- [ ] 去掉 `/solutions`、`/factory`、6 个 `/solutions/<slug>` 的 `robots: { index: false, … }`。
- [ ] 同一个 PR 里把它们加进 `src/lib/seo/sitemapEntries.ts` 的 `STATIC_PAGES`（en/ru 两种语言 = 16 个 URL），并更新文件顶部"不进 sitemap"的注释。noindex 和 sitemap 必须同时改，不能出现"在 sitemap 里但 noindex"。
- [ ] 前提：这些页面的文案和图片已经不是占位，经 PM / Ryan 确认没有未确认说法。达不到就继续 noindex，不开放。
- [ ] `/cases` **继续 noindex、不进 sitemap**，等有真实案例（Ryan 确认可公开）后再开。
- [ ] 合并部署后重跑第 2.3 节；GSC / Yandex 验证已完成的话重新提交 sitemap，还没验证就等第 4 节做完后一起提交。

以后的两个开关（不属于本次，按 `launch-runbook.md` §5）：隐私页 `PRIVACY_PAGE_COMPLETE`（`src/lib/legal/privacy.ts`）、品类页 `CATEGORY_PAGES_LIVE`（`src/lib/seo/categoryPages.ts`）。打开后都要重新提交 sitemap。

## 4. 部署成功、验收通过后：需要 Ryan 本人做的步骤

> ⏱ **顺序：** 第 1、2 节全部通过（部署成功、验收通过）以后才做本节。GSC / Yandex 验证**不挡上线**：上线不等验证值，验证值也不跟上线前的任何 DNS 变更一起加。sitemap 提交和「请求编入索引」都在验证通过之后。

> 🔑 **以下只能由 Ryan 用自己的账号做**，在私聊里进行，不在群里做。机器人**不代 Ryan 登录**、**不保存他的账号或密码**、**不改 DNS**。机器人只负责告诉 Ryan 在哪里点、TXT 记录加在哪个主机名下。验证值由 Ryan 在验收通过后自己登录 GSC / Yandex 获取，私信发给运维，由运维作为一次**单独的** DNS 变更加 TXT。本文不写任何真实验证值。
> DNS 记录只新增、不覆盖已有 TXT（SPF、DKIM、DMARC 等），同一主机名下可以有多条 TXT。

### 4.1 Google Search Console 🔑

1. Ryan 登录 GSC → 添加资源 → 选「**网域**」→ 填 `geiom.com`（网域资源自动覆盖 https/http、www/裸域）。
2. GSC 给出一条 TXT 记录（`google-site-verification=…`）。Ryan 把这个值**私信**发给运维，由运维单独做一次 DNS 变更，给 `geiom.com`（`@`）新增这条 TXT（Ryan 已定）。值不发到群里。
3. 回 GSC 点验证。**验证通过后不要删这条 TXT**。
4. 验证通过后：站点地图 → 提交 `https://geiom.com/sitemap.xml`，状态应为「成功」。
5. 验证通过后：网址检查：`https://geiom.com/en`、`https://geiom.com/ru` → 「测试实际网址」应可编入索引 → 「请求编入索引」。可以再加 `/en/products`、`/ru/products`。

### 4.2 Yandex Webmaster 🔑

1. Ryan 登录 Yandex Webmaster → 添加站点 `https://geiom.com`（和 `NEXT_PUBLIC_SITE_URL` 完全一致；Yandex 把 www 和裸域当成两个站，只加裸域）。
2. 验证方式：**用 DNS TXT**。Yandex 给出 TXT（`yandex-verification: …`），Ryan 私信发给运维，运维单独做一次 DNS 变更给 `geiom.com` 新增；验证后不要删。
   - 代码也支持 meta 方式：`NEXT_PUBLIC_YANDEX_VERIFICATION` → `src/app/[locale]/layout.tsx` 的 `verification.yandex`，输出 `<meta name="yandex-verification">`。但它只在 `/en`、`/ru` 页面上；根路径 `/` 是 307 跳转，而 Yandex 的 meta 验证查首页、首页有跳转会失败（见 [`yandex-webmaster-setup.md`](./yandex-webmaster-setup.md) §2 第 5 条）。另外改值要重新构建。所以首选 DNS TXT。
3. 站点地区（可选）：按 [`yandex-webmaster-setup.md`](./yandex-webmaster-setup.md) §4 决定，不要为了审核虚构俄罗斯地址。
4. 验证通过后：Индексирование → Файлы Sitemap → 添加 `https://geiom.com/sitemap.xml`。
5. 验证通过后（可选）：Переобход страниц 提交 `/ru`、`/en`。

### 4.3 Bing Webmaster（可选）🔑

- GSC 验证通过后，Ryan 登录 Bing Webmaster Tools →「从 Google Search Console 导入」，导入后自动验证，sitemap 一起导入，不需要额外 DNS 记录。
- 代码也支持 `NEXT_PUBLIC_BING_VERIFICATION`（`msvalidate.01` meta），一般用不到。

### 4.4 IndexNow（不需要 Ryan 登录）

- `INDEXNOW_KEY` 放服务器环境文件（`launch-runbook.md` §4，值由 Ryan 提供，不进仓库、不发群）。
- 上线后：`curl -s -w '\n%{http_code}\n' $S/<key>.txt` 返回密钥本身和 200；随便写一个 `.txt` 文件名应返回 404（`next.config.ts` rewrite 到 `/api/indexnow-key/[file]`）。
- 推送端点是 `https://yandex.com/indexnow`。现在 `INDEXNOW_LIVE_TYPES` 里 product / solution / article 都是 `live: false`，只有后台模型上架会推 `/en/products`、`/ru/products`；没有全站推送脚本，上线当天靠 sitemap。Google 不支持 IndexNow。

## 5. 上线后 1–7 天观察

- [ ] **第 0 天（上线后 2 小时内）**：第 2 节全部重跑；Cloudflare Security Events 看有没有 Googlebot / YandexBot 被拦；容器日志看 5xx 和 `[indexnow]`。
- [ ] **验收通过后**：Ryan 按第 4 节取 GSC / Yandex 验证值 → 运维单独加 TXT → 验证通过 → 提交 sitemap、请求编入索引 → 补做第 2.9 节的 GSC / Yandex 爬虫实测。下面 GSC / Yandex 的观察项从验证通过那天开始算。
- [ ] **每天，GSC**：「网页 / 编入索引」里已编入和未编入的原因，重点看「软 404」「已抓取但未编入索引」「重复网页，用户未选定规范网页」「被 noindex 排除」（noindex 只应出现在 solutions/factory/cases/privacy/s 这类页面）；「站点地图」已读取、发现的 URL 数和 sitemap 实际条数一致；「抓取统计」里 404、5xx、主机问题。
- [ ] **Core Web Vitals**：新站数据要几周才有；前 7 天先看 GSC「核心网页指标」有没有数据，没有就以 Lighthouse 为准。
- [ ] **Yandex**：「Страницы в поиске」收录数和被剔除原因、「Диагностика」、「Статистика обхода」里的 404 / 不可达、sitemap 处理状态。
- [ ] **Lighthouse 生产复测**：对 `https://geiom.com/en`、`https://geiom.com/ru` 各跑手机和桌面：
  ```bash
  npx lighthouse https://geiom.com/en --only-categories=performance,seo --output=json --output-path=./lh-en-mobile.json
  npx lighthouse https://geiom.com/en --preset=desktop --only-categories=performance,seo --output=json --output-path=./lh-en-desktop.json
  # /ru 同样跑两次
  ```
  对照 `lighthouserc.json`（桌面：LCP ≤ 2000 ms、CLS ≤ 0.1、性能分 ≥ 0.9）和 `docs/launch-checklist.md` §5（桌面首屏 ≤ 2 秒、手机 ≤ 3 秒）。结果贴回群里。
- [ ] **软 404 自查**：不存在的地址必须是真 404（第 2.6 节），`/products/<任意 slug>` 在品类页上线前是 404；过期分享链接 `/s/<id>` 是 410（`src/middleware.ts`）。GSC 报软 404 的 URL 逐个用 curl 看状态码。
- [ ] 第 7 天在群里汇报一次：收录数、sitemap 状态、有无 noindex / 软 404 / 爬虫被拦。

## 6. 回滚 / 应急

### 6.1 生产误带 noindex

**怎么发现**：第 2.1 节的命令有 `x-robots-tag: noindex`，或 `robots.txt` 是 `Disallow: /`，或页面 `<meta name="robots" content="noindex">`；GSC 网址检查显示「已被 noindex 排除」/「被 robots.txt 屏蔽」；`pnpm seo:audit https://geiom.com` 报 noindex。

**原因和处理**：

1. 全站 `X-Robots-Tag: noindex, nofollow` + `Disallow: /` → 构建时 `APP_ENV` 不是 `production`（这两项都在构建时确定，运行时补设没用）。用 `APP_ENV=production`、`NODE_ENV=production` **重新构建镜像**并部署。
2. canonical / sitemap 指向 localhost 或其他域名 → 构建时 `NEXT_PUBLIC_SITE_URL` 不对，带正确值重新构建。
3. 只有个别页面 noindex → 查该页 `generateMetadata` 里的 `robots`，或 Sanity 文档的 `seo.noindex`，按正常 PR 流程改。
4. 修好后：Cloudflare 清一次缓存（运维）；重跑第 2 节；GSC 网址检查 `/en`、`/ru` 重新请求编入索引，重新提交 sitemap；Yandex 重新处理 sitemap（🔑 Ryan）。

### 6.2 不该收录的页面被收录（例如 staging 或 `/cases`）

- 先确认该页现在是 noindex 或 404，再由 Ryan 在 GSC「移除」里提交临时移除（🔑）。不要用 robots.txt 屏蔽已收录页面（屏蔽后爬虫看不到 noindex）。

### 6.3 整站回滚

- 网站按 `launch-runbook.md` §2「回滚：只回滚代码」（PR #321 合并后的版本）切回上一个已合并 SHA 的镜像，运维操作、Ryan 批准。DNS 回滚由运维按下面附录的备份处理。
- 回滚期间不提交 sitemap、不手动推 IndexNow。**不要动** MX、SPF、DKIM、Email Routing、DMARC、GSC / Yandex 验证 TXT。

## 附录：切换前 DNS 快照（2026-10-15 00:17 PT，用于回滚）

由运维执行，SEO 不改 DNS。下面是 Cloudflare 面板里记录的结构。裸域 A/AAAA 记录的值是**源站 IP**（开 Cloudflare 代理），不是公网查到的 Cloudflare 边缘地址：边缘地址填进 A 记录会让代理绕回 Cloudflare 自己。源站 IP 不写进仓库，由运维填写。

| 主机 | 类型 | 记录值 | 备注 |
|---|---|---|---|
| `geiom.com` | A | 源站 IP（不写进仓库，由运维填写） | Cloudflare 代理（橙云） |
| `geiom.com` | AAAA | 源站 IPv6（如有；不写进仓库，由运维填写） | Cloudflare 代理（橙云） |
| `geiom.com` | TXT | `v=spf1 include:_spf.mx.cloudflare.net ~all` | 现有 SPF，只新增不覆盖 |
| `geiom.com` | MX | `route1/2/3.mx.cloudflare.net` | Cloudflare Email Routing，勿删 |
| `cf2024-1._domainkey.geiom.com` | TXT | Cloudflare DKIM（已存在） | 勿删、勿覆盖 |
| `_dmarc.geiom.com` | TXT | 无 | 上线时按运维 DNS 批次新增 `v=DMARC1; p=none` |
| `geiom.com` | NS | `dorthy.ns.cloudflare.com`、`mitchell.ns.cloudflare.com` | 权威在 Cloudflare |

- 切换时只清理 Squarespace 残留（裸域 4 条 A、www CNAME、`_domainconnect` CNAME），其他记录不动。发信走 Gmail SMTP，不为发信新增 SPF `include:` 或 DKIM。详见 [`launch-infra.md`](./launch-infra.md)。

## 待确认

无。

已定：www / http 301 由 nginx 做（第 0、2.5 节）；转发头按安全批准的新版 nginx（第 2.4 节，以最终 `nginx -t` 的文件为准）；`/api/health` 对外 404（第 2.8 节）；`Link` 响应头已用 `alternateLinks: false` 关掉（第 2.4 节）；GSC / Yandex 验证在部署成功、验收通过后做，不挡上线：Ryan 取值、私信运维，运维单独做一次 DNS 变更加 TXT（第 4 节）。
