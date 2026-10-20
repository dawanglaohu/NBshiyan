# S2 endpoint 真实 TypeSafe 校准报告

范围：仅校准正式第10节及 `_run/endpoints-contract.json` 的37个方法记录；未修改规范、契约、产品代码或主 `_run/judgments.jsonl`。

结果：37/37 `status=ok`；37次均 `model=jev-1.13.0`；37份英文state均无CJK且无 `language_warning`。每次由工作树既有 `typesafe_ask.py run endpoint` 发真实请求，最多3并发；每行独立 `.jsonl`、`.state.json`、完整 `.stdout.json` 和 `.stderr.txt`。日志state哈希已与对应输入逐一复核。

校准用途：模型给第二意见，不直接修改权限或替代架构师决定。未对低置信或不一致结果重问刷绿。`authenticated_self`只代表当前有效后台账号对本人安全设置的权限，不能用于聊天业务；带初次绑定/独立恢复凭据但无后台角色的调用者始终为`anonymous`，其凭据限制完整写入state。

## 阻断与需返修

1. 权限分歧已经交回架构方确认：第27行 `POST /api/admin/chat/conversations/[id]/read`（10快照表第40行）。模型选 `authenticated_self`（confidence 0.42，probability 0.49；SALES probability 0.47），与原文 ADMIN/SALES 不同。即使 `declared_ok=yes(0.78)` 也不能据此降权为所有本人后台账号；own cursor 只限制写入对象，并不取消共享聊天的角色范围。主会话依既定D7/C01及09的共享聊天范围确认保留ADMIN/SALES；authenticated_self包含EDITOR，不能调用。保留原日志与低置信分歧，不反复重跑刷绿；此项按原范围明确执行后不构成文档权限返修。
2. 幂等与重试小节不足：11条 mutating=yes+idempotent=no 逐行对照如下。activity、consent、operations、mail-queue GET/POST 尚无明确HTTP重试策略；recovery/enroll、recovery/confirm仅被泛称 enroll/confirm，需明列路径和响应丢失规则。
3. 正式10:83称“每行都在非幂等写清单”，但该快照不存在对应清单；需补真实逐行清单或删除不实引用并写足路由规则。不能把POST、GET、租约或数据库CAS一概当作可自动重试。

没有 `declared_ok=no`。第5/10/35行 `declared_ok=unsure` 是保留疑点，详见后文；不能写成全绿。

## 37行真实结果

表中 `line` 为helper原样输出；日志名均相对此报告目录。模型每行单列，未用历史marker替代。

