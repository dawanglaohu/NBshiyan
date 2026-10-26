---
type: task
id: CI-DEVICE-SERIAL
status: done
module: M3
origin: issue-ledger-20261024
---

# CI-DEVICE-SERIAL　设备会话回归串行执行并在失败时打印 TAP

> 来自 `04-执行/遗留issue-20261024.md`。不进入 19 节原批次。状态以该登记为准。

- 所属模块：[[M3]]
- 前置依赖：无
- GitHub：没有单独的 GitHub issue
- PR：#485
- 合并提交：`5bae3f292558d91cfe18475f3aec82c8efee4df0`
- 审查：由 PR 上 bot 审查替代
- 登记状态：已落地

没有单独的 GitHub issue。不改 src。lastActivityAt 的节流边界准备值是 activityThrottleMs 加 1000 毫秒。

## 输入 / 产出

- **输入**：设备会话回归在 CI 里并行时互相干扰，失败日志也不够定位。
- **产出**：该回归步骤串行执行；失败时打印 TAP 和文件门禁输出。活动续期测试的节流准备值离开等号。
- **有效路径**：`.github/workflows/ci.yml`、`tests/admin-session-activity.http.test.ts`

## 验收标准

已由 PR #485 于 2026-10-26 合入 main。合并提交 5bae3f292558d91cfe18475f3aec82c8efee4df0。设备会话回归使用 test-concurrency=1。失败时打印 TAP 与文件门禁输出后退出 1。成功路径仍做汇总检查和按文件门禁，并要求 todo 为 0。本登记不重做。

## 必须处理的边界

无

## 代码位置

<!-- code:begin -->
- `.github/workflows/ci.yml:125` — 设备会话回归使用 `--test-concurrency=1`
- `.github/workflows/ci.yml:133` — 失败时打印 TAP 和按文件门禁后退出 1
- `.github/workflows/ci.yml:136` — 成功路径要求 todo 为 0
- `tests/admin-session-activity.http.test.ts:351` — `lastActivityAt` 的节流边界准备值是 `activityThrottleMs + 1000` 毫秒
<!-- code:end -->

## 实施沉淀

<!-- notes:begin -->
设备会话回归在 CI 里串行跑 guard、device session 和 activity 三个文件。失败时把 TAP 和按文件门禁打到日志后退出 1。成功路径检查 skipped、fail、todo 都是 0，并且 pass 至少为 1。节流准备值离开等号 1000 毫秒。这次不改 `src`。
<!-- notes:end -->
