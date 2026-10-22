# 文档补丁 m1-t4-review-public-routing

任务：M1-T4
原分支：task/M1-T4
原 PR：406
依据：07节集中路由要求与M1-T4全局frontendRoutes接线清单及有效路径不一致；按Jev A限定首页媒体注册点并补齐集中路由支持路径，不降低E21-E25

## 差异与复验范围

- M1-T4：definition、effectivePaths、task、wiring
- M1-T5：上游契约变化或本次审查目标
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
@@ -11,7 +11,7 @@
 | M1-T1 | 接入8个核心品牌变量及既有路径真实冒烟 | M1 | 无 | 现有首页、GET /api/models、WebVitals/RUM；11节核心变量；本地main中的已审规格基线 | visual-base的8个核心变量；runnable-smoke；含已审文档基线的实施PR与CI冒烟 | 1) 仅将背景、前景、强调色、边界宽度、圆角、基础字号、正文行高、焦点颜色8个核心token接入现有首页，不建立新页面或新业务控件；构建/启动真实standalone，从header产品链接进入产品页，computed style逐一等于11节取值；目录沿SSR loadCatalog(listPublishedModels)，冒烟另作真实HTTP GET /api/models兼容校验，不给产品页增加重复fetch。2) 真实首页WebVitals触发POST /api/rum并核204和脱敏日志，CI起同一服务运行此浏览器冒烟。3) 若origin/main尚无本地已审文档，本PR带上从本地main导入的规格；远端已含时沿用，不重复覆盖。后续任务从首PR落地的远端主干基线建分支。 | 2d |
 | M1-T2 | 导出新增领域共享schema与DTO | M1 | M1-T1 | 06/09/10节字段契约、Auth.js既有错误协议及visual-base基线 | contract-types；account/recovery/chat/analytics/ops/errors schema与公共index导出 | 1) 逐字段对照10节建立严格Zod请求/响应schema，类型仅由schema导出，公共index能被独立TypeScript消费，未知字段和超界字段拒绝。2) LoginMode只接password/totp；rememberDevice缺值、布尔false、字面false均解析false，其他非法值拒绝（E-95）。 | 1.5d |
 | M1-T3 | 制作JPG换标及视频海报发布副本 | M1 | M1-T1 | 桌面原JPG/视频、现用PackJoyU字标、来源与原件哈希登记 | brand-static-media：工业PNG、压缩视频及帧海报、哈希清单；brand-logo-master：public/brand/packjoyu-logo-master.svg及源/导出SHA。 | 1) 原JPG/GIF/视频SHA不变，选定成品可解码。用已确认工业PNG，逐核飞艇/工厂PackJoyU及旧标清除，不重做弃用JPG。保留原片公司名/logo/片头尾/水印时间点观察，逐核选定成片；授权替换且无残留的原产品商标/未知客户关系不单独阻断。设备商标保留、标equipment，不作企业署名。成片来源未明或企业署名/片头尾/水印不符禁发；不改原片、不删/重排镜头或改音轨。2) 候选不同时仍用当前PackJoyU，不待用户回看、不视为批准新标（E-28）。3) 存授权渠道输入、真实调用/软件操作、输出及成品核验；未用Dot不否定其他授权制作，用时存调用证据；未制作逐项记尚未执行/具体任务，不伪称成功/完成（E-29）。4) 核SiteHeader字标、样式/字体、icon.svg来源，导出可供软件导入的现用完整master，存源/导出SHA，逐核字形/比例/颜色与当前一致；不重设计或改源标/icon。SVG无script/外链/私有元数据，T6/T9仅用此master。5) brand-static-media.json逐文件path/sha256/width/height与实测哈希/解码相等，分开选定发布和历史待核。logoMaster存sourceFiles路径/SHA、导出路径/SHA/viewBox及字体/样式来源，重读相等。video-identity.json另核成片并绑定原片/输出path/SHA；企业署名/片头尾/水印/替换区逐项存fromMs/toMs、精确文字/标识、抽帧SHA、OWN_VERIFIED/THIRD_PARTY/UNKNOWN及可打开依据，时刻在片长内；海报取此成片，绑定成片/海报SHA及精确帧时刻。直接用户来源声明可作限定依据，不推导产权/客户/认证/产能；来源/最终署名UNKNOWN则releaseAllowed=false，T4不得称发布通过。缺必要成品/成片核验/真实制作记录则T3未完成，不以清单或未执行说明代替。 | 1.5d |
