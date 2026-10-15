# 数据保留与隐私（Data retention & privacy）

> 待与隐私政策对齐（pending Ryan）— to be aligned with privacy policy pending Ryan.

所有天数均可通过环境变量配置，非法或越界的值回退到默认值。

| 数据 | 环境变量 | 默认 | 处理方式 |
|---|---|---|---|
| 设计（短链） | `DESIGN_TTL_DAYS` / `DESIGN_GRACE_DAYS` | 180 / 90 | 过期返回 410，过期后 grace 天由 cron 删除 |
| 样品申请邮箱计数（normalizedEmail） | `SAMPLE_COUNTER_RETAIN_DAYS` | 30 | cron 置空；IP 计数器靠限流存储 TTL 自动过期 |
| 审计日志 | `AUDIT_RETAIN_DAYS` | 365（最少 30） | cron 删除。`AuditLog.ip`（后台操作人的 IP）不单独匿名化，随整行在 365 天后删除 |
| 询盘到期匿名化 | `INQUIRY_RETAIN_DAYS` | 730 | 新询盘写入 `retainUntil`；到期后 cron 用与手动删除相同的逻辑匿名化（留言、来源归因、评分理由、产品备注清空；往来邮件和内部备注改为 `[deleted]`；产品配置去掉 logo 键；样品地址、物流单号、IP 国家（`ipCountry`）清空；回信 token 换成随机值，旧回信地址失效；绑定的 logo 记录和文件删除），写 `anonymizedAt`，不重复处理。联系人只要名下还有任何其他未匿名化的询盘，就**保持不变**（姓名、邮箱等都不动），等最后一条询盘也匿名化时才一起匿名化。每批 500 条在同一个事务里读写（复核、logo、产品配置都在事务内读取），受 `RETENTION_MAX_PER_RUN` 和整次运行的截止时间 `RETENTION_RUN_DEADLINE_MS` 限制 |
| 后台账号闲置停用 | `ADMIN_INACTIVE_DAYS` | 90（7–3650） | 从 max(最近登录 `lastLoginAt`, 重新启用 `reactivatedAt`, 创建时间) 起算；从未登录的按创建时间。cron **停用不删除**，与手动停用同一路径（会话失效、取消询盘分配），审计 `user.disable_inactive`（actor = `system`）。最后一个有效 ADMIN 不停用（`assertNotLastActiveAdmin`，与停用同一事务，`SELECT … FOR UPDATE`）。ADMIN 可用 `PATCH /api/admin/users/:id {"disabled": false}` 重新启用，闲置天数从启用时重新计算 |
| 未绑定 / 已失效的 logo | `LOGO_ORPHAN_TTL_MS`（代码常量） | 上传后 24 小时 | 没有绑定询盘、上传超过 24 小时、且没有被未过期的已保存方案引用的 logo，由 cron 删除记录和文件（删除前校验 key 必须是 `logos/YYYY-MM/<id>.png`）。cron 每天 03:00 UTC 跑一次，所以实际删除时间是上传后 24–48 小时 |
| 后台登录会话 | `SESSION_MAX_AGE`（`src/auth.ts`） | 2 小时 | JWT 会话 maxAge 2 小时，有操作时每 15 分钟续期一次（`updateAge`），所以闲置 2 小时后失效。停用账号会递增 `sessionVersion`，已签发的会话立即失效 |

清理入口：`/api/admin/cron/cleanup-uploads`（CRON_SECRET，每天 03:00 UTC；`maxDuration = 300` 秒）。同一时间只跑一次：持锁事务里 `pg_try_advisory_xact_lock`，拿不到返回 409 `cleanup_running`；锁随事务结束自动释放（包括出错时），事务超时 290 秒。整次运行共用一个截止时间：路由开始时算一次 `deadline = 开始时间 + RETENTION_RUN_DEADLINE_MS`（默认 270000，范围 10000–280000，超出范围用默认值，所以始终小于 290 秒的持锁事务超时），传给所有 6 个步骤（孤儿 logo 每批 200 条，闲置账号每批 500 个候选，其他每批 500 条）。每个步骤只在**开始新批次之前**检查截止时间（闲置账号步骤还会在每个账号之前检查）：已过截止时间就不再开始新批次，**正在执行的那一批会执行完**，所以实际结束时间可能比截止时间晚一批的耗时。截止时间之后还没开始的步骤直接跳过，返回结果里 `skipped` 列出被跳过的步骤，`deadlineReached: true` 表示结束时已过截止时间（可能有步骤没处理完），同时记一条 warn 日志；没处理完的留给下次 cron。旧变量 `RETENTION_STEP_BUDGET_MS` 已废弃，不再读取。

