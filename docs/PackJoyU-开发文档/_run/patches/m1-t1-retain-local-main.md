# 文档补丁 m1-t1-retain-local-main

任务：M1-T1
原分支：task/M1-T1
原 PR：393
依据：保留本地main已审规格的5个提交及最新来源说明，确保首PR落地后主检出可快进同步；保留当前实施、契约支持路径和复核记录

## 差异与复验范围

- M1-T1：handoff、task
- M1-T2：handoff
- M1-T3：handoff
- M1-T4：handoff
- M1-T5：handoff
- M1-T6：handoff
- M1-T7：handoff
- M1-T8：handoff
- M1-T9：handoff
- M2-T1：handoff
- M2-T2：handoff
- M2-T3：handoff
- M2-T4：handoff
- M2-T5：handoff
- M2-T6：handoff
- M2-T7：handoff
- M2-T8：handoff
- M3-T1：handoff
- M3-T10：handoff
- M3-T11：handoff
- M3-T12：handoff
- M3-T13：handoff
- M3-T14：handoff
- M3-T15：handoff
- M3-T16：handoff
- M3-T17：handoff
- M3-T18：handoff
- M3-T19：handoff
- M3-T2：handoff
- M3-T20：handoff
- M3-T21：handoff
- M3-T22：handoff
- M3-T23：handoff
- M3-T24：handoff
- M3-T25：handoff
- M3-T3：handoff
- M3-T4：handoff
- M3-T5：handoff
- M3-T6：handoff
- M3-T7：handoff
- M3-T8：handoff
- M3-T9：handoff
- M4-T1：handoff
- M4-T10：handoff
- M4-T11：handoff
- M4-T12：handoff
- M4-T13：handoff
- M4-T14：handoff
- M4-T15：handoff
- M4-T2：handoff
- M4-T3：handoff
- M4-T4：handoff
- M4-T5：handoff
- M4-T6：handoff
- M4-T7：handoff
- M4-T8：handoff
- M4-T9：handoff
- M5-T1：handoff
- M5-T10：handoff
- M5-T11：handoff
- M5-T2：handoff
- M5-T3：handoff
- M5-T4：handoff
- M5-T5：handoff
- M5-T6：handoff
- M5-T7：handoff
- M5-T8：handoff
- M5-T9：handoff
- M6-T1：handoff
- M6-T2：handoff
- M6-T3：handoff
- M6-T4：handoff
- M6-T5：handoff
- M6-T6：handoff
- M6-T7：handoff
- M7-T1：handoff
- M7-T2：handoff
- M7-T3：handoff
- M7-T4：handoff
- M7-T5：handoff
- M7-T6：handoff
- M7-T7：handoff
- M7-T8：handoff
- M7-T9：handoff

### 04-执行/19-模块任务拆分.md

````diff
--- before/04-执行/19-模块任务拆分.md
+++ after/04-执行/19-模块任务拆分.md
@@ -2,13 +2,13 @@
 
 84项任务均以0.5–2人日作为估算目标，尚未实施；估算不等于性能、工期或产品通过证据。模块表描述基础能力方向，具体界面目标的可见性顺序以任务DAG为准；模块服务不得反向导入，任务依赖按实际提供方排序。
 
-M1-T1是唯一起点：从当前主干新建任务工作树后，先从本机task/docs-s2-s6分支导入本目录及根AGENTS/CLAUDE，随首个实施PR提交；后续从其落地主干取得文档。换机器先传送这份本地规格基线，不假定origin/main已有。
+M1-T1是唯一起点：从origin/main新建任务工作树后，若该远端基线尚无规格，先从已合并的本地main导入本目录及根AGENTS/CLAUDE，随首个实施PR提交；已含规格时沿用该版本。后续从其落地的远端主干取得文档。换机器先传送已提交的本地规格基线，不假定origin/main已有；不依赖临时规格分支。
 
 primitive只验该规则/仓储层，integrationTask承担可见入口/真实HTTP/事件链最终验收；部分原语不单独宣称整条跨层边界，完整边界由集成任务覆盖。普通UI任务引用07/11/12和唯一minimalist-flat；后台D1–D6/GIF三尺寸不因模块分类省略。校准原始负项和整改证据保留，估算残余不确定性见21节，不以模型分数代替源契约审查。
 
 | ID | 标题 | 模块 | 依赖 | 输入 | 产出 | 验收标准 | 预估 |
 |---|---|---|---|---|---|---|---|
