---
type: task
id: GUARD-503
status: done
module: M3
origin: issue-ledger-20261024
---

# GUARD-503　数据库故障时保留后台登录并返回 503

> 来自 `04-执行/遗留issue-20261024.md`。不进入 19 节原批次。状态以该登记为准。

- 所属模块：[[M3]]
- 前置依赖：无
- GitHub：没有单独的 GitHub issue
- PR：#483
- 合并提交：`46621db51ec59e7d062de784f866370254f86c0f`
- 审查：由 PR 上 bot 审查替代
- 登记状态：已落地

没有单独的 GitHub issue。软导航不重跑 layout，每个后台页面自己返回错误卡。重试地址由页面传入后再校验，不读请求头。fix3 的表单白名单在 src/components/admin/format.ts 与 src/lib/admin/spec-form.ts：HTTP 400 的文案来自白名单，不使用服务器返回的 message 原文。

## 输入 / 产出

- **输入**：后台页面在数据库不可用时的会话检查结果。
- **产出**：数据库不可用时页面显示错误卡（HTTP 200）并保留登录 cookie；后台 API 返回 503，其他异常返回 500。
- **有效路径**：`src/lib/server/admin/page-access.ts`、`src/lib/server/admin/guard.ts`、`src/lib/server/admin/device-session.ts`、`src/lib/admin/outage-copy.ts`、`src/components/admin/AdminOutageNotice.tsx`、`src/app/admin/admin.css`、`src/components/admin/reveal-error.ts`、`src/app/admin/inquiries/page.tsx`、`src/app/admin/inquiries/[id]/page.tsx`、`src/app/admin/mail/unassigned/page.tsx`、`src/app/admin/models/new/page.tsx`、`src/app/admin/settings/page.tsx`、`src/app/admin/specs/page.tsx`、`src/app/admin/specs/[category]/page.tsx`、`src/app/admin/users/page.tsx`

## 验收标准

已由 PR #483 于 2026-10-26 合入 main。合并提交 46621db51ec59e7d062de784f866370254f86c0f。数据库不可用时页面显示错误卡（HTTP 200）并保留登录 cookie；后台 API 返回 503，其他异常返回 500。已吊销、会话版本不符和乱码 token 仍是 401 并清 cookie。本登记不重做。

## 必须处理的边界

无

## 代码位置

<!-- code:begin -->
- `src/lib/server/admin/page-access.ts:15` — 重试地址只接受 `/admin` 下的相对路径，否则回落 `/admin`
- `src/lib/server/admin/page-access.ts:64` — `enforceAdminPage` 在数据库不可用和服务出错时返回错误卡
- `src/lib/server/admin/guard.ts:75` — 仅数据库不可用为 503
- `src/lib/server/admin/guard.ts:76` — 其他查询异常为 500，这个分支不清 cookie
- `src/lib/server/admin/device-session.ts:205` — `authenticate` 同样区分 503 与 500
- `src/lib/admin/outage-copy.ts:7` — `OUTAGE_COPY` 是 503 与 500 的中英俄正文
- `src/components/admin/AdminOutageNotice.tsx:6` — 错误卡带 `lang`、标题和重试按钮
- `src/app/admin/admin.css:90` — 错误卡的底色、边框和圆角；焦点环与正文换行在随后两条规则
- `src/components/admin/reveal-error.ts:5` — 错误条滚入视野并聚焦
- `src/app/admin/inquiries/page.tsx:8` — 不放行时返回错误卡
- `src/app/admin/inquiries/[id]/page.tsx:24` — 不放行时返回错误卡
- `src/app/admin/mail/unassigned/page.tsx:13` — 不放行时返回错误卡
- `src/app/admin/models/new/page.tsx:7` — 不放行时返回错误卡
- `src/app/admin/settings/page.tsx:16` — 不放行时返回错误卡
- `src/app/admin/specs/page.tsx:10` — 不放行时返回错误卡
- `src/app/admin/specs/[category]/page.tsx:13` — 不放行时返回错误卡
- `src/app/admin/users/page.tsx:12` — 不放行时返回错误卡
<!-- code:end -->

## 实施沉淀

<!-- notes:begin -->
软导航不会重跑 layout，每个后台页面自己返回错误卡。不使用 throw 和 error.tsx，避免生产环境抹掉服务端错误信息。500 使用独立的 internal 结果。已吊销、会话版本不符和乱码 token 仍返回 401 并清除 cookie。重试地址由页面传入后再校验，不读请求头。俄文文案在 `src/lib/admin/outage-copy.ts` 标明待语言专家审。
<!-- notes:end -->
