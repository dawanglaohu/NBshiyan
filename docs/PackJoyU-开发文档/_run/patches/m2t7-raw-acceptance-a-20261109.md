# 文档补丁 m2t7-raw-acceptance-a-20261109

任务：M2-T7
原分支：task/M2-T7
原 PR：None
依据：A1-A3 终稿：耗时/samples/零成功边界落到 M2-T7/M6-T6/M7-T3 三条验收，不改 E-63/09/依赖；语言专家独审通过

## 差异与复验范围

- M2-T7：task
- M2-T8：上游契约变化或本次审查目标
- M3-T10：上游契约变化或本次审查目标
- M3-T11：上游契约变化或本次审查目标
- M3-T12：上游契约变化或本次审查目标
- M3-T13：上游契约变化或本次审查目标
- M3-T25：上游契约变化或本次审查目标
- M3-T6：上游契约变化或本次审查目标
- M3-T8：上游契约变化或本次审查目标
- M3-T9：上游契约变化或本次审查目标
- M6-T1：上游契约变化或本次审查目标
- M6-T2：上游契约变化或本次审查目标
- M6-T3：上游契约变化或本次审查目标
- M6-T4：上游契约变化或本次审查目标
- M6-T5：上游契约变化或本次审查目标
- M6-T6：edges、task
- M6-T7：上游契约变化或本次审查目标
- M7-T1：上游契约变化或本次审查目标
- M7-T10：上游契约变化或本次审查目标
- M7-T2：上游契约变化或本次审查目标
- M7-T3：task
- M7-T4：上游契约变化或本次审查目标
- M7-T5：上游契约变化或本次审查目标
- M7-T6：上游契约变化或本次审查目标
- M7-T7：上游契约变化或本次审查目标
- M7-T8：上游契约变化或本次审查目标
- M7-T9：上游契约变化或本次审查目标

### 04-执行/19-模块任务拆分.md

````diff
--- before/04-执行/19-模块任务拆分.md
+++ after/04-执行/19-模块任务拆分.md
@@ -23,7 +23,7 @@
 | M2-T4 | 定义模型分析事件生命周期纯规则 | M2 | M1-T2 | contract-types中的事件白名单、navigationId/viewId与durationMs约束 | model-event-rules；start/terminal去重及取消/重试转换的纯函数 | 1) 录制输入序列验证每viewId最多一个success/failure，timeout为failure，poster/FoldBox不产生GLB success，重试新尝试使用新viewId；函数不读DOM/env/cookie且不fetch。2) 事件输出必须通过M1共享schema；durationMs取注入单调时钟差，产品/导航关联原样保留，乱序/重复终态不覆盖已定终态；真实浏览器生产者由M2-T7消费。 | 1d |
 | M2-T5 | 连接产品上下文到既有询盘表单 | M2 | M2-T6、M1-T8 | model-fallback、现有InquiryWizard与POST /api/inquiries协议 | product-inquiry；产品卡至联系页询盘的上下文链 | 1) 点击产品卡inquire-product→/[locale]/contact，真实POST /api/inquiries携服务器认可productSlug并保存真实Inquiry编号，表单的产品/规格等于来源卡片，不改旧询盘协议。2) en/ru和390窄屏分别走该入口，提交前从模型拖动/键盘控制不产生询盘POST；名称、规格、询盘入口仍可见且能完成提交，保留一条真实路径GIF。 | 1d |
 | M2-T6 | 接通真实模型失败与海报回退 | M2 | M2-T3 | model-accessibility、对应产品poster与真实GLB来源 | model-fallback；GLB/WebGL/context失败的静态回退和重试入口 | 1) 分别注入GLB下载失败、WebGL不支持、context lost和仅poster/FoldBox，显示对应产品海报及可点击重试/询盘；不无限重试、不把其他产品图片充当回退。2) 重试建立新的实际加载尝试，卸载取消旧监听/加载回调；纯展示状态只上报加载结果回调，不在本任务创建分析成功事件，统计完整集成由M2-T7完成。 | 1d |
