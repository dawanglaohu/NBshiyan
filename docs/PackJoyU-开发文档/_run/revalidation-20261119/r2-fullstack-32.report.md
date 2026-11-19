# B10-M4T4-REVAL R2：32 项只读复验报告

**结论：32/32 均为「不适用」，没有「不满足」。** 复验人是全栈工程师/安全工程师。证据见 [R2.evidence.json](R2.evidence.json)，其中 `verdict=pass`、`conclusion=不适用`；逐项对照见 [R2.items.tsv](R2.items.tsv)，全局核对见 [R2.checks.json](R2.checks.json)。

## 固定对象
- 文档：`02ea695fbc7d581392d0d29e2fdcb27f1e6b8acb`。只用 `git show`/`git grep` 从主仓共享对象库读取。
- 代码：main `a7941062af916119d53e0802d1752b4c1ab02424`。
- 补丁：`m4t4-retry-contract-20261119`，sourceVersion 为 `c9509a49…`。32 项在 `revalidation.json` 里登记的 sourceVersion 都是这个值。

## 补丁对三节的实际改动
- `a7941062..02ea695f` 在这三节里只有 5 个 hunk：
  - 09 节：L24（ChatNotification 行的说明列）、L174 与 L176–L182（通知状态图）；
  - 15 节：L31（聊天通知的次数与退避）；
  - 18 节：L94（聊天可用性与通知策略）。
- 改动内容都是 M4 ChatNotification 的规则：首次发送后最多重试 3 次，attempts 只计已标记开始的尝试，退避时钟，过期清扫，UNKNOWN 提升，以及 SMTP 缺配置时置 DISABLED 的范围。
- ChatNotification 的模型名和字段清单（L24 第 1、2 列）逐字不变，其他数据行和既有邮件行都没动。
- 18 节里的既有邮件配置在 L48–L57，mail-queue 调度在 L125，都没有改。

## 判定方法
每项依次核了下面几点：
1. `revalidation.json` 的 `changedFields`，确认本卡契约实际包含这几节中的哪几节：
   - 18 项含 09/15/18；
   - 14 项含 09/18；
   - M3‑T21 至 T24 只含 18。
2. 本卡的「产出」行，以及卡面的通知关键词：ChatNotification、通知出箱、E‑90～E‑93、attempts 比较、availableAt、stableMessageId。32 项命中都是 0。
3. 有效路径和 main 上通知出箱代码是否有交集。通知符号只出现在 `prisma/schema.prisma`、`src/lib/server/chat/conversation-service.ts` 和 `src/lib/server/chat/repo.ts`。
   - 有 7 项的有效路径含 `schema.prisma`：M3‑T1、T2、T3、T4、T14、T19 和 R4‑T78812657。它们对 schema 的义务都是账号、设备、恢复、计数等模型，ChatNotification 字段清单没有变化。
   - 11 项 M3 卡（M3-T1、M3-T2、M3-T3、M3-T4、M3-T5、M3-T7、M3-T15、M3-T16、M3-T17、M3-T19、M3-T20）的有效路径含 `src/app/api/chat/`、`src/app/admin/chat/` 等路由目录，这些目录里没有通知符号。
4. 契约哈希：`revalidation.json` 的当前值、docs‑data 的 `handoff.contracts[*].hash` 和补丁证据中的值，三方 32/32 一致。

## 个别项说明
- **M3‑T21**：其中的 status/retry 属于既有询盘 MailThread 和离线 SMTP 探针，即既有邮件队列（卡 L31、L81）。本卡契约只含 18 节，18 节的改动只在聊天通知行。
- **M3‑T22**：未归类邮件只做样式迁移，门禁保持关闭，不新增后端。
- **R4‑T78812657**：有效路径含 09 节和 `schema.prisma`，义务是 AdminDeviceSession 的期限注释，09 节里这一行没有改。
- **R4‑T64765902 / R4‑T76958784**：前者是删除第三方 Tawk 的路径判断，后者是隐私页聊天 cookie 的文案，都与站内通知出箱无关。

## 纪律与限界
- 没有运行 status、verify、build 或 landed，没有改标记、源码、分支或工作树，也没有启动数据库、服务或测试。
- 本次是只读的文档契约复核，不能当作代码验收或运行证据。M4‑T4 本身以及 R1 中的 M4‑T1、M4‑T2 不在本组。
- 清除标记由运维统一集成，需要把本证据放到 `_run/revalidation-20261119/R2.evidence.json` 后再跑 verify。
