# 数据保留与隐私（Data retention & privacy）

> 待与隐私政策对齐（pending Ryan）— to be aligned with privacy policy pending Ryan.

所有天数均可通过环境变量配置，非法或越界的值回退到默认值。

| 数据 | 环境变量 | 默认 | 处理方式 |
|---|---|---|---|
| 设计（短链） | `DESIGN_TTL_DAYS` / `DESIGN_GRACE_DAYS` | 180 / 90 | 过期返回 410，过期后 grace 天由 cron 删除 |
| 样品申请邮箱计数（normalizedEmail） | `SAMPLE_COUNTER_RETAIN_DAYS` | 30 | cron 置空；IP 计数器靠限流存储 TTL 自动过期 |
| 审计日志 | `AUDIT_RETAIN_DAYS` | 365（最少 30） | cron 删除 |
| 已删除询盘的 logo | `INQUIRY_RETAIN_DAYS` | 730 | cron 删除文件 |

清理入口：`/api/admin/cron/cleanup-uploads`（CRON_SECRET）。每步独立执行，任一失败返回 500 并发送管理员告警（只含错误 name/code）。

## 客户数据导出 / 删除（仅 ADMIN）

- `POST /api/admin/privacy/export {email}`：按规范化邮箱匹配，JSON 以附件直接返回，不在服务器或 R2 保存；`Cache-Control: no-store`。
- `POST /api/admin/privacy/delete {email, confirmEmail}`：两者规范化后必须一致，否则 400 `confirm_mismatch`。匿名化姓名/邮箱/公司/电话/留言/地址/明细备注，保留条数、类别、日期用于统计；删除 logo 上传。
- 顺序：同源校验 → 仅 ADMIN（其他角色 403）→ 每管理员 5 次/窗口限流。
- 审计 `privacy.export` / `privacy.delete` 只记录邮箱的 HMAC-SHA256（密钥由 AUTH_SECRET 派生），从不记录明文。
