# 文档补丁 USER-AUDIT-20261019

任务：M1-T5
原分支：task/docs-s2-s6
原 PR：None
依据：用户复查：补公司图稿交付、旧后台完整换肤与3D及SSR事实口径；沿既有范围修正本地规格，无新PR

## 差异与复验范围

- M1-T1：architecture、handoff、sections、task
- M1-T2：architecture、handoff、sections
- M1-T3：architecture、definition、handoff、sections、task
- M1-T4：architecture、handoff、sections、task
- M1-T5：architecture、definition、edges、effectivePaths、handoff、sections、task
- M1-T6：architecture、definition、handoff、sections
- M1-T7：architecture、handoff、sections
- M1-T8：architecture、handoff、sections
- M1-T9：architecture、definition、design、edges、effectivePaths、handoff、module、project、sections、skills、task
- M2-T1：architecture、handoff、sections、task
- M2-T2：architecture、handoff、sections
- M2-T3：architecture、handoff、sections
- M2-T4：architecture、handoff、sections
- M2-T5：architecture、handoff、sections
- M2-T6：architecture、handoff、sections
- M2-T7：architecture、edges、handoff、sections、task
- M2-T8：architecture、handoff、sections
- M3-T1：handoff、sections
- M3-T10：handoff、sections
- M3-T11：handoff、sections
- M3-T12：handoff、sections
- M3-T13：handoff、sections
- M3-T14：handoff、sections
- M3-T15：handoff、sections
- M3-T16：handoff、sections
- M3-T17：handoff、sections
- M3-T18：handoff、sections
- M3-T19：handoff、sections
- M3-T2：handoff、sections
- M3-T20：handoff、sections
- M3-T21：architecture、definition、edges、effectivePaths、handoff、module、project、sections、skills、task
- M3-T22：architecture、definition、edges、effectivePaths、handoff、module、project、sections、skills、task
- M3-T23：architecture、definition、edges、effectivePaths、handoff、module、project、sections、skills、task
- M3-T24：architecture、definition、edges、effectivePaths、handoff、module、project、sections、skills、task
- M3-T25：architecture、definition、edges、effectivePaths、handoff、module、project、sections、skills、task
- M3-T3：handoff、sections
- M3-T4：handoff、sections
- M3-T5：handoff、sections
- M3-T6：handoff、sections
- M3-T7：handoff、sections、skills、task
- M3-T8：handoff、sections
- M3-T9：handoff、sections
- M4-T1：handoff、sections
- M4-T10：handoff、sections
- M4-T11：handoff、sections
- M4-T12：handoff、sections
- M4-T13：handoff、sections
- M4-T14：handoff、sections
- M4-T15：handoff、sections
- M4-T2：handoff、sections
- M4-T3：handoff、sections
- M4-T4：handoff、sections
- M4-T5：handoff、sections
- M4-T6：handoff、sections
- M4-T7：handoff、sections
- M4-T8：handoff、sections
- M4-T9：handoff、sections
- M5-T1：handoff、sections
- M5-T10：handoff、sections
- M5-T11：handoff、sections
- M5-T2：handoff、sections
- M5-T3：handoff、sections
- M5-T4：handoff、sections
- M5-T5：handoff、sections
- M5-T6：handoff、sections
- M5-T7：handoff、sections
- M5-T8：handoff、sections
- M5-T9：handoff、sections
- M6-T1：architecture、handoff、sections
- M6-T2：architecture、handoff、sections
- M6-T3：architecture、handoff、sections
- M6-T4：architecture、handoff、sections
- M6-T5：architecture、handoff、sections
- M6-T6：architecture、handoff、sections
- M6-T7：architecture、handoff、sections
- M7-T1：handoff、sections
- M7-T2：handoff、sections
- M7-T3：handoff、sections
- M7-T4：handoff、sections
- M7-T5：handoff、sections
- M7-T6：handoff、sections
- M7-T7：handoff、sections
- M7-T8：handoff、sections
- M7-T9：definition、handoff、sections、task

### 02-设计/06-系统架构与模块划分.md

````diff
--- before/02-设计/06-系统架构与模块划分.md
+++ after/02-设计/06-系统架构与模块划分.md
@@ -8,7 +8,7 @@
 |---|---|---|
 | M1 | 品牌与公共体验：负责现用 PackJoyU 字标、己方可证公司内容、JPG/GIF 发布副本、首页媒体和前台公共页面，并作为全站前后台视觉 token 的唯一归属；不承担后台权限或后台外壳。 | — |
 | M2 | 产品与 3D：负责产品列表、卡片和详情中的产品表达、直接模型操控、输入冲突处理、触屏与键盘查看、图片回退及带产品上下文的询盘入口。 | M1，M4，M5 |
-| M3 | 后台访问与账号：负责统一后台登录页和后台公共外壳、个人设置、设备会话、验证器绑定与登录方式切换、会话撤销及独立受限恢复；消费 M1 的视觉 token。 | M1 |
+| M3 | 后台访问与账号：负责统一后台登录页和后台公共外壳、个人设置、设备会话、验证器绑定与登录方式切换、会话撤销及独立受限恢复，并负责既有后台页面的共享视觉迁移/回归；不改其询盘/邮件/规格/模型业务，消费 M1 的唯一视觉 token。 | M1 |
 | M4 | 第一方人工咨询：负责访客必要会话、人工消息与离线留言、ADMIN/SALES 收件箱和回复、未读、失败草稿与幂等重试，并保存真实收件和通知结果。 | M1，M3，M5 |
 | M5 | 同意与统计账本：负责分析同意、匿名浏览器与事件标识、采集准入和去重、站点统计时区设置、日与产品聚合、原始与聚合保留及可重算边界，产出真实访问和 3D 统计。 | M3 |
 | M6 | 业务与运维看板：负责按角色查询并解释统计结果，读取询盘、聊天、接口错误、邮件、存储和备份的真实来源，区分数据时间、零值、无数据、未接入、失败和旧值。 | M1，M3，M4，M5 |
@@ -80,3 +80,15 @@
 ## 基础能力与界面落地顺序
 
 模块表表示服务及基础能力方向，不把整个模块锁成一个实施批次。任务DAG按实际提供方安排：M3基础认证先支持M6，而M3自定义登录UI等待真实stats目标可见；M3服务不得导入或反调M6服务。界面可见性验收的先后不改变模块服务方向。
+
+## 3D代码与品牌素材的执行责任
+
+| 内容 | 所属任务/执行角色 | 完成证据 |
+|---|---|---|
+| 现有GLB的网页查看器、卡片、鼠标/触屏/键盘、回退与接线 | M2-T1至T8，由实施模型修改现有R3F/Drei/Three代码 | 真实模型/事件/入口与修复前后操控证据；不默认重建几何/材质/贴图 |
+| 自有字标master、JPG换标与视频身份清单 | M1-T3，主实施方组织已授权GPT Dot远程软件制作并核验 | 真实软件记录、可核master/发布副本和哈希；原件不变 |
+| GIF逐帧换标 | M1-T6，GPT Dot软件制作者与主实施方复核 | 全361帧、原时序与遮挡/透视恢复均核；未实际制作不得落地 |
+| PDF所需公司图稿与源工程 | M1-T9，GPT Dot软件制作者 | 网站所需1–2幅独立图、可编辑工程/Web副本/alt及来源 |
+| 网站中的素材消费 | M1-T4/M1-T5，由实施模型接页面 | 实际安全资源、语言、尺寸、来源和可见入口 |
+
+任务分配不是工具已经调用。Dot不可达或产物缺失时保留具体未完成项，不能以计划、截图或状态登记替代素材成品；也不授权新购软件/服务或生产发布。
````

### 02-设计/07-前端架构.md

````diff
--- before/02-设计/07-前端架构.md
+++ after/02-设计/07-前端架构.md
@@ -65,9 +65,9 @@
 
 ## route
 
-Next15 App Router不变，src/lib/navigation/routes.ts集中16个本轮路由的路径/入口，src/i18n/routing.ts仍只发布en/ru；后台layout+page+API各自校验，登录/受限恢复在admin布局外；禁止把品类slug当完整PDP、开放新语言或绕过既有品类上线开关。
-
-**本轮触达路由：16个路由模式。** `[locale]`仅代表en/ru，不把两种语言算两条；查询分区、向导步骤和聊天浮层不是新路由。下方路由清单及入口表各16行，后续19节只对这16个模式声明本轮验收，不把现有27页全部列为重做。现有文章、solutions、factory、cases、共享设计等未改正文路由按`sourceMap.entrypoints.pageRoutes`保留，共用header/footer/token消费不产生新业务任务。`/admin`现有重定向不另加首页业务；新登录流程把空/默认`/admin`回跳归一到全部角色可见的`/admin/stats`，其他回跳仍须站内且属当前角色可见页面，防止EDITOR被固定送入其无权看的询盘页。
+Next15 App Router不变，src/lib/navigation/routes.ts集中23个本轮路由的路径/入口，src/i18n/routing.ts仍只发布en/ru；后台layout+page+API各自校验，登录/受限恢复在admin布局外；禁止把品类slug当完整PDP、开放新语言或绕过既有品类上线开关。
+
+**本轮触达路由：23个路由模式。** `[locale]`仅代表en/ru，不把两种语言算两条；查询分区、向导步骤和聊天浮层不是新路由。下方路由清单及入口表各23行，后续19节只对这23个模式声明本轮验收，不把现有27页全部列为重做。现有文章、solutions、factory、cases、共享设计等未改正文路由按`sourceMap.entrypoints.pageRoutes`保留，共用header/footer/token消费不产生新业务任务。`/admin`现有重定向不另加首页业务；新登录流程把空/默认`/admin`回跳归一到全部角色可见的`/admin/stats`，其他回跳仍须站内且属当前角色可见页面，防止EDITOR被固定送入其无权看的询盘页。
 
 `src/lib/navigation/routes.ts`保存以下route ID、路径构造器、入口ID和展示角色提示；公开href经既有`src/i18n/navigation.ts`，语言发布源仍为`src/i18n/routing.ts`。该表不是权限来源，真实角色判定沿`src/lib/server/admin/layout-gate.ts`与`page-access.ts`，API再次按当前角色校验。新增account/devices/stats开放ADMIN/SALES/EDITOR，chat仅ADMIN/SALES，settings/users仅ADMIN；页面初始SSR按当前session查，角色变化在下一接口/导航重新拒绝。
 
@@ -89,6 +89,13 @@
 | /admin/stats | src/app/admin/stats/page.tsx，新增 | 业务聚合与ADMIN运维分区；ADMIN全部、SALES业务、EDITOR公开流量/3D |
 | /admin/settings | src/app/admin/settings/page.tsx，既有扩展 | 新增section=analytics时区分区，about/org原流程保留；ADMIN |
 | /admin/users | src/app/admin/users/page.tsx，既有接缝 | 目标账号受验证恢复授权，替换旧直接重置旁路；ADMIN且不能自授权 |
+| /admin/inquiries | src/app/admin/inquiries/page.tsx，既有 | 询盘列表/筛选/分页/匿名化标签视觉；ADMIN/SALES，原服务端scope不变 |
+| /admin/inquiries/[id] | src/app/admin/inquiries/[id]/page.tsx，既有 | 详情/状态/分配/笔记/历史/邮件往来视觉；ADMIN或获原scope授权SALES；匿名化限制不变 |
+| /admin/models | src/app/admin/models/page.tsx，既有redirect | 保留重定向/admin/models/new；不新建模型列表，目标页当前角色守卫继续生效 |
+| /admin/models/new | src/app/admin/models/new/page.tsx，既有 | 模型上传/检查/预览/发布确认视觉；ADMIN/EDITOR；原大小与READY限制不变 |
+| /admin/specs | src/app/admin/specs/page.tsx，既有 | SSR categoryMeta品类列表视觉；ADMIN/EDITOR；不开放新类别 |
+| /admin/specs/[category] | src/app/admin/specs/[category]/page.tsx，既有 | 原品类规格表单/错误/保存视觉；ADMIN/EDITOR，未知category仍404 |
+| /admin/mail/unassigned | src/app/admin/mail/unassigned/page.tsx，既有条件关闭 | UNASSIGNED_MAIL_LIVE=false且后端未实现，保持入口隐藏/页面404/零相关请求；仅迁移已有组件样式，不开gate或新建接口 |
 
 ### 逐路由可见入口表
 
@@ -112,6 +119,13 @@
 | /admin/stats | 后台壳“数据看板”（解除原禁用占位） | ADMIN/SALES/EDITOR；运维分区仅ADMIN | GET stats按日期/产品/授权sources；ADMIN点“运维”仍查同一接口受限sources，逐源显示状态与数据时间；手动刷新不调用cron |
 | /admin/settings | 后台壳“站点设置”→分区“统计时区” | ADMIN | GET settings/analytics；显示当前version/timezone/recomputableFrom；提交PATCH带expectedVersion，冲突读取最新不自动覆盖 |
 | /admin/users | 后台壳“账号权限”→目标账号行“授权恢复” | ADMIN，目标不是自己；目标行当前可管理 | 当前密码+新TOTP获得RECOVERY_AUTHORIZE grant，POST recovery-authorizations一次展示permit；不直接重置对方因素或替其登录 |
+| /admin/inquiries | 已登录后台壳“询盘” | ADMIN/SALES | GET /api/admin/inquiries，用户筛选取GET /api/admin/users；保留q/date/status/assignee/page及原scope |
+| /admin/inquiries/[id] | 原询盘列表中的实际编号链接/可键盘行 | ADMIN及原scope可见SALES；真实持久id | GET /api/admin/inquiries/[id]及history；状态/负责人PATCH同id，笔记POST notes；mail/config允许时沿既有GET/POST mail与status/retry |
+| /admin/models | 上传页“3D 模型”面包屑 | 可访问上传页的ADMIN/EDITOR | 点击后仍重定向/admin/models/new；无新模型列表请求 |
+| /admin/models/new | 后台壳“3D 模型”；或上述重定向目标 | ADMIN/EDITOR | 原POST /api/admin/models上传、GET/PATCH /api/admin/models/[id]，POST process/publish；本轮不引入新后台接口 |
+| /admin/specs | 后台壳“产品规格” | ADMIN/EDITOR | SSR读取categoryMeta构成真实品类列表，无需虚构列表API |
+| /admin/specs/[category] | 规格列表真实品类链接；编辑页“全部品类”返回 | ADMIN/EDITOR且categoryMeta存在 | GET/PUT /api/admin/specs/[category]；原字段校验和保存反馈不变 |
+| /admin/mail/unassigned | 当前无可见入口，必须保持隐藏；从原后台导航验证不存在 | UNASSIGNED_MAIL_LIVE=false；ADMIN登录也不开放 | 真实直接请求仍404；无unassigned/count、列表、assign/ignore或附件请求；不把客户端预留URL当已实现HTTP能力 |
 
 ### 加载、守卫和路由边界
 
@@ -208,3 +222,13 @@
 ## 自定义登录与客户端的实施顺序
 
 M3-T7先沿既有Auth.js登录页，以真实密码和TOTP进入当前角色既有后台页，交付壳及account客户端GET/activity方法；不在此注册新signIn页。M6-T4在该壳接好stats页面后，M3-T6才注册/admin-login和pages.signIn，完整验证默认/admin/stats目标、GET stats与可见结果。不存在把404或URL变化当登录成功的阶段。M5-T10只在ops.ts补settings/analytics方法，M6-T4追加stats方法；客户端按统一M1-T8基础发送，展示件不直接fetch。
+
+## 目录读取与模型发起的实际来源
+
+当前products/page.tsx在服务端调用loadCatalog(listPublishedModels)，与/api/models共享同一查询而非浏览器调用该JSON API。保留现有SSR/60秒重生成，既有API可独立HTTP核兼容；不得为了任务里的数据源文字再加客户端重复请求。GLB/海报网络请求沿实际资源URL。可视区自动加载和主动操作触发真实GLB均属于viewId/start；只到达路由但没有模型加载尝试不产生start，不能因此加额外Activate步骤。
+
+## 既有后台视觉覆盖
+
+M3-T21至T25覆盖旧询盘/邮件往来、未归类门禁、模型上传入口、规格及完整settings/users控件；仅更新视觉和回归，不改变原权限、API或业务。/admin/models仍redirect到new，UNASSIGNED_MAIL_LIVE=false仍隐藏/404且零相关请求，关闭页面不伪造密度通过。完整逐页清单见上表与19。settings/analytics客户端只由M5-T10追加，旧业务方法沿原模块，不另造接口。
+
+“逐页”指本卡实际产出的页面或区域；增量任务仅验新增控件、布局和与现有页面的接缝，未迁移的旧内层不得称视觉通过。M3-T7验壳导航、外框、活动和退出；M3-T9验恢复授权区域；M5-T10验analytics分区。既有业务完整页由M3-T21至T25逐页验收，最终M7-T9汇总，完整GUI、D1–D6与overflow标准不减。
````

### 02-设计/10-接口约定.md