-| M2-T7 | 把真实GLB生命周期接入分析采集 | M2 | M2-T4、M2-T6、M5-T6、M5-T7、M5-T3 | model-event-rules、model-fallback、analytics-ingest与analytics-consent-ui | model-events；页面/产品访问与真实GLB start/terminal生产者接线 | 1) 真浏览器产品卡发起GLB后POST /api/analytics/events分别保存产品访问、model_view_start及成功/失败；仅进入产品路由且没有真实GLB加载尝试时无start；可视区自动加载或主动操作确实发起GLB时均产生start，不要求额外激活点击；未同意/拒绝分析时模型仍可用且无分析请求（E-42、E-46）。2) 分别注入GLB下载失败/WebGL不支持/context lost/poster或FoldBox，仅对应产品静态回退、重试及询盘可用；poster/演示无GLB success；同viewId最多一种终态，新实际重试按规则新viewId（E-103）。3) 成功/失败/超时两次尝试与切卡取消逐项核关联及真实durationMs，分母仅同意后真实start、timeout为failure、平均耗时带samples且无样本null，不补拒绝样本（E-63）。 | 1.5d |
+| M2-T7 | 把真实GLB生命周期接入分析采集 | M2 | M2-T4、M2-T6、M5-T6、M5-T7、M5-T3 | model-event-rules、model-fallback、analytics-ingest与analytics-consent-ui | model-events；页面/产品访问与真实GLB start/terminal生产者接线 | 1) 真浏览器产品卡发起GLB后POST /api/analytics/events分别保存产品访问、model_view_start及成功/失败；仅进入产品路由且没有真实GLB加载尝试时无start；可视区自动加载或主动操作确实发起GLB时均产生start，不要求额外激活点击；未同意/拒绝分析时模型仍可用且无分析请求（E-42、E-46）。2) 分别注入GLB下载失败/WebGL不支持/context lost/poster或FoldBox，仅对应产品静态回退、重试及询盘可用；poster/演示无GLB success；同viewId最多一种终态，新实际重试按规则新viewId（E-103）。3) 成功/失败/超时两次尝试与切卡取消逐项核关联及真实durationMs，分母仅同意后真实start、timeout为failure、不补拒绝样本（E-63）；平均耗时与samples、无样本null、零成功0%由 M6-T1 计算、M6-T6 输出、M7-T3 终验，不在本任务重复验收。 | 1.5d |
 | M2-T8 | 贯通产品咨询与人工收件回复 | M2 | M2-T5、M2-T7、M4-T5、M4-T6、M4-T9、M4-T14 | product-inquiry、chat-visitor-ui、chat-operator-ui与model-events | product-contact；带产品上下文的访客/运营人工咨询链 | 1) 产品卡chat-product打开窗口，POST /api/chat/conversations保存同一productSlug/持久且不变消息编号后才显示已接收；运营真实收件箱可读该消息并人工回复，访客收到同一回复；网络中无AI答复接口或自动生成答复（E-16、E-31）。2) 拒绝分析仍可咨询且不建分析ID/第三方聊天脚本；提交超时/响应丢失后同clientMessageId重试返回原收件结果，收件箱/通知各一项；当前标签草稿保留，en/ru/390路径有真实GIF（E-37、E-40）。 | 1.5d |
 | M3-T1 | 将真实Auth.js会话绑定当前设备与权限 | M3 | M1-T2、M3-T14 | 现有Credentials、JWT/sv、requireAdmin/page gate；M3-T14共享HTTP层；M1-T2契约。 | AdminDeviceSession；Auth.js登录/读取/普通signOut的sid适配；GET /api/admin/account的当前设备摘要及当前权限守卫。 本卡增加User.passwordlessEnabled并默认false，保证首个AccountDTO字段齐；真实GET account最终响应消费T14计数适配。 | 1) 调用方/接线点：真实Credentials→src/auth.ts→设备服务；真HTTP登录创建归当前user/sv的sid，GET /api/admin/account与Auth.js session/SSR均核User存在、disabled、lockedUntil、totpEnabled、role、sv、sid归属/revokedAt/期限；旧无sid JWT、数据库不可校验均拒绝，角色只取当前库值（E-70）。2) 普通会话为2h活动滑动，另加创建后12h绝对截止；记住7d闲置且签发后30d绝对；到期等号即拒绝，且发生在写入 lastActivityAt 之前；普通Auth.js signOut服务端撤sid后清cookie，复制的旧cookie访问GET account返回401，跨请求不得授权缓存（E-01、E-02、E-03、E-69）。 3) GET account包含10节完整AccountDTO和当前设备期限，未开启账号passwordlessEnabled=false；专用PG核真实响应requestCount一次、受控5xx增加errorCount，计数故障不改变原业务结果。 | 1.5d |
 | M3-T2 | 校验登录方式并原子核销当前验证器时间步 | M3 | M3-T1、M1-T2 | M3-T1 的真实设备登录与当前权限链；现有 enroll/token/confirm 与 TOTP 工具；M1-T2 单一 LoginMode schema。 | Credentials 的 password/totp 模式与恢复码拒绝；消费M3-T1已增加且默认false的User.passwordlessEnabled，不重复建字段；当前 secret/sv/step 的 TOTP CAS；POST /api/auth-admin/enroll、POST /api/auth-admin/enroll/confirm 的当前令牌/期限 CAS。 | 1) 调用方/接线点：真实 Auth.js Credentials→authorizeLogin；已启用账号的 totp 模式只校验账号+验证码，password 模式校验当前密码+验证码；未知mode、未开启totp、非空recoveryCode和未知账号都同一通用失败且无设备行（E-06、E-96）。2) 当前secret/sv/step原子核销，登录/并发请求同一步最多成功一次；重置交错时旧secret的码不能生效；保留6位前导零及既有限流（E-72、E-08）。3) 未绑定账号须既有一次性token完成首次绑定；真实 enroll/confirm 在最终事务复核 tokenhash/expiry/sv/pendingSecret，错误/过期/并发确认不提交，且未确认前 passwordlessEnabled 保持false（E-05、E-08）。 | 2d |
