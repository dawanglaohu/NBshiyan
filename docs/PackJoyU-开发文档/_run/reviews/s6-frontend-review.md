# S6 前端文档契约审查（第1轮）

VERDICT: revise。33个任务逐卡阅读当前派发包，19项pass、14项revise；仅审规格可实施性，未运行产品、未登记verify、未执行TypeSafe、未修改源或提交。

源版本：`85d042c28b91ac1bcc11b51b89285c0177cc894663e22201484a6b110d204272`。每卡执行`maintain_docs.py ... status --task <ID>`，33个current contractHash与dispatch一致；stale/runtimeDrift/结构blockers为空。status退出1是语义登记尚未完成，不能把它称产品测试失败或通过。逐卡证据在`s6-frontend-evidence.json`，原status输出在`s6-frontend-status.json`。

## 阻断及最小修法

### F01 产品咨询集成缺少人工回复UI提供方

影响：M2-T8。

定位：04-执行/19-模块任务拆分.md:26；_run/task-contracts.json:tasks.M2-T8.requires；_run/dispatch.json:tasks.M2-T8.implementation/前置与验收标准。

验收要求运营从真实收件箱人工回复、访客收到同一回复；前置闭包仅有M4-T6只读会话UI和M4-T11写API，没有M4-T14的OperatorReplyComposer/CloseConversation。该控件域又不在M2-T8主范围内，不能让产品任务重造它。

修法：M2-T8增加M4-T14依赖和requires chat-human-roundtrip-ui，保留原产品上下文与双端验收。

### F02 时区表单的领域客户端落点不在有效范围

影响：M5-T10。

定位：02-设计/07-前端架构.md:158；04-执行/19-模块任务拆分.md:71；_run/task-contracts.json:tasks.M5-T10.supportPaths；_run/dispatch.json:tasks.M5-T10.implementation/只改这些路径。

07规定settings/analytics由src/lib/client/ops.ts消费DTO。M5-T10要GET/PATCH时区但其taskPaths/supportPaths/frontendRoutes展开均不含该文件；只有后续M6-T4当前列出ops.ts。直接在展示件fetch会违反07分层。

修法：为M5-T10补src/lib/client/ops.ts范围，明确本卡拥有settings/analytics方法，M6-T4追加stats方法；保留统一M1-T8请求基础，不新增API。

### F03 部分UI闭包只有8个核心token，没有完整视觉组件提供方

影响：M3-T6, M3-T7, M3-T8, M3-T9, M3-T10, M3-T11, M3-T12, M3-T13, M4-T15。

定位：04-执行/19-模块任务拆分.md:11；04-执行/19-模块任务拆分.md:17；04-执行/19-模块任务拆分.md:32；04-执行/19-模块任务拆分.md:61；02-设计/07-前端架构.md:49；02-设计/07-前端架构.md:56；02-设计/07-前端架构.md:62。

M1-T1仅8个核心token；M1-T7才交完整token与Button/Input/Dialog/Status。当前M3-T6及所列M3后继、M4-T15的前置闭包均无M1-T7，UI却须满足11完整状态/密度并使用共享包装，其有效范围不允许另写ui/或tokens.css。其他M4/M6目标卡的闭包已有M1-T7。

修法：在首个M3 UI的前置加M1-T7/visual-components，并给M4-T15增加同一提供方；后继通过闭包继承，不重做控件或第二套token。

### F04 库级HTTP适配器被标为产品集成完成

影响：M1-T2, M1-T8。

定位：04-执行/19-模块任务拆分.md:12；04-执行/19-模块任务拆分.md:18；_run/task-contracts.json:tasks.M1-T2.integrationTask；_run/task-contracts.json:tasks.M1-T8.stage。

M1-T8只交api/error helpers和独立本地HTTP测试；该卡没有产品调用者或装配验收，当前integration阶段过度声明。M1-T2又以这张库卡作为integrationTask，未落到产品调用。Auth.js登录原协议特意不经过通用JSON适配器，因此M3-T6仅有GET account测试不能保证其为首个通用client生产调用者。

修法：M1-T8设primitive，integrationTask=M3-T7，以AdminSessionActivity/account客户端生产请求验取消/DTO/error。M1-T2的integrationTask指M3-T1真实Auth.js/账户HTTP消费者；相应M3-T14若只做基础也按阶段收敛，不靠helper测试称网站接线。

### F05 自定义登录的默认成功目标尚未交付，直接补依赖会成环

影响：M3-T6, M3-T7。

定位：02-设计/07-前端架构.md:70；04-执行/19-模块任务拆分.md:32；04-执行/19-模块任务拆分.md:33；04-执行/19-模块任务拆分.md:76；_run/dispatch.json:tasks.M3-T6.implementation/相关契约及验收。

07把空/default /admin回跳归一为所有角色可见的/admin/stats；实际stats页由M6-T4交付，其依赖M3-T7，而T7当前依赖T6。T6的完整成功导航无法在当前前置下证明，不能把404称登录成功。

修法：移除M3-T7→M3-T6及admin-auth-ui require，T7改在现有Auth.js密码+TOTP真实登录链上先交，保留T15并依赖T2/完整视觉基础；T6增加M6-T4/stats-base-ui，实际默认跳转后GET stats和可见页面通过。当前19 DAG实算该改法无环，服务不反调M6，仅UI目标可见性有序。

