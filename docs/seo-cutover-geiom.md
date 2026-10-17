# geiom.com 切换当天 SEO 检查清单（Vercel → Docker+Caddy+Cloudflare）

> 依据：`origin/main` `78a515f`（未合入 #279 时）+ PR #279 `e6ba3bb`；`nbshiyan-ops-plan.md` §7。
> 约定：主域 `https://geiom.com`（裸域），www/http 一跳 301 到裸域。DNS、GSC、Yandex 操作由 **运维 / Ryan** 执行，SEO 只抽查。
> 现状：geiom.com 目前是 Squarespace「Coming Soon」+ noindex，没有已收录页面，所以没有旧 URL 要做 301 映射。
> 本次切换**不改** noindex 页面：`/solutions`、`/factory`、6 个 solutions slug、`/cases` 继续 noindex，也不进 sitemap（上线时再单独改）。

```bash
S=https://geiom.com   # 正式
P=https://staging.geiom.com   # 预览/staging（Cloudflare Access + noindex，永不提交 GSC/Yandex）
```

## 1. 切换前

- [ ] **#279 已合并并部署**。没合并的话，`isProdEnv`、`next.config` 的 noindex 头、robots、IndexNow 都只认 `VERCEL_ENV`，自建服务器上会被当成非生产：整站 noindex，robots 全站 disallow，IndexNow 关闭。
- [ ] 生产环境变量：`APP_ENV=production`、`NEXT_PUBLIC_SITE_URL=https://geiom.com`（不带结尾 `/`）、`INDEXNOW_KEY`（8–128 位 `[a-zA-Z0-9-]`）。自建服务器用本地 Redis 做 IndexNow 去重：`RATE_LIMIT_STORE=redis`（不是 Upstash）。运维 PR1/PR2 会合入后，IndexNow 才同时接受 `upstash` 或 `redis`；在此之前缺兼容时 IndexNow 可能静默关闭。上线后由运维用日志确认 IndexNow 已启用。
- [ ] **`APP_ENV` 和 `NEXT_PUBLIC_SITE_URL` 必须作为 Docker build-args 传入**（仅在容器运行时设置太晚）：`NEXT_PUBLIC_*` 在构建时写进代码，`next.config.ts` 的 `isProd` 也在构建时算。`SITE_URL` 缺省是 `http://localhost:3000`，漏传会导致 canonical / sitemap 指向 localhost。
- [ ] staging 地址是 `staging.geiom.com`：前面挂 Cloudflare Access，不设 `APP_ENV=production`，`NEXT_PUBLIC_SITE_URL` 用 `https://staging.geiom.com`（ops-plan §7：staging 的 robots/sitemap 不指向正式域名）。整站 noindex，**永不**提交给 Search Console / Yandex。
- [ ] 用一个「生产配置」的构建（`APP_ENV=production`、`NEXT_PUBLIC_SITE_URL=https://geiom.com`，在 staging 机器上跑、不对外）检查输出：
  ```bash
  B=<该构建的内网地址 TBD>
  curl -s $B/robots.txt                       # 应为 Allow: / + disallow admin,/s/,/api/ + Sitemap: https://geiom.com/sitemap.xml
  curl -s $B/sitemap.xml | grep -o '<loc>[^<]*' | sort -u
  curl -s $B/en | grep -oE '(rel="(canonical|alternate)"[^>]*|"(url|@id)":"[^"]*")'
  curl -s $B/sitemap.xml $B/en $B/ru $B/robots.txt | grep -Ec 'localhost|vercel\.app|http://' # 应为 0
  curl -sI $B/en | grep -i x-robots-tag      # 应无输出
  ```
- [ ] sitemap 里不出现 `/solutions`、`/factory`、`/cases`、`/admin`、`/s/`。
- [ ] canonical 指向自身（`/en/...` 或 `/ru/...`）；hreflang 有 `en`、`ru`、`x-default`(=en)，都是 `https://geiom.com` 开头的绝对地址。
- [ ] JSON-LD（`OrganizationJsonLd`）里的 `url`、`@id` 都是 `https://geiom.com/...`。
- [ ] Cloudflare（ops-plan §7）：重定向规则 + Always HTTPS 做一跳 301；HTML 和 `/api/*` 设为 bypass；Bot Fight Mode / WAF / 挑战页放行已验证爬虫（Googlebot、YandexBot、bingbot）。
- [ ] GSC / Yandex 的 TXT 记录提前加好（见第 3 节），这样切换当天就能验证。