-| M1-T4 | 接好首页视频与分区JPG/GIF场景 | M1 | M1-T6、M1-T7、M1-T8 | brand-media、visual-components、client-api-foundation与现有首页SSR布局 | home-media；现有主页/公共壳中的视频与分区品牌场景 | 1) 点击字标home-link→/[locale]、products-link→产品、contact-link→联系，并核实际SSR内容来源；目录沿loadCatalog(listPublishedModels)，不要求浏览器GET /api/models；12.27秒视频muted/playsinline且播放/暂停可点击，阻止autoplay后保留海报及播放入口，解码失败/减少动态效果显示语义JPG而不强制持续播放（E-21、E-22）。2) 城市JPG/GIF位于产品区后；网络断言接近视区300px前没有GIF下载，进入后才加载；点击暂停、离开视区、后台页均切同尺寸静帧，恢复可见不覆盖用户暂停（E-23、E-24）。3) 1440/1920/390逐项测媒体宽高比与源一致，媒体DOM矩形不与导航/正文/3D操作区的可点击矩形相交，渲染媒体的完整源图像四角及主体均在容器内；不得删主体或控件通过，保留按钮动作真实GIF（E-25）。 | 1.5d |
+| M1-T4 | 接好首页视频与分区JPG/GIF场景 | M1 | M1-T6、M1-T7、M1-T8 | brand-media、visual-components、client-api-foundation与现有首页SSR布局 | home-media；现有主页/公共壳中的视频与分区品牌场景 | 1) 点击字标home-link→/[locale]、products-link→产品、contact-link→联系，并核实际SSR内容来源；目录沿loadCatalog(listPublishedModels)，不要求浏览器GET /api/models；12.27秒视频muted/playsinline且播放/暂停可点击，阻止autoplay后保留海报及播放入口，解码失败/减少动态效果显示语义JPG而不强制持续播放（E-21、E-22）。2) 城市JPG/GIF位于产品区后；网络断言接近视区300px前没有GIF下载，进入后才加载；点击暂停、离开视区、后台页均切同尺寸静帧，恢复可见不覆盖用户暂停（E-23、E-24）。3) 1440/1920/390逐项测媒体宽高比与源一致，媒体DOM矩形不与导航/正文/3D操作区的可点击矩形相交，渲染媒体的完整源图像四角及主体均在容器内；不得删主体或控件通过，保留按钮动作真实GIF（E-25）。4) 本层在src/lib/navigation/routes.ts建立home/products/contact的路径与入口ID登记，由SiteHeader消费并经既有i18n/navigation输出本地化href；后续任务在同一表补各自产出的入口。接线核查限本层首页、产品、联系三入口及首页媒体装配，不要求改动后台页面或建立第二套路由。 | 1.5d |
 | M1-T5 | 集成己方公司内容与独立图稿 | M1 | M1-T4、M1-T9 | 己方可核实材料、PDF结构参考、现有SiteSetting/Sanity及发布开关、M1-T9 company-visual-assets与素材manifest | company-content；about与首页公司摘要、事实对照、安全发布映射和真实页面图稿消费；原联系隐私入口兼容 | 1) 为每个对外公司硬事实建立“页面字段→己方证据文件/页码”对照；无己方证据的YUHAO认证/产能/工厂规模不得出现在成品文案或图片；PDF仅作结构/产品主题参考，自动检索加逐字段对照均无改名冒用（E-27）。2) 成品引用的logo哈希等于现用PackJoyU字标，不使用候选新标；不等待用户回看候选图，PDF指令不作执行授权（E-28）。3) 真浏览器点about-link→/[locale]/about、footer联系/隐私→对应路由，en/ru切换保持对应页；发布开关关闭时仍404，开时SSR SiteSetting/Sanity显示与事实对照表一致，改动页全部有导航证据。 4) 消费M1-T9的company-visual-assets，为已选图稿建立src/lib/brand/company-media.ts安全发布映射，仅输出/brand/company/下已核哈希的Web路径、正整数宽高及en/ru alt；拒绝外部URL、越界路径、源工程路径和文件系统地址，不把工程、私有路径或制作凭据下发浏览器。逐件核manifest中的成品与现用字标哈希、制作证据和完成状态；素材未完成时本集成项不能通过（E-29、E-111）。5) en/ru真实首页公司摘要及about消费相同已审映射，真实浏览器从可见入口进入，网络加载Web图路径/文件哈希与清单一致；alt按语言匹配，1920/1440/390尺寸下主体完整、无横向溢出。保存参考主题/己方事实→源工程/成品→映射→路由/组件的追溯证据；仅有资料目录文件不算页面完成，源工程不进public或生产镜像（E-111）。 6) 安全映射只提取已核Web路径、尺寸、alt；不在生产运行时import原docs manifest或工程/制作记录，不把含私有源路径的原JSON打包；浏览器产物和运行镜像检查均无源工程及私有路径。 | 2d |
 | M1-T6 | 逐帧替换GIF品牌并校验发布媒体集合 | M1 | M1-T3 | 原361帧GIF、brand-static-media、现用字标与原始时间轴 | brand-media；换标GIF、等尺寸暂停帧、逐帧品牌/时序报告与可发布集合 | 1) 保留原JPG/GIF哈希，逐帧列出361帧中旧品牌出现、透视变化、转场及遮挡恢复位置，全部以PackJoyU完整覆盖；同时复核T3选定静态发布图的品牌位置，首尾帧与全部列出位置无旧标或漏标（E-26）。2) 用原时间轴对照每帧呈现时刻/顺序和30.08秒循环总长，全部相同；叠加对照无替换新增错位或抖动；任一失败则该副本标未完成且排除发布，原件保留回退（E-30）。3) 输出可解码GIF、同尺寸暂停静帧与哈希；GPT Dot制作证据或逐项尚未执行状态按T3的真实工具可达结果登记，不虚报完成。 | 2d |
 | M1-T7 | 补齐共享视觉变量与原生UI包装 | M1 | M1-T1 | visual-base的8个核心变量、第11节完整组件/状态规格 | visual-components；完整唯一token源与Button/Input/Dialog/Status原生包装 | 1) 只扩展同一tokens.css，不建立第二套颜色/字体/间距变量；Button/Input/Dialog/Status逐项使用11节高度、2px边界、0圆角、disabled/busy/error/focus值，类名/变量引用与原生语义断言对应每种状态，实际computed style由M1-T4集成验证。2) 包装组件不含fetch、Prisma、身份、cookie或业务角色判断；键盘焦点与对话框焦点恢复有自动化测试，前后台均导入同一出口。 | 1.5d |