| 行 | 方法与路径 | 第10节源行 | 真实model | 原样line | 证据 |
|---|---|---:|---|---|---|
| 01 | `GET /api/auth/[...nextauth]` | 15 | `jev-1.13.0` | `endpoint: permission=anonymous(low 0.46) mutating=unsure(0.47) idempotent=unsure(0.50) declared_ok=yes(0.85)` | [01.state.json](01.state.json) / [01.jsonl](01.jsonl) / [01.stdout.json](01.stdout.json) |
| 02 | `POST /api/auth/[...nextauth]` | 15 | `jev-1.13.0` | `endpoint: permission=anonymous(medium 0.67) mutating=yes(0.92) idempotent=unsure(0.43) declared_ok=yes(0.87)` | [02.state.json](02.state.json) / [02.jsonl](02.jsonl) / [02.stdout.json](02.stdout.json) |
| 03 | `POST /api/auth-admin/enroll` | 16 | `jev-1.13.0` | `endpoint: permission=anonymous(high 0.93) mutating=yes(0.91) idempotent=unsure(0.37) declared_ok=yes(0.74)` | [03.state.json](03.state.json) / [03.jsonl](03.jsonl) / [03.stdout.json](03.stdout.json) |
| 04 | `POST /api/auth-admin/enroll/confirm` | 17 | `jev-1.13.0` | `endpoint: permission=anonymous(high 0.86) mutating=yes(0.95) idempotent=unsure(0.39) declared_ok=yes(0.72)` | [04.state.json](04.state.json) / [04.jsonl](04.jsonl) / [04.stdout.json](04.stdout.json) |
| 05 | `POST /api/admin/account/password` | 18 | `jev-1.13.0` | `endpoint: permission=authenticated_self(high 0.99) mutating=yes(0.95) idempotent=unsure(0.46) declared_ok=unsure(0.62)` | [05.state.json](05.state.json) / [05.jsonl](05.jsonl) / [05.stdout.json](05.stdout.json) |
| 06 | `POST /api/admin/account/2fa/reset` | 19 | `jev-1.13.0` | `endpoint: permission=authenticated_self(medium 0.73) mutating=yes(0.92) idempotent=unsure(0.37) declared_ok=yes(0.81)` | [06.state.json](06.state.json) / [06.jsonl](06.jsonl) / [06.stdout.json](06.stdout.json) |
| 07 | `POST /api/admin/users/[id]/reset-2fa` | 20 | `jev-1.13.0` | `endpoint: permission=ADMIN(high 1.00) mutating=yes(0.75) idempotent=no(0.26) declared_ok=yes(0.88)` | [07.state.json](07.state.json) / [07.jsonl](07.jsonl) / [07.stdout.json](07.stdout.json) |
| 08 | `GET /api/admin/account` | 21 | `jev-1.13.0` | `endpoint: permission=authenticated_self(high 0.86) mutating=no(0.10) idempotent=yes(0.90) declared_ok=yes(0.79)` | [08.state.json](08.state.json) / [08.jsonl](08.jsonl) / [08.stdout.json](08.stdout.json) |
| 09 | `POST /api/admin/account/session/activity` | 22 | `jev-1.13.0` | `endpoint: permission=authenticated_self(low 0.47) mutating=yes(0.90) idempotent=no(0.31) declared_ok=yes(0.67)` | [09.state.json](09.state.json) / [09.jsonl](09.jsonl) / [09.stdout.json](09.stdout.json) |
| 10 | `POST /api/admin/account/reauth` | 23 | `jev-1.13.0` | `endpoint: permission=authenticated_self(medium 0.66) mutating=yes(0.87) idempotent=no(0.19) declared_ok=unsure(0.59)` | [10.state.json](10.state.json) / [10.jsonl](10.jsonl) / [10.stdout.json](10.stdout.json) |
| 11 | `PATCH /api/admin/account/login-mode` | 24 | `jev-1.13.0` | `endpoint: permission=authenticated_self(high 0.98) mutating=yes(0.97) idempotent=unsure(0.52) declared_ok=yes(0.82)` | [11.state.json](11.state.json) / [11.jsonl](11.jsonl) / [11.stdout.json](11.stdout.json) |
| 12 | `GET /api/admin/account/devices` | 25 | `jev-1.13.0` | `endpoint: permission=authenticated_self(high 1.00) mutating=no(0.10) idempotent=yes(0.87) declared_ok=yes(0.86)` | [12.state.json](12.state.json) / [12.jsonl](12.jsonl) / [12.stdout.json](12.stdout.json) |
| 13 | `POST /api/admin/account/devices/[id]/revoke` | 26 | `jev-1.13.0` | `endpoint: permission=authenticated_self(high 1.00) mutating=yes(0.93) idempotent=yes(0.87) declared_ok=yes(0.88)` | [13.state.json](13.state.json) / [13.jsonl](13.jsonl) / [13.stdout.json](13.stdout.json) |
| 14 | `POST /api/admin/account/logout-all` | 27 | `jev-1.13.0` | `endpoint: permission=authenticated_self(high 0.87) mutating=yes(0.98) idempotent=unsure(0.40) declared_ok=yes(0.74)` | [14.state.json](14.state.json) / [14.jsonl](14.jsonl) / [14.stdout.json](14.stdout.json) |
| 15 | `POST /api/admin/account/recovery-authorizations` | 28 | `jev-1.13.0` | `endpoint: permission=ADMIN(high 0.99) mutating=yes(0.92) idempotent=no(0.18) declared_ok=yes(0.82)` | [15.state.json](15.state.json) / [15.jsonl](15.jsonl) / [15.stdout.json](15.stdout.json) |
| 16 | `POST /api/auth-admin/recovery/start` | 29 | `jev-1.13.0` | `endpoint: permission=anonymous(high 0.99) mutating=yes(0.98) idempotent=no(0.23) declared_ok=yes(0.92)` | [16.state.json](16.state.json) / [16.jsonl](16.jsonl) / [16.stdout.json](16.stdout.json) |
| 17 | `POST /api/auth-admin/recovery/enroll` | 30 | `jev-1.13.0` | `endpoint: permission=anonymous(high 0.99) mutating=yes(0.92) idempotent=no(0.18) declared_ok=yes(0.90)` | [17.state.json](17.state.json) / [17.jsonl](17.jsonl) / [17.stdout.json](17.stdout.json) |
| 18 | `POST /api/auth-admin/recovery/confirm` | 31 | `jev-1.13.0` | `endpoint: permission=anonymous(high 1.00) mutating=yes(0.97) idempotent=no(0.19) declared_ok=yes(0.76)` | [18.state.json](18.state.json) / [18.jsonl](18.jsonl) / [18.stdout.json](18.stdout.json) |
| 19 | `POST /api/chat/session` | 32 | `jev-1.13.0` | `endpoint: permission=anonymous(low 0.37) mutating=yes(0.87) idempotent=yes(0.75) declared_ok=yes(0.79)` | [19.state.json](19.state.json) / [19.jsonl](19.jsonl) / [19.stdout.json](19.stdout.json) |
| 20 | `POST /api/chat/conversations` | 33 | `jev-1.13.0` | `endpoint: permission=visitor_session(high 0.89) mutating=yes(0.95) idempotent=yes(0.72) declared_ok=yes(0.81)` | [20.state.json](20.state.json) / [20.jsonl](20.jsonl) / [20.stdout.json](20.stdout.json) |
| 21 | `GET /api/chat/conversations/[id]` | 34 | `jev-1.13.0` | `endpoint: permission=visitor_session(high 0.99) mutating=no(0.15) idempotent=yes(0.80) declared_ok=yes(0.82)` | [21.state.json](21.state.json) / [21.jsonl](21.jsonl) / [21.stdout.json](21.stdout.json) |
| 22 | `POST /api/chat/conversations/[id]/messages` | 35 | `jev-1.13.0` | `endpoint: permission=visitor_session(high 0.92) mutating=yes(0.95) idempotent=yes(0.83) declared_ok=yes(0.73)` | [22.state.json](22.state.json) / [22.jsonl](22.jsonl) / [22.stdout.json](22.stdout.json) |
| 23 | `POST /api/chat/conversations/[id]/read` | 36 | `jev-1.13.0` | `endpoint: permission=visitor_session(high 0.99) mutating=yes(0.87) idempotent=yes(0.86) declared_ok=yes(0.78)` | [23.state.json](23.state.json) / [23.jsonl](23.jsonl) / [23.stdout.json](23.stdout.json) |
| 24 | `GET /api/admin/chat/conversations` | 37 | `jev-1.13.0` | `endpoint: permission=SALES(high 0.99) mutating=no(0.25) idempotent=yes(0.81) declared_ok=yes(0.88)` | [24.state.json](24.state.json) / [24.jsonl](24.jsonl) / [24.stdout.json](24.stdout.json) |
| 25 | `GET /api/admin/chat/conversations/[id]` | 38 | `jev-1.13.0` | `endpoint: permission=SALES(high 0.99) mutating=no(0.10) idempotent=yes(0.84) declared_ok=yes(0.89)` | [25.state.json](25.state.json) / [25.jsonl](25.jsonl) / [25.stdout.json](25.stdout.json) |
| 26 | `POST /api/admin/chat/conversations/[id]/messages` | 39 | `jev-1.13.0` | `endpoint: permission=SALES(high 0.95) mutating=yes(0.96) idempotent=yes(0.86) declared_ok=yes(0.76)` | [26.state.json](26.state.json) / [26.jsonl](26.jsonl) / [26.stdout.json](26.stdout.json) |
| 27 | `POST /api/admin/chat/conversations/[id]/read` | 40 | `jev-1.13.0` | `endpoint: permission=authenticated_self(low 0.42) mutating=yes(0.90) idempotent=yes(0.87) declared_ok=yes(0.78)` | [27.state.json](27.state.json) / [27.jsonl](27.jsonl) / [27.stdout.json](27.stdout.json) |
| 28 | `PATCH /api/admin/chat/conversations/[id]` | 38 | `jev-1.13.0` | `endpoint: permission=SALES(high 0.95) mutating=yes(0.93) idempotent=yes(0.91) declared_ok=yes(0.83)` | [28.state.json](28.state.json) / [28.jsonl](28.jsonl) / [28.stdout.json](28.stdout.json) |
| 29 | `POST /api/analytics/consent` | 42 | `jev-1.13.0` | `endpoint: permission=anonymous(medium 0.65) mutating=yes(0.91) idempotent=no(0.34) declared_ok=yes(0.90)` | [29.state.json](29.state.json) / [29.jsonl](29.jsonl) / [29.stdout.json](29.stdout.json) |
| 30 | `POST /api/analytics/events` | 43 | `jev-1.13.0` | `endpoint: permission=anonymous(high 0.94) mutating=yes(0.87) idempotent=unsure(0.64) declared_ok=yes(0.70)` | [30.state.json](30.state.json) / [30.jsonl](30.jsonl) / [30.stdout.json](30.stdout.json) |
| 31 | `GET /api/admin/settings/analytics` | 44 | `jev-1.13.0` | `endpoint: permission=ADMIN(high 1.00) mutating=no(0.05) idempotent=yes(0.93) declared_ok=yes(0.93)` | [31.state.json](31.state.json) / [31.jsonl](31.jsonl) / [31.stdout.json](31.stdout.json) |
| 32 | `PATCH /api/admin/settings/analytics` | 44 | `jev-1.13.0` | `endpoint: permission=ADMIN(high 0.99) mutating=yes(0.96) idempotent=unsure(0.46) declared_ok=yes(0.90)` | [32.state.json](32.state.json) / [32.jsonl](32.jsonl) / [32.stdout.json](32.stdout.json) |
| 33 | `GET /api/admin/stats` | 46 | `jev-1.13.0` | `endpoint: permission=EDITOR(high 0.91) mutating=no(0.05) idempotent=yes(0.90) declared_ok=yes(0.86)` | [33.state.json](33.state.json) / [33.jsonl](33.jsonl) / [33.stdout.json](33.stdout.json) |
| 34 | `POST /api/admin/cron/operations` | 47 | `jev-1.13.0` | `endpoint: permission=cron(high 1.00) mutating=yes(0.86) idempotent=no(0.26) declared_ok=yes(0.87)` | [34.state.json](34.state.json) / [34.jsonl](34.jsonl) / [34.stdout.json](34.stdout.json) |
| 35 | `GET /api/admin/cron/mail-queue` | 48 | `jev-1.13.0` | `endpoint: permission=cron(high 0.98) mutating=yes(0.85) idempotent=no(0.25) declared_ok=unsure(0.59)` | [35.state.json](35.state.json) / [35.jsonl](35.jsonl) / [35.stdout.json](35.stdout.json) |
| 36 | `POST /api/admin/cron/mail-queue` | 48 | `jev-1.13.0` | `endpoint: permission=cron(high 1.00) mutating=yes(0.76) idempotent=no(0.32) declared_ok=yes(0.74)` | [36.state.json](36.state.json) / [36.jsonl](36.jsonl) / [36.stdout.json](36.stdout.json) |
| 37 | `POST /api/internal/ops-report` | 49 | `jev-1.13.0` | `endpoint: permission=cron(high 1.00) mutating=yes(0.88) idempotent=yes(0.65) declared_ok=yes(0.93)` | [37.state.json](37.state.json) / [37.jsonl](37.jsonl) / [37.stdout.json](37.stdout.json) |