@@ -81,11 +81,11 @@
 | M6-T3 | 登记存储备份报告与运维采样 | M6 | M6-T6、M5-T1、M5-T8 | job-foundation、受控服务器脚本、既有备份元数据、10报告契约 | ops-sources；ops-sample、POST /api/internal/ops-report与只读报告脚本 | 1) 受控deploy脚本→真实POST /api/internal/ops-report，Bearer与白名单严格；仅空间计数/备份完成验证元数据，拒任意路径和内容；同source+measuredAt同载荷幂等、异载荷409、旧时间不覆盖新值；无验证来源not_connected；SALES/EDITOR直接GET stats的STORAGE/BACKUP来源403且无计数，后台session不能替代report Bearer（E-65、E-66）。2) ops-sample在registry、composition、cron实际注册每15分钟，重启后按计划运行；真实measuredAt/lastSucceededAt读取到stats，停止报告显示原时间/旧值，未做恢复验证不能标可恢复；辅助源异常不阻断核心（E-67）。 | 2d |
 | M6-T4 | 交付可导航的核心数据看板页面 | M6 | M6-T6、M3-T7 | stats-core、后台壳、07页面入口与11样式密度 | stats-base-ui；后台stats-link、日期/产品/刷新与核心指标页面 | 1) 真登录后点击后台壳stats-link到/admin/stats；日期/产品/刷新控件发真实GET /api/admin/stats并渲染对应core DTO，授权浏览器/PV/产品/3D有真实来源，样本数与时区标签可见（E-61、E-63）。2) ADMIN/SALES/EDITOR页面仅呈其权限来源，直接请求越权仍403且响应不含隐藏计数；1920×1080、1440×900、390×844以真实会话留GIF与density=7/gutter16/gap16/pad16报告，work面按D1-D6且手机保留真实n/a（E-66）。 | 1.5d |
 | M6-T5 | 接入HTTP和邮件可靠性来源 | M6 | M6-T6、M4-T4 | stats-core、M3真实ApiDailyCounter、MailMessage与ChatNotification状态 | stats-reliability；明确覆盖的HTTP与通知计数适配器 | 1) 对已接线API产生真实2xx/5xx响应后GET /api/admin/stats的http来源，分母为同范围真实requestCount且错误为5xx；覆盖标签仅本轮instrumented routes，无分母为null、未接入为not_connected，禁止声称全站错误率（E-64）。2) 通过真实通知作业产生queued/sending/sent/failed/unknown结果，mail来源按真实尝试/SMTP接受计数，不把排队或咨询received算投递；某来源查询失败保留其原成功时间/旧值或显示无旧值失败，其他来源继续成功（E-51、E-52、E-53、E-64、E-67）。 | 1.5d |
