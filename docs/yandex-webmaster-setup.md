# Yandex Webmaster 上线指南（Refs #74）

> 依据 Yandex Webmaster 官方帮助（2026-10 查阅）：[验证站点所有权](https://yandex.com/support/webmaster/en/service/rights)、[站点地区](https://yandex.com/support/webmaster/en/site-geography/site-region)、[Sitemap 文件](https://yandex.com/support/webmaster/en/indexing-options/sitemap)、[站点搬迁与镜像](https://yandex.com/support/webmaster/en/yandex-indexing/moving)、[IndexNow](https://yandex.com/support/webmaster/en/indexing-options/index-now)、[IndexNow 密钥](https://yandex.com/support/webmaster/en/indexnow/key)。界面上的菜单名称以官方帮助为准，这里只写了帮助里明确提到的路径。
> 🔑 = 需要 Ryan 用自己的 Yandex 账号登录。在私聊里做，不能在群里做。

## 0. 前提
- 正式域名已上线，HTTPS 正常，`NEXT_PUBLIC_SITE_URL` 已经填好（例如 `https://<domain>`）。
- 带 www 和不带 www **只保留一个**：另一个由服务器 nginx 301 到 `NEXT_PUBLIC_SITE_URL`。http 也 301 到 https。
- 生产环境不带 noindex，robots.txt 允许抓取（见 `docs/launch-checklist.md` 第 6 节）。

## 1. 添加站点 🔑
1. Ryan 登录 Yandex Webmaster，添加站点，填写的地址要**和 `NEXT_PUBLIC_SITE_URL` 完全一致**，包括协议和有没有 www。Yandex 把 `https://www.` 和 `https://` 当成两个不同的站点。
2. 添加后会自动跳到所有权验证页面。

## 2. 所有权验证：meta 标签
1. 在验证页选择 “Meta tag on the home page”，复制 `content` 里的值。
2. 把这个值设为 `NEXT_PUBLIC_YANDEX_VERIFICATION`（公开值，构建时内联，放进服务器构建参数），然后重新构建并部署。代码已经支持（#83），会在首页 `<head>` 里输出 `<meta name="yandex-verification" content="…">`。
3. 查看首页源码，确认标签确实在 `<head>` 里，然后点 Verify。验证最多需要 24 小时。
4. **验证通过后也不要删掉这个变量**：Yandex 会定期复查，找不到验证码就会撤销所有权。
5. 如果首页有重定向，或者对 Yandex 机器人返回的不是 200，验证会失败。可以用 Webmaster 里的 Tools → Server response check 检查。

## 3. 主镜像（https，www 和 NEXT_PUBLIC_SITE_URL 一致）
- 在服务器端用 301 统一到一个地址，这是最可靠的做法。Yandex 博客说明过，重定向的优先级高于 Webmaster 里的手动设置。robots.txt 的 `Host` 指令已经不再使用，不要加。
- **已定（PM 2026-10-17）**：Webmaster 里只添加 `https://geiom.com` 一个站。`https://www.geiom.com` 和 `http://` 版本都由 nginx 301 到它，**不单独添加**，也不提交 Relocate site。
- 在 **Indexing → Searchable pages** 确认收录的都是主地址。

## 4. 站点地区：不设（PM 2026-10-17 已定）
- **结论**：不申请 Site region。目标用户是讲俄语的 B2B 采购，不是本地商家。Diagnostics 里「没有设地区」的提示属于预期。
- 以下是 Yandex 的规则，留作参考；以后如果要改这个决定，先由 PM / Ryan 重新拍板。
- 位置：**Display in the search → Site region**。选一个地区，再填一个**有联系方式的页面地址**，提交后由审核员核对，通常要几天到几周。
- 官方建议：只有当网站上确实写明了服务覆盖全国时，才选 “Russia”。否则应选具体城市，而且要和网站上写的地址一致。
- 不设地区对不依赖地理位置的搜索词影响不大；对依赖地理位置的搜索词，设了地区的网站可能排在前面。
- 无论设不设，都不要为了通过审核去编造俄罗斯地址或电话。我们是包装供应商，网站上的地址和联系方式以 Ryan 提供和确认的为准。
- 设地区要在**主地址**上设，在其他镜像上设的地区不会自动转到主地址。

## 5. 提交 Sitemap 🔑
1. 在 **Indexing → Sitemap files** 添加 `https://<domain>/sitemap.xml`，域名、协议和 www 都要和站点一致。
2. robots.txt 里已经有 `Sitemap:` 这一行，Yandex 也能自己发现，手动提交是为了快一些。
3. Yandex 一般在两周内处理。可以手动触发重新处理，每个站点最多 10 次。
4. 品类页开关（#198 的 `CATEGORY_PAGES_LIVE`）打开后，在这里再触发一次。

## 6. IndexNow（按当前实现核对）

当前 [indexnow.ts](../src/lib/seo/indexnow.ts)已接入 `https://yandex.com/indexnow`，使用 3 秒超时；只有正式环境、合法 `INDEXNOW_KEY` 和 Upstash 去重配置同时满足时才提交，并按已发布类型过滤地址。是否在实际环境启用须由授权运维确认，本文不修改开关或配置。

- 密钥为 8–128 个 `a-z A-Z 0-9 -` 字符；站点需提供同主机的 UTF-8 key 文件以供验证。不要把实际值写入文档。
- [IndexNow 官方 FAQ](https://www.indexnow.org/faq)列出的 Yandex 与 `api.indexnow.org` 都是参与端点；向其中一个提交会共享给其他参与引擎，无需为 Bing 重复提交。
- 批量 POST 上限是 10,000 个 URL。只提交实际新增、修改或删除的地址，不因保存草稿或填写监控表而推送未发布页面。200 表示接收，202 表示 key 验证待完成，不保证收录。
- 品类落地页仍受当前发布开关控制；上线前先确认 HTTP、noindex 与 sitemap，不写死旧的 24 地址清单。

更多设置与记录见 [Google/Bing 设置稿](./gsc-bing-setup.md)和[首周监控稿](./seo-first-week-monitoring.md)。

## 7. 不需要做的
- **Turbo 页面**：不做。我们的页面本身已经有速度目标，而且 Turbo 会和我们自己的页面以及 canonical 管理冲突。
- **Yandex Business（企业名录）**：只有在俄罗斯有实体地址时才有意义，目前不做。
- robots.txt 里的 `Host`、`Clean-param`：现在用不到，带参数的地址靠 canonical 处理。

## 8. 上线后的监控（每周看一次，前 4 周看得勤一些）
- **Diagnostics（诊断）**：严重问题和建议，比如没有 favicon、没有设地区、robots.txt 有错误。
- **Indexing → Searchable pages**：收录数和被剔除的页面，剔除原因有重复、noindex、404 等。
- **Sitemap files**：处理状态和错误。
- **Server response check**：抽查落地页、`/s/` 过期链接（应该是 410）、旧的内部 key 地址（应该是 301）。
- **Search queries（搜索词）**：看俄语关键词（`docs/seo-keywords-ru.md`）的展示和点击，用来调整文案。
- 每月在群里汇报一次。