## 非幂等11行对照

本表只列真实校准同时返回 `mutating=yes` 与 `idempotent=no` 的11行；其他未定/语义上的一次性写仍在后文保留。

| 行 | 方法与路径 | 当前第10节处理情况 | 核对与返修要求 |
|---|---|---|---|
| 07 | `POST /api/admin/users/[id]/reset-2fa` | 部分覆盖 | 10:83 的“恢复permit签发”及 10:72 一次性响应失败不盲重试覆盖语义；缺精确路径及该旧接口已变为签发permit的逐行条目。超时不可重发同grant，也不可重新造第二份。 |
| 09 | `POST /api/admin/account/session/activity` | 缺失，需返修 | 10:82–86 未列 activity；09:41 仅约定真实活动节流、CAS和Set-Cookie。空对象重放会使用新的服务器时间推进lastActivityAt，并非普通幂等写。应明确超时/429/503是否停止自动重试、何时允许下一次真实活动调用及先读哪个状态。 |
| 10 | `POST /api/admin/account/reauth` | 已覆盖语义，缺逐行清单 | 10:83 明列 reauth，禁止自动重试，超时先读状态且已消费不能造第二份；10:72 单次秘密失败不盲重试。应写明最终实际路由及未获得grant时只能按当前状态重新做新鲜验证，不能重放已用TOTP。 |
| 15 | `POST /api/admin/account/recovery-authorizations` | 已覆盖语义，缺逐行清单 | 10:83 明列恢复permit签发；10:72 说明一次性秘密失败不盲重试；09:18/47 约束15min一次性、目标绑定与不能自授权。需明确该路径与别名路径各自同一规则。 |
| 16 | `POST /api/auth-admin/recovery/start` | 已覆盖语义，缺逐行清单 | 10:83 明列 recovery/start，禁止自动重试，响应丢失须新恢复凭据/授权且不回传旧秘密；09:44–45 要求当前凭据同事务最多核销一次。 |
| 17 | `POST /api/auth-admin/recovery/enroll` | 泛称有歧义，需具体化 | 10:83 的 enroll/confirm 可指初次绑定或受限恢复，未逐路由区分；09:19/46 对restricted/pendingSecret有状态机，但没有单列本路由超时后如何恢复。应明确不可自动重新生成pendingSecret，以及读取/重入规则。 |
| 18 | `POST /api/auth-admin/recovery/confirm` | 泛称有歧义，需具体化 | 10:83 的 enroll/confirm 与10:72的一次性响应规则基本覆盖；09:46最终核销、恢复码只返一次且回普通登录。应具体列恢复confirm路径和响应丢失时恢复码不重返、不能生成第二次成功。 |
| 29 | `POST /api/analytics/consent` | 缺失，需返修 | 10:82–86 未列consent。09:67 约定同意生成随机ID、撤回清cookie、重新同意生成新ID，未定相同true请求重放是否保留原cookie/身份或重新生成。需定幂等分支和客户端重试策略，避免同意重试造成身份重建。 |
| 34 | `POST /api/admin/cron/operations` | 缺失，需返修 | 10:85 只有“cron按租约拒绝重叠”；09:84–85作业批次/租约与SMTP有界重试不是HTTP请求幂等。串行重复仍可触发下一批或外部副作用。需说明调用方超时/429/503不自动重发、以JobState核实后等下一计划/显式恢复的规则，或给出其他明确去重方案。 |
| 35 | `GET /api/admin/cron/mail-queue` | 缺失，需返修 | 既有GET会消费邮件队列并发信，不能套安全GET可重试；10:82仅称“安全GET”而未明确排除该worker路由。10:85重叠租约不防串行重触发。应明确遗留GET为副作用接口及其调度/超时/重试，与SMTP稳定Message-ID有界重试分层。 |
| 36 | `POST /api/admin/cron/mail-queue` | 缺失，需返修 | 10:85及09作业条款只处理worker租约与SMTP投递，未说明HTTP POST触发重试。应与GET别名共用明确策略，保留原stale/sent/failed/deferred/dropped协议。 |