````diff
--- before/02-设计/10-接口约定.md
+++ after/02-设计/10-接口约定.md
@@ -159,7 +159,7 @@
 
 以下是第07/11节使用的既有数据源，不改请求、成功体、错误协议或缓存策略，不计入上表本轮修改端点。
 
-- `GET /api/models`：`src/app/api/models/route.ts`调用`listPublishedModels`返回`{items}`，仅已上架且检查通过模型，`public,max-age=60,s-maxage=60`。模型字段沿`src/lib/server/published-models.ts`实际导出类型，前端不得造一个新的商品接口。
+- `GET /api/models`：`src/app/api/models/route.ts`调用`listPublishedModels`返回`{items}`，仅已上架且检查通过模型，`public,max-age=60,s-maxage=60`。模型字段沿`src/lib/server/published-models.ts`实际导出类型，前端不得造一个新的商品接口。产品页实际SSR调用loadCatalog(listPublishedModels)，不要求浏览器再次GET此端点；独立兼容HTTP校验不等于页面取数请求。
 - `GET /api/models/[id]/[variant]`：沿既有授权发布状态、variant白名单和内容哈希检查，返回模型或海报文件；静态`/models/`现有资源链仍保留，实际GLB加载完成才发成功终态。
 - `POST /api/inquiries`：沿`src/app/api/inquiries/route.ts`的严格schema、Turnstile/防滥用/上传归属及真实事务；合法新提交返回201 `{ref}`。`source`沿FORM/WIZARD/CART/CUSTOMIZER/SAMPLE，`locale`沿已发布语言；contact、items、message、logoUploadId等字段不借本轮改形状。点击提交的证据必须包含该真实请求、持久业务编号及重载后的记录，不能把已收到邮件当成保存成功。
 - 首页/about/contact/privacy的SSR内容沿现有Sanity/站点设置读取及完整度/发布开关；SSR不是新增JSON接口。页面入口、数据读取和404分支由页面集成任务验收。
````

### 02-设计/11-UI.md

````diff
--- before/02-设计/11-UI.md
+++ after/02-设计/11-UI.md
@@ -2,7 +2,7 @@
 
 前台采用 `brand` 寄存器，以品牌、产品影像与询盘为中心；后台采用 `product / back-office` 寄存器，以账号、咨询对象和真实统计为中心，共用 `minimalist-flat` 的唯一视觉 token，后台按本节密度组织列表、表格与表单。
 
-本节规定目标取值和验收要求，未实现产品页面或修改样式。页面范围与第07节的16个路由模式一致，`[locale]`仅为已发布的en/ru；聊天浮层、看板分区和恢复步骤不另增路由。现有条件上线、权限、noindex与内容完整度规则继续有效。
+本节规定目标取值和验收要求，未实现产品页面或修改样式。页面范围与第07节的23个路由模式一致，`[locale]`仅为已发布的en/ru；聊天浮层、看板分区和恢复步骤不另增路由。现有条件上线、权限、noindex与内容完整度规则继续有效。
 
 ## 页面清单
 
@@ -24,6 +24,13 @@
 | /admin/stats | 查看真实业务和运维结果 | 后台壳；日期/产品筛选；站点时区/数据水位；业务指标；趋势/来源表；ADMIN运维分区 | StatsContainer、SourceCard、SVG趋势与同DTO数据表、来源状态、重试 | 第10节GET /api/admin/stats的StatsDTO；逐角色/来源裁剪；刷新只读GET，不调用cron | 工作面 |
 | /admin/settings | 配置统计时区并保留现有设置 | 后台壳；既有about/org分区；analytics分区表单；可重算范围/当前版本旁栏 | 原设置页、AnalyticsSettingsContainer、Timezone字段、版本冲突提示 | 第10节GET/PATCH /api/admin/settings/analytics；既有about/org接口；仅ADMIN | 操作面 |
 | /admin/users | 从实际目标账号授权恢复 | 后台壳；既有账号表；目标账号动作；本人验证；一次性permit | 既有用户表、授权恢复按钮、ReauthDialog、permit结果区 | 既有用户管理；第10节reauth及recovery-authorizations；ADMIN且目标不是本人；旧无验证reset旁路停用 | 工作面（含授权操作区） |
+| /admin/inquiries | 扫描和筛选原询盘 | 后台壳；状态/搜索/日期/产品/负责人；真实列表；分页；匿名化标签 | InquiryList、DateRange、StatusBadge、DeletedTag、AdminTime | 既有GET inquiries/users，原scope及筛选协议 | 工作面 |
+| /admin/inquiries/[id] | 阅读与处理原询盘 | 标题/返回；状态/负责人；正文/产品；笔记/历史；原邮件区；匿名化提示 | InquiryDetail、InquiryHistory、anonymized、MailThread、MailParts | 既有详情/history/notes/reply/PATCH；邮件由config及原gate限制 | 工作面（含原处理操作区） |
+| /admin/models | 保持原上传入口重定向 | 无独立页面区域 | Next redirect | 既有redirect('/admin/models/new')；不增加列表API | 重定向（无独立密度测量） |
+| /admin/models/new | 维持模型上传到发布流程 | 步骤；文件/大小反馈；检查结果；GLB预览；确认；取消 | ModelUpload、ModelPreview、models.css | 既有upload/get/update/process/publish HTTP及实际GLB | 操作面（左对齐，可用预览旁栏） |
+| /admin/specs | 选择已有品类编辑 | 后台壳；品类真实列表；品类链接 | 原SSR列表、spec-list | categoryMeta；无需增加API | 工作面 |
+| /admin/specs/[category] | 编辑已有品类规格 | 标题/返回；材料/尺寸/MOQ/交期/费用/认证；错误；保存 | SpecEditor、specs.css | 既有GET/PUT specs/[category]、原校验 | 操作面 |
+| /admin/mail/unassigned | 保持现有关闭能力和预留组件视觉一致 | 当前不渲染业务区；组件内原分类/列表/详情/归类/忽略状态只作组件层检查 | UnassignedInbox、UnassignedNav、mail.css共享值 | 当前无可调用后端，入口隐藏/路由404/零请求；不得开gate | 条件关闭；工作面仅为组件结构，真实密度记gate-off/not-rendered |
 
 每个参数路由从第07节对应的实际品类链接或会话行进入。页头/页脚和后台壳沿真实角色显示入口；目录行、卡片名称、模型操作区和询盘按钮各有独立语义，不能把整卡做成与拖动重叠的链接。
 
@@ -280,3 +287,9 @@
 - publicBrand：桌面≥1024 gutter24/gap48/pad24，窄屏16/32/16；产品grid auto-fit minmax(min(100%,560px),1fr)，gap16，PC模型高clamp(360px,28vw,440px)，窄屏4:3且≥240px。
 - adminProduct：DENSITY7项目适配：所有屏幕gutter16/gap16/pad16；row40/control36，触屏44。work无max-width铺满；form左对齐minmax(0,800px)+320px旁栏，宽度不足折叠；card≤520px，rail224px。局部空/错/加载左上pad16，无撑高。
 - acceptance：所有后台UI任务显式测D1–D6及overflow：1920×1080、1440×900、390×844；work fill≥.85，form fill≥.55且左边距≤gutter+24；gap≤24/pad≤20，无空网格轨道/横向大空白>15%/body横溢出。详11；主register=brand不能豁免后台。
+
+## 既有后台与资料图稿补充
+
+原settings页的about/org/图片与analytics分区、原users账号表/创建/角色/停用及恢复授权全部消费同一风格，分别由M3-T25及已有提供方验收。新增7个既有路由模式只补视觉覆盖，包含redirect和gate-off，不增业务。公司区块图稿由M1-T9用授权软件独立重绘，M1-T5在首页公司摘要/about消费安全发布映射；私有源工程不进public或镜像。
+
+同行实际结构观察与采用映射见_run/benchmark-euproprt-20261019.md；只借信息层级和联系路径，不复制其品牌事实、素材或新增未经授权内容。
````

### 03-质量/13-边界问题与异常处理.md

````diff
--- before/03-质量/13-边界问题与异常处理.md
+++ after/03-质量/13-边界问题与异常处理.md
@@ -1,6 +1,6 @@
 # 边界问题与异常处理
 
-105条边界按台账原编号、模块和触发条件列出。各模块实现本域行为；M7验证跨域链路。第17节定义分层证据，第19节逐条绑定任务。期限和错误取值以09/10节为准，生产数据删除仍须另有明确授权。
+111条边界按台账原编号、模块和触发条件列出。各模块实现本域行为；M7验证跨域链路。第17节定义分层证据，第19节逐条绑定任务。期限和错误取值以09/10节为准，生产数据删除仍须另有明确授权。
 
 | 编号 | 场景 | 触发条件 | 期望行为 | 模块 |
 |---|---|---|---|---|
@@ -49,7 +49,7 @@
 | E-43 | C-05 分析采集、去重与保留期 | 用户撤回分析同意 | 停止采集，丢弃尚未发送的分析事件并清除本地分析标识；不能事后补发撤回期间的访问。 | M5 |
 | E-44 | C-05 分析采集、去重与保留期 | 同一授权浏览器刷新或重试同一事件 | 当日授权访客按浏览器标识去重，同一事件 ID 不重复计数；真实的新页面访问可增加 PV，UV 不随刷新增加。 | M5 |
 | E-45 | C-05 分析采集、去重与保留期 | 同一人换设备、清除标识或使用不同浏览器 | 在访客数的定义/提示处写明“已同意分析的匿名浏览器数”；分别用换设备、清标识、换浏览器验证可能形成新 browserHash，不出现“唯一真人”或跨设备识别宣称。 | M5 |
-| E-46 | C-05 分析采集、去重与保留期 | 进入产品页但未打开 3D，或打开后加载失败 | 产品页访问、3D 查看发起、加载成功及失败分别记录，绑定服务端认可的产品标识，失败不算加载成功。 | M5 |
+| E-46 | C-05 分析采集、去重与保留期 | 仅进入产品路由、可视区或主动操作实际发起GLB加载，或加载失败 | 产品页访问与真实模型加载发起分别记录：仅路由访问但尚无加载尝试不发start，可视区自动加载或主动操作确实发起GLB就按viewId发start，不要求额外激活点击；成功/失败按实际终态并绑定服务端认可产品标识，失败和poster/FoldBox不算GLB成功。 | M5 |
 | E-47 | C-05 分析采集、去重与保留期 | 客户端伪造产品、超长字段、任意事件类型或重放事件 | 服务端按白名单、字段长度与产品有效性校验并限制滥发，拒绝异常记录；分析记录不存原始 IP、跨站指纹、邮箱、聊天正文或含敏感查询参数的完整 URL。 | M5 |
 | E-48 | C-05 分析采集、去重与保留期 | 原始事件超过 30 天或聚合超过 13 个月 | 沿09节把保留边界写成 receivedAt+30天及无身份聚合 expiresAt 的13个自然月，并显示查询覆盖范围；清理只在另有明确生产保留授权且显式启用时执行，默认 dry-run/关闭真实清理，无授权请求拒绝实际删除；隔离测试验证过期目标集合、计数、去标识及不重建已过期明细，不扩大备份或已有数据删除权限。 | M5 |
 | E-49 | C-06 看板数据时间与异常状态 | 数据源已接通、查询成功且所选日确有 0 条符合口径的事件 | 展示数值 0、查询成功时间及授权统计范围，不伪报查询失败或尚未接入。 | M6 |
@@ -109,3 +109,9 @@
 | E-103 | 真实模型失败与统计 | GLB下载失败、WebGL不支持、context lost或只能展示海报/FoldBox演示 | 分别注入GLB下载失败、不支持WebGL、context lost、仅poster/FoldBox，检查对应产品静态回退、重试和询盘；同viewId最多一个终态，poster/程序演示均不发GLB success。真实模型重试若新建尝试按既定viewId规则处理。 | M2 |
 | E-104 | 产品复位与显示 | 任意旋转/缩放后点复位，或PC 1440/1920和窄屏查看 | 以产品已有初始相机/缩放边界作基准，任意操控后复位需回到该值；在1440/1920及窄屏检查完整模型可见、名称及关键操作可辨；移除底部重复介绍后规格与询盘入口仍可见可用，不靠删内容消除裁切。 | M2 |
 | E-105 | 恢复候选代码的来源与发布边界 | 复用候选缺准确来源、当前安全批准或与记录的HEAD不一致 | 逐项核真实head/base/check及必需批准；缺任一证据时不标为可合并或已上线，不自动合并部署；受保护备份和秘密不混入发布副本，保留可追溯来源和未满足项。 | M7 |
+| E-106 | 既有询盘与邮件往来视觉统一 | 运营进入原询盘列表/详情或其匿名化、加载、错误、邮件状态区域 | 同一minimalist-flat取值覆盖公共CSS与内联旧值，真实scope/API/匿名化限制不变；三尺寸computed style及密度/GIF对应真实列表→详情→原动作；已匿名化敏感内容仍不可见。 | M3 |
+| E-107 | 条件关闭后台邮件的视觉迁移 | 未归类邮件后端不存在且UNASSIGNED_MAIL_LIVE=false时进行后台样式升级 | 保持入口不渲染、真实路由404且相关请求为0；只迁移既存组件样式并标明组件层证据，未渲染组件的密度/GUI实测为gate-off/not-rendered，不开gate或新增接口换取通过。 | M3 |
+| E-108 | 既有模型管理视觉升级 | 用户从后台模型入口或/admin/models面包屑进入既有上传流程并处理实际GLB | 保留/models到/new的重定向和原上传/检查/READY/发布确认限制，不新增列表业务；模型上传、预览及状态控件消费唯一风格，三尺寸实际HTTP/GLB/GIF与密度证明操作未丢失。 | M3 |
+| E-109 | 既有规格列表和编辑器视觉统一 | ADMIN或EDITOR通过规格列表选择既存品类并编辑、验证和保存规格 | SSR品类列表和GET/PUT原协议、角色限制不变；必要字段/双语标签/校验错误和保存控件全部可见且可键盘操作，三尺寸D1–D6/overflow/真实GIF及保存后GET证明风格升级没有删功能。 | M3 |
+| E-110 | 旧设置与账号管理完整视觉升级 | ADMIN在原about/org/图片设置或完整账号表执行编辑、保存、冲突刷新和已有安全授权 | 原字段/图片/版本冲突及用户管理限制与已完成恢复授权/统计分区不变，所有控件统一到minimalist-flat；三尺寸真实点击→原HTTP→持久结果、computed style与D1–D6/overflow/GIF齐，不用只改外壳作为全后台完成。 | M3 |
+| E-111 | 公司图稿、可编辑源工程及品牌来源可追溯 | 网站公司区块的图稿只有文本/截图、缺可编辑工程/发布文件、旧品牌或来源哈希不符，或未被实际网页消费 | 逐件交付选定1–2幅独立重绘图稿的可编辑软件源工程、Web发布图与en/ru alt；登记参考PDF页码/主题、己方事实依据、当前PackJoyU标识哈希、源工程/导出哈希、软件版本、实际Dot操作记录及网页引用位置。真实页面加载匹配图稿并保持主体完整；缺任一必需产物或工具未执行时该项保持未完成，不以文字计划冒充完成；不扩大为25页整本目录或无依据的厂房/证照绘制。 | M1 |
````

### 03-质量/17-测试策略.md

````diff
--- before/03-质量/17-测试策略.md
+++ after/03-质量/17-测试策略.md
@@ -4,7 +4,7 @@
 
 ## 覆盖优先级
 
-13节105条边界均须在19节落实任务与验收证据。校准选择最高影响档且发生频率非rare的53条优先执行；这是排序输入，不删除低频安全负例或3D体验用例：
+13节111条边界均须在19节落实任务与验收证据。校准选择最高影响档且发生频率非rare的53条优先执行；这是排序输入，不删除低频安全负例或3D体验用例：
 
 E-02、E-03、E-04、E-05、E-08、E-10、E-11、E-14、E-15、E-16、E-17、E-20、E-29、E-34、E-37、E-38、E-40、E-42、E-43、E-44、E-45、E-46、E-48、E-56、E-57、E-58、E-61、E-62、E-63、E-64、E-68、E-69、E-70、E-71、E-72、E-74、E-75、E-77、E-78、E-79、E-80、E-81、E-82、E-83、E-85、E-86、E-87、E-88、E-89、E-91、E-93、E-95、E-96。
 
@@ -82,3 +82,7 @@
 ## 恢复来源补充边界
 
 E-105按最高影响且非rare优先：复用前只读核候选PR当前head/base/check和必需批准，与本机来源记录逐项匹配；缺批准或HEAD变化应保持未满足，不能把草稿已推送等同于可合并。扫描发布清单确保受保护恢复备份和秘密未混入。此处不授权合并或部署。
+
+## 用户复查补充覆盖
+
+E-106至E-110逐项覆盖旧后台实际页面/匿名化/邮件gate/模型redirect/规格及settings-users行为；E-109/E-110的权限/保存拒绝优先执行。每项只迁移视觉，原方法/响应/字段与真实持久结果保留；关闭gate用隐藏/404/零请求证明，不伪造渲染或密度全通过。E-111素材制作只核源工程/发布资源，完整网页消费在M1-T5验证。E-46的start按实际GLB发起，不以点击或路由到达替代；SSR目录不要求附加客户端fetch。
````

