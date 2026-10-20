# 接口约定

## 兼容与新增范围

- NextAuth Credentials、`/api/auth/*` 的 CSRF、redirect、cookie、CredentialsSignin 与 session 形状仍归 Auth.js。扩展 `sid`/有效期元数据，不向客户端返回设备撤销凭据；失败保持 Auth.js 通用登录失败，不能通过不同码透露账号是否存在、是否启用无密码。
- 既有 53 个 handler、询盘/邮件 DTO、`/api/rum` 的空体 204、绑定 `{otpauthUri}` / `{recoveryCodes}` 不整体换信封。只改本轮明确触达的账号验证/绑定安全接缝并保持旧字段兼容；旧日常恢复码字段停止作为登录入口，UI 引导到独立恢复，其旧请求得到通用登录失败。
- 新增账号设置、恢复、人工聊天、分析和看板接口：成功直接返回本节有名 DTO；错误用 `{error,requestId,fieldErrors?}`。认证/授权拒绝仍可使用已有 `{error}`，新客户端要接受无 requestId 的旧守卫错误。
- 不引入线上语义判断、AI 客服、新数据库、新队列服务、通用任务平台。Sanity 产品内容仍在原数据源，PostgreSQL 中只保存必要业务/分析引用。


`Auth.js`是兼容族，绝不承诺自定义成功信封；具体新增DTO后列。所有新JSON接口`Cache-Control: private, no-store`，公开分析也不缓存；时区设置GET仅ADMIN；cron不接受浏览器session替代Bearer。

