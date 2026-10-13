# 数据保留与隐私（Data retention & privacy）

> 待与隐私政策对齐（pending Ryan）— to be aligned with privacy policy pending Ryan.

所有天数均可通过环境变量配置，非法或越界的值回退到默认值。

| 数据 | 环境变量 | 默认 | 处理方式 |
|---|---|---|---|
| 设计（短链） | `DESIGN_TTL_DAYS` / `DESIGN_GRACE_DAYS` | 180 / 90 | 过期返回 410，过期后 grace 天由 cron 删除 |
| 样品申请邮箱计数（normalizedEmail） | `SAMPLE_COUNTER_RETAIN_DAYS` | 30 | cron 置空；IP 计数器靠限流存储 TTL 自动过期 |
| 审计日志 | `AUDIT_RETAIN_DAYS` | 365（最少 30） | cron 删除 |
| 询盘到期匿名化 | `INQUIRY_RETAIN_DAYS` | 730 | 新询盘写入 `retainUntil`；到期后 cron 用与手动删除相同的逻辑匿名化（留言、备注、往来邮件、样品地址清空，绑定的 logo 记录和文件删除），写 `anonymizedAt`，不重复处理。联系人在其名下没有其他未匿名化询盘时才匿名化。每批 500 条，受 `RETENTION_MAX_PER_RUN` 限制 |
| 后台账号闲置停用 | `ADMIN_INACTIVE_DAYS` | 90（7–3650） | 从 max(最近登录 `lastLoginAt`, 重新启用 `reactivatedAt`, 创建时间) 起算；从未登录的按创建时间。cron **停用不删除**，与手动停用同一路径（会话失效、取消询盘分配），审计 `user.disable_inactive`（actor = `system`）。最后一个有效 ADMIN 不停用（`assertNotLastActiveAdmin`，与停用同一事务，`SELECT … FOR UPDATE`）。ADMIN 可用 `PATCH /api/admin/users/:id {"disabled": false}` 重新启用，闲置天数从启用时重新计算 |
| 未绑定 / 已失效的 logo | — | — | cron 分批删除（删除前校验 key 必须是 `logos/YYYY-MM/<id>.png`） |

清理入口：`/api/admin/cron/cleanup-uploads`（CRON_SECRET，每天 03:00 UTC）。顺序：过期方案 → 孤儿 logo → 样品邮箱计数 → 到期询盘匿名化 → 闲置账号停用 → 审计日志；日志和告警只含条数和错误类型/码，不含个人信息。数据库字段 `Inquiry.anonymizedAt`、`User.lastLoginAt`、`User.reactivatedAt` 需要在部署前 `prisma db push`。审计日志、样品计数、过期方案都分批处理（每批 500 条，按 id 删除/更新），每次运行最多 `RETENTION_MAX_PER_RUN`（默认 20000）条，没处理完的留给下次。每步独立执行，任一失败返回 500 并发送管理员告警（只含错误 name/code）。

## 客户数据导出 / 删除（仅 ADMIN）

- `POST /api/admin/privacy/export {email}`：按规范化邮箱匹配，JSON 以附件直接返回，不在服务器或 R2 保存；`Cache-Control: no-store`。
- `POST /api/admin/privacy/delete {email, confirmEmail}`：两者规范化后必须一致，否则 400 `confirm_mismatch`。匿名化姓名/邮箱/公司/电话/留言/地址/明细备注，保留条数、类别、日期用于统计；删除 logo 上传。
- 顺序与其他后台路由一致：requireAdmin(['ADMIN'])（其他角色 403）→ assertSameOrigin → 每管理员 5 次/窗口限流。
- 按 `Contact.normalizedEmail` 精确匹配（有索引，无条数上限），写入询盘时填写；旧数据用 `scripts/backfill-normalized-email.ts` 回填。
- 审计 `privacy.export` / `privacy.delete` 只记录邮箱的 HMAC-SHA256（密钥 `PRIVACY_HASH_SECRET`，独立于 AUTH_SECRET；生产未设置时接口 503 拒绝执行），从不记录明文。