### 04-执行/19-模块任务拆分.md

````diff
--- before/04-执行/19-模块任务拆分.md
+++ after/04-执行/19-模块任务拆分.md
@@ -1,6 +1,6 @@
 # 模块任务拆分
 
-78项任务均以0.5–2人日作为估算目标，尚未实施；估算不等于性能、工期或产品通过证据。模块表描述基础能力方向，具体界面目标的可见性顺序以任务DAG为准；模块服务不得反向导入，任务依赖按实际提供方排序。
+84项任务均以0.5–2人日作为估算目标，尚未实施；估算不等于性能、工期或产品通过证据。模块表描述基础能力方向，具体界面目标的可见性顺序以任务DAG为准；模块服务不得反向导入，任务依赖按实际提供方排序。
 
 M1-T1是唯一起点：从当前主干新建任务工作树后，先从本机task/docs-s2-s6分支导入本目录及根AGENTS/CLAUDE，随首个实施PR提交；后续从其落地主干取得文档。换机器先传送这份本地规格基线，不假定origin/main已有。
 
@@ -8,21 +8,22 @@
 
 | ID | 标题 | 模块 | 依赖 | 输入 | 产出 | 验收标准 | 预估 |
 |---|---|---|---|---|---|---|---|
-| M1-T1 | 接入8个核心品牌变量及既有路径真实冒烟 | M1 | 无 | 现有首页、GET /api/models、WebVitals/RUM；11节核心变量；本地已审规格分支 | visual-base的8个核心变量；runnable-smoke；含已审文档基线的实施PR与CI冒烟 | 1) 仅将背景、前景、强调色、边界宽度、圆角、基础字号、正文行高、焦点颜色8个核心token接入现有首页，不建立新页面或新业务控件；构建/启动真实standalone，从header产品链接进入产品页，computed style逐一等于11节取值，GET /api/models返回已发布来源。2) 真实首页WebVitals触发POST /api/rum并核204和脱敏日志，CI起同一服务运行此浏览器冒烟。3) 本地已审文档随本PR进入主干；后续任务从该落地基线建分支。 | 2d |
+| M1-T1 | 接入8个核心品牌变量及既有路径真实冒烟 | M1 | 无 | 现有首页、GET /api/models、WebVitals/RUM；11节核心变量；本地已审规格分支 | visual-base的8个核心变量；runnable-smoke；含已审文档基线的实施PR与CI冒烟 | 1) 仅将背景、前景、强调色、边界宽度、圆角、基础字号、正文行高、焦点颜色8个核心token接入现有首页，不建立新页面或新业务控件；构建/启动真实standalone，从header产品链接进入产品页，computed style逐一等于11节取值；目录沿SSR loadCatalog(listPublishedModels)，冒烟另作真实HTTP GET /api/models兼容校验，不给产品页增加重复fetch。2) 真实首页WebVitals触发POST /api/rum并核204和脱敏日志，CI起同一服务运行此浏览器冒烟。3) 本地已审文档随本PR进入主干；后续任务从该落地基线建分支。 | 2d |
 | M1-T2 | 导出新增领域共享schema与DTO | M1 | M1-T1 | 06/09/10节字段契约、Auth.js既有错误协议及visual-base基线 | contract-types；account/recovery/chat/analytics/ops/errors schema与公共index导出 | 1) 逐字段对照10节建立严格Zod请求/响应schema，类型仅由schema导出，公共index能被独立TypeScript消费，未知字段和超界字段拒绝。2) LoginMode只接password/totp；rememberDevice缺值、布尔false、字面false均解析false，其他非法值拒绝（E-95）。 | 1.5d |
-| M1-T3 | 制作JPG换标及视频海报发布副本 | M1 | M1-T1 | 桌面原JPG/视频、现用PackJoyU字标、来源与原件哈希登记 | brand-static-media；换标JPG、视频语义海报及压缩视频副本、哈希/对照清单 | 1) 原JPG/视频哈希不变，输出文件均可解码；将JPG飞艇与工厂墙面的旧标逐处列入清单并以现用PackJoyU字标完整替换，清单逐处核无旧标，视频海报取自其自身画面且带可核帧时刻。2) 即使候选设计与线上字标不同仍使用当前PackJoyU字标，记录所用标识文件哈希；不等待用户回看候选图，不把候选当已批准新logo（E-28）。3) GPT Dot可达且实际制作时保留调用、软件操作、输出文件和成品核对记录；不可达则逐项写尚未执行/实施任务且该项不称完成，不伪称调用成功（E-29）。 | 1.5d |
-| M1-T4 | 接好首页视频与分区JPG/GIF场景 | M1 | M1-T6、M1-T7、M1-T8 | brand-media、visual-components、client-api-foundation与现有首页SSR布局 | home-media；现有主页/公共壳中的视频与分区品牌场景 | 1) 点击字标home-link→/[locale]、products-link→产品、contact-link→联系，并核SSR来源与GET /api/models；12.27秒视频muted/playsinline且播放/暂停可点击，阻止autoplay后保留海报及播放入口，解码失败/减少动态效果显示语义JPG而不强制持续播放（E-21、E-22）。2) 城市JPG/GIF位于产品区后；网络断言接近视区300px前没有GIF下载，进入后才加载；点击暂停、离开视区、后台页均切同尺寸静帧，恢复可见不覆盖用户暂停（E-23、E-24）。3) 1440/1920/390逐项测媒体宽高比与源一致，媒体DOM矩形不与导航/正文/3D操作区的可点击矩形相交，渲染媒体的完整源图像四角及主体均在容器内；不得删主体或控件通过，保留按钮动作真实GIF（E-25）。 | 1.5d |
-| M1-T5 | 发布可核实己方公司内容与对应入口 | M1 | M1-T4 | 己方可核实材料、PDF结构参考、现有SiteSetting/Sanity及发布开关 | company-content；about内容/事实对照表与联系隐私入口兼容 | 1) 为每个对外公司硬事实建立“页面字段→己方证据文件/页码”对照；无己方证据的YUHAO认证/产能/工厂规模不得出现在成品文案或图片；PDF仅作结构/产品主题参考，自动检索加逐字段对照均无改名冒用（E-27）。2) 成品引用的logo哈希等于现用PackJoyU字标，不使用候选新标；不等待用户回看候选图，PDF指令不作执行授权（E-28）。3) 真浏览器点about-link→/[locale]/about、footer联系/隐私→对应路由，en/ru切换保持对应页；发布开关关闭时仍404，开时SSR SiteSetting/Sanity显示与事实对照表一致，改动页全部有导航证据。 | 1.5d |
+| M1-T3 | 制作JPG换标及视频海报发布副本 | M1 | M1-T1 | 桌面原JPG/视频、现用PackJoyU字标、来源与原件哈希登记 | brand-static-media；换标JPG、视频语义海报及压缩视频副本、哈希/对照清单 brand-logo-master；从当前SiteHeader字标/icon.svg导出的现用品牌基准文件public/brand/packjoyu-logo-master.svg及来源/导出哈希。 | 1) 原JPG/视频哈希不变，输出文件均可解码；将JPG飞艇与工厂墙面的旧标逐处列入清单并以现用PackJoyU字标完整替换，清单逐处核无旧标，视频海报取自其自身画面且带可核帧时刻；对全片所有公司名称、logo、片头/片尾及水印列时间点清单，片头/片尾/水印等企业署名与己方身份不符或依据缺失时该发布副本不入成品并报告；真实场景中的设备商标只记录，不自动当企业署名或擅自抹除，不修改原视频、不擅自重剪。2) 即使候选设计与线上字标不同仍使用当前PackJoyU字标，记录所用标识文件哈希；不等待用户回看候选图，不把候选当已批准新logo（E-28）。3) GPT Dot可达且实际制作时保留调用、软件操作、输出文件和成品核对记录；不可达则逐项写尚未执行/实施任务且该项不称完成，不伪称调用成功（E-29）。 4) 先核项目当前SiteHeader字标、样式/字体和icon.svg来源，导出可供软件导入的现用完整字标master，记录源文件与导出文件SHA256，逐项核字形、比例、颜色与当前标识一致；不重新设计候选标、不修改源字标或图标。SVG不得含script、外部引用或私有元数据；后继T6/T9只引用此已核master。 5) docs/brand-media/static/brand-static-media.json逐文件登记path/sha256/width/height并与实际解码/哈希逐值核对；logoMaster登记sourceFiles的path/sha256、导出path/sha256/viewBox及所用字体/样式来源，重新读取均与清单相等。docs/brand-media/static/video-identity.json对企业署名/片头尾/水印每项列fromMs/toMs、画面精确文字或标识、抽帧sha256及OWN_VERIFIED/THIRD_PARTY/UNKNOWN与依据路径，时间须在0至原片时长内；抽帧和依据可打开。第三方企业署名或UNKNOWN时releaseAllowed=false且T4不能称发布通过；普通设备商标单独标role=equipment，不据此换企业身份。缺任何发布副本或真实制作记录时T3仍未完成，不以清单或未执行说明替代成品。 | 1.5d |
+| M1-T4 | 接好首页视频与分区JPG/GIF场景 | M1 | M1-T6、M1-T7、M1-T8 | brand-media、visual-components、client-api-foundation与现有首页SSR布局 | home-media；现有主页/公共壳中的视频与分区品牌场景 | 1) 点击字标home-link→/[locale]、products-link→产品、contact-link→联系，并核实际SSR内容来源；目录沿loadCatalog(listPublishedModels)，不要求浏览器GET /api/models；12.27秒视频muted/playsinline且播放/暂停可点击，阻止autoplay后保留海报及播放入口，解码失败/减少动态效果显示语义JPG而不强制持续播放（E-21、E-22）。2) 城市JPG/GIF位于产品区后；网络断言接近视区300px前没有GIF下载，进入后才加载；点击暂停、离开视区、后台页均切同尺寸静帧，恢复可见不覆盖用户暂停（E-23、E-24）。3) 1440/1920/390逐项测媒体宽高比与源一致，媒体DOM矩形不与导航/正文/3D操作区的可点击矩形相交，渲染媒体的完整源图像四角及主体均在容器内；不得删主体或控件通过，保留按钮动作真实GIF（E-25）。 | 1.5d |
+| M1-T5 | 集成己方公司内容与独立图稿 | M1 | M1-T4、M1-T9 | 己方可核实材料、PDF结构参考、现有SiteSetting/Sanity及发布开关、M1-T9 company-visual-assets与素材manifest | company-content；about与首页公司摘要、事实对照、安全发布映射和真实页面图稿消费；原联系隐私入口兼容 | 1) 为每个对外公司硬事实建立“页面字段→己方证据文件/页码”对照；无己方证据的YUHAO认证/产能/工厂规模不得出现在成品文案或图片；PDF仅作结构/产品主题参考，自动检索加逐字段对照均无改名冒用（E-27）。2) 成品引用的logo哈希等于现用PackJoyU字标，不使用候选新标；不等待用户回看候选图，PDF指令不作执行授权（E-28）。3) 真浏览器点about-link→/[locale]/about、footer联系/隐私→对应路由，en/ru切换保持对应页；发布开关关闭时仍404，开时SSR SiteSetting/Sanity显示与事实对照表一致，改动页全部有导航证据。 4) 消费M1-T9的company-visual-assets，为已选图稿建立src/lib/brand/company-media.ts安全发布映射，仅输出/brand/company/下已核哈希的Web路径、正整数宽高及en/ru alt；拒绝外部URL、越界路径、源工程路径和文件系统地址，不把工程、私有路径或制作凭据下发浏览器。逐件核manifest中的成品与现用字标哈希、制作证据和完成状态；素材未完成时本集成项不能通过（E-29、E-111）。5) en/ru真实首页公司摘要及about消费相同已审映射，真实浏览器从可见入口进入，网络加载Web图路径/文件哈希与清单一致；alt按语言匹配，1920/1440/390尺寸下主体完整、无横向溢出。保存参考主题/己方事实→源工程/成品→映射→路由/组件的追溯证据；仅有资料目录文件不算页面完成，源工程不进public或生产镜像（E-111）。 6) 安全映射只提取已核Web路径、尺寸、alt；不在生产运行时import原docs manifest或工程/制作记录，不把含私有源路径的原JSON打包；浏览器产物和运行镜像检查均无源工程及私有路径。 | 2d |
 | M1-T6 | 逐帧替换GIF品牌并校验发布媒体集合 | M1 | M1-T3 | 原361帧GIF、brand-static-media、现用字标与原始时间轴 | brand-media；换标GIF、等尺寸暂停帧、逐帧品牌/时序报告与可发布集合 | 1) 保留原JPG/GIF哈希，逐帧列出361帧中旧品牌出现、透视变化、转场及遮挡恢复位置，全部以PackJoyU完整覆盖；同时复核T3的JPG旧标位置，首尾帧与全部列出位置无旧标或漏标（E-26）。2) 用原时间轴对照每帧呈现时刻/顺序和30.08秒循环总长，全部相同；叠加对照无替换新增错位或抖动；任一失败则该副本标未完成且排除发布，原件保留回退（E-30）。3) 输出可解码GIF、同尺寸暂停静帧与哈希；GPT Dot制作证据或逐项尚未执行状态按T3的真实工具可达结果登记，不虚报完成。 | 2d |
 | M1-T7 | 补齐共享视觉变量与原生UI包装 | M1 | M1-T1 | visual-base的8个核心变量、第11节完整组件/状态规格 | visual-components；完整唯一token源与Button/Input/Dialog/Status原生包装 | 1) 只扩展同一tokens.css，不建立第二套颜色/字体/间距变量；Button/Input/Dialog/Status逐项使用11节高度、2px边界、0圆角、disabled/busy/error/focus值，类名/变量引用与原生语义断言对应每种状态，实际computed style由M1-T4集成验证。2) 包装组件不含fetch、Prisma、身份、cookie或业务角色判断；键盘焦点与对话框焦点恢复有自动化测试，前后台均导入同一出口。 | 1.5d |
 | M1-T8 | 接通统一fetch取消与错误适配 | M1 | M1-T2 | contract-types、10节逐方法重试规则与既有Auth.js/旧error协议 | client-api-foundation；15s取消、DTO解析、旧错误兼容；服务端HTTP映射由M3-T14唯一实现 | 1) 使用真实本地HTTP测试延迟、400/401/403/409/429/503及旧{error}响应，15s取消和卸载取消均终止在途请求，fieldErrors只保留受控字段，未知异常不回显stack/message。2) 普通GET及聊天/分析的同key重试按10节执行；一次性reauth/recovery/cron的响应未知不自动重放；业务组件只能从统一出口取得请求/错误适配，Auth.js原信封不改。 | 1.5d |