## 其他疑点与语义说明

- 第01/02行是Auth.js兼容族，GET可匿名读CSRF/session，POST登录/退出有不同副作用。state保留同源、CSRF、POST登录、GET session、redirect、cookie、CredentialsSignin，不伪称统一JSON；因此族级 `mutating/idempotent=unsure` 不应被改写成自定义REST保证。
- 第03/04/16/17/18行均正确选择anonymous，并不表示无需凭据。初始绑定必须email/password/当前一次性token，独立恢复必须有效恢复码/permit或专属restricted cookie与新TOTP，不能建立或升级ADMIN/SALES/EDITOR session。当前state与原文无“把恢复cookie当普通后台session”的歧义。
- 第05行改密 `declared_ok=unsure(0.62)`，但 permission=authenticated_self(high 0.99)。源文已要求本人、同源、当前密码+新TOTP、最终事务grant消费和全会话撤销；不是模型报告明确权限矛盾。仍需后端核实旧兼容路径与新grant路径确实同一最终验证，不据本校准替实现背书。
- 第10行reauth `declared_ok=unsure(0.59)`。基本self路径可用authenticated_self；RECOVERY_AUTHORIZE的target必须他人且当前角色ADMIN，DEVICE_REVOKE只可本人设备；这些purpose分支已在state完整保留，不能把最低入口角色当作每个purpose通行证。正式权限表的“target规则由purpose决定”需与09:17/43/47一起执行。
- 第19行chat/session返回idempotent=yes(0.75)，但09:61明确仅已有有效cookie时幂等；无cookie重试可产生空session并TTL清理。保留该模型过度概括，不承诺端到端无cookie幂等；10:82“新会话携UUID”的措辞还应明确是conversation创建，不能暗示cookie bootstrap从客户端UUID恢复授权。
- 第27行own cursor 与聊天权限的关系是实质分歧，已明确交回并收到架构确认，见上。英文role_definitions原本就说明authenticated_self覆盖所有后台角色且不含SALES-only业务授权，无需改state；未静默解释掉或追问模型刷绿。
- 第30行Analytics idempotent=unsure(0.64)，源10:82和09:69已双唯一+payload hash，原样重试不重计；不因模型unsure取消真实约束。应继续区分raw event去重和按日重新聚合。
- 第33行选EDITOR是最小可调用角色，只适用于公开流量/产品/3D请求；SALES inquiry按既有scope，ADMIN系统来源。state包含完整来源/字段/服务端查询前过滤/403/隐藏字段省略，不把least role误写成所有来源EDITOR可见。
- 第35行legacy mail-queue GET `declared_ok=unsure(0.59)`，但cron高置信且源明确是worker触发。保留GET旧协议是兼容决策；必须显式声明副作用和重试限制，不把该遗留兼容接口算“安全GET”。
- 第37行ops-report idempotent=yes(0.65)仅在同一报告重放覆盖同一测量状态的理解下成立；源09:29只定义快照字段，未明确旧measuredAt乱序拒绝条件。建议后端确认不会以旧报告倒退最近成功时间；这不是本轮判定的明确权限阻断。

