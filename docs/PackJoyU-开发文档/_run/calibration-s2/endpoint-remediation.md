# S2 端点最终返修

状态：规格返修完成；没有新增OPEN_CHOICES或权限变更。业务尚未实施，本记录不是运行验收。仅改09/10及端点导出，未改shared、08或生成器。

## 逐项处理

| 项目 | 落实 | 结论 |
|---|---|---|
| 后台聊天read最低角色分歧 | 按D7/C-01与09共享收件箱范围保留ADMIN/SALES，own cursor仅限制写对象，EDITOR拒绝；旧低置信line完整保留 | 权限不降级，不重问刷绿 |
| 原11条非幂等结果 | 10逐路径表逐项列07/09/10/15/16/17/18/29/34/35/36的请求效果、重试和未知结果前进路径 | 不再引用不存在清单 |
| activity | 推进授权闲置期限的请求不自动重放；安全GET读当前effectiveExpiresAt，下一次真实活动才能新调用 | 后台轮询不续期，超时不复活 |
| reauth/permit/start | 单用途秘密不读回；reauth丢grant需新TOTP本人验证；permit原15min窗口不因超时续期；start若cookie已收到可重入enroll，缺cookie才另取凭据 | 不直接烧第二码，不拿旧凭据换完整session |
| recovery/enroll | 同一有效session/sv/pending返回相同URI及原期限；pendingUntil不越session.expiresAt，重复不旋转/续时；到期终止流程 | 同窗口允许一次网络重入 |
| recovery/confirm | 不自动重试，不重返一次性恢复码/不重复成功；用新验证器下一步登录，本地改密用预授权新密码；材料未保存经新鲜验证重绑再生成 | 明确成功响应丢失后的前进路径 |
| consent | 有效同版本true保留原ID/grantedAt/expiry，重复false清cookie；首次/失效签发未确认停采；串行true→false并补最终false，旧响应不恢复采集 | 不因普通重试重建UV身份 |
| operations | HTTP触发不自动重发，JobState只读核代次/租约/结果，未知结果待下一计划或明确人工恢复 | 租约不冒充HTTP幂等 |
| mail-queue GET/POST | 两方法均发信worker触发；legacy GET非安全GET，本轮cron用POST，关闭代理/客户端重试与预取；JobState/原MailMessage核状态，原邮件unknown_delivery规则保留 | HTTP与SMTP重试分层 |
| ops-report | source+measuredAt同载荷复用、异载荷409、旧时间忽略，成功时间不倒退 | 状态上报的幂等边界完整 |
| DTO/登录字段 | DevicePageDTO、ChatSummaryPageDTO为具体分页别名，形状不变；保留root新增LoginMode/rememberDevice严格映射 | 无泛型占位符误报 |
| 端点导出 | 当前首表独立解析37个方法并同步_run/endpoints-contract.json | 与最终规范一致 |

## 前端状态参考

- account/activity失败不进入通用POST重试；读取当前有效期后，只有新实际交互才再次调用。grant失效要本人验证，不把旧grant重新发送，也不仅凭此强制清除仍有效设备。
- 受限页重复进入显示同一QR/URI与服务器原到期时间，不重置倒计时。start或本人2fa/reset超时先尝试当前restricted cookie能否进入该页，不能无条件重新核销恢复材料。
- confirm显示结果未知时不显示虚构恢复码，不重发旧确认；提示使用新验证器下个时间步登录。取回原码不可用，需要新鲜验证后的新重绑流程。
- 同意按钮写串行，最新撤回立即停采/清待发，再确保最后false落cookie；有效true重试不换ID或续期，确认前不发事件。
- 聊天read仍以ADMIN/SALES服务端鉴权，EDITOR即使只改本人游标也不可调用。Cron/worker不走浏览器API hook、预取或页面导航。

## 核对与证据

原37/37真实调用保留；只因新增重复请求分支，对17和29各补一次真实英文state校准，独立.remediation.*证据，不覆盖旧结果。

- `jev-1.13.0`：`endpoint: permission=anonymous(high 0.99) mutating=yes(0.88) idempotent=yes(0.79) declared_ok=yes(0.92)`
- `jev-1.13.0`：`endpoint: permission=anonymous(medium 0.69) mutating=yes(0.93) idempotent=yes(0.68) declared_ok=yes(0.90)`

原05/10/35的declared_ok=unsure及27的角色分歧均保留，没有把校准写成全绿。详见endpoint-calibration/report.md追加段。窄检查覆盖首表/JSON一致、11条路径、登录映射保留、JSON解析、UTF-8与diff空白；不运行产品测试。