| 方法 | 路径 | 入参 | 返回 | 权限 |
|---|---|---|---|---|
| GET/POST | /api/auth/[...nextauth] | Auth.js既有协议；Credentials新增mode与rememberDevice，可保留旧password+totp请求；非空recoveryCode日常明确拒绝 | Auth.js原redirect/CSRF/session协议；session可增sid非凭据摘要与effectiveExpiresAt | Auth.js，失败不透露账号方式 |
| POST | /api/auth-admin/enroll | 现有email/password/token | 既有{otpauthUri}，只修最终当前token/sv CAS | 现有一次性绑定凭据 |
| POST | /api/auth-admin/enroll/confirm | 现有email/password/token/totp | 既有{recoveryCodes} | 现有绑定窗口及单次新码 |
| POST | /api/admin/account/password | newPassword、PASSWORD actionGrant；兼容旧currentPassword+totp时也在同一最终事务执行相同新鲜验证；非空recoveryCode拒绝 | 既有{ok:true,reauthRequired:true} | 当前本人、同源、当前密码+新TOTP新鲜验证，撤销全部会话 |
| POST | /api/admin/account/2fa/reset | TOTP_RESET actionGrant；兼容旧currentPassword+totp也执行相同规则；恢复码不得走此捷径 | 既有ok/reenrollRequired/enrollLink字段；设受限恢复cookie，链接转受限重绑页 | 本人新鲜验证；最终新绑定前原有效因素保留，临时重绑记录受限 |
| POST | /api/admin/users/[id]/reset-2fa | RECOVERY_AUTHORIZE actionGrant(target=id)、reason | 受限RecoveryPermitDTO；旧UI迁移消费一次性permit，无无验证直重置旁路 | ADMIN、不能自己、同源；旧无body直接重置请求拒绝 |
| GET | /api/admin/account | 无 | AccountDTO：id/name/email/role/passwordlessEnabled/totpEnabled、当前设备摘要 | 当前有效后台账号，ADMIN/SALES/EDITOR |
| POST | /api/admin/account/session/activity | 空对象；真实前台活动节流调用 | SessionActivityDTO：effectiveExpiresAt、absoluteExpiresAt；真实Set-Cookie刷新 | 当前有效设备、同源、任一后台角色 |
| POST | /api/admin/account/reauth | purpose、targetId?、totp；还要password | ActionGrantDTO：token、purpose、expiresAt | 当前有效设备、同源；target规则由purpose决定 |
| PATCH | /api/admin/account/login-mode | passwordlessEnabled、actionGrant | AccountModeDTO：passwordlessEnabled、changedAt；成功撤销旧会话后重新登录 | 本人，当前已绑定TOTP，LOGIN_MODE单用途grant |
| GET | /api/admin/account/devices | cursor?、limit≤50 | CursorPage<DeviceDTO>，仅当前账号设备，标current/expiry/revoked | 当前有效后台账号 |
| POST | /api/admin/account/devices/[id]/revoke | actionGrant(DEVICE_REVOKE,target=id) | DeviceRevokeDTO：id、revokedAt；重复相同结果 | 当前账号自己的设备，当前sid可撤销自身 |
| POST | /api/admin/account/logout-all | actionGrant(LOGOUT_ALL) | SignedOutDTO；清Auth.js cookie | 当前有效后台账号；sv+设备撤销原子 |
| POST | /api/admin/account/recovery-authorizations | targetUserId、reason、actionGrant | RecoveryPermitDTO：token、expiresAt，只返回一次 | ADMIN、RECOVERY_AUTHORIZE且target绑定，不能自授权 |
| POST | /api/auth-admin/recovery/start | email、credentialKind RECOVERY_CODE/PERMIT、credential | RecoveryStateDTO：restricted、expiresAt，并设受限HttpOnly cookie | 独立恢复凭据；非后台session |
| POST | /api/auth-admin/recovery/enroll | 空对象 | RecoveryEnrollDTO：otpauthUri、expiresAt | 仅有效受限恢复cookie |
| POST | /api/auth-admin/recovery/confirm | totp | RecoveryCompleteDTO：completed、recoveryCodes，清受限cookie；不直接发ADMIN权限 | 仅有效受限session与新TOTP |
| POST | /api/chat/session | locale en/ru；仅主动联系 | ChatSessionDTO：available、expiresAt；设必要cookie | 精确同源+限流；不依赖分析同意 |
| POST | /api/chat/conversations | clientConversationId、clientMessageId、locale、bodyText、email?、productSlug?、sourcePath? | ConversationReceivedDTO：conversationId、message、receivedAt、duplicate | 有效访客cookie且同源 |
| GET | /api/chat/conversations/[id] | afterSeq=0、limit=50(max100) | ChatSyncDTO：conversation、messages、lastSeq、nextAfterSeq、hasMore、read | 仅自己的有效访客cookie |
| POST | /api/chat/conversations/[id]/messages | clientMessageId、bodyText | MessageReceivedDTO：message、receivedAt、duplicate | 仅自己、OPEN、同源 |
| POST | /api/chat/conversations/[id]/read | lastReadSeq | ReadDTO：lastReadSeq | 仅自己的访客cookie、同源，单调推进 |
| GET | /api/admin/chat/conversations | status?、cursor?、limit=25(max100)、unreadOnly? | CursorPage<ChatSummaryDTO>与本人未读总数 | ADMIN/SALES共享聊天范围；EDITOR拒绝 |
| GET | /api/admin/chat/conversations/[id] | afterSeq=0、limit=50(max100) | AdminChatSyncDTO（正文按授权，不含访客cookie/token） | ADMIN/SALES |
| POST | /api/admin/chat/conversations/[id]/messages | clientMessageId、bodyText | MessageReceivedDTO；author由session确定 | ADMIN/SALES、OPEN、同源 |
| POST | /api/admin/chat/conversations/[id]/read | lastReadSeq | ReadDTO | ADMIN/SALES且仅改自己的游标、同源 |
| PATCH | /api/admin/chat/conversations/[id] | status=CLOSED、expectedVersion | ChatStatusDTO：status、version、updatedAt | ADMIN/SALES、同源，CAS |
| POST | /api/analytics/consent | analytics Boolean、consentVersion | ConsentDTO：analytics、expiresAt；同意签匿名cookie/撤回清cookie | 同源，无需登录，禁止跟踪拒绝者 |
| POST | /api/analytics/events | events[1..20]：eventId/kind/occurredAt/locale及种类所需navigationId/viewId/productSlug/path | AnalyticsReceiptDTO：acceptedIds、duplicateIds、receivedAt | 有效分析同意cookie、同源；没有同意返回403不落事件 |
| GET | /api/admin/settings/analytics | 无 | AnalyticsSettingsDTO：version/timezone/timezoneRevision/recomputableFrom | ADMIN |
| PATCH | /api/admin/settings/analytics | timezone、expectedVersion | AnalyticsSettingsDTO与rebuildScheduled | ADMIN、同源，CAS并审计 |
| GET | /api/admin/stats | from/to本地日、productSlug?、timezoneRevision?、sources? | StatsDTO：授权来源列表/指标/coverage/真实数据时间，分源状态 | ADMIN全部；SALES业务范围；EDITOR公开流量和3D |
| POST | /api/admin/cron/operations | jobKey固定白名单；dryRun?仅保留任务 | JobResultDTO：jobKey/status/counts/finishedAt | Bearer CRON_SECRET、常量时间校验，无任意job/代码 |
| GET/POST | /api/admin/cron/mail-queue | 既有协议 | 既有stale/sent/failed/deferred/dropped计数 | 先既有邮件开关，再Bearer CRON_SECRET；本轮补真实调度 |
| POST | /api/internal/ops-report | source STORAGE/BACKUP、measuredAt、status、严格白名单values/safeErrorCode | OpsReportReceiptDTO：accepted、measuredAt | Bearer CRON_SECRET；受控服务器报告脚本，不接session/任意路径 |