-| M6-T6 | 接通受角色限制的真实统计HTTP入口 | M6 | M6-T1、M5-T4 | stats-query-rules、现行requireAdmin与scope、10 GET stats契约 | stats-core；GET /api/admin/stats与生产组合注册 | 1) 真实登录后GET /api/admin/stats→route→ops查询真实聚合，核HTTP状态、DTO与数据时间；同意→真实页面/产品访问→真实GLB start/terminal→已注册五分钟作业提交后，逐项核当日授权浏览器、PV、产品归因、3D次数，核心来源不能固定返回或未接入（E-61）。2) 未登录401；ADMIN全来源、SALES既有业务范围、EDITOR仅公开流量/产品/3D；直接请求敏感系统来源403，混合来源在查询前裁剪且无隐藏计数（E-66）。3) 切换有效时区后返回当前revision与重算状态，仅保留期完整覆盖可重算；超30天历史保留原标签或明确不可重算，不拼接趋势；不同浏览器时区同站点日一致（E-55、E-58）。 | 1.5d |
+| M6-T6 | 接通受角色限制的真实统计HTTP入口 | M6 | M6-T1、M5-T4 | stats-query-rules、现行requireAdmin与scope、10 GET stats契约 | stats-core；GET /api/admin/stats与生产组合注册 | 1) 真实登录后GET /api/admin/stats→route→ops查询真实聚合，核HTTP状态、DTO与数据时间；同意→真实页面/产品访问→真实GLB start/terminal→已注册五分钟作业提交后，逐项核当日授权浏览器、PV、产品归因、3D次数，核心来源不能固定返回或未接入（E-61）。3D耗时均值须携有效终态样本数samples，耗时无样本时均值为null；成功率以同意后真实start为分母，零成功与无样本的输出按09节、E-63及M6-T1既有口径逐项核对，samples不作成功率分母。DTO须与M6-T1同源，不得用0冒充未知值，不得对每日均值再平均。2) 未登录401；ADMIN全来源、SALES既有业务范围、EDITOR仅公开流量/产品/3D；直接请求敏感系统来源403，混合来源在查询前裁剪且无隐藏计数（E-66）。3) 切换有效时区后返回当前revision与重算状态，仅保留期完整覆盖可重算；超30天历史保留原标签或明确不可重算，不拼接趋势；不同浏览器时区同站点日一致（E-55、E-58）。 | 1.5d |
 | M6-T7 | 完成看板逐源状态与故障呈现 | M6 | M6-T4、M6-T2、M6-T5、M6-T3 | stats-base-ui、business/reliability/ops来源及10状态DTO | stats-ui；SourceCard状态、独立时间、趋势覆盖与安全重试 | 1) 从/admin/stats的真实GET响应分别验成功0、no_data、not_connected、无旧值query_failed、有旧值stale、单来源失败和重算partial；每源保留原dataThrough/lastSucceededAt，失败刷新不更新旧数据时间，其他指标可继续读取（E-49、E-50、E-51、E-52、E-53、E-67）。2) 查询成功但没有事件接收链路证据时，仅显示实际配置/最近接收/查询结果与未知或最后已知时间；零流量不产生健康心跳或全链路正常徽标（E-54）。3) 三尺寸真实页面复验D1-D6和可辨时间/来源标签、键盘刷新，保存GIF；手动刷新仅GET stats，不调cron/备份/发信。 | 1.5d |
 | M7-T1 | 终验公开媒体与3D访客路径 | M7 | M1-T5、M2-T5、M2-T8 | docs/brand-media/static/selected-media-release.json与M1-T6/M1-T9实际发布清单、来源/帧报告、首页现有BRAND_MEDIA及产品GLB链；参考原件仅历史核对 | visitor-media-acceptance；真实访客浏览GIF与媒体来源终验报告 | 1) 先核docs/brand-media/static/selected-media-release.json的选定成品；en/ru首页点产品入口，加载真实GLB、拖动/复位并核productSlug和询盘入口；视频用选定v3及对应帧海报，工业场景用确认PNG/GIF，核src/网络文件SHA与选定发布清单一致，不加载旧参考附件/hero。回归暂停、隐藏/减少动态，1920/1440/390无媒体遮挡操作（E-21、E-24、E-104）。2) 复核M1对选定工业GIF的361帧品牌/透视、每帧时序/顺序、30.08秒/无限循环及同尺寸暂停帧；保留原附件SHA，只把旧原件作历史/时序证据，不强制新场景与参考画面相同；不用候选标（E-26、E-30）。3) 核实际授权渠道的输入/调用或软件操作/输出/SHA与成品证据；用Dot才核对应调用，未用不能否定已有授权成品。缺必需产物/核验逐项保持未完成，不补造渠道；PNG/GIF的已确认不代表公司工程/事实已完成（E-29、E-111）。 | 1.5d |
 | M7-T2 | 终验真实会话跨路径持久与撤销 | M7 | M3-T8、M3-T6、M3-T10、M3-T11、M3-T13 | 设备/API/UI及Auth.js锁定版本、17真实会话检查 | session-acceptance；初登/活动刷新/SSR/退出与浏览器恢复证据 | 1) 真实登录并核rememberDevice=false的2h活动滑动；实际活动POST /api/admin/account/session/activity写Set-Cookie续期而SSR只读不冒称已续；记住设备7d闲置与30d绝对边界的HTTP测试拒绝等号/过期，连续活动不越30d（E-01、E-02、E-69、E-71）。2) 有效记住cookie关闭重开同浏览器可恢复；分别实际改密码、重置验证器、退出所有设备、撤销设备、禁用/改sv后旧cookie下一真实受保护HTTP被拒，刷新不复活；普通Auth.js signOut同步撤销sid，数据库不可校验时拒绝；mode非法/未启用totp/非空recoveryCode均通用登录失败（E-03、E-04、E-70、E-96）。 | 1.5d |
