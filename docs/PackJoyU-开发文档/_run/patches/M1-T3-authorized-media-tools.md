# 文档补丁 M1-T3-authorized-media-tools

任务：M1-T3
原分支：task/M1-T3
原 PR：397
依据：用户明确素材已单独制作且未使用Dot；实际制作渠道已留证，旧条款不应将未用Dot本身视为未完成。保留成品、身份与哈希验收。

## 差异与复验范围

- M1-T3：task
- M1-T4：上游契约变化或本次审查目标
- M1-T5：上游契约变化或本次审查目标
- M1-T6：task
- M1-T9：上游契约变化或本次审查目标
- M2-T1：上游契约变化或本次审查目标
- M2-T2：上游契约变化或本次审查目标
- M2-T3：上游契约变化或本次审查目标
- M2-T5：上游契约变化或本次审查目标
- M2-T6：上游契约变化或本次审查目标
- M2-T7：上游契约变化或本次审查目标
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
- M6-T6：上游契约变化或本次审查目标
- M6-T7：上游契约变化或本次审查目标
- M7-T1：上游契约变化或本次审查目标
- M7-T2：上游契约变化或本次审查目标
- M7-T3：上游契约变化或本次审查目标
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
@@ -10,10 +10,10 @@
 |---|---|---|---|---|---|---|---|
 | M1-T1 | 接入8个核心品牌变量及既有路径真实冒烟 | M1 | 无 | 现有首页、GET /api/models、WebVitals/RUM；11节核心变量；本地main中的已审规格基线 | visual-base的8个核心变量；runnable-smoke；含已审文档基线的实施PR与CI冒烟 | 1) 仅将背景、前景、强调色、边界宽度、圆角、基础字号、正文行高、焦点颜色8个核心token接入现有首页，不建立新页面或新业务控件；构建/启动真实standalone，从header产品链接进入产品页，computed style逐一等于11节取值；目录沿SSR loadCatalog(listPublishedModels)，冒烟另作真实HTTP GET /api/models兼容校验，不给产品页增加重复fetch。2) 真实首页WebVitals触发POST /api/rum并核204和脱敏日志，CI起同一服务运行此浏览器冒烟。3) 若origin/main尚无本地已审文档，本PR带上从本地main导入的规格；远端已含时沿用，不重复覆盖。后续任务从首PR落地的远端主干基线建分支。 | 2d |
 | M1-T2 | 导出新增领域共享schema与DTO | M1 | M1-T1 | 06/09/10节字段契约、Auth.js既有错误协议及visual-base基线 | contract-types；account/recovery/chat/analytics/ops/errors schema与公共index导出 | 1) 逐字段对照10节建立严格Zod请求/响应schema，类型仅由schema导出，公共index能被独立TypeScript消费，未知字段和超界字段拒绝。2) LoginMode只接password/totp；rememberDevice缺值、布尔false、字面false均解析false，其他非法值拒绝（E-95）。 | 1.5d |