-| M2-T1 | 扩展产品卡视口与精简信息区 | M2 | M1-T4 | 现有ProductGallery/Scene、GET /api/models及11布局 | 560px自适应大卡和独立模型/动作区域 | 1) 入口：首页products-link→/[locale]/products，数据源GET /api/models及实际模型URL；PC卡最小560px、视口clamp(360px,28vw,440px)，390宽不溢出；名称/必要规格/询盘控件可辨，删重复介绍后操作仍在。2) 标题与按钮独立链接，Canvas内拖动不导航、不提交；从列表category-link进入现有/[locale]/products/[slug]仍受发布开关且返回3D目录，不扩完整PDP。 | 1.5d |
+| M1-T9 | 制作公司区块独立图稿与可编辑源工程 | M1 | M1-T1、M1-T3 | 参考PDF组织/产品主题、己方可证事实、现用PackJoyU字标与用户已授权GPT Dot远程软件制作 M1-T3已交付并核哈希的brand-logo-master；不得另画一套字标。 | company-visual-assets；网站公司区块选定1–2幅独立重绘图稿、可编辑软件源工程、Web图/enru alt与尺寸、哈希及真实制作清单 | 1) 实际交付1–2幅网站公司区块独立重绘图稿，每幅均有“参考PDF页码/主题→己方可证事实或不含企业硬事实的产品示意”对照。只借鉴组织和产品主题，原PDF/JPG/GIF/视频与现用logo原文件SHA-256保持不变；YUHAO认证/产能/规模及无己方依据的真实厂房、设备、证照不出现在图中，不要求重画25页整本（E-27、E-111）。2) 每幅必须同时存在docs/brand-content/source/内的可编辑软件源工程及public/brand/company/内的Web图。用对应软件实际打开每个工程，能选择并编辑至少一个独立图形或文字对象，保留对象/图层面板与一次可撤回编辑的记录，关闭时不覆盖已登记源件；只有平面截图不算可编辑工程。实际解码每幅Web图并测得正整数宽高。docs/brand-content/company-visuals.json每幅都含source.path/source.sha256、web.path/web.sha256/width/height、alt.en/alt.ru、参考主题/事实依据；逐文件计算的SHA-256须与manifest逐字相同，解码宽高须逐值相同，en/ru alt均为非空且对应实际画面（E-111）。3) manifest登记现用PackJoyU logo master文件路径与SHA-256，读取该实际文件计算值须逐字匹配；图稿使用同一master而非候选新标，制作记录列明引用/导入该master的对象。原logo不修改，成品与源工程均无旧品牌或候选标；不等待用户回看候选图（E-28、E-111）。4) 必须提供可核对的实际GPT Dot调用/软件操作记录：对应调用或会话标识、软件名称版本、打开工程与导出Web文件的记录，记录中的文件逐件对应manifest路径和SHA-256；最后重新打开源工程、解码Web图并复算全部哈希，全部通过才交company-visual-assets。Dot不可达、软件步骤未执行或任一图稿/源工程/Web图/必要记录缺失时，本任务保持未完成，不能仅交尚未执行状态、计划或截图就提交为已完成或落地（E-29、E-111）。5) 本卡完整交付的边界是已核验的素材集合与manifest，不输出页面完成声明；E-111的首页/about实际消费及浏览器证据由M1-T5集成验收，T9不得伪造页面证据。源工程和工具私有记录不进入public或生产镜像（E-111）。 | 1.5d |
+| M2-T1 | 扩展产品卡视口与精简信息区 | M2 | M1-T4 | 现有ProductGallery/Scene、SSR loadCatalog(listPublishedModels)及11布局 | 560px自适应大卡和独立模型/动作区域 | 1) 入口：首页products-link→/[locale]/products，数据源为SSR loadCatalog(listPublishedModels)及浏览器实际GLB URL；GET /api/models仅作已有兼容端点独立校验，不新增客户端目录请求；PC卡最小560px、视口clamp(360px,28vw,440px)，390宽不溢出；名称/必要规格/询盘控件可辨，删重复介绍后操作仍在。2) 标题与按钮独立链接，Canvas内拖动不导航、不提交；从列表category-link进入现有/[locale]/products/[slug]仍受发布开关且返回3D目录，不扩完整PDP。 | 1.5d |
 | M2-T2 | 修正模型直接拖动与滚轮焦点 | M2 | M2-T1 | 现有真实GLB和OrbitControls、D20 | 可取消的精确指针/焦点控制 | 1) 从产品卡模型viewport直接pointer-down捕获当前模型，hover停自转且不几何缩放；普通wheel页面滚动，仅模型聚焦Ctrl/Cmd+wheel或zoom控件缩放，不先强制激活（E-97、E-98、E-99）。2) pointercancel/blur/Escape/卸载均释放，重新操作正确目标且不残留锁页；用户暂停优先于隐藏/显示恢复；测试保留修改前失败与修改后通过（E-100）。 | 2d |
 | M2-T3 | 接通模型键盘触屏与复位控件 | M2 | M2-T2 | model-pointer、每产品初始相机/缩放边界与现有大卡 | model-accessibility；键盘/单指/双指/复位与44px控件 | 1) Tab逐个到达命名控件且焦点可见，方向/缩放/复位与鼠标功能相同；Escape退出并回来源控件，不锁Tab、不自动跳产品链接（E-101）。2) 分别测试模型单指拖动、双指min/max内缩放、文字区页面滚动，所有操作只在模型区接管且不提交询盘；逐个测点击目标≥44 CSS px（E-102）。3) 任意旋转/缩放后复位等于该产品初始相机/边界；1440/1920及窄屏完整模型可见、名称/关键控件符合11节字号且规格/询盘仍可见，不通过删内容消除裁切（E-104）。 | 1.5d |
 | M2-T4 | 定义模型分析事件生命周期纯规则 | M2 | M1-T2 | contract-types中的事件白名单、navigationId/viewId与durationMs约束 | model-event-rules；start/terminal去重及取消/重试转换的纯函数 | 1) 录制输入序列验证每viewId最多一个success/failure，timeout为failure，poster/FoldBox不产生GLB success，重试新尝试使用新viewId；函数不读DOM/env/cookie且不fetch。2) 事件输出必须通过M1共享schema；durationMs取注入单调时钟差，产品/导航关联原样保留，乱序/重复终态不覆盖已定终态；真实浏览器生产者由M2-T7消费。 | 1d |
 | M2-T5 | 连接产品上下文到既有询盘表单 | M2 | M2-T6、M1-T8 | model-fallback、现有InquiryWizard与POST /api/inquiries协议 | product-inquiry；产品卡至联系页询盘的上下文链 | 1) 点击产品卡inquire-product→/[locale]/contact，真实POST /api/inquiries携服务器认可productSlug并保存真实Inquiry编号，表单的产品/规格等于来源卡片，不改旧询盘协议。2) en/ru和390窄屏分别走该入口，提交前从模型拖动/键盘控制不产生询盘POST；名称、规格、询盘入口仍可见且能完成提交，保留一条真实路径GIF。 | 1d |
 | M2-T6 | 接通真实模型失败与海报回退 | M2 | M2-T3 | model-accessibility、对应产品poster与真实GLB来源 | model-fallback；GLB/WebGL/context失败的静态回退和重试入口 | 1) 分别注入GLB下载失败、WebGL不支持、context lost和仅poster/FoldBox，显示对应产品海报及可点击重试/询盘；不无限重试、不把其他产品图片充当回退。2) 重试建立新的实际加载尝试，卸载取消旧监听/加载回调；纯展示状态只上报加载结果回调，不在本任务创建分析成功事件，统计完整集成由M2-T7完成。 | 1d |
-| M2-T7 | 把真实GLB生命周期接入分析采集 | M2 | M2-T4、M2-T6、M5-T6、M5-T7、M5-T3 | model-event-rules、model-fallback、analytics-ingest与analytics-consent-ui | model-events；页面/产品访问与真实GLB start/terminal生产者接线 | 1) 真浏览器产品卡发起GLB后POST /api/analytics/events分别保存产品访问、model_view_start及成功/失败；只进入产品页不打开3D无start；未同意/拒绝分析时模型仍可用且无分析请求（E-42、E-46）。2) 分别注入GLB下载失败/WebGL不支持/context lost/poster或FoldBox，仅对应产品静态回退、重试及询盘可用；poster/演示无GLB success；同viewId最多一种终态，新实际重试按规则新viewId（E-103）。3) 成功/失败/超时两次尝试与切卡取消逐项核关联及真实durationMs，分母仅同意后真实start、timeout为failure、平均耗时带samples且无样本null，不补拒绝样本（E-63）。 | 1.5d |
+| M2-T7 | 把真实GLB生命周期接入分析采集 | M2 | M2-T4、M2-T6、M5-T6、M5-T7、M5-T3 | model-event-rules、model-fallback、analytics-ingest与analytics-consent-ui | model-events；页面/产品访问与真实GLB start/terminal生产者接线 | 1) 真浏览器产品卡发起GLB后POST /api/analytics/events分别保存产品访问、model_view_start及成功/失败；仅进入产品路由且没有真实GLB加载尝试时无start；可视区自动加载或主动操作确实发起GLB时均产生start，不要求额外激活点击；未同意/拒绝分析时模型仍可用且无分析请求（E-42、E-46）。2) 分别注入GLB下载失败/WebGL不支持/context lost/poster或FoldBox，仅对应产品静态回退、重试及询盘可用；poster/演示无GLB success；同viewId最多一种终态，新实际重试按规则新viewId（E-103）。3) 成功/失败/超时两次尝试与切卡取消逐项核关联及真实durationMs，分母仅同意后真实start、timeout为failure、平均耗时带samples且无样本null，不补拒绝样本（E-63）。 | 1.5d |
 | M2-T8 | 贯通产品咨询与人工收件回复 | M2 | M2-T5、M2-T7、M4-T5、M4-T6、M4-T9、M4-T14 | product-inquiry、chat-visitor-ui、chat-operator-ui与model-events | product-contact；带产品上下文的访客/运营人工咨询链 | 1) 产品卡chat-product打开窗口，POST /api/chat/conversations保存同一productSlug/持久且不变消息编号后才显示已接收；运营真实收件箱可读该消息并人工回复，访客收到同一回复；网络中无AI答复接口或自动生成答复（E-16、E-31）。2) 拒绝分析仍可咨询且不建分析ID/第三方聊天脚本；提交超时/响应丢失后同clientMessageId重试返回原收件结果，收件箱/通知各一项；当前标签草稿保留，en/ru/390路径有真实GIF（E-37、E-40）。 | 1.5d |
 | M3-T1 | 将真实Auth.js会话绑定当前设备与权限 | M3 | M1-T2、M3-T14 | 现有Credentials、JWT/sv、requireAdmin/page gate；M3-T14共享HTTP层；M1-T2契约。 | AdminDeviceSession；Auth.js登录/读取/普通signOut的sid适配；GET /api/admin/account的当前设备摘要及当前权限守卫。 本卡增加User.passwordlessEnabled并默认false，保证首个AccountDTO字段齐；真实GET account最终响应消费T14计数适配。 | 1) 调用方/接线点：真实Credentials→src/auth.ts→设备服务；真HTTP登录创建归当前user/sv的sid，GET /api/admin/account与Auth.js session/SSR均核User存在、disabled、lockedUntil、totpEnabled、role、sv、sid归属/revokedAt/期限；旧无sid JWT、数据库不可校验均拒绝，角色只取当前库值（E-70）。2) 普通初始有效期2h，记住7d闲置且签发后30d绝对；到期等号即拒绝；普通Auth.js signOut服务端撤sid后清cookie，复制的旧cookie访问GET account返回401，跨请求不得授权缓存（E-01、E-02、E-03、E-69）。 3) GET account包含10节完整AccountDTO和当前设备期限，未开启账号passwordlessEnabled=false；专用PG核真实响应requestCount一次、受控5xx增加errorCount，计数故障不改变原业务结果。 | 1.5d |
 | M3-T2 | 校验登录方式并原子核销当前验证器时间步 | M3 | M3-T1、M1-T2 | M3-T1 的真实设备登录与当前权限链；现有 enroll/token/confirm 与 TOTP 工具；M1-T2 单一 LoginMode schema。 | Credentials 的 password/totp 模式与恢复码拒绝；消费M3-T1已增加且默认false的User.passwordlessEnabled，不重复建字段；当前 secret/sv/step 的 TOTP CAS；POST /api/auth-admin/enroll、POST /api/auth-admin/enroll/confirm 的当前令牌/期限 CAS。 | 1) 调用方/接线点：真实 Auth.js Credentials→authorizeLogin；已启用账号的 totp 模式只校验账号+验证码，password 模式校验当前密码+验证码；未知mode、未开启totp、非空recoveryCode和未知账号都同一通用失败且无设备行（E-06、E-96）。2) 当前secret/sv/step原子核销，登录/并发请求同一步最多成功一次；重置交错时旧secret的码不能生效；保留6位前导零及既有限流（E-72、E-08）。3) 未绑定账号须既有一次性token完成首次绑定；真实 enroll/confirm 在最终事务复核 tokenhash/expiry/sv/pendingSecret，错误/过期/并发确认不提交，且未确认前 passwordlessEnabled 保持false（E-05、E-08）。 | 2d |
@@ -30,7 +31,7 @@
 | M3-T4 | 签发管理员目标恢复permit | M3 | M3-T3、M3-T1 | M3-T3目标新鲜授权与当前权限；09/10 permit15min和审计协议。 | AdminRecoveryPermit；POST /api/admin/account/recovery-authorizations及POST /api/admin/users/[id]/reset-2fa兼容别名。 | 1) 调用方/接线点：真实ADMIN handler→recovery-authorizations；当前密码+新TOTP取得绑定他人的RECOVERY_AUTHORIZE grant后签15min permit，target不可自己；旧无body直接reset、仅session、访客邮件请求、SALES/EDITOR均拒绝且目标因素不变（E-13）。2) permit随机256bit、仅存hash/一次响应，授权核销/target/source/reason审计同事务，重复同grant不再签发；日志无permit明文，响应丢失不自动签第二份；普通passwordless会话不能借此省略现密码（E-73、E-75）。 | 1d |
 | M3-T5 | 接通受限重入绑定与最终一次确认 | M3 | M3-T19、M3-T2 | M3-T19真实受限session，09/10 pending/confirm状态与当前TOTP CAS。 | POST /api/auth-admin/recovery/enroll和POST /api/auth-admin/recovery/confirm；重入与原子发布新因素。 | 1) 调用方/接线点：真实受限handler→recovery-enrollment服务；首次加密pendingSecret，原窗口重入返回同URI/原expiresAt，不旋转/续时；错误/过期/重复confirm及两次并发confirm均核当前token/sv/secret/step，最多一次提交，失败前旧有效方式可用（E-08、E-14）。2) 真实confirm新未用TOTP后在同一事务发布secret和新恢复码hash、递增sv/撤旧设备/旧恢复凭据、消费session并清cookie，恢复码只返一次；SERVER_OWNER预授权hash才同步改密，HTTP只收totp；结果未知不重放，下一时间步真实普通登录核实，旧因素/旧设备拒绝（E-15）。 3) 新增断言复用T19已签发受限cookie的前置，不重做签发流程：POST /api/auth-admin/recovery/enroll body={}返回200，JSON的otpauthUri为非空字符串、expiresAt为UTC时间；同cookie再次POST {}仍200且两字段逐字相等、数据库pending密文及pendingUntil不变。在原expiresAt等号发enroll得到401/error=recovery_expired，不改旧secret/password。错totp的confirm返回401且无completed=true或recoveryCodes；5次错码后同受限凭据不再200。有效新totp的confirm返回200、completed=true、recoveryCodes为非空字符串数组，Set-Cookie将同一受限cookie清除，数据库completedAt非空且sv只因该次最终确认增加1。把成功前保存的同cookie复制到两个并发confirm请求，恰好一个200；另一个401且无recoveryCodes，再重复仍401、sv及恢复码hash不再变化。成功后GET /api/admin/account使用旧设备cookie为401；等待下一未用时间步用新验证器走Credentials可取得后台cookie，旧验证器码不取得会话。confirm body加password/newPassword/passwordHash任一字段为400/error=invalid；只有SERVER_OWNER预授权hash的既有测试账号在成功后用其预授权新密码登录，其他来源密码hash前后相等。 | 2d |
 | M3-T6 | 接通唯一登录页和明确方式字段 | M3 | M3-T2、M1-T2、M1-T1、M1-T8、M1-T7、M6-T4 | M3-T2 Credentials及M1 token/client基础；07登录路由、11/12登录单卡。 M6-T4已提供真实/admin/stats，T7外壳/账户活动客户端已在该前置链交付。 | /admin-login、Auth.js pages.signIn、LoginForm及页脚入口；只实现日常登录UI。 | 1) 入口：公开页脚Administrator sign-in（footer-admin-login）→/admin-login；数据源Auth.js GET/POST /api/auth/[...nextauth]；点login-submit实际提交CSRF/Credentials并验证cookie与GET account，totp只email/totp，password方式界面密码控件提交Auth.js的password字段，界面解释账号不是第二因素（E-09）。2) 未勾选/缺rememberDevice与字面false的真实表单请求使设备remembered=false，勾选true才true，非法值不签session（E-95）。3) 对未知mode、未开启totp账号、非空recoveryCode与不存在账号分别直送Credentials，断言同一通用失败、无新增设备和无账号差异；合法password/totp各自真实成功；无日常恢复码字段，非站内/无当前角色权限回跳不采用（E-96）。 按11节唯一minimalist-flat，在实际服务1920×1080、1440×900、390×844记录GIF与computed style：2px黑边、0圆角、无阴影、强调色#b45700；后台逐页以work/form/card、density7/gutter16/gap16/pad16运行D1–D6和overflow探针。label与键盘焦点可达，触屏控件点击框至少44px。 4) 空/default /admin成功回跳实际到已存在的/admin/stats，断言GET /api/admin/stats及可见核心看板；404或仅redirect URL不算成功。 | 1d |