## 响应、字段与例子

新增成功体不额外套ok/data。除Auth.js协议外，新错误保持error字符串可兼容旧守卫；requestId只做追踪，不是秘密。以下UUID/ID是示例非真实记录。

```json
{"message":{"id":"cm_example_message","seq":3,"sender":"VISITOR","bodyText":"Can you make this box in blue?","createdAt":"2026-10-19T16:20:00.000Z"},"receivedAt":"2026-10-19T16:20:00.000Z","duplicate":false}
```

```json
{"error":"idempotency_conflict","requestId":"5fcf5ba2-7d35-4d50-8798-e6f65b1268ef","fieldErrors":{"clientMessageId":"This identifier was used for different content."}}
```

| 字段/DTO | 类型、必填、域与边界 | 约定 |
|---|---|---|
| clientMessageId / clientConversationId / eventId / navigationId / viewId | UUID，按相应请求必填，不接受递增短ID | 客户端每个真实动作产生一次，重试复用；服务端身份不从这些ID推断 |
| bodyText | string，trim后1..4000 Unicode code points；不得NUL/不可见控制，允许换行 | 纯文本，禁止HTML；服务端和UI都不回显原始异常 |
| email（聊天） | optional string，trim，≤254，单个合法邮箱，不接受显示名/CRLF | 不填不阻断聊天；不进入分析和通知正文 |
| productSlug | optional/事件按kind必填；小写slug≤120，必须存在已发布产品上下文 | 不允许任意外部URL或从未发布模型推产品成功 |
| sourcePath / path | optional/按kind；≤200，单个/开头站内path，去query/hash，不接绝对URL、反斜杠、双斜杠/点段 | 语言只en/ru；不得从query复制email/token |
| afterSeq / lastReadSeq / lastSeq | 非负整数≤2147483647；after默认0，read必填 | messages按seq升序；读游标不得超过服务端lastSeq |
| expectedVersion | 非负Int必填 | 与当前行不同409version_conflict，不自动覆盖设置 |
| actionGrant / recovery credential | server生成256bit base64url，tokenHash存DB，max128字符 | 不放URL、cookie之外持久JS存储、日志或埋点；一次性响应失败不盲重试 |
| totp | string，恰好6位ASCII数字 | 匹配实际step并CAS，不能数字转换吞前导0 |
| rememberDevice / passwordlessEnabled / analytics | Boolean，显式值 | 不接受字符串truthy；省略rememberDevice视false；日常mode未指定沿password |
| occurredAt / receivedAt / expiresAt | RFC3339 UTC ISO字符串，服务端用Date验证 | received/expires由服务端生成；occurredAt准入-48h/+5min |
| from / to | YYYY-MM-DD站点自然日，闭区间用户参数，服务端转换左闭右开UTC边界 | 默认今日，最大连续400日且不能越13mo保留范围；非法或反向400 |
| StatsSourceDTO | source、state、value:number/null、timezone、timezoneRevision、dataThrough、queriedAt、lastSucceededAt、coverage | 不含browserHash、联系人、聊天正文、token、服务器路径；零值必须是成功查询结果 |
| CursorPage<T> | items、nextCursor:string/null、hasMore:Boolean | 默认25/max100；cursor为受验证的最后sort键，不是SQL片段；设备/聊天列表按createdAt/id或updatedAt/id稳定排序，快照刷新不当增量日志 |

## 幂等、重试、限流与版本

