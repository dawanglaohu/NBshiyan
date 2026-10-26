---
type: task
id: BACKFILL-MJS
status: done
module: M3
origin: issue-ledger-20261024
---

# BACKFILL-MJS　hardExpiresAt 回填改为可在生产运行的脚本

> 来自 `04-执行/遗留issue-20261024.md`。不进入 19 节原批次。状态以该登记为准。

- 所属模块：[[M3]]
- 前置依赖：无
- GitHub：没有单独的 GitHub issue
- PR：#488
- 合并提交：`f95a8e234cc1d1b531e67324118b10c85205d3d6`
- 审查：由 PR 上 bot 审查替代
- 登记状态：已落地

没有单独的 GitHub issue。两条 UPDATE 的文本与 device-session.ts 的 backfillHardExpiresAt 相同。

## 输入 / 产出

- **输入**：生产镜像不能跑 tsx，已有设备行的 hardExpiresAt 仍可能为空。
- **产出**：node 可执行的回填脚本，时长与应用内回填一致，并进入 standalone 镜像。
- **有效路径**：`scripts/backfill-hard-expires-at.mjs`、`scripts/backfill-hard-expires-at-lib.mjs`、`package.json`、`next.config.ts`、`Dockerfile`、`tests/backfill-hard-expires-at.test.ts`

## 验收标准

已由 PR #488 于 2026-10-26 合入 main。合并提交 f95a8e234cc1d1b531e67324118b10c85205d3d6。回填命令是 node scripts/backfill-hard-expires-at.mjs。普通会话 12 小时，记住设备 30 天。只更新 hardExpiresAt 仍为空的行。本登记不重做。

## 必须处理的边界

无

## 代码位置

<!-- code:begin -->
- `scripts/backfill-hard-expires-at.mjs:15` — 生产入口：无参数才回填，stdout 两行计数
- `scripts/backfill-hard-expires-at.mjs:20` — 仅在有 `DATABASE_URL` 时动态加载 `@prisma/client`
- `scripts/backfill-hard-expires-at.mjs:24` — 使用与 `ADMIN_SESSION_POLICY` 相同的 12 小时 / 30 天
- `scripts/backfill-hard-expires-at-lib.mjs:15` — `ORDINARY_ABSOLUTE_MS` 为 12 小时
- `scripts/backfill-hard-expires-at-lib.mjs:17` — `REMEMBERED_ABSOLUTE_MS` 为 30 天
- `scripts/backfill-hard-expires-at-lib.mjs:34` — 只更新 `hardExpiresAt` 仍为空的行
- `scripts/backfill-hard-expires-at-lib.mjs:57` — 多余参数退出码 2；异常只写 `error=backfill_failed`
- `package.json:15` — `admin:backfill-hard-expires` 为 `node scripts/backfill-hard-expires-at.mjs`
- `next.config.ts:117` — 两个 `.mjs` 列入 `/api/health` 的 `outputFileTracingIncludes`
- `Dockerfile:116` — 构建时断言两个脚本都在镜像里
- `tests/backfill-hard-expires-at.test.ts:71` — 锁定时长，并比对两条 UPDATE
<!-- code:end -->

## 实施沉淀

<!-- notes:begin -->
生产镜像不能跑 tsx。回填命令是 `node scripts/backfill-hard-expires-at.mjs`，由 `pnpm admin:backfill-hard-expires` 调用。时长写在 `.mjs` 里，单测要求等于 `ADMIN_SESSION_POLICY.ordinaryAbsoluteMs` 与 `absoluteMs`。两条 UPDATE 的文本与 `device-session.ts` 的 `backfillHardExpiresAt` 相同。脚本随 `/api/health` 的文件追踪进入 standalone。Dockerfile 在文件缺失时让构建失败。
<!-- notes:end -->
