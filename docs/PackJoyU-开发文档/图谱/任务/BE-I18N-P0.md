---
type: task
id: BE-I18N-P0
status: done
module: M7
origin: issue-ledger-20261024
---

# BE-I18N-P0　第 0 期 i18n 后端

> 来自 `04-执行/遗留issue-20261024.md`。不进入 19 节原批次。状态以该登记为准。

- 所属模块：[[M7]]
- 前置依赖：无
- GitHub：#430
- PR：#449
- 合并提交：`a761b058de8bc45c87d19207a411b1cfc204ab82`
- 审查：全栈审查
- 登记状态：已落地

已由 PR #449 于 2026-10-24 合入 main。合并提交 a761b058de8bc45c87d19207a411b1cfc204ab82。issue #430 已关闭。这次不发布新语言。sample-ack 由 inquiry-ack 经 SAMPLE_RULES 写入 src/lib/server/email/templates.generated.ts。design/emails/ 新增的是 inquiry-ack 的 es/de/fr 稿。

## 输入 / 产出

- **输入**：已发布语言清单，以及 es/de/fr 邮件稿和 Sanity 字段。
- **产出**：邮件模板和 Sanity schema 支持 es/de/fr。这次不发布任何新语言。未发布语言的公开接口仍返回 400。
- **有效路径**：`scripts/build-email-templates.mjs`、`src/i18n/published-locales.ts`、`src/lib/server/published-locales.ts`、`sanity/schemas/index.ts`、`design/emails/inquiry-ack.es.html`、`design/emails/inquiry-ack.es.txt`、`design/emails/inquiry-ack.de.html`、`design/emails/inquiry-ack.de.txt`、`design/emails/inquiry-ack.fr.html`、`design/emails/inquiry-ack.fr.txt`、`src/lib/server/email/templates.generated.ts`、`src/lib/server/specs.ts`

## 验收标准

不改 enum Locale。PR #360 已经加上 es/de/fr/ja/hi/ar。预留不等于发布。邮件模板改为语言表驱动，es/de/fr 的 inquiry-ack 和 sample-ack 能生成；任一条 SAMPLE_RULES 未命中时脚本报错退出。各语言的公司行都从客户确认邮件去掉。加一种新语言只改语言表和模板文件。pnpm email:build 后生成文件与源一致。未发布语言的公开接口仍是 400，有测试。Sanity schema 有 es/de/fr 字段，en 仍必填。不因为本任务去发布语言，除非派发说明明确要求。不新增依赖，不改 lockfile。tsc、lint、test 通过。改到 scripts 和 src/lib/server，走全栈审查。涉及后台 e2e 时，PR 正文写明单 IP 登录总数 ≤26。

## 必须处理的边界

无

## 代码位置

<!-- code:begin -->
- `src/i18n/published-locale-list.ts:5` — 已发布语言仍是 en、ru。es/de/fr 不在这份清单里。
- `src/i18n/published-locales.ts:17` — 页面、sitemap、hreflang 和公开接口读这一份再导出。
- `src/lib/server/published-locales.ts:15` — PublishedLocaleSchema 只接受已发布语言。
- `src/lib/server/specs.ts:142` — parseLocale 对未发布语言返回 null，路由给 400。
- `src/lib/contracts/common.ts:9` — LocaleSchema 使用已发布清单。
- `src/lib/contracts/common.ts:30` — 站内路径的语言段必须是已发布语言。
- `scripts/build-email-templates.mjs:66` — CUSTOMER_LOCALES 驱动 inquiry-ack 和 sample-ack。es 从第 103 行起。
- `scripts/build-email-templates.mjs:176` — sample-ack 由 inquiry-ack 经 sampleRules 改写，未命中就退出。
- `src/lib/server/email/templates.generated.ts:13` — 生成结果含 inquiry-ack.es，同文件还有 de、fr。
- `src/lib/server/email/render.ts:27` — 回复时间的语言后缀认 es、de、fr。
- `sanity/schemas/index.ts:8` — 内容字段有 es、de、fr。en 仍在第 6 行，必填。
- `src/lib/seo/contentSlug.ts:7` — de 变音折成 ae/oe/ue/ss，es/fr 去掉组合附加符号。
- `design/emails/inquiry-ack.es.html:1` — es 询盘确认稿。de、fr 的 html 和 txt 在同一目录。
- `tests/i18n-be-phase0.test.ts:51` — 断言 es/de/fr 的 inquiry-ack 和 sample-ack 能生成。
<!-- code:end -->

## 实施沉淀

<!-- notes:begin -->
- PR #449，合并提交 `a761b058de8bc45c87d19207a411b1cfc204ab82`。`git show --stat` 是 23 个文件。这次准备 es/de/fr 的邮件稿和 Sanity 字段。已发布清单仍是 en、ru。
- 公开契约、站内路径和品类规格都读 `published-locale-list.ts`。未发布语言的公开接口仍是 400。Prisma enum Locale 里的 es/de/fr/ja/hi/ar 是预留。
- sample-ack 不另写稿。`build-email-templates.mjs` 用语言表里的 sampleRules 从 inquiry-ack 改写。任一条没命中，脚本报错退出。客户确认邮件按语言表去掉公司行。
- 加一种客户语言：在 CUSTOMER_LOCALES 加一行，并放入 `design/emails/inquiry-ack.<code>.{html,txt}`。处理逻辑不按语言写分支。
<!-- notes:end -->