-| M3-T7 | 统一后台外壳并只上报真实活动 | M3 | M3-T15、M1-T1、M1-T7、M3-T2、M1-T8 | 既有Auth.js GET/POST登录页、M3-T2登录协议、M3-T15活动API、M1-T7完整视觉组件与M1-T8统一client基础。 | 统一后台外壳、角色导航显示、AdminSessionActivity与普通退出；个人安全表单由M3-T12交付。 本卡首先在src/lib/client/account.ts提供GET account与POST activity方法，后继只追加领域方法，不重造请求基础。 | 1) 入口：既有/api/auth/signin密码+TOTP真实登录→当前角色既有可访问后台页面→壳内控制；此阶段不注册T6自定义登录页；数据源GET /api/admin/account，点admin-signout执行真实Auth.js signOut并复制旧cookie GET account=401；菜单当前角色数据来自服务端，401立即清本账号内容/取消在途请求（E-03、E-70）。2) 可见页面鼠标/键盘/路由真实操作后才POST /api/admin/account/session/activity，15min内至多一次；仅轮询/隐藏页/无参session读取不发activity，失焦/卸载取消监听；真实续期写回与撤销并发沿T15接口断言（E-68）。 按11节唯一minimalist-flat，在实际服务1920×1080、1440×900、390×844记录GIF与computed style：2px黑边、0圆角、无阴影、强调色#b45700；后台逐页以work/form/card、density7/gutter16/gap16/pad16运行D1–D6和overflow探针。label与键盘焦点可达，触屏控件点击框至少44px。 | 1d |
+| M3-T7 | 统一后台外壳并只上报真实活动 | M3 | M3-T15、M1-T1、M1-T7、M3-T2、M1-T8 | 既有Auth.js GET/POST登录页、M3-T2登录协议、M3-T15活动API、M1-T7完整视觉组件与M1-T8统一client基础。 | 统一后台外壳、角色导航显示、AdminSessionActivity与普通退出；个人安全表单由M3-T12交付。 本卡首先在src/lib/client/account.ts提供GET account与POST activity方法，后继只追加领域方法，不重造请求基础。 | 1) 入口：既有/api/auth/signin密码+TOTP真实登录→当前角色既有可访问后台页面→壳内控制；此阶段不注册T6自定义登录页；数据源GET /api/admin/account，点admin-signout执行真实Auth.js signOut并复制旧cookie GET account=401；菜单当前角色数据来自服务端，401立即清本账号内容/取消在途请求（E-03、E-70）。2) 可见页面鼠标/键盘/路由真实操作后才POST /api/admin/account/session/activity，15min内至多一次；仅轮询/隐藏页/无参session读取不发activity，失焦/卸载取消监听；真实续期写回与撤销并发沿T15接口断言（E-68）。 按11节唯一minimalist-flat，在实际服务1920×1080、1440×900、390×844记录GIF与computed style：2px黑边、0圆角、无阴影、强调色#b45700；本卡只测壳导航、页面外框、活动及退出控件：三尺寸记录壳元素computed style，按实际外框work/form/card与density7/gutter16/gap16/pad16运行适用D1–D6及overflow，不将旧业务内层计为本卡视觉已通过。旧业务内层完整页由M3-T21至T25逐页迁移、测量及回归，M7-T9汇总；未迁移区域据实列出，不豁免后继完整测量。label与键盘焦点可达，触屏控件点击框至少44px。 | 1d |
 | M3-T8 | 显示本人设备并退出指定设备 | M3 | M3-T12、M3-T17 | M3-T12共享ReauthDialog、M3-T17设备API。 | /admin/account/devices、DevicesContainer/DeviceRow、本人游标页与单设备撤销。 | 1) 入口：个人页Signed-in devices（account-devices-link）→/admin/account/devices；数据源GET /api/admin/account/devices；1/2/多页仅本人行，current/expiry/revoked由DTO，分页同ID恰一次；GET不续activity（E-70）。2) 点device-revoke-{id}复用ReauthDialog→POST reauth(DEVICE_REVOKE,target=id)→POST /api/admin/account/devices/[id]/revoke；断言目标设备下一GET account401、其他未撤设备仍有效，撤当前设备清屏回login；跨target和已用grant无变更（E-73）。 按11节唯一minimalist-flat，在实际服务1920×1080、1440×900、390×844记录GIF与computed style：2px黑边、0圆角、无阴影、强调色#b45700；后台逐页以work/form/card、density7/gutter16/gap16/pad16运行D1–D6和overflow探针。label与键盘焦点可达，触屏控件点击框至少44px。 | 1d |
 | M3-T9 | 在账号行复用验证对话框授权恢复 | M3 | M3-T12、M3-T4 | 既有UsersAdmin、M3-T12 ReauthDialog、M3-T4目标授权API。 | /admin/users目标行授权按钮与单次permit结果区；移除原直接重置调用。 | 1) 入口：后台Account permissions（admin-users-link）→/admin/users→真实他人行Authorize recovery（user-authorize-recovery-{id}）；数据源既有用户列表、POST /api/admin/account/reauth及POST /api/admin/account/recovery-authorizations；复用现成对话框点击后实际依次发送target grant和permit请求，target因素不变、token一次显示且审计actor/source/target齐（E-13）。2) 自己行无授权控制，直请求self/EDITOR/SALES/旧无body reset均拒绝；取消不发请求，未知结果不重复签，关闭结果区清秘密而用户增删角色流程契约不改（E-73）。 按11节唯一minimalist-flat，在实际服务1920×1080、1440×900、390×844记录GIF与computed style：2px黑边、0圆角、无阴影、强调色#b45700；后台逐页以work/form/card、density7/gutter16/gap16/pad16运行D1–D6和overflow探针。label与键盘焦点可达，触屏控件点击框至少44px。 | 0.5d |
 | M3-T10 | 接通首次绑定表单与一次展示材料 | M3 | M3-T6、M3-T2 | M3-T2现有enroll安全后端、M3-T6登录页、M1唯一token。 | /admin-enroll表单与登录页首次绑定入口、有效token内存导入/清URL。 | 1) 入口：/admin-login的First authenticator setup（login-enroll）→/admin-enroll；数据源POST /api/auth-admin/enroll、POST /api/auth-admin/enroll/confirm；真实既有token/email/password表单→URI→下一未用新码确认→恢复码一次显示；未确认前无密码开关仍false，绑定错误/过期/重放不变更（E-05、E-08）。2) token/URI/码仅内存，历史fragment读入立即清URL，pagehide清秘密；已确认码不再提交登录，回login用下一步新码完成真实登录；无有效token仅输入email不得绑定（E-10）。 按11节唯一minimalist-flat，在实际服务1920×1080、1440×900、390×844记录GIF与computed style：2px黑边、0圆角、无阴影、强调色#b45700；后台逐页以work/form/card、density7/gutter16/gap16/pad16运行D1–D6和overflow探针。label与键盘焦点可达，触屏控件点击框至少44px。 | 0.5d |
@@ -44,6 +45,11 @@
 | M3-T18 | 提供受OS权限保护的本地恢复预授权CLI | M3 | M3-T4 | M3-T4同源permit持久规则与既有初始密码脚本guard/Argon参数。 | scripts/admin-authorize-recovery.mjs；显式target/role/reason、TTY隐式密码预授权及安全审计。 | 1) 真实CLI仅OS管理权限下针对明确target、当前role、reason签15min一次性permit；非TTY或不明目标拒绝且无记录，输出凭据一次、审计只actor/target/source/time/reason无秘密；无第二管理员且无恢复码的隔离账号取得有效permit（E-12）。2) 可选改密在TTY隐藏输入并确认，沿既有Argon规则只写pendingPasswordHash，原password/TOTP此时不变；原初始密码脚本ADMIN/未绑定/未停用/TTY guard原样，不能先清因素绕过；HTTP不得提交pendingPasswordHash（E-75）。 | 1d |
 | M3-T19 | 原子核销恢复码或permit为受限会话 | M3 | M3-T4、M3-T1 | M3-T4 permit与M3-T1设备撤销；现有恢复码hash；09/10 start锁序。 | AdminRecoverySession；POST /api/auth-admin/recovery/start与受限HttpOnly cookie。 | 1) 调用方/接线点：真实POST start→User锁后重读当前recoveryCodes/permit→核销+sv递增+旧sid/旧恢复会话撤销+10min restricted session+审计同事务；同码并发仅一次，不同码并发也不复活已用码；email单独/旧凭据拒绝（E-10、E-11）。2) 受限cookie仅Path=/api/auth-admin/recovery、Secure/HttpOnly/SameSite=Strict，不能请求后台、换Auth.js session或带ADMIN角色；原有效TOTP/password/defaultMode保持，中断/过期无新因素提交；SERVER_OWNER permit的预授权hash仅服务器事务转入session，HTTP body不接（E-14）。 | 1.5d |
 | M3-T20 | 将本人换验证器接入受限重绑 | M3 | M3-T5、M3-T3 | M3-T3 TOTP_RESET grant与M3-T5受限重绑。 | POST /api/admin/account/2fa/reset的SELF_REAUTH受限session与旧响应兼容。 | 1) 调用方/接线点：真实2fa/reset→当前设备+TOTP_RESET grant事务消费→SELF_REAUTH受限cookie及enrollLink；兼容currentPassword+totp同强度且recoveryCode拒绝，原因素在最终confirm前不清除，受限cookie后台请求401（E-14）。2) 未提供现密码且仅无密码session/TOTP时签grant或直接reset均拒绝且绑定不变；取得合法本人grant后受限enroll/confirm完成新绑定并留审计，忘密仅能另走OS-owner预授权，不经HTTP自设密码（E-75）。 | 0.5d |
+| M3-T21 | 迁移原询盘列表、详情与往来邮件视觉 | M3 | M1-T7、M3-T7 | 现有/admin/inquiries及详情、真实Inquiry/API、MailThread/MailParts、匿名化状态；11锁定风格。 | legacy-inquiries-ui；询盘列表/详情与既有邮件往来统一视觉和回归证据，不修改询盘业务。 | 1) 真实ADMIN/SALES登录后点后台“询盘”→/admin/inquiries，搜索/日期/状态/负责人/分页均发送既有GET /api/admin/inquiries及GET /api/admin/users；点击真实行编号进入/admin/inquiries/[id]，GET对应详情/history保持原scope，返回列表与筛选仍有效。真实POST /api/inquiries先建合成询盘，不用数据库插入冒充业务链。 2) 详情保留状态PATCH、负责人分配、POST notes、既有回复路径及匿名化只读限制；在隔离PG/SMTP中从可见控件核原method/body和持久结果，SALES不能读取他人询盘。既有邮件开启且后端mail/config允许时MailThread沿GET/POST /api/admin/inquiries/[id]/mail、status/retry显示真实状态；关闭时不发信且原回退可见，不改变gate。 3) 把InquiryDetail的内联conic-gradient、anonymized.tsx的4/999px圆角/1px边界及InquiryHistory/StatusBadge/DateRange/InquiryNotFound的旧视觉改为11节同源组件/样式。已匿名化正文/邮箱不重新显示、状态/历史/结果文字不因去色或删环图而消失；保留数值与标签。必读07/11/12，消费唯一minimalist-flat和M1视觉组件，不重搜或改slug。实际服务真实登录，在1920×1080、1440×900、390×844记录真实操作GIF、computed style（2px黑边、0圆角、无阴影/渐变、强调色#b45700）、D1–D6/overflow；density7/gutter16/gap16/pad16，work铺满/form左对齐，44px触屏目标，loading/empty/error/success/disabled/focus逐态可判。权限和业务动作、旧API/邮件gate均保持。（E-106） | 2d |
+| M3-T22 | 迁移未归类邮件样式并保持关闭门禁 | M3 | M1-T7、M3-T7、M3-T21 | 现有UnassignedInbox/UnassignedNav与mail.css；UNASSIGNED_MAIL_LIVE=false、相关HTTP后端不存在的源码事实。 | legacy-unassigned-ui；未归类组件样式统一及真实关闭门禁/零请求证据；不开放邮件功能。 | 1) 保留UNASSIGNED_MAIL_LIVE=false和MAIL_ATTACHMENTS_LIVE=false；真实ADMIN登录点击现有询盘导航，侧栏没有未归类邮件入口；直达/admin/mail/unassigned仍404，网络记录无/mail/unassigned、assign-lookup、assign、ignore或附件请求。不新增后端、不开gate、不以mock数据宣称运营收件闭环。 2) UnassignedInbox/UnassignedNav及其mail.css专属选择器沿11节同源值替换独立色板/8/12/999px圆角/1px边界，保留现有切分类/选择/归类/忽略/撤销/过期说明回调及禁止附件入口；组件层状态断言注明组件证据，不能冒称真实API完成。 3) 在真实服务1920×1080、1440×900、390×844记录原询盘导航到受门禁拒绝页面的GIF和零请求断言；关闭组件没有渲染时D1–D6/overflow/computed style明确记gate-off/not-rendered，不能填通过。共享MailParts/MailThread可见样式复用T21实际服务密度/GIF，组件层验证各状态的2px边界/0圆角/单强调色和44px目标，不开启隐藏界面造证据。必读07/11/12、锁定minimalist-flat。（E-107） | 0.5d |
+| M3-T23 | 迁移既有模型上传和预览工作流视觉 | M3 | M1-T7、M3-T7 | 现有/admin/models重定向与/admin/models/new、ModelUpload/ModelPreview、models.css及真实models-http。 | legacy-model-admin-ui；既有模型上传/检查/预览/发布控件统一视觉，列表重定向不变。 | 1) 真实ADMIN/EDITOR登录点“3D 模型”→/admin/models/new；点击上传页“3D 模型”面包屑→/admin/models后仍按现状重定向/new，不新建列表。用隔离合成GLB/海报走原POST /api/admin/models、GET/PATCH /api/admin/models/[id]、POST process/publish，真实结果仍受既有大小/READY/发布确认约束，不能因样式改造跳过检查。 2) models.css与ModelUpload/ModelPreview的旧背景/圆角/按钮/步骤条沿唯一token；预览Canvas仍显示真实GLB与既有主题能力，不把预览本身变成界面装饰；上传/处理/错误/阻断原因/预览/确认各步骤动作、文件输入可访问名称及取消返回询盘保留。必读07/11/12，消费唯一minimalist-flat和M1视觉组件，不重搜或改slug。实际服务真实登录，在1920×1080、1440×900、390×844记录真实操作GIF、computed style（2px黑边、0圆角、无阴影/渐变、强调色#b45700）、D1–D6/overflow；density7/gutter16/gap16/pad16，work铺满/form左对齐，44px触屏目标，loading/empty/error/success/disabled/focus逐态可判。权限和业务动作、旧API/邮件gate均保持。（E-108） | 1d |
+| M3-T24 | 迁移规格列表及品类编辑器视觉 | M3 | M1-T7、M3-T7 | 现有/admin/specs SSR categoryMeta列表、品类SpecEditor和specs.css，既有GET/PUT规格接口。 | legacy-specs-ui；SSR规格导航及原编辑表单统一视觉，不变规格业务。 | 1) 真实ADMIN和EDITOR分别登录，点击后台“产品规格”到/admin/specs；服务端HTML中categoryMeta每个key恰有一个/admin/specs/{key}链接。点击corrugated-boxes链接后pathname=/admin/specs/corrugated-boxes，GET /api/admin/specs/corrugated-boxes=200，JSON.category=corrugated-boxes且Cache-Control含no-store；点击“全部品类”后pathname=/admin/specs。登录SALES直接开这两页均404，GET/PUT规格接口403；ADMIN请求未知category的GET/PUT为404、error=not_found。 2) 在隔离数据库通过原编辑控件设置material en=Visual test EN、material ru=Visual test RU、notes en=note EN、notes ru=note RU，size min的l/w/h=10/20/30、size max=40/50/60、单位mm，moq value=123、单位pcs，lead time min/max=7/14、单位day，样品费选择free；清空认证，贸易术语只选FOB。点击唯一submit“保存”只发一次PUT /api/admin/specs/corrugated-boxes，body恰含size/material/moq/sampleFee/leadTime/certifications/tradeTerms/notes八键，各嵌套值等于上述输入，certifications=null、sampleFee={free:true}、tradeTerms=[FOB]。响应200，category等于corrugated-boxes、updatedAt为ISO时间，八字段逐项等于body；随后真实GET=200且八字段及updatedAt逐项等于PUT响应。刷新浏览器触发GET后material/notes、六尺寸、MOQ、交期、free与FOB控件值逐项等于上述输入，status结果区可见已保存文案。 3) 在同一表单只将moq value改0并点击保存，观察1秒PUT请求增加0，role=alert含1与100000000的范围提示，material en和moq value仍分别为Visual test EN和0。服务端原错误协议复用既有API用例：ADMIN同源PUT含moq.value=0返回400/error=invalid，issues中含path=moq.value；随后GET的moq.value仍123。测试只消费现有规则，不增加端点、字段、品类或PDP。 4) 必读07/11/12，只消费minimalist-flat。1920×1080、1440×900、390×844逐项记录真实列表→编辑→保存→返回GIF和GET/PUT网络证据。对.spec-sec、material en输入和保存按钮测border各边=2px且rgb(0,0,0)、borderRadius各角=0px、boxShadow=none、backgroundImage=none；Tab到material en后document.activeElement就是该input，focus-visible的outlineWidth=2px/offset=2px/color=rgb(180,87,0)。桌面按钮/单行输入高36px、触屏目标矩形至少44×44px，单行输入字号16px、表格标签14px/20px；D1–D6/overflow按列表work、编辑form记录，gutter/gap/pad=16px、work fill≥0.85、form fill≥0.55且左边缘≤gutter+24px、block gap≤24px/card pad≤20px、页面scrollWidth≤clientWidth。在相同表单数据/展开状态下比较迁移前后，六尺寸、MOQ、费用、认证与双语字段的DOM数量相等，必要文字可换行；loading/empty/error/success/disabled/focus逐态留下断言，不删字段或动作取得通过。（E-109） | 1d |
+| M3-T25 | 统一既有站点设置和账号表完整视觉 | M3 | M1-T7、M3-T7、M3-T9、M5-T10、M1-T5 | 已接恢复授权和统计时区的现有settings/users；旧about/org/图片库与完整账号表；唯一风格。 | legacy-settings-users-ui；about/org/图片控件、分区导航及完整账号管理统一视觉，保留新增安全与时区功能。 | 1) 真实ADMIN从“站点设置”进入/admin/settings，普通分区链接到?section=org；GET /api/admin/site-settings/about、GET/PUT organization、PUT about/[locale]及enabled、GET/POST assets、PUT about/images、DELETE assets/[id]沿既有协议。在隔离合成数据/资产中走保存与409刷新确认、上传/排序/alt错误；不改发布完整度、富文本净化、脏草稿/版本语义。 2) 从“账号权限”进入/admin/users，GET /api/admin/users?all=1、POST users和PATCH /api/admin/users/[id]保持原权限/自修改/最后管理员限制；已有恢复授权按钮复用M3-T9，不恢复旧直接reset旁路，统计分区复用M5-T10不覆盖；settings/users原路由不重复注册、不增语言。 3) 迁移settings.css/about-images.css及AboutSettings/OrgSettings/AboutImages/ImageTextField/ConfirmDialog/SettingsSections/UsersAdmin的旧色/圆角/边界/状态，所有现存字段、图片alt/排序、角色/停用等控件保留；失败/冲突不假成功、不清非秘密草稿。必读07/11/12，消费唯一minimalist-flat和M1视觉组件，不重搜或改slug。实际服务真实登录，在1920×1080、1440×900、390×844记录真实操作GIF、computed style（2px黑边、0圆角、无阴影/渐变、强调色#b45700）、D1–D6/overflow；density7/gutter16/gap16/pad16，work铺满/form左对齐，44px触屏目标，loading/empty/error/success/disabled/focus逐态可判。权限和业务动作、旧API/邮件gate均保持。（E-110） | 2d |
 | M4-T1 | 原子保存咨询首消息及唯一通知出箱 | M4 | M4-T8、M5-T1、M5-T8 | M4-T8真实必要cookie、M5作业基础、09/10消息/会话/出箱约束。 | ChatConversation/Message/ReadCursor/Notification schema；POST /api/chat/conversations及持久首消息服务。 | 1) 调用方/接线点：真实POST conversations→cookie范围服务→会话+首消息+seq+messageId唯一出箱同事务，成功才返持久不变id/seq/receivedAt；数据库失败无部分记录，同UUID同payload返回原结果、异payload409、并发仅一消息一通知（E-18、E-31、E-90）。2) 16KiB限体后strict schema，正文1..4000code points纯文本，email省略/空值可发送，trim后超254、CRLF/显示名/非法格式字段错误；身份取cookie，不能关联他人session，拒分析仍接收且不建分析身份（E-39、E-40）。 | 1.5d |
 | M4-T2 | 读取访客消息页并单调推进读位置 | M4 | M4-T1、M4-T8 | M4-T1持久seq消息与M4-T8必要cookie；09/10分页和read MAX。 | GET /api/chat/conversations/[id]与POST /api/chat/conversations/[id]/read，访客范围/稳定分页。 | 1) 调用方/接线点：真实GET/read handlers→cookie范围repo；仅本人，afterSeq升序max100，页间插入后补齐ID恰一次，read MAX不越lastSeq、不回退，轮询仅receipt不标用户read；猜ID/seq/email无权（E-19、E-34、E-77、E-79）。2) 先以已完成POST conversations真实存首消息，再记录retainUntil/lastActivityAt；反复GET/POST read前后90d截止不变；复用M4-T8期限前置，过期cookie请求401且保留中的消息记录与正文不变（E-85）。 | 1d |
 | M4-T3 | 查询当前授权运营的收件箱及读状态 | M4 | M4-T2、M3-T1 | 真实聊天事实与M3当前角色；09/10共享聊天范围及运营read cursor。 | GET /api/admin/chat/conversations、GET /api/admin/chat/conversations/[id]、POST /api/admin/chat/conversations/[id]/read。 | 1) 调用方/接线点：真实后台read handlers→requireAdmin(ADMIN/SALES)→inbox服务；未登录/EDITOR/撤权账号/访客直接读取不返回正文；当前角色每次重验、不会凭隐藏按钮放行（E-19、E-32、E-78）。2) 列表快照按updatedAt/id游标、正文seq分页max100，插页消息完整恰一次；本人read MAX不影响另一运营游标，未展示的新seq仍未读；真实queued/sending/sent/failed/unknown/disabled通知独立返回，不改received（E-34、E-35、E-79）。3) GET/read/通知不延长90d，cookie失效仅访客401，ADMIN/SALES仍读期内咨询；通知失败不改变收件箱可处理状态（E-41、E-86、E-89）。 | 1d |