## 英文state与来源完整性

已忠实翻译每行 method/path/input/output/permissions；补充09相关英文上下文只用于还原实际鉴权、事务、凭据限制、来源范围及副作用，没有新增权限。模型输入不包含配置、数据库、真实账号、私密资料或密钥。未安装库。

roles固定为`anonymous、visitor_session、authenticated_self、EDITOR、SALES、ADMIN、cron`，各有英文定义；helper另附`public`。没有把账号ID当权限标签。

| 输入源 | 校准快照SHA256 | 校准后当前文件SHA256 | 一致 |
|---|---|---|---|
| `_run/endpoints-contract.json` | `2bc35697eb1ea5d2257501945b08d4956144325ec8b712f7b528f4a6650b832e` | `dbd5d6375f0b8680c7689b2778091e0ef2e6111f35e26ab8549285d6c4cdc56c` | 否 |
| `02-设计/10-接口约定.md` | `9abb2896d34266ad6a18fdcc8e6c51388f162d5dff4f1f929ef23a1aadb9f4d4` | `13081499c9629ad67c17a4228b1119b66acbe57d31dfbe8be08bd8c9780454c9` | 否 |
| `02-设计/09-数据模型.md` | `4345e5a499b56d45622cfe8a70922a51a01a745c7b0b13e515e4d861c3649f63` | `4345e5a499b56d45622cfe8a70922a51a01a745c7b0b13e515e4d861c3649f63` | 是 |