-| M1-T1 | 接入8个核心品牌变量及既有路径真实冒烟 | M1 | 无 | 现有首页、GET /api/models、WebVitals/RUM；11节核心变量；本地已审规格分支 | visual-base的8个核心变量；runnable-smoke；含已审文档基线的实施PR与CI冒烟 | 1) 仅将背景、前景、强调色、边界宽度、圆角、基础字号、正文行高、焦点颜色8个核心token接入现有首页，不建立新页面或新业务控件；构建/启动真实standalone，从header产品链接进入产品页，computed style逐一等于11节取值；目录沿SSR loadCatalog(listPublishedModels)，冒烟另作真实HTTP GET /api/models兼容校验，不给产品页增加重复fetch。2) 真实首页WebVitals触发POST /api/rum并核204和脱敏日志，CI起同一服务运行此浏览器冒烟。3) 本地已审文档随本PR进入主干；后续任务从该落地基线建分支。 | 2d |
+| M1-T1 | 接入8个核心品牌变量及既有路径真实冒烟 | M1 | 无 | 现有首页、GET /api/models、WebVitals/RUM；11节核心变量；本地main中的已审规格基线 | visual-base的8个核心变量；runnable-smoke；含已审文档基线的实施PR与CI冒烟 | 1) 仅将背景、前景、强调色、边界宽度、圆角、基础字号、正文行高、焦点颜色8个核心token接入现有首页，不建立新页面或新业务控件；构建/启动真实standalone，从header产品链接进入产品页，computed style逐一等于11节取值；目录沿SSR loadCatalog(listPublishedModels)，冒烟另作真实HTTP GET /api/models兼容校验，不给产品页增加重复fetch。2) 真实首页WebVitals触发POST /api/rum并核204和脱敏日志，CI起同一服务运行此浏览器冒烟。3) 若origin/main尚无本地已审文档，本PR带上从本地main导入的规格；远端已含时沿用，不重复覆盖。后续任务从首PR落地的远端主干基线建分支。 | 2d |
 | M1-T2 | 导出新增领域共享schema与DTO | M1 | M1-T1 | 06/09/10节字段契约、Auth.js既有错误协议及visual-base基线 | contract-types；account/recovery/chat/analytics/ops/errors schema与公共index导出 | 1) 逐字段对照10节建立严格Zod请求/响应schema，类型仅由schema导出，公共index能被独立TypeScript消费，未知字段和超界字段拒绝。2) LoginMode只接password/totp；rememberDevice缺值、布尔false、字面false均解析false，其他非法值拒绝（E-95）。 | 1.5d |
 | M1-T3 | 制作JPG换标及视频海报发布副本 | M1 | M1-T1 | 桌面原JPG/视频、现用PackJoyU字标、来源与原件哈希登记 | brand-static-media；换标JPG、视频语义海报及压缩视频副本、哈希/对照清单 brand-logo-master；从当前SiteHeader字标/icon.svg导出的现用品牌基准文件public/brand/packjoyu-logo-master.svg及来源/导出哈希。 | 1) 原JPG/视频哈希不变，输出文件均可解码；将JPG飞艇与工厂墙面的旧标逐处列入清单并以现用PackJoyU字标完整替换，清单逐处核无旧标，视频海报取自其自身画面且带可核帧时刻；对全片所有公司名称、logo、片头/片尾及水印列时间点清单，片头/片尾/水印等企业署名与己方身份不符或依据缺失时该发布副本不入成品并报告；真实场景中的设备商标只记录，不自动当企业署名或擅自抹除，不修改原视频、不擅自重剪。2) 即使候选设计与线上字标不同仍使用当前PackJoyU字标，记录所用标识文件哈希；不等待用户回看候选图，不把候选当已批准新logo（E-28）。3) GPT Dot可达且实际制作时保留调用、软件操作、输出文件和成品核对记录；不可达则逐项写尚未执行/实施任务且该项不称完成，不伪称调用成功（E-29）。 4) 先核项目当前SiteHeader字标、样式/字体和icon.svg来源，导出可供软件导入的现用完整字标master，记录源文件与导出文件SHA256，逐项核字形、比例、颜色与当前标识一致；不重新设计候选标、不修改源字标或图标。SVG不得含script、外部引用或私有元数据；后继T6/T9只引用此已核master。 5) docs/brand-media/static/brand-static-media.json逐文件登记path/sha256/width/height并与实际解码/哈希逐值核对；logoMaster登记sourceFiles的path/sha256、导出path/sha256/viewBox及所用字体/样式来源，重新读取均与清单相等。docs/brand-media/static/video-identity.json对企业署名/片头尾/水印每项列fromMs/toMs、画面精确文字或标识、抽帧sha256及OWN_VERIFIED/THIRD_PARTY/UNKNOWN与依据路径，时间须在0至原片时长内；抽帧和依据可打开。第三方企业署名或UNKNOWN时releaseAllowed=false且T4不能称发布通过；普通设备商标单独标role=equipment，不据此换企业身份。缺任何发布副本或真实制作记录时T3仍未完成，不以清单或未执行说明替代成品。 | 1.5d |
 | M1-T4 | 接好首页视频与分区JPG/GIF场景 | M1 | M1-T6、M1-T7、M1-T8 | brand-media、visual-components、client-api-foundation与现有首页SSR布局 | home-media；现有主页/公共壳中的视频与分区品牌场景 | 1) 点击字标home-link→/[locale]、products-link→产品、contact-link→联系，并核实际SSR内容来源；目录沿loadCatalog(listPublishedModels)，不要求浏览器GET /api/models；12.27秒视频muted/playsinline且播放/暂停可点击，阻止autoplay后保留海报及播放入口，解码失败/减少动态效果显示语义JPG而不强制持续播放（E-21、E-22）。2) 城市JPG/GIF位于产品区后；网络断言接近视区300px前没有GIF下载，进入后才加载；点击暂停、离开视区、后台页均切同尺寸静帧，恢复可见不覆盖用户暂停（E-23、E-24）。3) 1440/1920/390逐项测媒体宽高比与源一致，媒体DOM矩形不与导航/正文/3D操作区的可点击矩形相交，渲染媒体的完整源图像四角及主体均在容器内；不得删主体或控件通过，保留按钮动作真实GIF（E-25）。 | 1.5d |