@@ -85,4 +91,4 @@
 | M7-T6 | 终验新鲜本人授权与忘密码隔离 | M7 | M3-T7、M3-T9、M3-T12、M3-T13 | reauth-dialog、单用途ActionGrant、安全变更与受限恢复入口 | fresh-auth-acceptance；新鲜授权/并发核销/无现密码负例报告 | 1) 从真实个人信息操作发POST /api/admin/account/reauth，当前密码+新TOTP才得5min grant；同TOTP步并发最多一成功，同grant并发最多一变更，跨purpose/target/device、过期或撤销后变更均拒且状态未变（E-72、E-73、E-74）。2) 用真实绑定/模式切换入口分别提交错码、过期码、重放与两次并发切换，最终事务重查pending/期限/sv且错误不提交、并发最多一成功，失败后仍有至少一种已验证方式（E-08）。3) 已启用无密码且忘现密码者可正常email+totp登录处理非敏感业务；仅会话或仅TOTP请求reauth及直接敏感变更均被拒且不签普通grant，界面引导独立受限恢复；受限路径只允许新绑定并有审计，HTTP不能写pendingPasswordHash（E-75）。 | 1.5d |
 | M7-T7 | 终验运维来源与通知重启消费 | M7 | M6-T7、M4-T4、M5-T1、M5-T8 | stats-reliability/ops-sources、真实cron与独立聊天SMTP适配器 | operations-acceptance；来源异常及真实通知调度报告 | 1) 隔离SMTP接收真实聊天通知，核attempt/sent/failed/unknown与HTTP计数的明确覆盖；停止单辅助来源后stats保留原成功时间/旧值或未接入且核心继续可读，未验证备份不标可恢复（E-64、E-65、E-67）。2) 直接以未登录/EDITOR会话调用人工通知相关受保护入口被拒，cron仅Bearer；chat-notifications独立受限适配器不扩旧mail UI，实际cron每分钟登记，保存消息后重启并等待计划消费持久出箱；不能只手动调HTTP或写空注册，保存received不受通知失败回滚（E-94）。 | 1.5d |
 | M7-T8 | 核对恢复候选的当前来源与安全批准 | M7 | M7-T4、M7-T2、M7-T5、M7-T3、M7-T7 | 本轮实际复用候选清单、GitHub PR及可追溯恢复来源记录 | provenance-acceptance；逐候选head/base/check/批准与未满足项只读清单 | 1) 对本轮实际复用的每个恢复候选实时只读查询真实PR head/base/check和必需安全批准，逐项将当前HEAD与来源记录比对并保存时间/安全链接；任一来源不明、HEAD不符、检查未过或必需批准缺失时明确未满足，不能标可合并或已上线（E-105）。2) 对发布副本及所复用Git差异执行秘密/受保护备份混入检查，仅记录安全路径/计数和来源摘要，发现命中保留阻断项；不复制真实秘密或备份内容，不自动合并部署，交付清单可追溯每项来源及未满足证据（E-105）。 | 0.5d |
-| M7-T9 | 验收既有分发脚本与隔离备份恢复链 | M7 | M7-T8 | 已审版本的既有Docker/standalone分发脚本、17/18验收方法及终验报告 宿主仅使用本任务既有worktree和planning；旧build-offbox包装内部clone步骤不在本任务执行。 | delivery-acceptance；隔离build/import/schema/restore真实结果与最终交付清单 | 1) 仅隔离环境在本任务planning/build-source用git archive导出已核main SHA，复用既有Docker构建/manifest/import-and-scan/deploy的受控子步骤；不直接执行会另建clone的build-offbox包装，不新clone仓库，核镜像manifest/SHA/平台；backup→Prisma diff→plan-check→db push无accept-data-loss→零drift→standalone启动/首页computed style/真实接口事件smoke有精确版本、命令和结果；不新增托管平台或改分发方案。2) 将真实备份恢复到一次性PG并由应用读取，核旧镜像兼容/回退和凭据失效策略；只读检查真实备份完成/恢复验证元数据与ops-report/stats显示相符，无可验证备份来源时必须not_connected，文件存在/计划时间不能冒充成功或可恢复；不新增备份平台，不上传备份内容（E-65）。3) 汇总访客、会话、恢复、分析和运维终验的同head证据及未完成项；发布包不包含受保护备份秘密，生产合并/上线/清理与采购均不自动执行。 | 1.5d |
+| M7-T9 | 验收既有分发脚本与隔离备份恢复链 | M7 | M7-T8、M3-T21、M3-T22、M3-T23、M3-T24、M3-T25 | 已审版本的既有Docker/standalone分发脚本、17/18验收方法及终验报告 宿主仅使用本任务既有worktree和planning；旧build-offbox包装内部clone步骤不在本任务执行。 | delivery-acceptance；隔离build/import/schema/restore真实结果与最终交付清单 | 1) 仅隔离环境在本任务planning/build-source用git archive导出已核main SHA，复用既有Docker构建/manifest/import-and-scan/deploy的受控子步骤；不直接执行会另建clone的build-offbox包装，不新clone仓库，核镜像manifest/SHA/平台；backup→Prisma diff→plan-check→db push无accept-data-loss→零drift→standalone启动/首页computed style/真实接口事件smoke有精确版本、命令和结果；不新增托管平台或改分发方案。2) 将真实备份恢复到一次性PG并由应用读取，核旧镜像兼容/回退和凭据失效策略；只读检查真实备份完成/恢复验证元数据与ops-report/stats显示相符，无可验证备份来源时必须not_connected，文件存在/计划时间不能冒充成功或可恢复；不新增备份平台，不上传备份内容（E-65）。3) 汇总访客、会话、恢复、分析和运维终验的同head证据及未完成项；发布包不包含受保护备份秘密，生产合并/上线/清理与采购均不自动执行。 4) 最终清单核M3-T21至T25逐页同head视觉、密度、原业务回归证据；既有关闭门禁和重定向按其真实结果登记，不为凑页面数打开功能。 | 1.5d |
````

### 04-执行/20-里程碑与交付顺序.md

````diff
--- before/04-执行/20-里程碑与交付顺序.md
+++ after/04-执行/20-里程碑与交付顺序.md
@@ -6,12 +6,12 @@
 |---|---|---|---|
 | 第1批 | M1 | 2.0d | M1-T1 接入8个核心品牌变量及既有路径真实冒烟 |
 | 第2批 | M1 | 4.5d | M1-T2 导出新增领域共享schema与DTO；M1-T3 制作JPG换标及视频海报发布副本；M1-T7 补齐共享视觉变量与原生UI包装 |
-| 第3批 | M1、M2、M3、M5 | 6.5d | M1-T6 逐帧替换GIF品牌并校验发布媒体集合；M1-T8 接通统一fetch取消与错误适配；M2-T4 定义模型分析事件生命周期纯规则；M3-T14 接通新API配置、错误映射与脱敏计数；M5-T1 建立JobState租约与代次仓储原语 |
+| 第3批 | M1、M2、M3、M5 | 8.0d | M1-T6 逐帧替换GIF品牌并校验发布媒体集合；M1-T8 接通统一fetch取消与错误适配；M1-T9 制作公司区块独立图稿与可编辑源工程；M2-T4 定义模型分析事件生命周期纯规则；M3-T14 接通新API配置、错误映射与脱敏计数；M5-T1 建立JobState租约与代次仓储原语 |
 | 第4批 | M1、M3、M4 | 4.5d | M1-T4 接好首页视频与分区JPG/GIF场景；M3-T1 将真实Auth.js会话绑定当前设备与权限；M4-T8 建立主动联系才签发的必要cookie；M4-T15 移除Tawk接线并说明必要人工咨询 |
-| 第5批 | M1、M2、M3、M5 | 8.5d | M1-T5 发布可核实己方公司内容与对应入口；M2-T1 扩展产品卡视口与精简信息区；M3-T2 校验登录方式并原子核销当前验证器时间步；M3-T15 通过真实活动写回会话期限并验证四条Auth.js路径；M5-T2 接通服务端分析同意签名cookie；M5-T9 建立版本化IANA时区与自然日仓储规则 |
+| 第5批 | M1、M2、M3、M5 | 9.0d | M1-T5 集成己方公司内容与独立图稿；M2-T1 扩展产品卡视口与精简信息区；M3-T2 校验登录方式并原子核销当前验证器时间步；M3-T15 通过真实活动写回会话期限并验证四条Auth.js路径；M5-T2 接通服务端分析同意签名cookie；M5-T9 建立版本化IANA时区与自然日仓储规则 |
 | 第6批 | M2、M3、M5 | 5.5d | M2-T2 修正模型直接拖动与滚轮焦点；M3-T3 签发一次性新鲜本人授权；M3-T7 统一后台外壳并只上报真实活动；M5-T6 持久化严格白名单分析事件 |
-| 第7批 | M2、M3、M5 | 8.5d | M2-T3 接通模型键盘触屏与复位控件；M3-T4 签发管理员目标恢复permit；M3-T16 原子切换本人登录方式与密码；M3-T17 提供本人设备列表及目标撤销API；M5-T3 以一致快照重算并原子替换日聚合；M5-T7 接通同意UI、页面事件与隐私说明 |
-| 第8批 | M2、M3、M5 | 6.0d | M2-T6 接通真实模型失败与海报回退；M3-T18 提供受OS权限保护的本地恢复预授权CLI；M3-T19 原子核销恢复码或permit为受限会话；M5-T5 实现分析保留候选与覆盖边界计划器；M5-T8 注册聚合作业并接通真实5分钟cron |
+| 第7批 | M2、M3、M5 | 12.5d | M2-T3 接通模型键盘触屏与复位控件；M3-T4 签发管理员目标恢复permit；M3-T16 原子切换本人登录方式与密码；M3-T17 提供本人设备列表及目标撤销API；M3-T21 迁移原询盘列表、详情与往来邮件视觉；M3-T23 迁移既有模型上传和预览工作流视觉；M3-T24 迁移规格列表及品类编辑器视觉；M5-T3 以一致快照重算并原子替换日聚合；M5-T7 接通同意UI、页面事件与隐私说明 |
+| 第8批 | M2、M3、M5 | 6.5d | M2-T6 接通真实模型失败与海报回退；M3-T18 提供受OS权限保护的本地恢复预授权CLI；M3-T19 原子核销恢复码或permit为受限会话；M3-T22 迁移未归类邮件样式并保持关闭门禁；M5-T5 实现分析保留候选与覆盖边界计划器；M5-T8 注册聚合作业并接通真实5分钟cron |
 | 第9批 | M2、M3、M4、M5 | 8.5d | M2-T5 连接产品上下文到既有询盘表单；M2-T7 把真实GLB生命周期接入分析采集；M3-T5 接通受限重入绑定与最终一次确认；M4-T1 原子保存咨询首消息及唯一通知出箱；M4-T12 注册既有邮件队列真实POST调度；M5-T4 接通时区设置HTTP与重算范围查询；M5-T11 注册默认dry-run的分析保留任务 |
 | 第10批 | M3、M4、M5、M6 | 5.5d | M3-T20 将本人换验证器接入受限重绑；M4-T2 读取访客消息页并单调推进读位置；M4-T4 消费持久聊天通知并注册每分钟作业；M5-T10 呈现ADMIN时区表单与保存反馈；M6-T1 定义统计查询范围与核心来源DTO |
 | 第11批 | M4、M6 | 3.0d | M4-T3 查询当前授权运营的收件箱及读状态；M4-T10 幂等追加访客消息并更新咨询保留期限；M6-T6 接通受角色限制的真实统计HTTP入口 |
@@ -20,10 +20,10 @@
 | 第14批 | M3、M4、M7 | 7.5d | M3-T10 接通首次绑定表单与一次展示材料；M3-T11 接通独立恢复及受限重绑向导；M4-T6 接通运营收件箱和只读会话页；M4-T13 在隔离授权策略下原子匿名化过期咨询；M7-T3 终验同意到分析看板及统计日界线；M7-T7 终验运维来源与通知重启消费 |
 | 第15批 | M3、M4 | 3.0d | M3-T12 接通个人安全页与共享新鲜验证对话框；M4-T14 在真实双端会话接通人工回复与关闭 |
 | 第16批 | M2、M3 | 3.0d | M2-T8 贯通产品咨询与人工收件回复；M3-T8 显示本人设备并退出指定设备；M3-T9 在账号行复用验证对话框授权恢复 |