-| M1-T3 | 制作JPG换标及视频海报发布副本 | M1 | M1-T1 | 桌面原JPG/视频、现用PackJoyU字标、来源与原件哈希登记 | brand-static-media；换标JPG、视频语义海报及压缩视频副本、哈希/对照清单 brand-logo-master；从当前SiteHeader字标/icon.svg导出的现用品牌基准文件public/brand/packjoyu-logo-master.svg及来源/导出哈希。 | 1) 原JPG/视频哈希不变，输出文件均可解码；将JPG飞艇与工厂墙面的旧标逐处列入清单并以现用PackJoyU字标完整替换，清单逐处核无旧标，视频海报取自其自身画面且带可核帧时刻；对全片所有公司名称、logo、片头/片尾及水印列时间点清单，片头/片尾/水印等企业署名与己方身份不符或依据缺失时该发布副本不入成品并报告；真实场景中的设备商标只记录，不自动当企业署名或擅自抹除，不修改原视频、不擅自重剪。2) 即使候选设计与线上字标不同仍使用当前PackJoyU字标，记录所用标识文件哈希；不等待用户回看候选图，不把候选当已批准新logo（E-28）。3) GPT Dot可达且实际制作时保留调用、软件操作、输出文件和成品核对记录；不可达则逐项写尚未执行/实施任务且该项不称完成，不伪称调用成功（E-29）。 4) 先核项目当前SiteHeader字标、样式/字体和icon.svg来源，导出可供软件导入的现用完整字标master，记录源文件与导出文件SHA256，逐项核字形、比例、颜色与当前标识一致；不重新设计候选标、不修改源字标或图标。SVG不得含script、外部引用或私有元数据；后继T6/T9只引用此已核master。 5) docs/brand-media/static/brand-static-media.json逐文件登记path/sha256/width/height并与实际解码/哈希逐值核对；logoMaster登记sourceFiles的path/sha256、导出path/sha256/viewBox及所用字体/样式来源，重新读取均与清单相等。docs/brand-media/static/video-identity.json对企业署名/片头尾/水印每项列fromMs/toMs、画面精确文字或标识、抽帧sha256及OWN_VERIFIED/THIRD_PARTY/UNKNOWN与依据路径，时间须在0至原片时长内；抽帧和依据可打开。第三方企业署名或UNKNOWN时releaseAllowed=false且T4不能称发布通过；普通设备商标单独标role=equipment，不据此换企业身份。缺任何发布副本或真实制作记录时T3仍未完成，不以清单或未执行说明替代成品。 | 1.5d |
+| M1-T3 | 制作JPG换标及视频海报发布副本 | M1 | M1-T1 | 桌面原JPG/视频、现用PackJoyU字标、来源与原件哈希登记 | brand-static-media；用户已确认的工业风静态PNG、视频语义海报及压缩视频副本、哈希/对照清单 brand-logo-master；从当前SiteHeader字标/icon.svg导出的现用品牌基准文件public/brand/packjoyu-logo-master.svg及来源/导出哈希。 | 1) 原JPG/GIF/视频哈希不变，选定输出均可解码；静态发布图采用用户已确认的工业风PNG，替代早期局部换标JPG，核对飞艇和工厂两处PackJoyU标识及旧标清除结果，不要求重做已弃用局部换标版本；视频海报取自实际选定的换标成片，登记精确帧时刻、成片与海报哈希。原片公司名称、logo、片头尾和水印的时间点观察清单保留，发布身份审查逐项核实际选定成片；已授权替换且复核无残留的原产品商标，不单凭原片商标或未知客户关系阻断该成片。真实设备商标只记录，不当作企业署名或擅自抹除。成片仍有不符的企业署名、片头尾、水印或来源无法确认时禁止发布；不修改原视频，不擅自删镜头、重排或改变音轨。2) 即使候选设计与线上字标不同仍使用当前PackJoyU字标，记录所用标识文件哈希；不等待用户回看候选图，不把候选当已批准新logo（E-28）。3) 按用户授权的实际制作渠道保留输入、工具调用或软件操作、输出文件和成品核对记录；素材已通过其他授权渠道制作时，不因未使用GPT Dot判为未执行。实际使用GPT Dot时保留对应调用证据；尚未实际制作的项目逐项登记尚未执行及具体实施任务，不伪称调用成功或成品完成（E-29）。 4) 先核项目当前SiteHeader字标、样式/字体和icon.svg来源，导出可供软件导入的现用完整字标master，记录源文件与导出文件SHA256，逐项核字形、比例、颜色与当前标识一致；不重新设计候选标、不修改源字标或图标。SVG不得含script、外部引用或私有元数据；后继T6/T9只引用此已核master。 5) docs/brand-media/static/brand-static-media.json逐文件登记path/sha256/width/height，与实际解码/哈希逐值核对，并明确选定发布文件与历史待核副本；logoMaster登记sourceFiles的path/sha256、导出path/sha256/viewBox及所用字体/样式来源，重新读取均与清单相等。docs/brand-media/static/video-identity.json分别保留原片观察和选定成片复核；成片复核绑定原片及输出path/sha256，对企业署名、片头尾、水印及替换区域登记fromMs/toMs、实际文字或标识、抽帧sha256、OWN_VERIFIED/THIRD_PARTY/UNKNOWN与可打开依据，时间须在片长内；海报绑定该成片和帧时刻。直接用户来源声明可作依据并注明陈述范围，不推导未陈述的工厂产权、客户合作、认证或产能。成片来源或企业署名仍UNKNOWN时releaseAllowed=false且T4不能称发布通过；设备商标单独标role=equipment，不据此换企业身份。缺任何必要发布副本、成片核验或真实制作记录时T3仍未完成，不以清单或未执行说明替代成品。 | 1.5d |
 | M1-T4 | 接好首页视频与分区JPG/GIF场景 | M1 | M1-T6、M1-T7、M1-T8 | brand-media、visual-components、client-api-foundation与现有首页SSR布局 | home-media；现有主页/公共壳中的视频与分区品牌场景 | 1) 点击字标home-link→/[locale]、products-link→产品、contact-link→联系，并核实际SSR内容来源；目录沿loadCatalog(listPublishedModels)，不要求浏览器GET /api/models；12.27秒视频muted/playsinline且播放/暂停可点击，阻止autoplay后保留海报及播放入口，解码失败/减少动态效果显示语义JPG而不强制持续播放（E-21、E-22）。2) 城市JPG/GIF位于产品区后；网络断言接近视区300px前没有GIF下载，进入后才加载；点击暂停、离开视区、后台页均切同尺寸静帧，恢复可见不覆盖用户暂停（E-23、E-24）。3) 1440/1920/390逐项测媒体宽高比与源一致，媒体DOM矩形不与导航/正文/3D操作区的可点击矩形相交，渲染媒体的完整源图像四角及主体均在容器内；不得删主体或控件通过，保留按钮动作真实GIF（E-25）。 | 1.5d |
 | M1-T5 | 集成己方公司内容与独立图稿 | M1 | M1-T4、M1-T9 | 己方可核实材料、PDF结构参考、现有SiteSetting/Sanity及发布开关、M1-T9 company-visual-assets与素材manifest | company-content；about与首页公司摘要、事实对照、安全发布映射和真实页面图稿消费；原联系隐私入口兼容 | 1) 为每个对外公司硬事实建立“页面字段→己方证据文件/页码”对照；无己方证据的YUHAO认证/产能/工厂规模不得出现在成品文案或图片；PDF仅作结构/产品主题参考，自动检索加逐字段对照均无改名冒用（E-27）。2) 成品引用的logo哈希等于现用PackJoyU字标，不使用候选新标；不等待用户回看候选图，PDF指令不作执行授权（E-28）。3) 真浏览器点about-link→/[locale]/about、footer联系/隐私→对应路由，en/ru切换保持对应页；发布开关关闭时仍404，开时SSR SiteSetting/Sanity显示与事实对照表一致，改动页全部有导航证据。 4) 消费M1-T9的company-visual-assets，为已选图稿建立src/lib/brand/company-media.ts安全发布映射，仅输出/brand/company/下已核哈希的Web路径、正整数宽高及en/ru alt；拒绝外部URL、越界路径、源工程路径和文件系统地址，不把工程、私有路径或制作凭据下发浏览器。逐件核manifest中的成品与现用字标哈希、制作证据和完成状态；素材未完成时本集成项不能通过（E-29、E-111）。5) en/ru真实首页公司摘要及about消费相同已审映射，真实浏览器从可见入口进入，网络加载Web图路径/文件哈希与清单一致；alt按语言匹配，1920/1440/390尺寸下主体完整、无横向溢出。保存参考主题/己方事实→源工程/成品→映射→路由/组件的追溯证据；仅有资料目录文件不算页面完成，源工程不进public或生产镜像（E-111）。 6) 安全映射只提取已核Web路径、尺寸、alt；不在生产运行时import原docs manifest或工程/制作记录，不把含私有源路径的原JSON打包；浏览器产物和运行镜像检查均无源工程及私有路径。 | 2d |