````

### README.md

````diff
--- before/README.md
+++ after/README.md
@@ -17,7 +17,7 @@
 
 ## 如何开工
 
-文档当前交付在本机`task/docs-s2-s6`规格分支及主目录，不假定远端主干已包含它。第一项M1-T1从origin/main创建任务工作树后，先从该本机分支导入本目录及根AGENTS/CLAUDE，随首个实施PR提交；其他任务等待它合入主干再创建。换机器须先传送此规格基线，不能从没有文档的分支派出任务。
+文档已合并到本地`main`；不假定远端`origin/main`已包含它。第一项M1-T1从origin/main创建任务工作树后，若该远端基线尚无文档，先从本地main导入本目录及根AGENTS/CLAUDE，随首个实施PR提交；已含文档时沿用该版本。其他任务等待首PR合入远端主干后再创建。换机器须先传送已提交的规格基线，不能从没有文档的分支派出任务。
 
 任务交接台顶部可选择窗口数、复制各窗口的顺序和开工提示；文件冲突会压低实际并行数，批次只是依赖层级。先复制开工提示，再派发当前可用任务。复制“实施”会推进本机状态，未准备派发时不要试点；完成后复制“审查”，审查通过由审查方登记复核、回填知识库、记录落地并按既定PR流程合入。每批全落地后做批次收口；紧邻上一批最新收口为clean/fixed才解锁下一批，open遗留会派生独立返工任务。
 
````

### _run/presentation.json

````diff
--- before/_run/presentation.json
+++ after/_run/presentation.json
@@ -102,7 +102,7 @@
       ]
     },
     "stack": "TypeScript / Next.js 15 / React 19 / Auth.js / Prisma PostgreSQL / next-intl / React Three Fiber；现有CSS与原生控件，不接线上AI判断层",