## 2. 切换后验证（DNS 生效后）

- [ ] http→https，一跳：`curl -sI http://geiom.com/en | grep -iE '^(HTTP|location)'` → `301`，`location: https://geiom.com/en`
- [ ] www→裸域，一跳：`curl -sIL http://www.geiom.com/ru | grep -iE '^(HTTP|location)'` → 只有**一个** 301 指向 `https://geiom.com/ru`，然后是 200。`https://www.geiom.com/ru` 同样检查。
- [ ] 根路径：`curl -sI $S/ | grep -iE '^(HTTP|location)'` → next-intl 按语言跳到 `/en` 或 `/ru`（是 307 还是 308 待实测，TBD）。
- [ ] 结尾斜杠：`curl -sI $S/en/products/` → 308 到 `/en/products`（Next 默认 `trailingSlash: false`）。
- [ ] 真 404：`curl -s -o /dev/null -w '%{http_code}\n' $S/en/no-such-page` 和 `$S/no-such-page` → `404`（不能是 200 或跳首页）。
- [ ] robots：`curl -sI $S/robots.txt` → 200、`content-type: text/plain`；`curl -s $S/robots.txt` 内容和第 1 节一致，**不是** `Disallow: /`。
- [ ] sitemap：`curl -sI $S/sitemap.xml` → 200、`application/xml`。每个 URL 都返回 200，且 canonical 等于自身：
  ```bash
  for u in $(curl -s $S/sitemap.xml | grep -o '<loc>[^<]*' | cut -c6-); do
    c=$(curl -s -o /tmp/p -w '%{http_code}' "$u"); can=$(grep -o 'rel="canonical" href="[^"]*' /tmp/p | cut -d'"' -f4)
    [ "$c" = 200 ] && [ "$can" = "$u" ] || echo "FAIL $c $u -> $can"; done
  ```
- [ ] hreflang 互相指向：`curl -s $S/en/products | grep -o 'hreflang="[^"]*" href="[^"]*'`，再对 `/ru/products` 跑一遍。en↔ru 互指，`x-default` 指向 en。
- [ ] JSON-LD：`curl -s $S/en | grep -o '"@id":"[^"]*"\|"url":"[^"]*"'` 全是 `https://geiom.com`。
- [ ] 生产无 noindex：`for p in / /en /ru /en/products /ru/contact /sitemap.xml; do curl -sI $S$p | grep -i x-robots-tag; done` → 无输出。
- [ ] 应保持 noindex 的页面：`curl -sI $S/en/solutions $S/en/factory $S/en/cases`（看 meta robots：`curl -s $S/en/cases | grep -o '<meta name="robots"[^>]*'`）；`/admin`、`/s/*` 带 `X-Robots-Tag: noindex, nofollow`。
- [ ] 预览 `staging.geiom.com` 仍 noindex，且永不提交 GSC/Yandex：`curl -sI $P/en | grep -iE '^HTTP|x-robots-tag|cf-access'` → 未登录时被 Cloudflare Access 拦（302 到 Access 登录页 / 403），登录后响应带 `x-robots-tag: noindex, nofollow`；`curl -s $P/robots.txt`（登录后）→ `Disallow: /`。
- [ ] HTML 不被 Cloudflare 缓存：`curl -sI $S/en | grep -i cf-cache-status` → `DYNAMIC` 或 `BYPASS`（不能是 `HIT`）。`/_next/static/*` 可以 `HIT`。
- [ ] 爬虫不被拦：GSC「网址检查 → 测试实际网址」、Yandex「Проверка ответа сервера」都要返回 200，不能是挑战页。Cloudflare Security Events 里不能有 Googlebot / YandexBot 被拦（不能只靠伪造 UA 的 curl 来判断）。

## 3. DNS 变更与域名验证（只列清单，运维执行；SEO / 本清单作者不改 DNS）