-| M1-T6 | 逐帧替换GIF品牌并校验发布媒体集合 | M1 | M1-T3 | 原361帧GIF、brand-static-media、现用字标与原始时间轴 | brand-media；换标GIF、等尺寸暂停帧、逐帧品牌/时序报告与可发布集合 | 1) 保留原JPG/GIF哈希，逐帧列出361帧中旧品牌出现、透视变化、转场及遮挡恢复位置，全部以PackJoyU完整覆盖；同时复核T3的JPG旧标位置，首尾帧与全部列出位置无旧标或漏标（E-26）。2) 用原时间轴对照每帧呈现时刻/顺序和30.08秒循环总长，全部相同；叠加对照无替换新增错位或抖动；任一失败则该副本标未完成且排除发布，原件保留回退（E-30）。3) 输出可解码GIF、同尺寸暂停静帧与哈希；GPT Dot制作证据或逐项尚未执行状态按T3的真实工具可达结果登记，不虚报完成。 | 2d |
+| M1-T6 | 逐帧替换GIF品牌并校验发布媒体集合 | M1 | M1-T3 | 原361帧GIF、brand-static-media、现用字标与原始时间轴 | brand-media；换标GIF、等尺寸暂停帧、逐帧品牌/时序报告与可发布集合 | 1) 保留原JPG/GIF哈希，逐帧列出361帧中旧品牌出现、透视变化、转场及遮挡恢复位置，全部以PackJoyU完整覆盖；同时复核T3选定静态发布图的品牌位置，首尾帧与全部列出位置无旧标或漏标（E-26）。2) 用原时间轴对照每帧呈现时刻/顺序和30.08秒循环总长，全部相同；叠加对照无替换新增错位或抖动；任一失败则该副本标未完成且排除发布，原件保留回退（E-30）。3) 输出可解码GIF、同尺寸暂停静帧与哈希；GPT Dot制作证据或逐项尚未执行状态按T3的真实工具可达结果登记，不虚报完成。 | 2d |
 | M1-T7 | 补齐共享视觉变量与原生UI包装 | M1 | M1-T1 | visual-base的8个核心变量、第11节完整组件/状态规格 | visual-components；完整唯一token源与Button/Input/Dialog/Status原生包装 | 1) 只扩展同一tokens.css，不建立第二套颜色/字体/间距变量；Button/Input/Dialog/Status逐项使用11节高度、2px边界、0圆角、disabled/busy/error/focus值，类名/变量引用与原生语义断言对应每种状态，实际computed style由M1-T4集成验证。2) 包装组件不含fetch、Prisma、身份、cookie或业务角色判断；键盘焦点与对话框焦点恢复有自动化测试，前后台均导入同一出口。 | 1.5d |
 | M1-T8 | 接通统一fetch取消与错误适配 | M1 | M1-T2 | contract-types、10节逐方法重试规则与既有Auth.js/旧error协议 | client-api-foundation；15s取消、DTO解析、旧错误兼容；服务端HTTP映射由M3-T14唯一实现 | 1) 使用真实本地HTTP测试延迟、400/401/403/409/429/503及旧{error}响应，15s取消和卸载取消均终止在途请求，fieldErrors只保留受控字段，未知异常不回显stack/message。2) 普通GET及聊天/分析的同key重试按10节执行；一次性reauth/recovery/cron的响应未知不自动重放；业务组件只能从统一出口取得请求/错误适配，Auth.js原信封不改。 | 1.5d |
 | M1-T9 | 制作公司区块独立图稿与可编辑源工程 | M1 | M1-T1、M1-T3 | 参考PDF组织/产品主题、己方可证事实、现用PackJoyU字标与用户已授权GPT Dot远程软件制作 M1-T3已交付并核哈希的brand-logo-master；不得另画一套字标。 | company-visual-assets；网站公司区块选定1–2幅独立重绘图稿、可编辑软件源工程、Web图/enru alt与尺寸、哈希及真实制作清单 | 1) 实际交付1–2幅网站公司区块独立重绘图稿，每幅均有“参考PDF页码/主题→己方可证事实或不含企业硬事实的产品示意”对照。只借鉴组织和产品主题，原PDF/JPG/GIF/视频与现用logo原文件SHA-256保持不变；YUHAO认证/产能/规模及无己方依据的真实厂房、设备、证照不出现在图中，不要求重画25页整本（E-27、E-111）。2) 每幅必须同时存在docs/brand-content/source/内的可编辑软件源工程及public/brand/company/内的Web图。用对应软件实际打开每个工程，能选择并编辑至少一个独立图形或文字对象，保留对象/图层面板与一次可撤回编辑的记录，关闭时不覆盖已登记源件；只有平面截图不算可编辑工程。实际解码每幅Web图并测得正整数宽高。docs/brand-content/company-visuals.json每幅都含source.path/source.sha256、web.path/web.sha256/width/height、alt.en/alt.ru、参考主题/事实依据；逐文件计算的SHA-256须与manifest逐字相同，解码宽高须逐值相同，en/ru alt均为非空且对应实际画面（E-111）。3) manifest登记现用PackJoyU logo master文件路径与SHA-256，读取该实际文件计算值须逐字匹配；图稿使用同一master而非候选新标，制作记录列明引用/导入该master的对象。原logo不修改，成品与源工程均无旧品牌或候选标；不等待用户回看候选图（E-28、E-111）。4) 必须提供可核对的实际GPT Dot调用/软件操作记录：对应调用或会话标识、软件名称版本、打开工程与导出Web文件的记录，记录中的文件逐件对应manifest路径和SHA-256；最后重新打开源工程、解码Web图并复算全部哈希，全部通过才交company-visual-assets。Dot不可达、软件步骤未执行或任一图稿/源工程/Web图/必要记录缺失时，本任务保持未完成，不能仅交尚未执行状态、计划或截图就提交为已完成或落地（E-29、E-111）。5) 本卡完整交付的边界是已核验的素材集合与manifest，不输出页面完成声明；E-111的首页/about实际消费及浏览器证据由M1-T5集成验收，T9不得伪造页面证据。源工程和工具私有记录不进入public或生产镜像（E-111）。 | 1.5d |