-    "conventions": "本项目使用Next App Router，无hash路由；通用交接提示中的#/（首页）在本项目执行/en或/ru可见导航，不引入hash router。新增API信封和DTO遵06/10；既有Auth.js协议保持。源数据/素材未验证不冒充已完成。 混合模块M3/M4/M5的具体UI任务显式引用07/11/12、stylekit与record-browser-gif；后台逐页测D1–D6，沿唯一minimalist-flat及11值不重搜。 M1-T1工作树创建后先从本机task/docs-s2-s6导入docs/PackJoyU-开发文档、AGENTS.md、CLAUDE.md，作为首PR基线；其他任务等其落地后从origin/main创建。文档未上传远端，不假定origin已有。后台探针用真实登录cookie，禁止注入认证存储，CLI不能真实登录时在已登录页面调用探针导出测量。 原语completionStage只做本卡规则/DB层证据，完整可见入口/真实GIF/密度归其integrationTask；通用GUI模板按当前完成阶段解释，最终集成不免验。 “逐页”指本卡实际产出的页面或区域；增量任务仅验新增控件、布局和与现有页面的接缝，未迁移的旧内层不得称视觉通过。M3-T7验壳导航、外框、活动和退出；M3-T9验恢复授权区域；M5-T10验analytics分区。既有业务完整页由M3-T21至T25逐页验收，最终M7-T9汇总，完整GUI、D1–D6与overflow标准不减。",
+    "conventions": "本项目使用Next App Router，无hash路由；通用交接提示中的#/（首页）在本项目执行/en或/ru可见导航，不引入hash router。新增API信封和DTO遵06/10；既有Auth.js协议保持。源数据/素材未验证不冒充已完成。 混合模块M3/M4/M5的具体UI任务显式引用07/11/12、stylekit与record-browser-gif；后台逐页测D1–D6，沿唯一minimalist-flat及11值不重搜。 M1-T1从origin/main创建工作树后，若该远端基线尚无规格，先从已合并的本地main导入docs/PackJoyU-开发文档、AGENTS.md、CLAUDE.md，作为首PR基线；已含规格时沿用该版本。其他任务等首PR落地后从origin/main创建。文档仅合并本地main，不假定origin已含；不依赖临时规格分支。后台探针用真实登录cookie，禁止注入认证存储，CLI不能真实登录时在已登录页面调用探针导出测量。 原语completionStage只做本卡规则/DB层证据，完整可见入口/真实GIF/密度归其integrationTask；通用GUI模板按当前完成阶段解释，最终集成不免验。 “逐页”指本卡实际产出的页面或区域；增量任务仅验新增控件、布局和与现有页面的接缝，未迁移的旧内层不得称视觉通过。M3-T7验壳导航、外框、活动和退出；M3-T9验恢复授权区域；M5-T10验analytics分区。既有业务完整页由M3-T21至T25逐页验收，最终M7-T9汇总，完整GUI、D1–D6与overflow标准不减。",
     "design": {
       "register": "brand",
       "style": "`minimalist-flat` — 以黑白平面、清楚边界和单一强调色承托生产视频、包装与3D，前后台共享方向，页面按用途分配密度。",
````

新旧任务契约在同名 JSON 的 changes、源条款在 sourceChanges。只复验变化及其影响，不重新初始化分支。

## 原任务续做

# 继续原任务 M1-T1：接入8个核心品牌变量及既有路径真实冒烟
沿用分支 task/M1-T1、现有工作树和原 PR；不要创建新任务或重新初始化分支。
任务契约版本：dffd9ad0c9bc1f982e14a939f86d662f89877b1b1fc92c531b58263e63198d06
读取 _run/patches/ 中本次补丁的差异和复验清单，只处理列出的条目及其直接影响。没有差异说明时先核对现有 PR 的返工记录，不按完整实施流程重做。
修正后的验收：
1) 仅将背景、前景、强调色、边界宽度、圆角、基础字号、正文行高、焦点颜色8个核心token接入现有首页，不建立新页面或新业务控件
构建/启动真实standalone，从header产品链接进入产品页，computed style逐一等于11节取值
目录沿SSR loadCatalog(listPublishedModels)，冒烟另作真实HTTP GET /api/models兼容校验，不给产品页增加重复fetch。2) 真实首页WebVitals触发POST /api/rum并核204和脱敏日志，CI起同一服务运行此浏览器冒烟。3) 若origin/main尚无本地已审文档，本PR带上从本地main导入的规格
远端已含时沿用，不重复覆盖。后续任务从首PR落地的远端主干基线建分支。
有效范围：
.github/workflows/ci.yml
AGENTS.md
CLAUDE.md
docs/PackJoyU-开发文档/
e2e/brand-smoke.spec.ts
eslint.config.mjs
next.config.ts
package.json
playwright.config.ts
prod-env-check.ts
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
src/components/layout/SiteFooter.tsx
src/components/layout/SiteHeader.tsx
src/i18n/navigation.ts
src/i18n/routing.ts
src/instrumentation.ts
src/lib/navigation/routes.ts
src/styles/motion-tokens.css
src/styles/tokens.css
tsconfig.json
保留已有代码和回填；修改后运行必要检查、追加提交并 push，继续原 PR 审查。
## 自行裁决：交 Jev，不交用户
实施、审查、查 bug、批次收口过程中出现的每一条「自行裁决」，以及验收冲突、文档缺口、栈外依赖、UI/UX 未定项，都先列出 2–5 个真实可行的选项；不能把你想要的答案当唯一候选。
把原始需求、任务标题与验收、冲突和选项忠实译成英文写入 state.json（文档与回报仍用中文）；UI/UX 取舍使用 design，其余使用 adjudicate。
运行 python "docs/PackJoyU-开发文档/_run/typesafe_ask.py" --log "docs/PackJoyU-开发文档/_run/judgments.jsonl" --label "M1-T1:resume" run adjudicate --state <state.json>；UI/UX 将 adjudicate 换成 design。若 language_warning 提示中文过多，重译后重跑。
仅 status=ok 且 verdicts.adopt.action=take 才按 option 执行；confidence=low 仍用 Jev 的 option，记低置信风险。spec_change=yes 走文档补丁，outside_stack=yes 在回报点名，不自动扩权。
adopt=red_line 仅涉及付费、不可逆删除、改变已定范围或对外承诺时请求用户授权；status=skipped/error 或缺有效 pick 时留下待 Jev 裁决，不得由人代答、判 pass、声称已落地或写 clean/fixed。
回报逐条写：冲突 → 全部候选 → Jev line/model/采纳的 option → 代码或文档动作；没有写「无」。