> 邮件通道现状（Ryan 已确认，现有配置不动）：**收信** = Cloudflare Email Routing → Worker（temp-mail / D1）；**发信** = 免费 Gmail SMTP，From 是 Gmail 地址，Reply-To 是 geiom.com 地址。信是从 gmail.com 发出的，geiom.com 的 SPF / DKIM / DMARC 管不到这些外发邮件，所以**不为发信加任何 DNS 记录**（不加 Gmail / Resend 的 SPF `include:`，不加新 DKIM）。没有自建 SMTP/IMAP，也没有 `mail.geiom.com` A 记录、bounce+ / VERP，本清单不要求、也不建议新增这类记录。SPF 保持 `v=spf1 include:_spf.mx.cloudflare.net ~all` 不变；一个域名只能有一条 DMARC。SMTP 账号和应用专用密码不写进任何文档。

### 3.1 切换前 DNS 快照（备份，用于回滚）

查询时间：2026-10-15 00:17 PT。本机 `dig` 被透明劫持（一律返回 `198.18.0.1`），以下为 Cloudflare / Google **DNS-over-HTTPS** 的公网结果；**Cloudflare 面板里橙色云代理的源站目标可能与公网 A 答案不同**，删 Squarespace 残留时以面板记录为准。

| 主机 | 类型 | 当前公网值（备份） | 备注 |
|---|---|---|---|
| `geiom.com` | A | `104.21.45.232`、`172.67.220.15` | Cloudflare 代理 anycast；面板里可能仍挂着 Squarespace 源站 A（待运维核对） |
| `geiom.com` | AAAA | `2606:4700:3031::6815:2de8`、`2606:4700:3033::ac43:dc0f` | Cloudflare 代理 |
| `www.geiom.com` | CNAME | （无） | 公网无 CNAME；A 解析到与裸域相同的 CF IP（可能是面板里的 proxied A，或 CNAME 已被展平/已删） |
| `_domainconnect.geiom.com` | CNAME | （无） | 公网无记录（SOA only） |
| `_dmarc.geiom.com` | TXT | （无 / NXDOMAIN） | **尚无 DMARC**，可新增 |

> 运维已在 Cloudflare 后台备份里确认：Squarespace 记录 = 4 条裸域 A、www CNAME、`_domainconnect` CNAME（公网查不到是因为被代理）。
| `geiom.com` | TXT | `v=spf1 include:_spf.mx.cloudflare.net ~all` | 现有 SPF；只新增、不覆盖 |
| `geiom.com` | MX | `9 route2.mx.cloudflare.net.`、`41 route3.mx.cloudflare.net.`、`74 route1.mx.cloudflare.net.` | Cloudflare Email Routing；**勿删** |
| `cf2024-1._domainkey.geiom.com` | TXT | `v=DKIM1; h=sha256; k=rsa; p=…`（Cloudflare Email DKIM，已存在） | Email Routing/Sending 相关；**勿删、勿覆盖** |
| `geiom.com` | NS | `dorthy.ns.cloudflare.com.`、`mitchell.ns.cloudflare.com.` | 权威已在 Cloudflare |

复核命令（运维侧，优先用公网解析器或 DoH，避免本机劫持）：

```bash
dig @1.1.1.1 +short geiom.com A
dig @1.1.1.1 +short www.geiom.com CNAME
dig @1.1.1.1 +short _domainconnect.geiom.com CNAME
dig @1.1.1.1 +short _dmarc.geiom.com TXT
dig @1.1.1.1 +short geiom.com TXT
dig @1.1.1.1 +short geiom.com MX
```

### 3.2 切换时清理 Squarespace 残留（只删下列项）

- [ ] **先备份**：在 Cloudflare DNS 面板导出/截图当前全部记录；对照上表记下将被删除的记录的完整值（含 TTL、代理状态）。
- [ ] 清掉 Squarespace 留下的记录（**只删这几条**）：
  - 裸域 `geiom.com` 的 **4 条 A**（Squarespace 源站；若面板里已是指向新源站 / 仅 CF 代理且无 Squarespace 目标，则跳过并报 PM/运维确认）；
  - `www` 的 **CNAME**（若仍指向 Squarespace / `ext-cust.squarespace.com` 等）；
  - `_domainconnect` 的 **CNAME**（Squarespace Domain Connect；公网当前已无，面板若仍有则删）。