- 安全GET均幂等；read采用MAX、revoke结果幂等但授权消费不可自动重试、关闭同目标版本重复可返回当前状态。聊天和新会话携客户端UUID+payloadHash，数据库唯一为最终去重；Analytics事件双唯一与hash防重。这里不使用无限期通用Idempotency表。
- reauth、设备撤销/全部退出授权消费、恢复permit签发、recovery/start、enroll/confirm、login-mode、logout-all、时区变更是有限一次性或CAS写。客户端禁止自动重试；超时先重新读取状态，凭据已消费不能造第二份；recovery/start响应丢失需新恢复凭据/授权，不回传先前秘密。每行都在“非幂等写清单”，不能假定POST会自动安全重试。
- 消息网络/408/429/5xx允许复用原key退避重试（1s/2s/4s，最多3次，429遵Retry-After）；幂等冲突、401/403/404/409关闭或匿名化不重试。访客401提示会话失效并允许另开，后台401去安全站内登录，不能把新callback指到外站。502通知失败不影响已received消息。
- 初值：公开session/新会话每匿名cookie10次/10min与IP-HMAC20次/10min；聊天写每会话20条/min、每后台用户30条/min；同步每cookie/后台用户60次/min；分析每cookie120事件/min、每IP-HMAC300事件/min；恢复/reauth沿既有账号+IP限流并加每账号5次/10min、每IP20次/10min，5次错码作废待确认新因素和受限凭据，保留原有效绑定；看板每后台用户30次/min；cron按租约拒绝重叠。IP仅当场派生限流键不入分析库，遵现有可信边缘IP解析。
- 新JSON体上限：聊天16KiB、账号/恢复8KiB、分析批次32KiB；先限体再JSON解析。普通API客户端15s超时，服务端普通数据库交互事务≤5s，聚合单批快照/替换事务≤30s且总作业仍≤55s；SMTP由作业独立20s截止，外部验证沿既有10s；cron总55s。429带Retry-After，超时/数据库不可用503，不把失败记录伪作成功。
- URL沿现有`/api`体系，新协议称`operations-v1`并以DTO字段向后追加；不改全站版本前缀。破坏性变更另开兼容窗口/新路径并双读验证，移除旧协议另任务；Auth.js版本始终由锁文件约束，不把自定义API版本套到它。

## 非REST通道与短轮询

本轮无新增WebSocket/SSE。消息同步使用`afterSeq`短轮询：可见且窗口打开3s，收到hasMore立即补页；隐藏/关闭暂停，恢复前台立即补齐；网络失败1/2/4/8/16/30s退避，成功回3s；同请求只允许一个在途，取消旧请求不推进游标。后台收件箱刷新快照，聊天正文按会话seq补齐。所有回调卸载时取消请求/计时器。

不新增SSE、WebSocket或长连接路由。消息同步的seq协议与传输分开，后续变更传输须独立契约与部署验证。

## 新增错误码表与兼容错误

| code | HTTP | 含义/客户端动作 |
|---|---|---|
| invalid | 400 | body/query不符合strict schema，fieldErrors仅受控字段名 |
| too_large | 413 | 体积上限，不重试原体 |
| unauthorized | 401 | 当前Auth.js/设备失效，重新登录；兼容旧守卫 |
| account_disabled / forbidden / forbidden_origin | 403 | 已禁用/角色不足/同源失败；沿现有语义 |
| not_found | 404 | 不存在或不属于访客cookie可见范围，不能枚举别人的聊天 |
| rate_limited | 429 | 按Retry-After等待；兼容旧守卫 |
| version_conflict | 409 | 设置/状态CAS不一致，读取最新后再显式提交 |
| idempotency_conflict | 409 | 同一动作标识被用于不同载荷，不换新key强行重发 |
| conversation_closed | 409 | 已关闭，仅可读/另开咨询 |
| conversation_anonymized | 409 | 保留期已匿名化，不可恢复旧正文或继续回复 |
| analytics_consent_required | 403 | 无有效同意cookie，不存事件，前端停采 |
| event_time_out_of_range | 400 | 发生时间越过-48h/+5min窗口，不补造时间重发 |
| action_grant_invalid | 401 | 单用途新鲜凭据失效/已核销/不匹配，重新本人验证 |
| bad_credentials | 401 | 独立恢复通用失败，不透露账号/码/方式差异 |
| recovery_expired | 401 | 有效受限会话已到期，不能升级后台权限 |
| job_busy | 409 | 同一固定作业有有效租约，本次不重入 |
| source_unavailable | 503 | 请求整体缺必要来源；单来源异常在StatsDTO独立state说明 |
| service_unavailable | 503 | 数据库/受控依赖不可用，只有明确幂等写可重试 |
| internal_error | 500 | 未知异常，安全requestId，正文不带内部message/stack |

Auth.js CredentialsSignin、现有enroll的bad_credentials、现有邮件mail_failed/unknown_delivery及关闭404、/api/rum空体400/403/429保持原契约，不冒充上表覆盖全库。没有线上语义判断契约或judgments注册。

