# 上线后第一周 SEO 监控草稿

配合 [Google/Bing 设置](./gsc-bing-setup.md)与 [Yandex 设置](./yandex-webmaster-setup.md)使用。D1 是实际开始监控的日期；空表不表示已完成检查。账号和服务器日志由站点所有者或授权运维读取，凭据与生产客户数据不写入记录。

## 每日检查（D1–D7）

| 项目 | 检查方法 | 判断与处理 |
| --- | --- | --- |
| 正式站可抓取性 | 读取 robots.txt、正式首页/产品/联系页的 HTTP 状态、meta robots 和 X-Robots-Tag；仅抽查已发布语言和内容 | 正式公开页应能抓取；非预期 noindex、全站 Disallow 或首页非 200 立即交运维排查 `APP_ENV` 与部署。预览环境应有访问保护，robots 不是访问控制。 |
| Sitemap | 公开获取 sitemap.xml；有权限时看 Google、Bing、Yandex 的处理报告 | 应返回 XML，条目只指向可索引页面。区分“已提交”“已发现”和“已收录”，无数量保证。 |
| 索引状态 | 查看平台已索引/未索引原因和网址检查；`site:` 结果只作粗略参考 | 初期数据可能少或滞后，先记录基线。持续异常先查抓取、响应和内容，不按固定天数保证收录。 |
| HTTP 错误 | 授权运维按状态码汇总匿名错误计数，结合平台抓取统计 | 区分预期不存在/下线的 404、410 与内部坏链；持续 5xx/503 交后端排查，保留诊断时间，不粘贴询盘或账号数据。 |

## 指定日检查

| 日期 | 项目 | 方法和判断 |
| --- | --- | --- |
| D1 | 关键页 | 使用[设置稿的页面清单](./gsc-bing-setup.md#sitemap-与关键页)记录实际响应、索引限制和平台诊断。未发布的品类、文章、About 语言版本不加入。 |
| D1、D4、D7 | canonical / hreflang | 抽查源码、sitemap 和平台诊断；canonical 对应自身规范页，语言页互指已发布的对应 URL，默认回退指向正确。差异交 SEO/开发定位。 |
| D2、D5 | 结构化数据 | 用 [Schema Markup Validator](https://validator.schema.org/)检查语法与页面事实，再按 [Google Product snippet 要求](https://developers.google.com/search/docs/appearance/structured-data/product-snippet)判断资格。品类聚合页不因含 Product 就有富结果资格；缺必需字段可能导致不符合资格，不能笼统记为“可忽略警告”，更不能编造价格、库存、评分或认证补齐。 |
| D2、D5 | 性能 | 查看 Search Console Core Web Vitals；数据不足时另记 PageSpeed Insights/Lighthouse 实验室的 LCP、CLS、TBT，注明设备和测量条件。实验室数据不代替真实用户 INP。 |
| D3、D7 | 搜索词 | 有权限时查看 Google、Bing、Yandex 的展示、点击和英俄查询；结合 [RU 关键词](./seo-keywords-ru.md)记录内容改进候选，不把单次波动当结论。 |
| D7 | 周记录 | 汇总基线变化、异常、负责人和下一步；事实与俄语稿仍由 Ryan 确认。 |

## 升级与记录

正式站被屏蔽或首页非 200 立即处理；持续服务错误由运维和后端处理；sitemap、规范页、语言、坏链与结构化数据问题交 SEO/开发。DNS、平台授权、构建参数或索引提交交站点所有者。认证、MOQ、交期、产能等信息在确认前保持待核实，不为完成监控表填推测值。

| 指标 | D1 | D2 | D3 | D4 | D5 | D6 | D7 | 备注/下一步 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Google 已索引/未索引原因 | | | | | | | | |
| Bing 索引状态 | | | | | | | | |
| Yandex 可搜索页面 | | | | | | | | |
| Sitemap 处理状态 | | | | | | | | |
| 非预期 404/410/5xx 汇总 | | | | | | | | |
| LCP/CLS/TBT 实验室条件及数值 | | | | | | | | |
| 结构化数据语法/事实/资格问题 | | | | | | | | |

目标值在取得基线后另行确认。本表不更改网站索引开关，也不执行内容发布。
