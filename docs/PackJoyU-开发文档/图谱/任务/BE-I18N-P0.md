---
type: task
id: BE-I18N-P0
status: todo
module: M7
origin: issue-ledger-20261024
---

# BE-I18N-P0　第 0 期 i18n 后端

> 来自 `04-执行/遗留issue-20261024.md`。不进入 19 节原批次。状态以该登记为准。

- 所属模块：[[M7]]
- 前置依赖：无
- GitHub：#430
- 审查：全栈审查
- 登记状态：待派

## 输入 / 产出

- **输入**：已发布语言清单，以及 es/de/fr 邮件稿和 Sanity 字段。
- **产出**：邮件模板、PublishedLocaleSchema 和 Sanity schema 接受 es/de/fr，未发布语言的公开接口仍拒绝。
- **有效路径**：`scripts/build-email-templates.mjs`、`src/i18n/published-locales.ts`、`src/lib/server/published-locales.ts`、`sanity/schemas/index.ts`

## 验收标准

不改 enum Locale。PR #360 已经加上 es/de/fr/ja/hi/ar。预留不等于发布。邮件模板改为语言表驱动，es/de/fr 的 inquiry-ack 和 sample-ack 能生成；任一条 SAMPLE_RULES 未命中时脚本报错退出。各语言的公司行都从客户确认邮件去掉。加一种新语言只改语言表和模板文件。pnpm email:build 后生成文件与源一致。未发布语言的公开接口仍是 400，有测试。Sanity schema 有 es/de/fr 字段，en 仍必填。不因为本任务去发布语言，除非派发说明明确要求。不新增依赖，不改 lockfile。tsc、lint、test 通过。改到 scripts 和 src/lib/server，走全栈审查。涉及后台 e2e 时，PR 正文写明单 IP 登录总数 ≤26。

## 必须处理的边界

无

## 代码位置

<!-- code:begin -->
_落地前回填：`路径:行号` — 作用。_
<!-- code:end -->

## 实施沉淀

<!-- notes:begin -->
_落地前回填实现选择、失败教训与维护约束。_
<!-- notes:end -->