-| 第17批 | M3、M7 | 2.0d | M3-T13 接通退出全部设备确认与结果核实；M7-T1 终验公开媒体与3D访客路径 |
+| 第17批 | M3、M7 | 4.0d | M3-T13 接通退出全部设备确认与结果核实；M3-T25 统一既有站点设置和账号表完整视觉；M7-T1 终验公开媒体与3D访客路径 |
 | 第18批 | M7 | 4.5d | M7-T2 终验真实会话跨路径持久与撤销；M7-T4 终验询盘聊天闭环与容量降级；M7-T6 终验新鲜本人授权与忘密码隔离 |
 | 第19批 | M7 | 2.0d | M7-T5 终验受限恢复与单管理员兜底 |
 | 第20批 | M7 | 0.5d | M7-T8 核对恢复候选的当前来源与安全批准 |
 | 第21批 | M7 | 1.5d | M7-T9 验收既有分发脚本与隔离备份恢复链 |
 
-共78项、100.5人日、21个依赖批次；窗口预测受共享注册点影响，不是截止承诺。
+共84项、109.0人日、21个依赖批次；图稿与旧后台视觉均完成前最终交付不解锁。估算不是实际耗时承诺。
````

### 04-执行/21-风险与未决事项.md

````diff
--- before/04-执行/21-风险与未决事项.md
+++ after/04-执行/21-风险与未决事项.md
@@ -1,6 +1,6 @@
 # 风险与未决事项
 
-未决事项不等于遗漏任务：105条边界均纳入19节。当前没有待用户回答的普通技术/视觉岔路；费用、不可逆删除、范围和外部承诺仍不由代理授予。低置信D3/8/9/12/17/18/19，审题flawed的D2/5/6/7/8及incomplete的D3/12/17完整保留22节。
+未决事项不等于遗漏任务：111条边界均纳入19节。当前没有待用户回答的普通技术/视觉岔路；费用、不可逆删除、范围和外部承诺仍不由代理授予。低置信D3/8/9/12/17/18/19/21/22，审题flawed的D2/5/6/7/8及incomplete的D3/12/17完整保留22节。
 
 | 风险 | 影响 | 缓解动作 | 触发条件 |
 |---|---|---|---|
@@ -14,3 +14,5 @@
 | 恢复PR或本地文档基线未进入实施主干 | 新工作树缺输入、复用未审安全改动 | M1-T1首个PR纳入已审本地规格；后续基于其落地main。恢复PR按实时head/check和必需批准逐个评估，不自动合并/部署 | origin/main没有spec或复用PR缺当前证据/安全批准 |
 | 目录状态不全或任务视觉规范传递遗漏 | D19 low；前后台风格/密度漂移 | 唯一minimalist-flat原件+11项目适配；缺状态显式补足；混合模块UI逐卡指定StyleKit/GIF/D1–D6，原目录CSS冲突不整段注入 | 缺状态、重搜slug、后台继承品牌间距或缺密度/真实GIF证据 |
 | 任务人天与回归复用仍有估算偏差 | 一轮实质拆分后，部分粒度校准仍偏大；预测不是工期承诺 | 开工先核本卡改动与前置现有测试，只新增本卡分支证据；若确认超过2人日，用局部契约补丁继续拆分并保留全部验收，不能降标准或以计划当实测 | 实际开工发现仍跨独立职责或超过2人日；相关任务保持未落地 |
+
+D21/D22的任务分工均为真实裁决的低置信选项，已采纳并保留估时风险；不能把拆分、工具可达或文档通过当素材已完成。旧后台同步视觉的范围现已显式登记，保持原关闭门禁。
````

### 05-附录/22-决策记录.md

````diff
--- before/05-附录/22-决策记录.md
+++ after/05-附录/22-决策记录.md
@@ -22,3 +22,5 @@
 | 18 | 聊天通知持久队列 | sound；专属出箱与扩展现有邮件状态机均可持久化通知，但兼容和 PII 耦合不同，问题成立；TypeSafe 判 sound=no，与本审题不同但同选 A，保留裁决并由 medium 降为 low。 | 专属ChatNotification出箱；复用SMTP；唯一messageId、租约和真实cron | 原文的“在线聊天工具”需要先可靠保存联系内容，未要求统一邮件工作台；队列结构需求未覆盖，按可逆优先新增 ChatNotification 专属出箱，复用 SMTP 适配器而避免扩大既有询盘邮件状态机。 decision: sound=no(0.32) covered=no(0.07) pick=A(high 1.00) irreversible=unsure(0.56) agree=yes | E-90、E-91、E-92、E-93、E-94 | 本轮仅需让运营获知新咨询，未要求把聊天通知加入现有邮件管理 UI；ChatNotification 的专属表、作业及审计范围可以独立演进，现有询盘邮件协议不变。 | low |
 | 19 | 官网与后台视觉方向 | sound；Jev低置信选择已采纳；原目录状态覆盖partial，采用项目状态规格补足 | minimalist-flat；前台brand、后台product/后台，共用唯一token文件 | 用户要求调整前端、对标同行并同步后台风格；真实目录3候选交Jev，原样line：design: pick=A(low 0.41) register=brand(high 0.85) stated=yes(0.85) token_only=unsure(0.46) adopt=take(A)；model=jev-1.13.0 | E-21–E-30 | 方向集中token；原目录备用CSS不直接整段注入，缺失状态显式补全；不设真人视觉闸门 | low |
 | 20 | PC内联3D输入控制 | sound；Jev对该局部商品展示语境给commerce低置信分类，不改变官网/后台寄存器或增加结算 | 视口内pointer-down直接捕获当前模型；悬停暂停自动旋转；默认滚轮仍滚页面；显式缩放与Escape退出 | 原话要求鼠标在模型上精准操控，选择直接内联操作；design: pick=A(high 0.80) register=commerce(low 0.39) stated=yes(0.92) token_only=no(0.04) adopt=take(A)；model=jev-1.13.0 | E-97–E-104 | 源码的悬停缩放与共用Canvas是复现输入，不宣称根因已证实；实现需旧版失败/新版通过的真实操控证据 | high |
+| 21 | 既有后台视觉迁移的任务归属 | sound；两种拆分均保留原业务，按领域可独立验收 | 新增5项旧后台视觉任务，最终交付依赖齐备 | 复查确认仅换外壳不能覆盖独立CSS/内联样式；adjudicate: pick=A(low 0.36) spec_change=unsure(0.52) outside_stack=no(0.09) needs_owner=no(0.09) reversible=yes(0.82) adopt=take(A)；model=jev-1.13.0 | E-106–E-110 | 只迁移既有视觉及回归，保持关闭gate与重定向，不新增业务/API；估时未实测 | low |
+| 22 | PDF公司图稿制作与网页集成的分工 | sound；保留所有事实/字标/入口要求，拆开软件产出与消费 | M1-T9制作图稿，M1-T5集成到首页公司摘要/about | 原要求有独立重绘，原任务只列文本；adjudicate: pick=A(low 0.26) spec_change=no(0.26) outside_stack=no(0.28) needs_owner=no(0.17) reversible=yes(0.73) adopt=take(A)；model=jev-1.13.0 | E-111 | 仅选网站所需1–2幅图，不重画整本25页、不虚构企业事实；没有实际图稿和软件源工程不能落地 | low |
````

### 05-附录/23-变更记录.md

````diff
--- before/05-附录/23-变更记录.md
+++ after/05-附录/23-变更记录.md
@@ -3,3 +3,4 @@
 | 版本 | 日期 | 变更内容 | 原因 | 涉及决策 |
 |---|---|---|---|---|
 | 1.0 | 2026-10-19 | 首版24节开发规格、105条边界、78项任务及源驱动阅读器/知识库；明确恢复PR基线、品牌/媒体、账号、人工聊天、分析和运维来源 | 网站改版及运营能力升级；本地文档交付与产品实施分开验收 | 1-20 |
+| 1.1 | 2026-10-19 | 用户复查补齐旧后台视觉覆盖、公司图稿制作与Web消费；新增6任务和6边界，合计84任务/111边界/23路由模式，纠正SSR目录来源及真实3D加载口径 | 原有范围的责任和验收漏项修正，沿用已选StyleKit方向 | 6,19-22 |
````

### 05-附录/24-参考资料.md

````diff
--- before/05-附录/24-参考资料.md
+++ after/05-附录/24-参考资料.md
@@ -15,3 +15,5 @@
 - [StyleKit minimalist-flat原目录](https://www.stylekit.top/api/styles/minimalist-flat/brief)，原件`_run/stylekit-spec.json`、三候选及HTTP来源证据`_run/style-catalog-evidence/`。目录状态覆盖partial，项目适配在11节；不整段注入备用CSS。
 - [TypeSafe文档](https://docs.typesafe.ai/)仅用于文档流程校准；真实model/state哈希/用量在`_run/judgments.jsonl`和`calibration-s2/s4`，产品运行时没有AI判断层或AI客服。
 - 本机unattended-run 1.9.0、StyleKit、diagram-generator、obsidian-vault技能为生成与校准流程来源。Mermaid序列/状态图由离线阅读器内置渲染，ER/数据流保留可编辑源码；未安装外部Mermaid CLI不等于图片已输出。
+
+同行结构的实际观察及本项目采用条款见`_run/benchmark-euproprt-20261019.md`；公司图稿制作、源工程和Web成品归M1-T9，网站消费归M1-T5。
````

### _run/presentation.json

````diff
--- before/_run/presentation.json
+++ after/_run/presentation.json
@@ -27,7 +27,7 @@
         "layout": "沿src/app路由、src/components按品牌/产品/账号/聊天/看板分域、src/lib/client放请求及hooks、src/lib/contracts放同源DTO、src/styles/tokens.css放M1唯一视觉token；既有目录渐进修改，禁止另建应用、全库搬家或在public发布原始附件。",
         "tier": "page/layout负责服务端数据和守卫，container/hook负责请求、状态及取消，展示组件只接DTO与事件，ui只包装原生控件；禁止展示组件直接fetch、client导入server/Prisma、页面跳过服务端权限或业务组件绕过ui重复造通用控件。",
         "ui": "沿React19、现有CSS和原生HTML，通用包装置src/components/ui，领域组件留原域；复用现有焦点/对话框能力，只有已有控件不覆盖的语义才增原生包装；禁止新增组件库、状态库或在领域组件另选slug/色值，第11节统一写现有token文件。",
-        "route": "Next15 App Router不变，src/lib/navigation/routes.ts集中16个本轮路由的路径/入口，src/i18n/routing.ts仍只发布en/ru；后台layout+page+API各自校验，登录/受限恢复在admin布局外；禁止把品类slug当完整PDP、开放新语言或绕过既有品类上线开关。",
+        "route": "Next15 App Router不变，src/lib/navigation/routes.ts集中23个本轮路由的路径/入口，src/i18n/routing.ts仍只发布en/ru；后台layout+page+API各自校验，登录/受限恢复在admin布局外；禁止把品类slug当完整PDP、开放新语言或绕过既有品类上线开关。",
         "state": "仅React state/reducer/ref/context与native fetch；全局只放非秘密同意状态、既有询盘清单及必要UI状态，服务结果按页面查询键保留内存快照并显式失效；禁止TanStack/Zustand、持久化正文/邮箱/凭据、轮询续闲置、旧响应倒退seq或跨账号复用缓存。",
         "api": "新请求由src/lib/client/api.ts及account/chat/analytics/ops客户端模块消费10节DTO，15s AbortController、same-origin/no-store，兼容旧{error}；Auth.js仍用原CSRF/signIn/signOut协议；只对10节允许的消息写复用UUID退避重试，禁止自动重试一次性授权/恢复/CAS写或新增便捷endpoint。",
         "utils": "无IO纯函数留src/lib/client纯转换模块及既有lib/a11y、three、quote、chat/rules、analytics/rules；seq合并/日期标签/字段显示可纯化；禁止utils读取env、发请求、持有当前账号/草稿、决定权限或把浏览器本地午夜当站点统计边界。",
@@ -102,7 +102,7 @@
       ]
     },
     "stack": "TypeScript / Next.js 15 / React 19 / Auth.js / Prisma PostgreSQL / next-intl / React Three Fiber；现有CSS与原生控件，不接线上AI判断层",
-    "conventions": "本项目使用Next App Router，无hash路由；通用交接提示中的#/（首页）在本项目执行/en或/ru可见导航，不引入hash router。新增API信封和DTO遵06/10；既有Auth.js协议保持。源数据/素材未验证不冒充已完成。 混合模块M3/M4/M5的具体UI任务显式引用07/11/12、stylekit与record-browser-gif；后台逐页测D1–D6，沿唯一minimalist-flat及11值不重搜。 M1-T1工作树创建后先从本机task/docs-s2-s6导入docs/PackJoyU-开发文档、AGENTS.md、CLAUDE.md，作为首PR基线；其他任务等其落地后从origin/main创建。文档未上传远端，不假定origin已有。后台探针用真实登录cookie，禁止注入认证存储，CLI不能真实登录时在已登录页面调用探针导出测量。 原语completionStage只做本卡规则/DB层证据，完整可见入口/真实GIF/密度归其integrationTask；通用GUI模板按当前完成阶段解释，最终集成不免验。",
+    "conventions": "本项目使用Next App Router，无hash路由；通用交接提示中的#/（首页）在本项目执行/en或/ru可见导航，不引入hash router。新增API信封和DTO遵06/10；既有Auth.js协议保持。源数据/素材未验证不冒充已完成。 混合模块M3/M4/M5的具体UI任务显式引用07/11/12、stylekit与record-browser-gif；后台逐页测D1–D6，沿唯一minimalist-flat及11值不重搜。 M1-T1工作树创建后先从本机task/docs-s2-s6导入docs/PackJoyU-开发文档、AGENTS.md、CLAUDE.md，作为首PR基线；其他任务等其落地后从origin/main创建。文档未上传远端，不假定origin已有。后台探针用真实登录cookie，禁止注入认证存储，CLI不能真实登录时在已登录页面调用探针导出测量。 原语completionStage只做本卡规则/DB层证据，完整可见入口/真实GIF/密度归其integrationTask；通用GUI模板按当前完成阶段解释，最终集成不免验。 “逐页”指本卡实际产出的页面或区域；增量任务仅验新增控件、布局和与现有页面的接缝，未迁移的旧内层不得称视觉通过。M3-T7验壳导航、外框、活动和退出；M3-T9验恢复授权区域；M5-T10验analytics分区。既有业务完整页由M3-T21至T25逐页验收，最终M7-T9汇总，完整GUI、D1–D6与overflow标准不减。",
     "design": {
       "register": "brand",
       "style": "`minimalist-flat` — 以黑白平面、清楚边界和单一强调色承托生产视频、包装与3D，前后台共享方向，页面按用途分配密度。",
@@ -157,7 +157,8 @@
         "messages/en.json",
         "messages/ru.json",
         "docs/brand-content/",
-        "e2e/company-content.spec.ts"
+        "e2e/company-content.spec.ts",
+        "src/lib/brand/company-media.ts"
       ],
       "M1-T6": [
         "public/brand/",
@@ -542,6 +543,50 @@
       "M7-T9": [
         "docs/acceptance/delivery/",
         "e2e/delivery-smoke.spec.ts"
+      ],
+      "M1-T9": [
+        "public/brand/company/",
+        "docs/brand-content/source/",
+        "docs/brand-content/company-visuals.json"
+      ],
+      "M3-T21": [
+        "src/components/admin/InquiryList.tsx",
+        "src/components/admin/InquiryDetail.tsx",
+        "src/components/admin/InquiryHistory.tsx",
+        "src/components/admin/InquiryNotFound.tsx",
+        "src/components/admin/StatusBadge.tsx",
+        "src/components/admin/DateRange.tsx",
+        "src/components/admin/anonymized.tsx",
+        "src/components/admin/mail/MailThread.tsx",
+        "src/components/admin/mail/MailParts.tsx",
+        "src/app/admin/admin.css",
+        "src/app/admin/mail.css"
+      ],
+      "M3-T22": [
+        "src/components/admin/mail/UnassignedInbox.tsx",
+        "src/components/admin/mail/UnassignedNav.tsx",
+        "src/app/admin/mail.css"
+      ],
+      "M3-T23": [
+        "src/components/admin/models/ModelUpload.tsx",
+        "src/components/admin/models/ModelPreview.tsx",
+        "src/components/admin/models/models.css"
+      ],
+      "M3-T24": [
+        "src/components/admin/specs/SpecEditor.tsx",
+        "src/components/admin/specs/specs.css",
+        "src/app/admin/specs/page.tsx"
+      ],
+      "M3-T25": [
+        "src/components/admin/settings/settings.css",
+        "src/components/admin/settings/about-images.css",
+        "src/components/admin/settings/AboutSettings.tsx",
+        "src/components/admin/settings/OrgSettings.tsx",
+        "src/components/admin/settings/AboutImages.tsx",
+        "src/components/admin/settings/ImageTextField.tsx",
+        "src/components/admin/settings/ConfirmDialog.tsx",
+        "src/components/admin/settings/SettingsSections.tsx",
+        "src/components/admin/users/UsersAdmin.tsx"
       ]
     },
     "taskSkills": {
@@ -695,12 +740,12 @@
         {
           "name": "stylekit",
           "when": "实施/审查本卡UI及集成时",
-          "why": "消费唯一minimalist-flat与11，不重搜slug；必读07/11/12。前台brand、后台product；后台gutter/gap/pad16、row40、control36/触屏44，work铺满/form左对齐/card≤520，三尺寸D1–D6/overflow。原语只验本层，完整界面证据归integrationTask。"
-        },
-        {
-          "name": "record-browser-gif",
-          "when": "验收真实页面交互时",
-          "why": "真实服务、真实登录/数据，记录可见入口与点击请求、computed style和密度JSON；未完成集成不称页面完成。"
+          "why": "消费唯一minimalist-flat与11，不重搜slug；必读07/11/12。前台brand、后台product；后台gutter/gap/pad16、row40、control36/触屏44，work铺满/form左对齐/card≤520，三尺寸D1–D6/overflow。原语只验本层，完整界面证据归integrationTask。 本卡验收范围为壳导航、外框、活动和退出；如旧内层未迁移据实列出，完整页视觉和密度由M3-T21至T25及M7-T9完成，不在壳任务冒称全后台通过。"
+        },
+        {
+          "name": "record-browser-gif",
+          "when": "验收真实页面交互时",
+          "why": "真实服务、真实登录/数据，记录可见入口与点击请求、computed style和密度JSON；未完成集成不称页面完成。 本卡验收范围为壳导航、外框、活动和退出；如旧内层未迁移据实列出，完整页视觉和密度由M3-T21至T25及M7-T9完成，不在壳任务冒称全后台通过。"
         }
       ],
       "M3-T8": [
@@ -953,6 +998,73 @@
           "name": "record-browser-gif",
           "when": "验收真实页面交互时",
           "why": "真实服务、真实登录/数据，记录可见入口与点击请求、computed style和密度JSON；未完成集成不称页面完成。"
+        }
+      ],
+      "M3-T21": [
+        {
+          "name": "stylekit",
+          "when": "实施与审查视觉迁移时",
+          "why": "必读07/11/12，只消费锁定minimalist-flat；后台product密度D1–D6/overflow，不重搜slug。"
+        },
+        {
+          "name": "record-browser-gif",
+          "when": "真实可见入口验收时",
+          "why": "真实服务/登录/原HTTP、三尺寸computed style和密度；关闭gate不伪造可见或通过。"
+        }
+      ],
+      "M3-T22": [
+        {
+          "name": "stylekit",
+          "when": "实施与审查视觉迁移时",
+          "why": "必读07/11/12，只消费锁定minimalist-flat；后台product密度D1–D6/overflow，不重搜slug。"
+        },
+        {
+          "name": "record-browser-gif",
+          "when": "真实可见入口验收时",
+          "why": "真实服务/登录/原HTTP、三尺寸computed style和密度；关闭gate不伪造可见或通过。"
+        }
+      ],
+      "M3-T23": [
+        {
+          "name": "stylekit",
+          "when": "实施与审查视觉迁移时",
+          "why": "必读07/11/12，只消费锁定minimalist-flat；后台product密度D1–D6/overflow，不重搜slug。"
+        },
+        {
+          "name": "record-browser-gif",
+          "when": "真实可见入口验收时",
+          "why": "真实服务/登录/原HTTP、三尺寸computed style和密度；关闭gate不伪造可见或通过。"
+        }
+      ],
+      "M3-T24": [
+        {
+          "name": "stylekit",
+          "when": "实施与审查视觉迁移时",
+          "why": "必读07/11/12，只消费锁定minimalist-flat；后台product密度D1–D6/overflow，不重搜slug。"
+        },
+        {
+          "name": "record-browser-gif",
+          "when": "真实可见入口验收时",
+          "why": "真实服务/登录/原HTTP、三尺寸computed style和密度；关闭gate不伪造可见或通过。"
+        }
+      ],
+      "M3-T25": [
+        {
+          "name": "stylekit",
+          "when": "实施与审查视觉迁移时",
+          "why": "必读07/11/12，只消费锁定minimalist-flat；后台product密度D1–D6/overflow，不重搜slug。"
+        },
+        {
+          "name": "record-browser-gif",
+          "when": "真实可见入口验收时",
+          "why": "真实服务/登录/原HTTP、三尺寸computed style和密度；关闭gate不伪造可见或通过。"
+        }
+      ],
+      "M1-T9": [
+        {
+          "name": "computer-use:computer-use",
+          "when": "授权GPT Dot素材制作通道可达时",
+          "why": "只用现有授权远程软件与同一brand-logo-master制作所需图稿；实际调用/软件/工程/Web成品逐件留证。缺产物不得落地，不新购软件或重建GLB。"
         }
       ]
     }
