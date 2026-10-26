---
type: task
id: GATE-HARDEN
status: done
module: M7
origin: issue-ledger-20261024
---

# GATE-HARDEN　安全审查 gate 防止 workflow 绕过

> 来自 `04-执行/遗留issue-20261024.md`。不进入 19 节原批次。状态以该登记为准。

- 所属模块：[[M7]]
- 前置依赖：无
- GitHub：#438
- PR：#438
- 合并提交：`bec2066b4876ce814554dd64d2d63f71b5abb26c`
- 审查：全栈审查
- 登记状态：已落地

已由 PR #438 于 2026-10-25 合入 main。合并提交 bec2066b4876ce814554dd64d2d63f71b5abb26c。后续范围见 GATE-HARDEN-2。

## 输入 / 产出

- **输入**：已合入 main 的 PR #438。
- **产出**：合入 main 后的 pull_request_target gate、replay 和 rerun。
- **有效路径**：`.github/workflows/security-review.yml`、`.github/workflows/security-review-replay.yml`、`.github/workflows/security-review-rerun.yml`

## 验收标准

已由 PR #438 于 2026-10-25 合入 main。合并提交 bec2066b4876ce814554dd64d2d63f71b5abb26c。gate 与 rerun 不 checkout、不安装依赖、不构建、不执行 PR head 里的代码。新增路径规则覆盖 src/app/admin、src/app/media、src/components/admin、src/components/seo/JsonLd.tsx、src/lib/site-settings。需要全栈审查者批准后，再由有旁路权限的管理员合并。

## 必须处理的边界

无

## 代码位置

<!-- code:begin -->
- `.github/workflows/security-review-replay.yml:1` — 批准或撤销评审时只发信号，不在 PR 的 merge commit 上做判定
- `.github/workflows/security-review-rerun.yml:1` — 只从默认分支重跑 pull_request_target 的 gate，不 checkout，不读 artifact
- `.github/workflows/security-review.yml:3` — pull_request_target 使用默认分支上的这份文件，PR 改规则不会改变本次判定
- `.github/workflows/security-review.yml:4` — 只通过 API 读 PR 文件列表和 reviews，不安装、不构建、不执行 PR head 的代码
- `.github/workflows/security-review.yml:31` — 路径规则补上 src/app/admin、src/app/media、src/components/admin、src/components/seo/JsonLd.tsx、src/lib/site-settings
<!-- code:end -->

## 实施沉淀

<!-- notes:begin -->
gate 与 rerun 不 checkout，不安装依赖，不构建，不执行 PR head 里的代码。replay 只发信号，判定留在默认分支的 security-review.yml。PR 修改、删除规则或提前 return 不会改变这次判定。新增路径覆盖后台、媒体、后台组件、JsonLd 和 site-settings。合入前默认分支上还没有这份检查。
<!-- notes:end -->