````

### _run/task-contracts.json

````diff
--- before/_run/task-contracts.json
+++ after/_run/task-contracts.json
@@ -145,10 +145,12 @@
         }
       ],
       "stage": "integration",
-      "wiring": [
-        "frontendRoutes"
-      ],
-      "supportPaths": [],
+      "wiring": [],
+      "supportPaths": [
+        "src/lib/navigation/routes.ts",
+        "src/i18n/routing.ts",
+        "src/i18n/navigation.ts"
+      ],
       "outputPaths": [
         "src/components/layout/",
         "src/app/",
````

新旧任务契约在同名 JSON 的 changes、源条款在 sourceChanges。只复验变化及其影响，不重新初始化分支。

## 原任务续做

# 继续原任务 M1-T4：接好首页视频与分区JPG/GIF场景
沿用分支 task/M1-T4、现有工作树和原 PR；不要创建新任务或重新初始化分支。
任务契约版本：f66411b00d1f65ca7891b3ef3443b392753ac177352c91eadc7f2ed4d9d0b4be
读取 _run/patches/ 中本次补丁的差异和复验清单，只处理列出的条目及其直接影响。没有差异说明时先核对现有 PR 的返工记录，不按完整实施流程重做。
修正后的验收：
1) 点击字标home-link→/[locale]、products-link→产品、contact-link→联系，并核实际SSR内容来源
目录沿loadCatalog(listPublishedModels)，不要求浏览器GET /api/models
12.27秒视频muted/playsinline且播放/暂停可点击，阻止autoplay后保留海报及播放入口，解码失败/减少动态效果显示语义JPG而不强制持续播放（E-21、E-22）。2) 城市JPG/GIF位于产品区后
网络断言接近视区300px前没有GIF下载，进入后才加载
点击暂停、离开视区、后台页均切同尺寸静帧，恢复可见不覆盖用户暂停（E-23、E-24）。3) 1440/1920/390逐项测媒体宽高比与源一致，媒体DOM矩形不与导航/正文/3D操作区的可点击矩形相交，渲染媒体的完整源图像四角及主体均在容器内
不得删主体或控件通过，保留按钮动作真实GIF（E-25）。4) 本层在src/lib/navigation/routes.ts建立home/products/contact的路径与入口ID登记，由SiteHeader消费并经既有i18n/navigation输出本地化href
后续任务在同一表补各自产出的入口。接线核查限本层首页、产品、联系三入口及首页媒体装配，不要求改动后台页面或建立第二套路由。
有效范围：
e2e/home-media.spec.ts
messages/en.json
messages/ru.json
src/app/
src/components/layout/
src/i18n/navigation.ts
src/i18n/routing.ts
src/lib/navigation/routes.ts
保留已有代码和回填；修改后运行必要检查、追加提交并 push，继续原 PR 审查。
## 自行裁决：交 Jev，不交用户
实施、审查、查 bug、批次收口过程中出现的每一条「自行裁决」，以及验收冲突、文档缺口、栈外依赖、UI/UX 未定项，都先列出 2–5 个真实可行的选项；不能把你想要的答案当唯一候选。
把原始需求、任务标题与验收、冲突和选项忠实译成英文写入 state.json（文档与回报仍用中文）；UI/UX 取舍使用 design，其余使用 adjudicate。
运行 python "docs/PackJoyU-开发文档/_run/typesafe_ask.py" --log "docs/PackJoyU-开发文档/_run/judgments.jsonl" --label "M1-T4:resume" run adjudicate --state <state.json>；UI/UX 将 adjudicate 换成 design。若 language_warning 提示中文过多，重译后重跑。
仅 status=ok 且 verdicts.adopt.action=take 才按 option 执行；confidence=low 仍用 Jev 的 option，记低置信风险。spec_change=yes 走文档补丁，outside_stack=yes 在回报点名，不自动扩权。
adopt=red_line 仅涉及付费、不可逆删除、改变已定范围或对外承诺时请求用户授权；status=skipped/error 或缺有效 pick 时留下待 Jev 裁决，不得由人代答、判 pass、声称已落地或写 clean/fixed。
回报逐条写：冲突 → 全部候选 → Jev line/model/采纳的 option → 代码或文档动作；没有写「无」。