-| M7-T3 | 终验同意到分析看板及统计日界线 | M7 | M5-T5、M5-T4、M6-T7、M2-T4、M5-T11、M5-T10、M2-T7 | analytics-ingest/aggregate/retention、真实产品event与最终stats-ui | analytics-acceptance；真实采集聚合、时区与保留授权链报告 | 1) 从真实同意控件→真实页面/产品/GLB start与唯一终态→计划聚合提交→/admin/stats读取同productSlug/viewId来源；拒绝或撤回不采集，成功率只用授权start，真实失败/超时不算success，无样本null且均值带samples（E-42、E-61、E-63）。2) 专用PG与HTTP链覆盖DST23/25小时、午夜、48h迟到、同revision快照以及旧租约晚提交被拒；时区改变不拼接超原始覆盖趋势；原始30d/聚合13月候选边界可测，生产无保留授权时请求真实清理被拒且删除0（E-48、E-56、E-81、E-88）。 | 2d |
+| M7-T3 | 终验同意到分析看板及统计日界线 | M7 | M5-T5、M5-T4、M6-T7、M2-T4、M5-T11、M5-T10、M2-T7 | analytics-ingest/aggregate/retention、真实产品event与最终stats-ui | analytics-acceptance；真实采集聚合、时区与保留授权链报告 | 1) 从真实同意控件→真实页面/产品/GLB start与唯一终态→计划聚合提交→/admin/stats读取同productSlug/viewId来源；拒绝或撤回不采集，成功率只用授权start，真实失败/超时不算success，无样本null且均值带samples（E-42、E-61、E-63）。分别核验耗时均值的samples与无样本null，以及成功率的零成功/无样本边界；按09节、E-63及M6-T1既有口径判定，成功率分母仅为同意后真实start，耗时samples不作成功率分母；结果与M6-T1/M6-T6同源。2) 专用PG与HTTP链覆盖DST23/25小时、午夜、48h迟到、同revision快照以及旧租约晚提交被拒；时区改变不拼接超原始覆盖趋势；原始30d/聚合13月候选边界可测，生产无保留授权时请求真实清理被拒且删除0（E-48、E-56、E-81、E-88）。 | 2d |
 | M7-T4 | 终验询盘聊天闭环与容量降级 | M7 | M7-T1、M4-T6、M4-T7、M4-T14、M4-T12、M4-T13 | product-contact、访客/运营聊天和现有联系渠道、独立可用性开关 | visitor-acceptance；带产品上下文的询盘/聊天收发及容量边界报告 | 1) 从产品可见联系入口提交真实POST /api/inquiries及POST /api/chat/conversations，核productSlug/持久且不变消息ID；ADMIN/SALES从收件箱回复，访客seq同步收到；网络失败保留当前标签草稿，同UUID重试仅一消息；收件与通知失败独立，拒分析也可咨询（E-16、E-18、E-31、E-37、E-40）。2) 在隔离目标环境实测聊天开启前后内存/并发/延迟并记录限制；不足时实际关闭独立聊天可用性开关并保留可见原联系/询盘入口，前端显示不可用而非虚假在线；不使用旧约2.7GB快照当当前容量，不自动购买扩容（E-20）。 | 1.5d |
 | M7-T5 | 终验受限恢复与单管理员兜底 | M7 | M7-T6、M3-T9、M3-T11、M3-T18、M3-T20 | 已交付恢复向导/OS-owner CLI、一次性码和受限cookie协议 | admin-acceptance；恢复并发、不可越权及本地兜底证据 | 1) 从独立恢复入口POST /api/auth-admin/recovery/start→enroll→confirm；同码、不同码并发核销不复活已用码，restricted cookie不能访问后台；中断/过期保留旧有效因素，重入返回同URI/期限，新确认才替换因素且必须普通登录（E-10、E-11、E-14）。2) 无第二管理员且恢复码丢失时，隔离服务器OS-owner实际TTY CLI明确target/reason生成permit，隐藏密码预授权只在新TOTP最终确认提交且审计；旧首次绑定reset脚本guard不放宽，匿名浏览器不能签permit/改密码；最终confirm撤销旧会话/旧绑定/旧恢复材料、新恢复码仅展示一次，旧设备下一请求被拒（E-15）。 | 2d |
 | M7-T6 | 终验新鲜本人授权与忘密码隔离 | M7 | M3-T7、M3-T9、M3-T12、M3-T13 | reauth-dialog、单用途ActionGrant、安全变更与受限恢复入口 | fresh-auth-acceptance；新鲜授权/并发核销/无现密码负例报告 | 1) 从真实个人信息操作发POST /api/admin/account/reauth，当前密码+新TOTP才得5min grant；同TOTP步并发最多一成功，同grant并发最多一变更，跨purpose/target/device、过期或撤销后变更均拒且状态未变（E-72、E-73、E-74）。2) 用真实绑定/模式切换入口分别提交错码、过期码、重放与两次并发切换，最终事务重查pending/期限/sv且错误不提交、并发最多一成功，失败后仍有至少一种已验证方式（E-08）。3) 已启用无密码且忘现密码者可正常email+totp登录处理非敏感业务；仅会话或仅TOTP请求reauth及直接敏感变更均被拒且不签普通grant，界面引导独立受限恢复；受限路径只允许新绑定并有审计，HTTP不能写pendingPasswordHash（E-75）。 | 1.5d |