````

### _run/task-contracts.json

````diff
--- before/_run/task-contracts.json
+++ after/_run/task-contracts.json
@@ -76,7 +76,8 @@
     },
     "M1-T3": {
       "provides": [
-        "brand-static-media"
+        "brand-static-media",
+        "brand-logo-master"
       ],
       "requires": [
         {
@@ -161,6 +162,10 @@
         {
           "task": "M1-T4",
           "capability": "home-media"
+        },
+        {
+          "task": "M1-T9",
+          "capability": "company-visual-assets"
         }
       ],
       "stage": "integration",
@@ -174,7 +179,8 @@
         "messages/en.json",
         "messages/ru.json",
         "docs/brand-content/",
-        "e2e/company-content.spec.ts"
+        "e2e/company-content.spec.ts",
+        "src/lib/brand/company-media.ts"
       ],
       "sections": [
         1,
@@ -201,6 +207,10 @@
         {
           "task": "M1-T3",
           "capability": "brand-static-media"
+        },
+        {
+          "task": "M1-T3",
+          "capability": "brand-logo-master"
         }
       ],
       "stage": "integration",
@@ -3418,6 +3428,26 @@
         {
           "task": "M7-T8",
           "capability": "provenance-acceptance"
+        },
+        {
+          "task": "M3-T21",
+          "capability": "legacy-inquiries-ui"
+        },
+        {
+          "task": "M3-T22",
+          "capability": "legacy-unassigned-ui"
+        },
+        {
+          "task": "M3-T23",
+          "capability": "legacy-model-admin-ui"
+        },
+        {
+          "task": "M3-T24",
+          "capability": "legacy-specs-ui"
+        },
+        {
+          "task": "M3-T25",
+          "capability": "legacy-settings-users-ui"
         }
       ],
       "stage": "integration",
@@ -3438,6 +3468,271 @@
         10,
         14,
         16,
+        17,
+        18
+      ]
+    },
+    "M1-T9": {
+      "provides": [
+        "company-visual-assets"
+      ],
+      "requires": [
+        {
+          "task": "M1-T1",
+          "capability": "visual-base"
+        },
+        {
+          "task": "M1-T3",
+          "capability": "brand-logo-master"
+        }
+      ],
+      "supportPaths": [],
+      "stage": "primitive",
+      "wiring": [],
+      "outputPaths": [
+        "public/brand/company/",
+        "docs/brand-content/source/",
+        "docs/brand-content/company-visuals.json"
+      ],
+      "sections": [
+        1,
+        2,
+        4,
+        5,
+        6,
+        11,
+        14,
+        17,
+        18
+      ],
+      "integrationTask": "M1-T5"
+    },
+    "M3-T21": {
+      "provides": [
+        "legacy-inquiries-ui"
+      ],
+      "requires": [
+        {
+          "task": "M1-T7",
+          "capability": "visual-components"
+        },
+        {
+          "task": "M3-T7",
+          "capability": "admin-shell"
+        }
+      ],
+      "supportPaths": [
+        "e2e/admin-legacy-inquiries-visual.spec.ts",
+        "tests/admin-legacy-inquiries-style.test.ts"
+      ],
+      "stage": "integration",
+      "wiring": [],
+      "outputPaths": [
+        "src/components/admin/InquiryList.tsx",
+        "src/components/admin/InquiryDetail.tsx",
+        "src/components/admin/InquiryHistory.tsx",
+        "src/components/admin/InquiryNotFound.tsx",
+        "src/components/admin/StatusBadge.tsx",
+        "src/components/admin/DateRange.tsx",
+        "src/components/admin/anonymized.tsx",
+        "src/components/admin/mail/MailThread.tsx",
+        "src/components/admin/mail/MailParts.tsx",
+        "src/app/admin/admin.css",
+        "src/app/admin/mail.css"
+      ],
+      "sections": [
+        1,
+        2,
+        4,
+        5,
+        6,
+        7,
+        10,
+        11,
+        12,
+        14,
+        17,
+        18
+      ]
+    },
+    "M3-T22": {
+      "provides": [
+        "legacy-unassigned-ui"
+      ],
+      "requires": [
+        {
+          "task": "M1-T7",
+          "capability": "visual-components"
+        },
+        {
+          "task": "M3-T7",
+          "capability": "admin-shell"
+        },
+        {
+          "task": "M3-T21",
+          "capability": "legacy-inquiries-ui"
+        }
+      ],
+      "supportPaths": [
+        "e2e/admin-legacy-unassigned-gate.spec.ts",
+        "tests/admin-legacy-unassigned-style.test.ts"
+      ],
+      "stage": "integration",
+      "wiring": [],
+      "outputPaths": [
+        "src/components/admin/mail/UnassignedInbox.tsx",
+        "src/components/admin/mail/UnassignedNav.tsx",
+        "src/app/admin/mail.css"
+      ],
+      "sections": [
+        1,
+        2,
+        4,
+        5,
+        6,
+        7,
+        10,
+        11,
+        12,
+        14,
+        17,
+        18
+      ]
+    },
+    "M3-T23": {
+      "provides": [
+        "legacy-model-admin-ui"
+      ],
+      "requires": [
+        {
+          "task": "M1-T7",
+          "capability": "visual-components"
+        },
+        {
+          "task": "M3-T7",
+          "capability": "admin-shell"
+        }
+      ],
+      "supportPaths": [
+        "e2e/admin-legacy-model-visual.spec.ts",
+        "tests/admin-legacy-model-style.test.ts"
+      ],
+      "stage": "integration",
+      "wiring": [],
+      "outputPaths": [
+        "src/components/admin/models/ModelUpload.tsx",
+        "src/components/admin/models/ModelPreview.tsx",
+        "src/components/admin/models/models.css"
+      ],
+      "sections": [
+        1,
+        2,
+        4,
+        5,
+        6,
+        7,
+        10,
+        11,
+        12,
+        14,
+        17,
+        18
+      ]
+    },
+    "M3-T24": {
+      "provides": [
+        "legacy-specs-ui"
+      ],
+      "requires": [
+        {
+          "task": "M1-T7",
+          "capability": "visual-components"
+        },
+        {
+          "task": "M3-T7",
+          "capability": "admin-shell"
+        }
+      ],
+      "supportPaths": [
+        "e2e/admin-legacy-specs-visual.spec.ts",
+        "tests/admin-legacy-specs-style.test.ts"
+      ],
+      "stage": "integration",
+      "wiring": [],
+      "outputPaths": [
+        "src/components/admin/specs/SpecEditor.tsx",
+        "src/components/admin/specs/specs.css",
+        "src/app/admin/specs/page.tsx"
+      ],
+      "sections": [
+        1,
+        2,
+        4,
+        5,
+        6,
+        7,
+        10,
+        11,
+        12,
+        14,
+        17,
+        18
+      ]
+    },
+    "M3-T25": {
+      "provides": [
+        "legacy-settings-users-ui"
+      ],
+      "requires": [
+        {
+          "task": "M1-T7",
+          "capability": "visual-components"
+        },
+        {
+          "task": "M3-T7",
+          "capability": "admin-shell"
+        },
+        {
+          "task": "M3-T9",
+          "capability": "target-recovery-ui"
+        },
+        {
+          "task": "M5-T10",
+          "capability": "analytics-settings-ui"
+        },
+        {
+          "task": "M1-T5",
+          "capability": "company-content"
+        }
+      ],
+      "supportPaths": [
+        "e2e/admin-legacy-settings-users-visual.spec.ts",
+        "tests/admin-legacy-settings-users-style.test.ts"
+      ],
+      "stage": "integration",
+      "wiring": [],
+      "outputPaths": [
+        "src/components/admin/settings/settings.css",
+        "src/components/admin/settings/about-images.css",
+        "src/components/admin/settings/AboutSettings.tsx",
+        "src/components/admin/settings/OrgSettings.tsx",
+        "src/components/admin/settings/AboutImages.tsx",
+        "src/components/admin/settings/ImageTextField.tsx",
+        "src/components/admin/settings/ConfirmDialog.tsx",
+        "src/components/admin/settings/SettingsSections.tsx",
+        "src/components/admin/users/UsersAdmin.tsx"
+      ],
+      "sections": [
+        1,
+        2,
+        4,
+        5,
+        6,
+        7,
+        10,
+        11,
+        12,
+        14,
         17,
         18
       ]
````

新旧任务契约在同名 JSON 的 changes、源条款在 sourceChanges。只复验变化及其影响，不重新初始化分支。

## 原任务续做

# 继续原任务 M1-T5：集成己方公司内容与独立图稿
沿用分支 task/M1-T5、现有工作树和原 PR；不要创建新任务或重新初始化分支。
任务契约版本：18602e1a4b760a19c3907ba9e87adbb43d37e40bbd27e92767f9eca031d27653
读取 _run/patches/ 中本次补丁的差异和复验清单，只处理列出的条目及其直接影响。没有差异说明时先核对现有 PR 的返工记录，不按完整实施流程重做。
修正后的验收：
1) 为每个对外公司硬事实建立“页面字段→己方证据文件/页码”对照
无己方证据的YUHAO认证/产能/工厂规模不得出现在成品文案或图片
PDF仅作结构/产品主题参考，自动检索加逐字段对照均无改名冒用（E-27）。2) 成品引用的logo哈希等于现用PackJoyU字标，不使用候选新标
不等待用户回看候选图，PDF指令不作执行授权（E-28）。3) 真浏览器点about-link→/[locale]/about、footer联系/隐私→对应路由，en/ru切换保持对应页
发布开关关闭时仍404，开时SSR SiteSetting/Sanity显示与事实对照表一致，改动页全部有导航证据。
4) 消费M1-T9的company-visual-assets，为已选图稿建立src/lib/brand/company-media.ts安全发布映射，仅输出/brand/company/下已核哈希的Web路径、正整数宽高及en/ru alt
拒绝外部URL、越界路径、源工程路径和文件系统地址，不把工程、私有路径或制作凭据下发浏览器。逐件核manifest中的成品与现用字标哈希、制作证据和完成状态
素材未完成时本集成项不能通过（E-29、E-111）。5) en/ru真实首页公司摘要及about消费相同已审映射，真实浏览器从可见入口进入，网络加载Web图路径/文件哈希与清单一致
alt按语言匹配，1920/1440/390尺寸下主体完整、无横向溢出。保存参考主题/己方事实→源工程/成品→映射→路由/组件的追溯证据
仅有资料目录文件不算页面完成，源工程不进public或生产镜像（E-111）。
6) 安全映射只提取已核Web路径、尺寸、alt
不在生产运行时import原docs manifest或工程/制作记录，不把含私有源路径的原JSON打包
浏览器产物和运行镜像检查均无源工程及私有路径。
有效范围：
docs/brand-content/
e2e/company-content.spec.ts
messages/en.json
messages/ru.json
src/app/
src/app/admin-enroll/
src/app/admin-login/
src/app/admin-recovery/
src/app/admin/account/
src/app/admin/chat/
src/app/admin/settings/
src/app/admin/stats/
src/app/admin/users/
src/components/about/
src/components/admin/AdminShell.tsx
src/components/layout/SiteFooter.tsx
src/components/layout/SiteHeader.tsx
src/i18n/navigation.ts
src/i18n/routing.ts
src/lib/brand/company-media.ts
src/lib/navigation/routes.ts
保留已有代码和回填；修改后运行必要检查、追加提交并 push，继续原 PR 审查。
## 自行裁决：交 Jev，不交用户
实施、审查、查 bug、批次收口过程中出现的每一条「自行裁决」，以及验收冲突、文档缺口、栈外依赖、UI/UX 未定项，都先列出 2–5 个真实可行的选项；不能把你想要的答案当唯一候选。
把原始需求、任务标题与验收、冲突和选项忠实译成英文写入 state.json（文档与回报仍用中文）；UI/UX 取舍使用 design，其余使用 adjudicate。
运行 python "docs/PackJoyU-开发文档/_run/typesafe_ask.py" --log "docs/PackJoyU-开发文档/_run/judgments.jsonl" --label "M1-T5:resume" run adjudicate --state <state.json>；UI/UX 将 adjudicate 换成 design。若 language_warning 提示中文过多，重译后重跑。
仅 status=ok 且 verdicts.adopt.action=take 才按 option 执行；confidence=low 仍用 Jev 的 option，记低置信风险。spec_change=yes 走文档补丁，outside_stack=yes 在回报点名，不自动扩权。
adopt=red_line 仅涉及付费、不可逆删除、改变已定范围或对外承诺时请求用户授权；status=skipped/error 或缺有效 pick 时留下待 Jev 裁决，不得由人代答、判 pass、声称已落地或写 clean/fixed。
回报逐条写：冲突 → 全部候选 → Jev line/model/采纳的 option → 代码或文档动作；没有写「无」。