- [ ] **不动**：MX、现有 TXT（含 SPF、GSC/Yandex 验证）、DKIM（`cf2024-1._domainkey` 等）、Email Routing 相关记录、NS。不要为「自建邮件」去加 `mail.geiom.com` A、bounce+/VERP 或 SMTP/IMAP 主机名。
- [ ] 清理后把新的 A/AAAA（或 CNAME）指到本次 Docker+Caddy 源站，并保持 Cloudflare 代理策略与 ops-plan §7 一致（www→裸域 301 由 Cloudflare 重定向规则处理）。

### 3.3 新增 DMARC（一个域名只能有一条）

- [ ] **先查**：`dig @1.1.1.1 +short TXT _dmarc.geiom.com`（或面板搜 `_dmarc`）。当前公网为 **NXDOMAIN / 无记录**。
- [ ] 若**已有** `_dmarc` TXT：**不要覆盖**；把现有值报给 PM 和运维，由他们决定是否改 `p=` / `rua=`。
- [ ] 若**没有**，由运维新增一条：
  | 主机 | 类型 | 值 |
  |---|---|---|
  | `_dmarc.geiom.com`（或面板主机名 `_dmarc`） | TXT | `v=DMARC1; p=none` |
- [ ] 先**不带 `rua`**。等 temp-mail 关掉匿名创建以后再加收报告地址，否则报告可能被抢注的地址收走。`p=none` 只监控，不拒信。
- [ ] 验证：`dig @1.1.1.1 +short TXT _dmarc.geiom.com` 应只返回**一条** DMARC。

### 3.4 发信 SPF / DKIM：不改

- [ ] 发信走 Gmail SMTP（From = Gmail 地址，Reply-To = geiom.com 地址），收件方按 gmail.com 的 SPF / DKIM / DMARC 校验，geiom.com 的记录不参与外发邮件。
- [ ] **SPF 保持** `v=spf1 include:_spf.mx.cloudflare.net ~all`，不加 Gmail（`_spf.google.com`）或 Resend 的 `include:`，也不整段覆盖。
- [ ] **DKIM 不新增**：已有 `cf2024-1._domainkey` 等记录保留，不覆盖。
- [ ] **DMARC 只用 `p=none`**（见 3.3），不改成 `quarantine` / `reject`。
- [ ] 验证：切换后 `dig @1.1.1.1 +short TXT geiom.com` 里的 SPF 仍是上面这一条，且只有一条 `v=spf1`。

### 3.5 GSC / Yandex 域名验证 TXT

由 Ryan 拿到验证用的 TXT 记录后，交运维在 Cloudflare DNS 里**只新增、不覆盖**已有记录（SPF、DKIM、DMARC 等）；同一主机名 `@` 下可以有多条 TXT（DMARC 除外，见 3.3）。我们不代 Ryan 登录 GSC/Yandex，也不保存他的账号。

| 用途 | 主机 | 类型 | 值 | 文档 |
|---|---|---|---|---|
| Google Search Console「网域」资源 | `geiom.com`（@） | TXT | `google-site-verification=<GSC 给的 token>` | https://support.google.com/webmasters/answer/9008080 |
| Yandex Webmaster | `geiom.com`（@） | TXT | `yandex-verification: <Вебмастер 给的代码>` | https://yandex.com/support/webmaster/en/service/rights ；格式见 https://yandex.com/dev/webmaster/doc/en/concepts/verification |

- [ ] 账号由 Ryan 本人持有（{{待Ryan确认}}）：由 Ryan 用自己的账号添加域名资源，拿到验证用的 TXT 记录，交给运维添加（只新增、不覆盖已有记录）。我们不代他登录，也不保存他的账号。
- [ ] Yandex 要添加的网址是 `https://geiom.com`；带 www 和不带 www 在 Yandex 里算两个站，按我们的配置只加裸域。
- [ ] 备选方法（不改 DNS 时）：Yandex 可以用 `<meta name="yandex-verification" content="…">` 或根目录的 `yandex_<code>.html`；GSC「网址前缀」资源可以用 meta 标签或 HTML 文件。走这条路需要改代码，另外开 PR（TBD）。
- [ ] 验证：`dig @1.1.1.1 +short TXT geiom.com`（应同时看到 SPF + 验证 TXT；本机 dig 不可靠时用 DoH）。
- [ ] Bing（可选）：在 Bing Webmaster Tools 里「从 GSC 导入」，不需要额外的 DNS 记录。