````

新旧任务契约在同名 JSON 的 changes、源条款在 sourceChanges。只复验变化及其影响，不重新初始化分支。

## 原任务续做

# 继续原任务 M2-T7：把真实GLB生命周期接入分析采集
沿用分支 task/M2-T7、现有工作树和原 PR；不要创建新任务或重新初始化分支。
任务契约版本：c445090a750be9e0ea6126dd988b12e9651bbdc99b2281f2ff2bd7e75519c84d
读取 _run/patches/ 中本次补丁的差异和复验清单，只处理列出的条目及其直接影响。没有差异说明时先核对现有 PR 的返工记录，不按完整实施流程重做。
修正后的验收：
1) 真浏览器产品卡发起GLB后POST /api/analytics/events分别保存产品访问、model_view_start及成功/失败
仅进入产品路由且没有真实GLB加载尝试时无start
可视区自动加载或主动操作确实发起GLB时均产生start，不要求额外激活点击
未同意/拒绝分析时模型仍可用且无分析请求（E-42、E-46）。2) 分别注入GLB下载失败/WebGL不支持/context lost/poster或FoldBox，仅对应产品静态回退、重试及询盘可用
poster/演示无GLB success
同viewId最多一种终态，新实际重试按规则新viewId（E-103）。3) 成功/失败/超时两次尝试与切卡取消逐项核关联及真实durationMs，分母仅同意后真实start、timeout为failure、不补拒绝样本（E-63）
平均耗时与samples、无样本null、零成功0%由 M6-T1 计算、M6-T6 输出、M7-T3 终验，不在本任务重复验收。
有效范围：
.github/workflows/ci.yml
e2e/admin-device-session.spec.ts
e2e/admin-enroll.spec.ts
e2e/admin-login.spec.ts
e2e/admin.spec.ts
e2e/base-url.ts
e2e/hotfix-login-empty.spec.ts
e2e/model-events.spec.ts
eslint.config.mjs
playwright.config.ts
src/app/
src/app/admin-enroll/
src/app/admin-login/
src/app/admin-recovery/
src/app/admin/account/
src/app/admin/chat/
src/app/admin/settings/
src/app/admin/stats/
src/app/admin/users/
src/components/admin/AdminShell.tsx
src/components/analytics/
src/components/layout/SiteFooter.tsx
src/components/layout/SiteHeader.tsx
src/components/three/
src/i18n/navigation.ts
src/i18n/routing.ts
src/lib/client/analytics.ts
src/lib/contracts/analytics.ts
src/lib/contracts/chat.ts
src/lib/navigation/routes.ts
保留已有代码和回填；修改后运行必要检查、追加提交并 push，继续原 PR 审查。
## 自行裁决：交 Jev，不交用户
实施、审查、查 bug、批次收口过程中出现的每一条「自行裁决」，以及验收冲突、文档缺口、栈外依赖、UI/UX 未定项，都先列出 2–5 个真实可行的选项；不能把你想要的答案当唯一候选。
把原始需求、任务标题与验收、冲突和选项忠实译成英文写入 state.json（文档与回报仍用中文）；UI/UX 取舍使用 design，其余使用 adjudicate。
运行 python "docs/PackJoyU-开发文档/_run/typesafe_ask.py" --log "docs/PackJoyU-开发文档/_run/judgments.jsonl" --label "M2-T7:resume" run adjudicate --state <state.json>；UI/UX 将 adjudicate 换成 design。若 language_warning 提示中文过多，重译后重跑。
仅 status=ok 且 verdicts.adopt.action=take 才按 option 执行；confidence=low 仍用 Jev 的 option，记低置信风险。spec_change=yes 走文档补丁，outside_stack=yes 在回报点名，不自动扩权。
adopt=red_line 仅涉及付费、不可逆删除、改变已定范围或对外承诺时请求用户授权；status=skipped/error 或缺有效 pick 时留下待 Jev 裁决，不得由人代答、判 pass、声称已落地或写 clean/fixed。
回报逐条写：冲突 → 全部候选 → Jev line/model/采纳的 option → 代码或文档动作；没有写「无」。