**锁事务和工作事务是分开的**：持锁的事务只负责拿 advisory lock 并在整次运行期间保持打开；各步骤的读写在各自的事务/连接里执行，不在持锁事务里。如果持锁事务撞到 290 秒超时被 Prisma 回滚，锁会提前释放，而这时最后一批可能还在执行，下一次触发（手动或 cron）就可能和它重叠。这是可以接受的，因为每个操作都是幂等的：
- 删除（过期方案、孤儿 logo、审计日志）都按 id 删除并在删除条件里再带一次过期/未绑定条件，删过的行第二次删 0 条；对已经不存在的文件再删一次没有影响。
- 样品邮箱计数是把 `normalizedEmail` 设成 null，重复设置结果一样。
- 询盘匿名化在事务里重新确认 `anonymizedAt` 为空；两次同时处理同一条时，写入的都是同样的清空值，只是回信 token 被换成另一个随机值（旧 token 本来就要作废）。
- 闲置账号停用在事务里重新确认仍满足闲置条件，最后一个 ADMIN 的检查用 `SELECT … FOR UPDATE`；重叠时最坏情况是同一个账号多记一条 `user.disable_inactive` 审计。顺序：过期方案 → 孤儿 logo → 样品邮箱计数 → 到期询盘匿名化 → 闲置账号停用 → 审计日志；日志和告警只含条数和错误类型/码，不含个人信息。数据库字段 `Inquiry.anonymizedAt`、`User.lastLoginAt`、`User.reactivatedAt` 需要在部署前 `prisma db push`。审计日志、样品计数、过期方案都分批处理（每批 500 条，按 id 删除/更新），每次运行最多 `RETENTION_MAX_PER_RUN`（默认 20000）条，没处理完的留给下次。每步独立执行，任一失败返回 500 并发送管理员告警（只含错误 name/code）。

**客户回信（安全规则）**：以后新增的任何客户回信（inbound reply）处理接口，**必须**用 `findInquiryForReply`（`src/lib/server/privacy.ts`）按 token 查找询盘，它会拒绝已匿名化的询盘；并且**绝不能**对 `anonymizedAt` 不为空的询盘做任何写入（新增往来邮件、改状态、存附件等）。目前还没有这个接口，新增时安全审查要核对。

**并发**：清理（包括试运行）同一时间只跑一次，正在跑时再请求返回 409 `cleanup_running`（Postgres advisory lock）。

**试运行（`RETENTION_DRY_RUN=1`）**：cron 只统计、不清理。返回 `{ dryRun: true, designs, orphanLogos, sampleCounters, auditLogs, inquiries, inquiryLogos, inactiveUsers, skippedLastAdmin }`。全程只用 count 和只读查询：不写数据库、不删文件、不写审计，日志只记条数。统计的是全部待处理条数，不受 `RETENTION_MAX_PER_RUN` 限制。真实运行会先删过期方案，有些 logo 会因此变成孤儿，所以 `orphanLogos` 可能比真实运行时少。上线前设成 `1` 触发一次，核对条数后**删掉这个变量**，下次 cron 才会真正清理。

## 客户数据导出 / 删除（仅 ADMIN）

- `POST /api/admin/privacy/export {email}`：按规范化邮箱匹配，JSON 以附件直接返回，不在服务器或 R2 保存；`Cache-Control: no-store`。
- `POST /api/admin/privacy/delete {email, confirmEmail}`：两者规范化后必须一致，否则 400 `confirm_mismatch`。匿名化姓名/邮箱/公司/电话/留言/地址/明细备注并清空 IP 国家（`ipCountry`），只保留条数、类别、日期用于统计；删除 logo 上传。
- 顺序与其他后台路由一致：requireAdmin(['ADMIN'])（其他角色 403）→ assertSameOrigin → 每管理员 5 次/窗口限流。
- 按 `Contact.normalizedEmail` 精确匹配（有索引，无条数上限），写入询盘时填写；旧数据用 `scripts/backfill-normalized-email.ts` 回填。
- 审计 `privacy.export` / `privacy.delete` 只记录邮箱的 HMAC-SHA256（密钥 `PRIVACY_HASH_SECRET`，独立于 AUTH_SECRET；生产未设置时接口 503 拒绝执行），从不记录明文。

**询盘匿名化补充（隐私审计第 7 条）**：
- **最后活动规则**：后台回信（`POST /api/admin/inquiries/:id/reply`）和改状态（`PATCH /api/admin/inquiries/:id` 的 `status` 有变化）时，`retainUntil` 顺延到 now + `INQUIRY_RETAIN_DAYS`（默认 730 天）。单纯改派负责人不算活动，不顺延。
- **已匿名化询盘不可写**：回信和 PATCH（改状态/改派）对 `anonymizedAt` 不为空的询盘返回 `409 {"error":"anonymized"}`；写入本身也带 `anonymizedAt IS NULL` 条件，检查后被匿名化同样返回 409。回信在发信前检查；顺延和写往来邮件在同一事务里。
- **匿名邮箱**：联系人邮箱改成 `deleted+<16 位随机 hex>@invalid.invalid`（`crypto.randomBytes`），不再由原邮箱哈希派生，无法比对或反查。
- **审计**：每批匿名化在同一事务里写一条 `AuditLog`，`action = retention.run`，`actorId = system`，`target`、`ip` 为空，`meta = { step: "inquiries", count, createdFrom, createdTo }`（本批询盘 createdAt 的最早/最晚时间），不含询盘 id、邮箱或其他个人信息。
- **AuditLog.ip**：保存的是后台操作人 IP，不随询盘匿名化，统一按 `AUDIT_RETAIN_DAYS`（默认 365 天）整行删除。