## 4. 提交 sitemap、网址检查、IndexNow

- [ ] GSC：网域资源验证通过 → 站点地图 → 提交 `https://geiom.com/sitemap.xml`。
- [ ] GSC 网址检查：`https://geiom.com/en`、`/ru`、`/en/products`、`/ru/products` → 请求编入索引。
- [ ] Yandex Webmaster：验证通过 → Индексирование → Файлы Sitemap → 添加 `https://geiom.com/sitemap.xml`；Переобход страниц 提交 `/ru`、`/en`、`/ru/products`。
- [ ] IndexNow（按仓库实现，`src/lib/seo/indexnow.ts`）：
  - 启用条件：生产环境（#279 后为 `APP_ENV`/`VERCEL_ENV`=production）+ `INDEXNOW_KEY` 格式合法 + 去重存储可用 + `NEXT_PUBLIC_SITE_URL` 是 https。缺任何一项都会**静默**关闭。
  - 去重存储：自建服务器用本地 Redis（`RATE_LIMIT_STORE=redis`），**不是** Upstash。运维 PR1/PR2 会使 IndexNow 同时接受 `upstash` 或 `redis`；合入前若代码仍只认 Upstash，自建上 IndexNow 会静默关闭。另需配置好 `INDEXNOW_KEY`。上线后由运维查日志确认已启用（不应出现因 store/key 缺失而关闭的迹象）。
  - 密钥文件：`https://geiom.com/<INDEXNOW_KEY>.txt`（next.config rewrite 到 `/api/indexnow-key/[file]`），内容就是密钥本身。检查：`curl -s -w '\n%{http_code}\n' $S/<KEY>.txt` → 返回密钥和 200；随便写一个文件名应返回 404。
  - 推送端点写死为 `https://yandex.com/indexnow`（POST JSON：host/key/keyLocation/urlList），同一 URL 10 分钟去重。Yandex 和 Bing 通过 IndexNow 协议互相共享提交；**Google 不支持 IndexNow**，Google 只靠 sitemap 和 GSC。
  - 触发：Sanity webhook `/api/sanity/revalidate`，以及后台模型上架 `/api/admin/models/[id]/publish`（推 `/en/products`、`/ru/products`）。product/solution/article 类型目前 `live: false`，所以现在只有模型上架会推。**没有「全站推送」脚本**，切换当天要靠 sitemap；想手动推一次的话由运维用密钥 POST（TBD）。
  - 验证：上架或重新上架一个模型后，日志里不应出现 `[indexnow] errorSummary=…`，并由运维确认 IndexNow 已启用；Yandex Webmaster 里 IndexNow 的统计（TBD 实测）。
  - 参考：https://www.indexnow.org/documentation 、https://yandex.com/support/webmaster/en/indexing-options/index-now

## 5. 前 72 小时监控 / 回滚

- [ ] 0–2 h：第 2 节全部重跑一遍；Cloudflare Security Events 看爬虫有没有被拦；应用日志看 5xx 和 `[indexnow]`。
- [ ] 每天：GSC「网页 / 编入索引」覆盖率、「站点地图」状态（已读取、已发现的 URL 数）、抓取统计（404、5xx、主机问题）；Yandex「Страницы в поиске」「Диагностика」「Статистика обхода」里的 404 / 不可达。
- [ ] 检查 noindex 页（solutions/factory/cases）没有被收录、没有进 sitemap。
- [ ] 出现以下任何一种情况立即报 SEO / 运维：生产出现 `X-Robots-Tag: noindex` 或 robots `Disallow: /`；www 有多跳；sitemap 里有 localhost / vercel.app 地址；爬虫被挑战。
- [ ] 回滚：网站 A/AAAA（或 CNAME）按 3.1 备份切回（Vercel 或 Squarespace 源站，由运维决定，TBD）。**不要动** MX、SPF、DKIM、Email Routing、已有 DMARC、GSC/Yandex TXT。新站目前没有收录，短时间回滚不影响 SEO；回滚期间不要提交 sitemap 和 IndexNow。