````

新旧任务契约在同名 JSON 的 changes、源条款在 sourceChanges。只复验变化及其影响，不重新初始化分支。

## 原任务续做

# 继续原任务 M1-T3：制作JPG换标及视频海报发布副本
沿用分支 task/M1-T3、现有工作树和原 PR；不要创建新任务或重新初始化分支。
任务契约版本：1f1a4eef0d6018543bb9f3142ff6ad82170b073192fbfe37e114fb0553b5a909
读取 _run/patches/ 中本次补丁的差异和复验清单，只处理列出的条目及其直接影响。没有差异说明时先核对现有 PR 的返工记录，不按完整实施流程重做。
修正后的验收：
1) 原JPG/GIF/视频哈希不变，选定输出均可解码
静态发布图采用用户已确认的工业风PNG，替代早期局部换标JPG，核对飞艇和工厂两处PackJoyU标识及旧标清除结果，不要求重做已弃用局部换标版本
视频海报取自实际选定的换标成片，登记精确帧时刻、成片与海报哈希。原片公司名称、logo、片头尾和水印的时间点观察清单保留，发布身份审查逐项核实际选定成片
已授权替换且复核无残留的原产品商标，不单凭原片商标或未知客户关系阻断该成片。真实设备商标只记录，不当作企业署名或擅自抹除。成片仍有不符的企业署名、片头尾、水印或来源无法确认时禁止发布
不修改原视频，不擅自删镜头、重排或改变音轨。2) 即使候选设计与线上字标不同仍使用当前PackJoyU字标，记录所用标识文件哈希
不等待用户回看候选图，不把候选当已批准新logo（E-28）。3) 按用户授权的实际制作渠道保留输入、工具调用或软件操作、输出文件和成品核对记录
素材已通过其他授权渠道制作时，不因未使用GPT Dot判为未执行。实际使用GPT Dot时保留对应调用证据
尚未实际制作的项目逐项登记尚未执行及具体实施任务，不伪称调用成功或成品完成（E-29）。
4) 先核项目当前SiteHeader字标、样式/字体和icon.svg来源，导出可供软件导入的现用完整字标master，记录源文件与导出文件SHA256，逐项核字形、比例、颜色与当前标识一致
不重新设计候选标、不修改源字标或图标。SVG不得含script、外部引用或私有元数据
后继T6/T9只引用此已核master。
5) docs/brand-media/static/brand-static-media.json逐文件登记path/sha256/width/height，与实际解码/哈希逐值核对，并明确选定发布文件与历史待核副本
logoMaster登记sourceFiles的path/sha256、导出path/sha256/viewBox及所用字体/样式来源，重新读取均与清单相等。docs/brand-media/static/video-identity.json分别保留原片观察和选定成片复核
成片复核绑定原片及输出path/sha256，对企业署名、片头尾、水印及替换区域登记fromMs/toMs、实际文字或标识、抽帧sha256、OWN_VERIFIED/THIRD_PARTY/UNKNOWN与可打开依据，时间须在片长内
海报绑定该成片和帧时刻。直接用户来源声明可作依据并注明陈述范围，不推导未陈述的工厂产权、客户合作、认证或产能。成片来源或企业署名仍UNKNOWN时releaseAllowed=false且T4不能称发布通过
设备商标单独标role=equipment，不据此换企业身份。缺任何必要发布副本、成片核验或真实制作记录时T3仍未完成，不以清单或未执行说明替代成品。
有效范围：
docs/brand-media/static/
public/brand/
保留已有代码和回填；修改后运行必要检查、追加提交并 push，继续原 PR 审查。
## 自行裁决：交 Jev，不交用户
实施、审查、查 bug、批次收口过程中出现的每一条「自行裁决」，以及验收冲突、文档缺口、栈外依赖、UI/UX 未定项，都先列出 2–5 个真实可行的选项；不能把你想要的答案当唯一候选。
把原始需求、任务标题与验收、冲突和选项忠实译成英文写入 state.json（文档与回报仍用中文）；UI/UX 取舍使用 design，其余使用 adjudicate。
运行 python "docs/PackJoyU-开发文档/_run/typesafe_ask.py" --log "docs/PackJoyU-开发文档/_run/judgments.jsonl" --label "M1-T3:resume" run adjudicate --state <state.json>；UI/UX 将 adjudicate 换成 design。若 language_warning 提示中文过多，重译后重跑。
仅 status=ok 且 verdicts.adopt.action=take 才按 option 执行；confidence=low 仍用 Jev 的 option，记低置信风险。spec_change=yes 走文档补丁，outside_stack=yes 在回报点名，不自动扩权。
adopt=red_line 仅涉及付费、不可逆删除、改变已定范围或对外承诺时请求用户授权；status=skipped/error 或缺有效 pick 时留下待 Jev 裁决，不得由人代答、判 pass、声称已落地或写 clean/fixed。
回报逐条写：冲突 → 全部候选 → Jev line/model/采纳的 option → 代码或文档动作；没有写「无」。
