---
type: task
id: SEO-4
status: hold
module: M7
origin: issue-ledger-20261024
---

# SEO-4　生产环境只认 APP_ENV

> 来自 `04-执行/遗留issue-20261024.md`。不进入 19 节原批次。状态以该登记为准。

- 所属模块：[[M7]]
- 前置依赖：无
- GitHub：#428
- 审查：全栈审查
- 登记状态：暂不派

暂不派。运维只核对 APP_ENV 这一个变量是否为 production。不要在文档或 PR 里记录完整环境输出。

## 输入 / 产出

- **输入**：现在仍把 VERCEL_ENV 当作生产兜底的判断。
- **产出**：生产只认 APP_ENV=production。
- **有效路径**：`src/lib/site.ts`、`src/lib/seo/mock.ts`、`src/lib/server/privacy.ts`、`src/lib/server/security.ts`、`src/lib/server/mail/config.ts`、`src/lib/server/admin/enroll-token.ts`

## 验收标准

等运维对 APP_ENV=production 的检查 PASS 之后才派，然后走全栈审查。去掉 VERCEL_ENV 兜底。src 里不再把 VERCEL_ENV 当成生产（专门断言「只设 VERCEL_ENV=production 仍是非生产」的测试除外）。单测：APP_ENV=production 是生产；只设 VERCEL_ENV=production 不是生产；生产下 TURNSTILE_VERIFY_URL 和 SEO_AUDIT_MOCK=1 都不生效。tsc、lint、test、build 通过。改到 src/lib/server，必须全栈审查。

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