源码快照保存在本目录 `source-*`；表内源行均指校准时快照。共享文档在并行架构工作中可能继续变化，后续修改须重新核对受影响英文state。

校准结束时主会话只澄清Auth.js两行的LoginMode=password/totp和rememberDevice表单字符串严格映射；已对比快照与当前diff，返回/权限/副作用未改变。因此本37次结果仍明确标为针对原快照；字段解释变化不需要重跑37次。主会话后续新增重试逐行清单后，由主会话再按上方11行对照人工核对。

幂等判断关注业务状态和预期动作；普通访问日志或独立统计记录的差异不能单独证明业务非幂等。上表activity关注真实会话期限变化，consent关注匿名身份/cookie变更，作业关注实际下一批工作或SMTP外部副作用。安全敏感一次性授权的自动重试限制独立保留。

## 可合并证据

主会话可按01..37顺序合并本目录37份 `.jsonl`；不要合并 `.stdout.json` 冒充主日志。每份日志恰好一条，model/哈希/label/usage俱全；`results.json`可机器读取全部结论，`manifest.json`保留方法顺序及源表行。


## 最终端点返修复核（保留原37次结果）

已由后端架构方对照决策7/C-01、09共享聊天范围及当前10复核：第27行后台聊天read仍只允许ADMIN/SALES，且仅改服务器session确定的本人游标；EDITOR与其他仅authenticated_self账号拒绝。原模型`authenticated_self(low 0.42)`表示最低入口角色判断与业务授权冲突，不能降权刷绿。本次未重问第27行，原line与概率保留；结论为按既定权限执行，非新增权限选择。

