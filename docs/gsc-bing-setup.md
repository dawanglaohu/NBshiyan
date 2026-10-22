# Google Search Console 与 Bing Webmaster Tools 设置草稿

本文用于站点所有者和运维人员准备搜索平台设置，不表示账号、DNS、验证或收录已经完成。实际操作前，先按[上线检查](./launch-checklist.md)确认正式站点；首周记录使用[SEO 监控表](./seo-first-week-monitoring.md)。

## 前提

- 正式域名 HTTPS 正常，www、非 www、http 统一跳转到选定的正式地址；`NEXT_PUBLIC_SITE_URL` 与该地址一致。
- 正式环境使用 `APP_ENV=production`。当前代码仍兼容 `VERCEL_ENV=production`，自托管配置以 `APP_ENV` 为准，详见 [site.ts](../src/lib/site.ts)。预览环境应有访问保护，并检查 robots 与 noindex。
- 只提交已经发布、HTTP 200、允许抓取且没有 noindex 的页面。当前品类落地页由 `CATEGORY_PAGES_LIVE` 控制，不能为填写本表而打开。
- 账号授权、DNS、构建参数和部署由 Ryan 或授权运维操作；不要把凭据或私密截图写进仓库。

## Google Search Console

### 添加和验证资源

1. 站点所有者登录 [Search Console](https://search.google.com/search-console)。优先添加网域资源，填写根域名，不带协议和路径；它覆盖不同协议和子域名。
2. 按平台给出的 DNS TXT 记录验证。保留已有 SPF 等 TXT，验证成功后也保留验证记录。
3. 如果需要只看正式 HTTPS 地址，可另加网址前缀资源。它只覆盖指定协议、主机和路径；也可使用效果报告中的页面过滤查看 `/en/` 与 `/ru/`。
4. 网址前缀资源可使用 HTML meta 验证。将公开验证值放入构建环境的 `NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION`，按现有发布流程重新构建部署，再查看 HTML 中的 `google-site-verification`。

资源范围和可用验证方式以 [Google 官方说明](https://support.google.com/webmasters/answer/34592)为准；添加资源本身不会改变搜索排名。

### Sitemap 与关键页

1. 在站点地图中提交 `https://<正式域名>/sitemap.xml`，确认处理状态和发现网址数，不预设应收录数量。
2. 对 `/en`、`/ru`、两种语言的 `/products` 和 `/contact` 使用网址检查。About、文章和其他详情页仅在该语言已发布并允许索引后加入抽查。
3. 检查 HTTP 状态、robots、meta/X-Robots-Tag、正文、canonical 和适用的 hreflang；记录“用户声明的规范网址”和“Google 选定的规范网址”，不一致时先检查重复内容与跳转。
4. “测试实际网址”和“请求编入索引”用于诊断与提交请求，不保证立刻收录。详情见 [URL Inspection](https://support.google.com/webmasters/answer/9012289)。

### 语言页面

对应的英俄已发布页面应互相指向正确语言的 URL，并指向自身；不能把俄语页 canonical 一律指到英文。`x-default` 指向默认回退页。没有对应语言内容、带 noindex 或尚未发布的页面不能凑入语言列表，页面与 sitemap 结果按各自实现核对。

检查依据是 [Google 多语言页面规范](https://developers.google.com/search/docs/specialty/international/localized-versions)。不要用访客 IP 或浏览器语言强制跳走不同语言 URL，以免抓取遗漏。

## Bing Webmaster Tools

### 添加和验证站点

1. 站点所有者登录 [Bing Webmaster Tools](https://www.bing.com/webmasters/)。可选择从 Google Search Console 导入，经所有者授权后选择已验证站点与 sitemap。
2. 导入后核对 Bing 中的站点地址、权限和 sitemap 状态。需要持续导入或重新验证时，以平台当时提示为准，不预先承诺撤销 Google 授权后仍能持续同步。
3. 手动添加时，按平台给出的 DNS、XML 文件或 meta 方法验证。本站支持构建参数 `NEXT_PUBLIC_BING_VERIFICATION`，会输出 `msvalidate.01`；公开验证值由授权运维配置。
4. 提交同一个正式 sitemap，并用 URL Inspection 抽查 Google 清单中的已发布页面。

验证方法见 [Bing 官方帮助](https://www.bing.com/webmasters/help/add-and-verify-site-12184f8b)。

### IndexNow 的当前行为

当前 [indexnow.ts](../src/lib/seo/indexnow.ts)使用 `https://yandex.com/indexnow`，请求超时为 3 秒。它检查正式环境、合法 key 和 Upstash 去重配置，并按已发布类型过滤地址；这些条件未满足时不会提交。本文不修改或开启该行为。

[IndexNow 官方 FAQ](https://www.indexnow.org/faq)同时列出 Yandex 端点和 `https://api.indexnow.org/indexnow`：向一个参与端点提交即可在参与引擎间共享，无需为 Bing 再发一遍。HTTP 200 表示接收，202 表示密钥验证待完成；均不保证收录。只有实际已启用时才检查平台报告，不为验收本文向真实引擎发送测试请求。

## 设置后记录

记录站点资源、验证方法、sitemap 状态、关键页诊断结果、操作日期和待处理问题。记录公开结果即可，不保存凭据。继续使用[第一周监控表](./seo-first-week-monitoring.md)，不要把本站仓库里的文章草稿直接导入正式内容。