### F06 布局任务被整条边界注入要求后继指针与复位能力

影响：M2-T1。

定位：04-执行/19-模块任务拆分.md:19；04-执行/19-模块任务拆分.md:20；04-执行/19-模块任务拆分.md:21；_run/dispatch.json:tasks.M2-T1.implementation/必须处理的边界。

M2-T1只交大卡和独立链接/动作区，但E-97/E-104整条注入还要求跨卡pointer capture、无hover几何缩放、任意操控后复位。这些是依赖T1的M2-T2/T3唯一交付职责。按提示必须整条兜底会迫使T1提前重做后继或接受未完成能力。

修法：T1保留全部局部布局、不导航和内容可辨承诺，去掉E-97/E-104整条覆盖标签；完整E97留T2、E104留T3，保持全局覆盖。

## 已核对的共同契约

- 07:74–114与11:9–26各有同一16个路由模式；公开6页、登录/首次绑定/独立恢复3页、账号/设备2页、收件/正文2页、stats/settings/users3页都有源控件和权限。产品品类壳保持原开关，不新增PDP或语言。参数路由从真实品类链接/会话行进入。
- 06:41–55共享errors/env/types/naming由同源presentation镜像；07:49–64分层要求组件不直fetch/server，10的Auth.js原协议和新增DTO信封分开。UI字段包括rememberDevice=false、6位totp、grant purpose/target、UUID/seq、expectedVersion、timezoneRevision、独立dataThrough/lastSucceededAt均能追到相应provider；F02是漏列客户端路径，F01是漏列回复UI。
- 10首表及_run/endpoints-contract.json均为37个逐方法记录；docs-data.js的data.endpoints也是37项。Auth.js与mail-queue GET/POST各为两条，不丢读写索引。注册表无judgments，应用没有线上AI判断或AI聊天。
- 11:38–67明确raw StyleKit获取成功但readiness=fallback、states partial、dark missing；只交light。自定disabled/focus/状态表与密度是项目适配，未冒充目录原值，不直接注入冲突globalCss。11:190–232/17密度表和探针work/form/card一致；桌面gutter/gap/pad16不大于手机，单卡和手机按工具真实n/a，不强造全pass。
- 对所有实际UI卡核了最终implementation文本，唯一minimalist-flat、07/11/12、stylekit/GIF、1920×1080/1440×900/390×844及后台D1–D6/overflow均已写入。混合M3/M4/M5虽角色模板仍叫后端工程师，但taskSkills显式必读前端章节、契约sections也有07/11/12，因此不是“未锁风格/架构”；无需为分类标签改模块。
- M1-T7和M2-T4的primitive→integrationTask及真正消费者依赖正确；M1-T2/M1-T8存在F04阶段缺口。三维直接捕获、普通wheel滚页、明确缩放、可取消输入、两相邻卡实际命中、静态回退不记GLB success在11/12/17和M2包中一致。
- 17:层次证据/主冒烟要求真实服务、产品入口与请求；禁止认证存储注入/直改业务数字/拦截本应用API造闭环。后台cookie/密码/恢复秘密仅内存，截图/GIF禁泄漏秘密。来源和素材本轮尚未实施，GPT Dot不可达应保持具体未完成项，不可借文档生成声称制作成功。

## 逐任务结论

| 任务 | 结论 | 阻断 |
|---|---|---|
| M1-T1 | pass | — |
| M1-T2 | revise | F04 |
| M1-T3 | pass | — |
| M1-T4 | pass | — |
| M1-T5 | pass | — |
| M1-T6 | pass | — |
| M1-T7 | pass | — |
| M1-T8 | revise | F04 |
| M2-T1 | revise | F06 |
| M2-T2 | pass | — |
| M2-T3 | pass | — |
| M2-T4 | pass | — |
| M2-T5 | pass | — |
| M2-T6 | pass | — |
| M2-T7 | pass | — |
| M2-T8 | revise | F01 |
| M3-T6 | revise | F03, F05 |
| M3-T7 | revise | F03, F05 |
| M3-T8 | revise | F03 |
| M3-T9 | revise | F03 |
| M3-T10 | revise | F03 |
| M3-T11 | revise | F03 |
| M3-T12 | revise | F03 |
| M3-T13 | revise | F03 |
| M4-T5 | pass | — |
| M4-T6 | pass | — |
| M4-T9 | pass | — |
| M4-T14 | pass | — |
| M4-T15 | revise | F03 |
| M5-T7 | pass | — |
| M5-T10 | revise | F02 |
| M6-T4 | pass | — |
| M6-T7 | pass | — |

## 非阻断说明

- frontendRoutes把无方括号父目录src/app/纳入effectivePaths，会使部分前端任务保守串行；06已明示该代价，不能据此声称精确细粒度并行。当前没有为省冲突删注册点。
- 估时与通用模型的size意见不代替任务职责审查。已实质拆分的一轮保留证据；本轮仅列具体生产caller、provider/范围和阶段矛盾，不依据分数继续无限拆卡。
- 首轮明确阻断修完后，只对变化条款及其哈希传播的任务做第2轮；其余本轮证据保留。缺省回跳的建议图在当前19 DAG验证无环，不能通过404/空页面或删成功导航验收规避。