10现有“逐路径副作用、重试与结果未知”表逐项覆盖原11行：07、09、10、15、16、17、18、29、34、35、36。activity推进实际授权闲置期限，不自动重放；operations与mail-queue GET/POST均有worker副作用，HTTP失败不证明未执行，不自动触发重试，只读JobState/原邮件状态与下一计划恢复。遗留GET明确排除安全GET，本轮调度采用POST，关闭通用代理重试和预取。HTTP幂等按RFC9110所请求效果判定，正常日志/计数不作为业务非幂等理由；一次性安全动作仍禁止自动重放。不存在的“非幂等写清单”引用已删除，改为实际逐路径表。

第17、29行补充了原state未定义的重复请求效果，所以只对这两个新state各运行一次真实校准；不是对同state反复提问。旧17/29的state、jsonl、stdout及本报告原表完全保留，新增证据独立命名：

| 原行 | 明确的语义变化 | 新model与原样line | 独立证据 |
|---|---|---|---|
| 17 | 同一有效restricted cookie/session/sv与未过期pending重入，返回相同URI/原期限，不旋转或续时；过期终止，confirm仍一次性 | `jev-1.13.0`；`endpoint: permission=anonymous(high 0.99) mutating=yes(0.88) idempotent=yes(0.79) declared_ok=yes(0.92)` | [17.remediation.state.json](17.remediation.state.json) / [17.remediation.jsonl](17.remediation.jsonl) / [17.remediation.stdout.json](17.remediation.stdout.json) |
| 29 | 相同true+有效同版本cookie保留原ID/grantedAt/expiry；重复false清cookie，不建身份；撤回后再同意或首次/过期签发才新ID，写入串行且遵最新意图 | `jev-1.13.0`；`endpoint: permission=anonymous(medium 0.69) mutating=yes(0.93) idempotent=yes(0.68) declared_ok=yes(0.90)` | [29.remediation.state.json](29.remediation.state.json) / [29.remediation.jsonl](29.remediation.jsonl) / [29.remediation.stdout.json](29.remediation.stdout.json) |

两个新增state均纯英文、无language_warning，真实status=ok，model=jev-1.13.0。原37次中第05/10/35行的declared_ok=unsure仍保留；本次补齐其兼容验证、purpose限制、遗留GET副作用与结果未知策略，只能说明规格已明确，不能代替未来真实实现/路由测试。

另已明确：chat/session没有cookie时不承诺端到端幂等；ops-report同source/measuredAt同载荷幂等、异载荷409、旧测量忽略，不能倒退成功时间。一次性确认响应丢失不重返恢复码；用新验证器下一步正常登录，材料丢失仅通过新鲜验证后的独立重绑再生成。分页泛型名改为DevicePageDTO/ChatSummaryPageDTO，形状不变；登录mode=password/totp和rememberDevice字面true/false映射保留。首表仍37个方法记录，_run/endpoints-contract.json已从当前首表重导并逐项一致。
