import copy
import hashlib
import json
import re
from pathlib import Path

BASE = Path(r'D:\xiangmu\.codex-plans\NBshiyan-docs-s2-s6')
OUT = BASE / 's5-remediation'
DOCS = Path(r'D:\xiangmu\NBshiyan-docs-s2-s6\docs\PackJoyU-开发文档')
source = {t['id']: t for t in json.loads((BASE / 'all-tasks.json').read_text(encoding='utf-8-sig'))}
english = {t['id']: t for t in json.loads((BASE / 's5-calibration/tasks-en.json').read_text(encoding='utf-8'))}
edges = json.loads((BASE / 's5-calibration/edges-en.json').read_text(encoding='utf-8'))
tasks = {k: copy.deepcopy(v) for k, v in source.items() if v['module'] in {'M1', 'M2', 'M5'}}


def set_task(task_id, *, title, input, output, acceptance, days, deps, paths, provides,
             requires=(), support=(), wiring=(), ui=False, stage='integration', integration=None,
             en_title, en_input, en_output, en_accept):
    t = copy.deepcopy(tasks.get(task_id, {}))
    t.update(id=task_id, module=task_id.split('-')[0], title=title, input=input, output=output,
             acceptance=acceptance, days=days, deps=list(deps), paths=list(paths),
             supportPaths=list(support), provides=list(provides),
             requires=[{'task': a, 'capability': b} for a, b in requires],
             stage=stage, wiring=list(wiring), ui=ui)
    if integration:
        t['integrationTask'] = integration
    else:
        t.pop('integrationTask', None)
    tasks[task_id] = t
    english[task_id] = dict(id=task_id, module=t['module'], title=en_title,
                            input=en_input, output=en_output, accept=en_accept)


set_task('M1-T1',
 title='接入8个核心品牌变量及既有路径真实冒烟',
 input='现有首页、GET /api/models、WebVitals/RUM；11节核心变量；本地已审规格分支',
 output='visual-base的8个核心变量；runnable-smoke；含已审文档基线的实施PR与CI冒烟',
 acceptance='1) 仅将背景、前景、强调色、边界宽度、圆角、基础字号、正文行高、焦点颜色8个核心token接入现有首页，不建立新页面或新业务控件；构建/启动真实standalone，从header产品链接进入产品页，computed style逐一等于11节取值，GET /api/models返回已发布来源。2) 真实首页WebVitals触发POST /api/rum并核204和脱敏日志，CI起同一服务运行此浏览器冒烟。3) 本地已审文档随本PR进入主干；后续任务从该落地基线建分支。',
 days='2d', deps=[],
 paths=['src/styles/tokens.css','src/styles/motion-tokens.css','.github/workflows/ci.yml','e2e/brand-smoke.spec.ts','docs/PackJoyU-开发文档/','AGENTS.md','CLAUDE.md'],
 provides=['visual-base','runnable-smoke'], wiring=['buildPipeline','frontendRoutes'], ui=True,
 en_title='Wire eight core brand variables and a real smoke test of existing paths',
 en_input='The existing home page, GET /api/models and WebVitals/RUM; core variables in section 11; the locally reviewed specification branch',
 en_output='Eight core visual-base variables; runnable-smoke; an implementation PR carrying the reviewed documentation baseline and a CI smoke test',
 en_accept='1) Wire only eight core tokens into the existing home page: background, foreground, accent color, border width, border radius, base font size, body line height and focus color; do not create new pages or business controls. Build/start the real standalone service, follow the header product link to the products page, verify each computed style equals section 11, and verify GET /api/models returns the published source. 2) Actual home-page WebVitals must trigger POST /api/rum; verify 204 and redacted logs. CI starts the same service and runs this browser smoke test. 3) Bring the locally reviewed documents into main through this PR; subsequent tasks branch from that landed baseline.')

set_task('M1-T2',
 title='导出新增领域共享schema与DTO',
 input='06/09/10节字段契约、Auth.js既有错误协议及visual-base基线',
 output='contract-types；account/recovery/chat/analytics/ops/errors schema与公共index导出',
 acceptance='1) 逐字段对照10节建立严格Zod请求/响应schema，类型仅由schema导出，公共index能被独立TypeScript消费，未知字段和超界字段拒绝。2) LoginMode只接password/totp；rememberDevice缺值、布尔false、字面false均解析false，其他非法值拒绝（E-95）。',
 days='1.5d', deps=['M1-T1'], paths=['src/lib/contracts/','tests/contracts-foundation.test.ts'],
 provides=['contract-types'], requires=[('M1-T1','visual-base')], wiring=['sharedTypes'],
 stage='primitive', integration='M1-T8',
 en_title='Export shared schemas and DTOs for the new domains',
 en_input='Field contracts in sections 06/09/10, the existing Auth.js error protocol and the visual-base baseline',
 en_output='contract-types; account/recovery/chat/analytics/ops/errors schemas and public index exports',
 en_accept='1) Establish strict Zod request/response schemas by checking every field against section 10; derive types only from schemas, make the public index consumable by independent TypeScript code, and reject unknown or out-of-bound fields. 2) LoginMode accepts only password/totp; missing rememberDevice, boolean false and literal false parse as false, while other invalid values are rejected. (E-95).')

set_task('M1-T3',
 title='制作JPG换标及视频海报发布副本',
 input='桌面原JPG/视频、现用PackJoyU字标、来源与原件哈希登记',
 output='brand-static-media；换标JPG、视频语义海报及压缩视频副本、哈希/对照清单',
 acceptance='1) 原JPG/视频哈希不变，输出文件均可解码；将JPG飞艇与工厂墙面的旧标逐处列入清单并以现用PackJoyU字标完整替换，清单逐处核无旧标，视频海报取自其自身画面且带可核帧时刻。2) 即使候选设计与线上字标不同仍使用当前PackJoyU字标，记录所用标识文件哈希；不等待用户回看候选图，不把候选当已批准新logo（E-28）。3) GPT Dot可达且实际制作时保留调用、软件操作、输出文件和成品核对记录；不可达则逐项写尚未执行/实施任务且该项不称完成，不伪称调用成功（E-29）。',
 days='1.5d', deps=['M1-T1'], paths=['public/brand/','docs/brand-media/static/'],
 provides=['brand-static-media'], requires=[('M1-T1','visual-base')],
 en_title='Produce a rebranded JPG and video-poster publication copies',
 en_input='The original desktop JPG/video, the current PackJoyU wordmark, and provenance/original-hash records',
 en_output='brand-static-media; a rebranded JPG, a semantically matching video poster and compressed video copy, hashes and a comparison checklist',
 en_accept='1) Original JPG/video hashes remain unchanged and all output files decode. List every old-logo location on the JPG blimp and factory wall, replace each completely with the current PackJoyU wordmark, and verify no old logo remains at each listed location. Extract the video poster from its own footage and record a verifiable frame time. 2) Even when a candidate design differs from the online wordmark, use the current PackJoyU wordmark and record the logo file hash. Do not wait for the user to revisit candidate images or treat a candidate as an approved new logo (E-28). 3) When GPT Dot is reachable and actually produces the assets, retain invocation, software-operation, output-file and finished-output check records. When unreachable, record not yet executed/the implementation task for each item, do not mark that item finished, and do not falsely claim successful invocation (E-29).')

set_task('M1-T6',
 title='逐帧替换GIF品牌并校验发布媒体集合',
 input='原361帧GIF、brand-static-media、现用字标与原始时间轴',
 output='brand-media；换标GIF、等尺寸暂停帧、逐帧品牌/时序报告与可发布集合',
 acceptance='1) 保留原JPG/GIF哈希，逐帧列出361帧中旧品牌出现、透视变化、转场及遮挡恢复位置，全部以PackJoyU完整覆盖；同时复核T3的JPG旧标位置，首尾帧与全部列出位置无旧标或漏标（E-26）。2) 用原时间轴对照每帧呈现时刻/顺序和30.08秒循环总长，全部相同；叠加对照无替换新增错位或抖动；任一失败则该副本标未完成且排除发布，原件保留回退（E-30）。3) 输出可解码GIF、同尺寸暂停静帧与哈希；GPT Dot制作证据或逐项尚未执行状态按T3的真实工具可达结果登记，不虚报完成。',
 days='2d', deps=['M1-T3'], paths=['public/brand/','docs/brand-media/animation/'],
 provides=['brand-media'], requires=[('M1-T3','brand-static-media')],
 en_title='Replace GIF branding frame by frame and verify the publication-media set',
 en_input='The original 361-frame GIF, brand-static-media, the current wordmark and the original timeline',
 en_output='brand-media; a rebranded GIF, same-size pause frame, frame-by-frame branding/timing report and publishable set',
 en_accept='1) Preserve original JPG/GIF hashes. List old-brand appearances, perspective changes, transitions and reappearances after occlusion across all 361 frames, and cover each completely with PackJoyU. Also recheck the JPG old-logo locations from T3; the first/last frames and all listed locations must contain no old or missed logo (E-26). 2) Compare every frame presentation time/order and the total 30.08-second loop against the original timeline; all must match. Overlay comparison must show no newly introduced misalignment or jitter. Any failure marks the copy unfinished and excludes it from publication, while preserving originals for rollback (E-30). 3) Output a decodable GIF, a same-size paused still and hashes. Record GPT Dot production evidence or per-item not-yet-executed status according to T3 actual tool availability; do not falsely report completion.')

set_task('M1-T7',
 title='补齐共享视觉变量与原生UI包装',
 input='visual-base的8个核心变量、第11节完整组件/状态规格',
 output='visual-components；完整唯一token源与Button/Input/Dialog/Status原生包装',
 acceptance='1) 只扩展同一tokens.css，不建立第二套颜色/字体/间距变量；Button/Input/Dialog/Status逐项使用11节高度、2px边界、0圆角、disabled/busy/error/focus值，类名/变量引用与原生语义断言对应每种状态，实际computed style由M1-T4集成验证。2) 包装组件不含fetch、Prisma、身份、cookie或业务角色判断；键盘焦点与对话框焦点恢复有自动化测试，前后台均导入同一出口。',
 days='1.5d', deps=['M1-T1'], paths=['src/styles/tokens.css','src/components/ui/','tests/ui-primitives.test.ts'],
 provides=['visual-components'], requires=[('M1-T1','visual-base')], stage='primitive', integration='M1-T4',
 en_title='Complete shared visual variables and native UI wrappers',
 en_input='The eight core visual-base variables and the complete component/state specification in section 11',
 en_output='visual-components; the complete single token source and native Button/Input/Dialog/Status wrappers',
 en_accept='1) Extend only the same tokens.css, without a second set of color/font/spacing variables. Button/Input/Dialog/Status must use section 11 heights, 2px borders, 0 border radius and disabled/busy/error/focus values; Class/variable-reference and native-semantics assertions must match every state; M1-T4 verifies actual computed styles in integration. 2) Wrapper components contain no fetch, Prisma, identity, cookie or business-role decisions. Automated tests cover keyboard focus and dialog focus restoration; public and admin clients import the same export.')

set_task('M1-T8',
 title='接通统一fetch取消与错误适配',
 input='contract-types、10节逐方法重试规则与既有Auth.js/旧error协议',
 output='client-api-foundation；15s取消、DTO解析、旧错误兼容及服务端HTTP错误映射',
 acceptance='1) 使用真实本地HTTP测试延迟、400/401/403/409/429/503及旧{error}响应，15s取消和卸载取消均终止在途请求，fieldErrors只保留受控字段，未知异常不回显stack/message。2) 普通GET及聊天/分析的同key重试按10节执行；一次性reauth/recovery/cron的响应未知不自动重放；业务组件只能从统一出口取得请求/错误适配，Auth.js原信封不改。',
 days='1.5d', deps=['M1-T2'], paths=['src/lib/client/api.ts','src/lib/client/api-errors.ts','src/lib/server/http/errors.ts','tests/client-api-foundation.http.test.ts'],
 provides=['client-api-foundation'], requires=[('M1-T2','contract-types')], wiring=['sharedTypes'],
 en_title='Wire unified fetch cancellation and error adapters',
 en_input='contract-types, the method-specific retry rules in section 10, and the existing Auth.js/old error protocols',
 en_output='client-api-foundation; cancellation at 15s, DTO parsing, old-error compatibility and server-side HTTP error mapping',
 en_accept='1) Use a real local HTTP server to test delays, 400/401/403/409/429/503 and old {error} responses. Cancellation at 15s and on unmount must terminate in-flight requests; fieldErrors retain only controlled fields, and unknown exceptions must not echo stack/message. 2) Ordinary GET and same-key chat/analytics retries follow section 10. Unknown results for one-time reauth/recovery/cron requests are not automatically replayed. Business components obtain request/error adapters only through the unified export, and the original Auth.js envelope remains unchanged.')

set_task('M1-T4',
 title='接好首页视频与分区JPG/GIF场景',
 input='brand-media、visual-components、client-api-foundation与现有首页SSR布局',
 output='home-media；现有主页/公共壳中的视频与分区品牌场景',
 acceptance='1) 点击字标home-link→/[locale]、products-link→产品、contact-link→联系，并核SSR来源与GET /api/models；12.27秒视频muted/playsinline且播放/暂停可点击，阻止autoplay后保留海报及播放入口，解码失败/减少动态效果显示语义JPG而不强制持续播放（E-21、E-22）。2) 城市JPG/GIF位于产品区后；网络断言接近视区300px前没有GIF下载，进入后才加载；点击暂停、离开视区、后台页均切同尺寸静帧，恢复可见不覆盖用户暂停（E-23、E-24）。3) 1440/1920/390逐项测媒体宽高比与源一致，媒体DOM矩形不与导航/正文/3D操作区的可点击矩形相交，渲染媒体的完整源图像四角及主体均在容器内；不得删主体或控件通过，保留按钮动作真实GIF（E-25）。',
 days='1.5d', deps=['M1-T6','M1-T7','M1-T8'], paths=['src/components/layout/','src/app/','messages/en.json','messages/ru.json','e2e/home-media.spec.ts'],
 provides=['home-media'], requires=[('M1-T6','brand-media'),('M1-T7','visual-components'),('M1-T8','client-api-foundation')], wiring=['frontendRoutes'], ui=True,
 en_title='Wire the home-page video and a separate JPG/GIF scene',
 en_input='brand-media, visual-components, client-api-foundation and the existing home-page SSR layout',
 en_output='home-media; video and a separate brand scene in the existing home page/public shell',
 en_accept='1) Click wordmark home-link to /[locale], products-link to products and contact-link to contact, and verify the SSR source and GET /api/models. The 12.27-second video has muted/playsinline and clickable play/pause controls. With autoplay blocked, retain its poster/play entry; decoding failure or reduced motion shows a semantic JPG without forcing continuous playback (E-21, E-22). 2) Put the city JPG/GIF after products. Network assertions show no GIF download before approaching within 300px of the viewport, and loading only afterward. Pause clicks, leaving the viewport and backgrounding the page switch to a same-size still; restored visibility does not override the user pause (E-23, E-24). 3) At 1440/1920/390, measure media aspect ratios against sources and verify its DOM rectangles do not intersect clickable rectangles for navigation/body/3D operating areas. The rendered complete source image corners and main subject remain within the container; do not pass by removing the subject or controls. Retain a real GIF of button actions (E-25).')

set_task('M1-T5',
 title='发布可核实己方公司内容与对应入口',
 input='己方可核实材料、PDF结构参考、现有SiteSetting/Sanity及发布开关',
 output='company-content；about内容/事实对照表与联系隐私入口兼容',
 acceptance='1) 为每个对外公司硬事实建立“页面字段→己方证据文件/页码”对照；无己方证据的YUHAO认证/产能/工厂规模不得出现在成品文案或图片；PDF仅作结构/产品主题参考，自动检索加逐字段对照均无改名冒用（E-27）。2) 成品引用的logo哈希等于现用PackJoyU字标，不使用候选新标；不等待用户回看候选图，PDF指令不作执行授权（E-28）。3) 真浏览器点about-link→/[locale]/about、footer联系/隐私→对应路由，en/ru切换保持对应页；发布开关关闭时仍404，开时SSR SiteSetting/Sanity显示与事实对照表一致，改动页全部有导航证据。',
 days='1.5d', deps=['M1-T4'], paths=['src/components/about/','src/app/','messages/en.json','messages/ru.json','docs/brand-content/','e2e/company-content.spec.ts'],
 provides=['company-content'], requires=[('M1-T4','home-media')], wiring=['frontendRoutes'], ui=True,
 en_title='Publish verifiable company-owned content and its entries',
 en_input='Verifiable company-owned materials, the PDF as a structural reference, and existing SiteSetting/Sanity/publication switches',
 en_output='company-content; about content/a fact-comparison table and compatible contact/privacy entries',
 en_accept='1) For every public hard corporate fact, create a page-field to company-owned evidence file/page mapping. YUHAO certifications/capacity/factory scale lacking company-owned evidence must appear in neither final copy nor images. Use the PDF only for structure/product themes; automated searches plus per-field comparison must find no renamed appropriation (E-27). 2) The final logo hash equals the current PackJoyU wordmark; do not use a candidate new logo or wait for the user to revisit candidates. PDF instructions are not execution authorization (E-28). 3) In a real browser click about-link to /[locale]/about and footer contact/privacy to their respective routes; en/ru switching retains the corresponding page. With the publication switch off, retain 404; with it on, SSR SiteSetting/Sanity matches the fact table. Retain navigation evidence for every changed page.')

# The bounded card-layout and pointer tasks keep their original scope and English.
tasks['M2-T1']['deps'] = ['M1-T4']
tasks['M2-T1']['requires'] = [{'task':'M1-T4','capability':'home-media'}]

set_task('M2-T3',
 title='接通模型键盘触屏与复位控件',
 input='model-pointer、每产品初始相机/缩放边界与现有大卡',
 output='model-accessibility；键盘/单指/双指/复位与44px控件',
 acceptance='1) Tab逐个到达命名控件且焦点可见，方向/缩放/复位与鼠标功能相同；Escape退出并回来源控件，不锁Tab、不自动跳产品链接（E-101）。2) 分别测试模型单指拖动、双指min/max内缩放、文字区页面滚动，所有操作只在模型区接管且不提交询盘；逐个测点击目标≥44 CSS px（E-102）。3) 任意旋转/缩放后复位等于该产品初始相机/边界；1440/1920及窄屏完整模型可见、名称/关键控件符合11节字号且规格/询盘仍可见，不通过删内容消除裁切（E-104）。',
 days='1.5d', deps=['M2-T2'], paths=['src/components/three/','src/lib/three/','e2e/model-accessibility.spec.ts'],
 provides=['model-accessibility'], requires=[('M2-T2','model-pointer')], wiring=['frontendRoutes'], ui=True,
 en_title='Wire model keyboard/touch and reset controls',
 en_input='model-pointer, each product initial camera/zoom bounds and the existing large cards',
 en_output='model-accessibility; keyboard/single-finger/two-finger/reset controls with 44px targets',
 en_accept='1) Tab reaches each named control with visible focus; direction/zoom/reset provide the same functions as the mouse. Escape exits to its source control without trapping Tab or automatically following product links (E-101). 2) Separately test single-finger model drag, two-finger zoom within min/max and text-area page scroll; takeover stays within the model area, no gesture submits an inquiry, and each measured hit target is at least 44 CSS px (E-102). 3) After arbitrary rotation/zoom, reset equals that product initial camera/bounds. At 1440/1920 and narrow sizes the complete model is visible, names/key controls meet section 11 font sizes, and specifications/inquiry remain visible; do not eliminate clipping by deleting content (E-104).')

set_task('M2-T6',
 title='接通真实模型失败与海报回退',
 input='model-accessibility、对应产品poster与真实GLB来源',
 output='model-fallback；GLB/WebGL/context失败的静态回退和重试入口',
 acceptance='1) 分别注入GLB下载失败、WebGL不支持、context lost和仅poster/FoldBox，显示对应产品海报及可点击重试/询盘；不无限重试、不把其他产品图片充当回退。2) 重试建立新的实际加载尝试，卸载取消旧监听/加载回调；纯展示状态只上报加载结果回调，不在本任务创建分析成功事件，统计完整集成由M2-T7完成。',
 days='1d', deps=['M2-T3'], paths=['src/components/three/','src/lib/three/','e2e/model-fallback.spec.ts'],
 provides=['model-fallback'], requires=[('M2-T3','model-accessibility')], wiring=['frontendRoutes'], ui=True,
 en_title='Wire real-model failures and poster fallback',
 en_input='model-accessibility, the corresponding product posters and actual GLB sources',
 en_output='model-fallback; static fallback/retry entries for GLB/WebGL/context failures',
 en_accept='1) Separately inject GLB-download failure, unsupported WebGL, context lost and poster/FoldBox-only display. Show the corresponding product poster and clickable retry/inquiry; do not retry indefinitely or substitute another product image. 2) Retry establishes a new actual loading attempt; unmount cancels old listeners/loading callbacks. Presentation state emits only a load-result callback, without creating analytics success events in this task; M2-T7 completes metrics integration.')

set_task('M2-T4',
 title='定义模型分析事件生命周期纯规则',
 input='contract-types中的事件白名单、navigationId/viewId与durationMs约束',
 output='model-event-rules；start/terminal去重及取消/重试转换的纯函数',
 acceptance='1) 录制输入序列验证每viewId最多一个success/failure，timeout为failure，poster/FoldBox不产生GLB success，重试新尝试使用新viewId；函数不读DOM/env/cookie且不fetch。2) 事件输出必须通过M1共享schema；durationMs取注入单调时钟差，产品/导航关联原样保留，乱序/重复终态不覆盖已定终态；真实浏览器生产者由M2-T7消费。',
 days='1d', deps=['M1-T2'], paths=['src/lib/analytics/model-events.ts','tests/model-event-rules.test.ts'],
 provides=['model-event-rules'], requires=[('M1-T2','contract-types')], stage='primitive', integration='M2-T7',
 en_title='Define pure lifecycle rules for model analytics events',
 en_input='The event allowlist and navigationId/viewId/durationMs constraints in contract-types',
 en_output='model-event-rules; pure functions for start/terminal deduplication and cancellation/retry transitions',
 en_accept='1) Recorded input sequences verify at most one success/failure per viewId, timeout as failure, no GLB success from poster/FoldBox, and a new viewId for a retried new attempt. Functions read no DOM/env/cookie and perform no fetch. 2) Output events must pass the shared M1 schema; durationMs comes from the injected monotonic-clock difference, product/navigation associations are preserved, and out-of-order/duplicate terminals do not overwrite the decided terminal. M2-T7 consumes these rules in the real-browser producer.')

set_task('M2-T7',
 title='把真实GLB生命周期接入分析采集',
 input='model-event-rules、model-fallback、analytics-ingest与analytics-consent-ui',
 output='model-events；页面/产品访问与真实GLB start/terminal生产者接线',
 acceptance='1) 真浏览器产品卡发起GLB后POST /api/analytics/events分别保存产品访问、model_view_start及成功/失败；只进入产品页不打开3D无start；未同意/拒绝分析时模型仍可用且无分析请求（E-42、E-46）。2) 分别注入GLB下载失败/WebGL不支持/context lost/poster或FoldBox，仅对应产品静态回退、重试及询盘可用；poster/演示无GLB success；同viewId最多一种终态，新实际重试按规则新viewId（E-103）。3) 成功/失败/超时两次尝试与切卡取消逐项核关联及真实durationMs，分母仅同意后真实start、timeout为failure、平均耗时带samples且无样本null，不补拒绝样本（E-63）。',
 days='1.5d', deps=['M2-T4','M2-T6','M5-T6','M5-T7','M5-T3'], paths=['src/components/three/','src/components/analytics/','e2e/model-events.spec.ts'],
 provides=['model-events'], requires=[('M2-T4','model-event-rules'),('M2-T6','model-fallback'),('M5-T6','analytics-ingest'),('M5-T7','analytics-consent-ui')], wiring=['eventKinds','frontendRoutes'], ui=True,
 en_title='Wire actual GLB lifecycles into analytics ingestion',
 en_input='model-event-rules, model-fallback, analytics-ingest and analytics-consent-ui',
 en_output='model-events; producer wiring for page/product visits and real GLB start/terminal events',
 en_accept='1) After real-browser product-card GLB initiation, POST /api/analytics/events separately persists product visits, model_view_start and success/failure. Entering a product page without opening 3D produces no start. Without consent/with analytics rejected, models remain usable and no analytics request occurs (E-42, E-46). 2) Separately inject GLB-download failure, unsupported WebGL, context lost and poster/FoldBox-only display. Corresponding product fallback/retry/inquiry stay usable, posters/demonstrations send no GLB success, each viewId has at most one terminal kind, and new actual retries use new viewIds under the rules (E-103). 3) Verify associations and actual durationMs for two success/failure/timeout attempts and cancellation on card switching. The denominator includes only real starts after consent; timeout is failure, mean duration carries samples and is null with no samples, and rejected samples are not added (E-63).')

set_task('M2-T5',
 title='连接产品上下文到既有询盘表单',
 input='model-fallback、现有InquiryWizard与POST /api/inquiries协议',
 output='product-inquiry；产品卡至联系页询盘的上下文链',
 acceptance='1) 点击产品卡inquire-product→/[locale]/contact，真实POST /api/inquiries携服务器认可productSlug并保存真实Inquiry编号，表单的产品/规格等于来源卡片，不改旧询盘协议。2) en/ru和390窄屏分别走该入口，提交前从模型拖动/键盘控制不产生询盘POST；名称、规格、询盘入口仍可见且能完成提交，保留一条真实路径GIF。',
 days='1d', deps=['M2-T6','M1-T8'], paths=['src/components/inquiry/','src/components/quote/','src/components/three/ProductGallery.tsx','src/app/','e2e/product-inquiry.spec.ts'],
 provides=['product-inquiry'], requires=[('M2-T6','model-fallback'),('M1-T8','client-api-foundation')], wiring=['frontendRoutes'], ui=True,
 en_title='Connect product context to the existing inquiry form',
 en_input='model-fallback, the existing InquiryWizard and POST /api/inquiries protocol',
 en_output='product-inquiry; the context chain from product cards to contact-page inquiries',
 en_accept='1) Click product-card inquire-product to /[locale]/contact. A real POST /api/inquiries carries a server-recognized productSlug and persists a real Inquiry identifier; form product/specifications equal the source card, without changing the old inquiry protocol. 2) Use that entry separately in en/ru and at narrow width 390. Model dragging/keyboard control before submission produces no inquiry POST; names, specifications and inquiry entries remain visible and can complete submission. Retain one real-path GIF.')

set_task('M2-T8',
 title='贯通产品咨询与人工收件回复',
 input='product-inquiry、chat-visitor-ui、chat-operator-ui与model-events',
 output='product-contact；带产品上下文的访客/运营人工咨询链',
 acceptance='1) 产品卡chat-product打开窗口，POST /api/chat/conversations保存同一productSlug/稳定消息编号后才显示已接收；运营真实收件箱可读该消息并人工回复，访客收到同一回复；网络中无AI答复接口或自动生成答复（E-16、E-31）。2) 拒绝分析仍可咨询且不建分析ID/第三方聊天脚本；提交超时/响应丢失后同clientMessageId重试返回原收件结果，收件箱/通知各一项；当前标签草稿保留，en/ru/390路径有真实GIF（E-37、E-40）。',
 days='1.5d', deps=['M2-T5','M2-T7','M4-T5','M4-T6'], paths=['src/components/chat/','src/components/three/ProductGallery.tsx','e2e/product-contact.spec.ts'],
 provides=['product-contact'], requires=[('M2-T5','product-inquiry'),('M2-T7','model-events'),('M4-T5','chat-visitor-ui'),('M4-T6','chat-operator-ui')], wiring=['frontendRoutes'], ui=True,
 en_title='Connect product consultation through human receipt and reply',
 en_input='product-inquiry, chat-visitor-ui, chat-operator-ui and model-events',
 en_output='product-contact; the visitor/operator human-consultation chain with product context',
 en_accept='1) Product-card chat-product opens the window. POST /api/chat/conversations must persist the same productSlug/stable message identifier before showing received. The real operator inbox can read it and a human replies; the visitor receives that same reply. Network traffic contains no AI-reply endpoint or automatically generated reply (E-16, E-31). 2) Rejected analytics does not prevent consultation or create analytics IDs/third-party chat scripts. After submission timeout/lost response, retry with the same clientMessageId and return the original receipt; the inbox/notification each contain one item. Preserve the current-tab draft and retain real GIFs for en/ru/390 paths (E-37, E-40).')

set_task('M5-T1',
 title='建立JobState租约与代次仓储原语',
 input='contract-types、09节JobState和数据库时间/条件更新规则',
 output='job-leases；JobState schema、原子领取/续租/完成与安全状态读取',
 acceptance='1) 在真实隔离PostgreSQL中并发领取同key只有一项成功，租约90s后可新代次领取；旧owner/generation完成写拒绝，新结果不被旧写覆盖。2) summary只接白名单计数/时间/版本，lastSucceededAt只在成功提交推进，失败保留原成功时间；没有任意脚本执行能力；此原语由M5-T8在生产组合点接入真实作业。',
 days='1d', deps=['M1-T2'], paths=['src/lib/server/jobs/lease-repo.ts','src/lib/server/jobs/types.ts','prisma/schema.prisma','tests/job-leases.db.test.ts'],
 provides=['job-leases'], requires=[('M1-T2','contract-types')], stage='primitive', integration='M5-T8',
 en_title='Establish JobState lease/generation repository primitives',
 en_input='contract-types, JobState in section 09 and database-time/conditional-update rules',
 en_output='job-leases; JobState schema, atomic acquisition/renewal/completion and safe status reads',
 en_accept='1) In real isolated PostgreSQL, concurrent acquisition of the same key yields only one success; after a 90s lease, a new generation can acquire it. Completion by an old owner/generation is rejected and cannot overwrite new results. 2) summary accepts only allowlisted counts/times/versions; lastSucceededAt advances only on successful commit, and failure retains the old successful time. There is no arbitrary-script execution capability. M5-T8 wires this primitive into real jobs at the production composition point.')

set_task('M5-T2',
 title='接通服务端分析同意签名cookie',
 input='contract-types、M3当前HTTP防护与09节同意cookie规则',
 output='analytics-consent-api；POST /api/analytics/consent及同意验签服务',
 acceptance='1) 真实HTTP POST /api/analytics/consent在精确同源/限流后解析strict Boolean；首次true签随机ID与版本/原期限cookie，已有有效同版本true响应保留原ID/期限；false/重复false清cookie且不生成身份。2) 伪签名、过期或缺cookie均不能通过同意验证，响应无原始IP/邮箱/正文；此任务只实现后端准入，UI撤回与生产者停采由M5-T7集成。',
 days='1d', deps=['M1-T2','M3-T1'], paths=['src/lib/server/analytics/consent.ts','src/app/api/analytics/consent/route.ts','tests/analytics-consent.http.test.ts'],
 provides=['analytics-consent-api'], requires=[('M1-T2','contract-types'),('M3-T1','http-guards-metrics')], wiring=['backendRoutes','container'],
 en_title='Wire the server-side signed analytics-consent cookie',
 en_input='contract-types, current M3 HTTP protections and consent-cookie rules in section 09',
 en_output='analytics-consent-api; POST /api/analytics/consent and consent-signature verification',
 en_accept='1) A real HTTP POST /api/analytics/consent parses a strict Boolean after exact-origin/rate-limit checks. Initial true signs a random ID plus version/original expiry cookie; repeated true with a valid same-version cookie preserves its original ID/expiry. false/repeated false clears the cookie without generating identity. 2) Forged signatures, expired cookies and missing cookies fail consent validation; responses contain no raw IP/email/body. This task implements backend admission only; M5-T7 integrates UI withdrawal and stopping producers.')

set_task('M5-T6',
 title='持久化严格白名单分析事件',
 input='analytics-consent-api、共享事件schema与已发布产品来源',
 output='analytics-ingest；AnalyticsEvent及POST /api/analytics/events',
 acceptance='1) 真HTTP以有效签名同意cookie发送page_view/product_view/model_view_start/model_load_success/model_load_failure/chat_start；分别验证必填navigationId/viewId/productSlug和发布产品白名单；schema拒绝未知种类/超长/敏感URL，事件库无IP/指纹/email/正文。2) 真实Postgres重复eventId/semanticKey同载荷仅一行，异载荷409；同viewId success/failure只能一种终态，产品页事件与start/terminal分开存，failure不写success；-48h/+5min之外拒绝。3) 撤回cookie后请求403且事件行数不变；客户端真实模型生产者由M2-T7接入，浏览器同意及普通页面生产者由M5-T7接入。',
 days='1.5d', deps=['M5-T2'], paths=['src/lib/server/analytics/ingest.ts','src/lib/server/analytics/event-repo.ts','src/app/api/analytics/events/route.ts','prisma/schema.prisma','tests/analytics-ingest.http.db.test.ts'],
 provides=['analytics-ingest'], requires=[('M5-T2','analytics-consent-api')], wiring=['backendRoutes','container','eventKinds','migrations'],
 en_title='Persist strictly allowlisted analytics events',
 en_input='analytics-consent-api, shared event schemas and the published-product source',
 en_output='analytics-ingest; AnalyticsEvent and POST /api/analytics/events',
 en_accept='1) Through real HTTP with a valid signed-consent cookie send page_view/product_view/model_view_start/model_load_success/model_load_failure/chat_start. Individually validate required navigationId/viewId/productSlug and the published-product allowlist. Schema rejects unknown kinds/oversized fields/sensitive URLs; the event database contains no IP/fingerprint/email/body. 2) Real PostgreSQL stores only one row for repeated eventId/semanticKey with the same payload and returns 409 for differing payloads. The same viewId has only one success/failure terminal; page events and start/terminal records are stored separately, and failure does not write success. Reject timestamps outside -48h/+5min. 3) After consent-cookie withdrawal requests return 403 and event-row count does not change. M2-T7 wires the real-model client producer; M5-T7 wires browser consent and ordinary-page producers.')

set_task('M5-T7',
 title='接通同意UI撤回与页面事件生产者',
 input='analytics-consent-api、analytics-ingest、client-api-foundation及现有footer偏好入口',
 output='analytics-consent-ui、analytics-page-events；串行同意写与页面生产者',
 acceptance='1) 真浏览器footer analytics-preferences打开控件；未同意/拒绝不生成保存分析ID、不发事件，页面/3D仍可用；同意后真实路由完成产生page_view且同navigationId重试不重复（E-42）。2) 撤回立即停采、清本地分析ID和待发队列，不补发撤回期访问；true在途后选择false按最新意图串行清cookie，响应乱序不能重开采集（E-43）。3) UI使用11节唯一minimalist-flat及07/12接线，1920×1080/1440×900/390×844记录实际请求GIF/computed style；键盘和44px触屏目标可用。',
 days='1.5d', deps=['M5-T2','M5-T6','M1-T8','M1-T7'], paths=['src/lib/client/analytics.ts','src/components/consent/','src/components/analytics/','e2e/analytics-consent.spec.ts'],
 provides=['analytics-consent-ui','analytics-page-events'], requires=[('M5-T2','analytics-consent-api'),('M5-T6','analytics-ingest'),('M1-T8','client-api-foundation'),('M1-T7','visual-components')], wiring=['frontendRoutes','eventKinds'], ui=True,
 en_title='Wire consent-UI withdrawal and page-event producers',
 en_input='analytics-consent-api, analytics-ingest, client-api-foundation and the existing footer preferences entry',
 en_output='analytics-consent-ui and analytics-page-events; serialized consent writes and page producers',
 en_accept='1) Open controls through footer analytics-preferences in a real browser. Without consent/with rejection, do not generate/store analytics IDs or send events, while pages/3D remain usable. After consent, a completed real navigation produces page_view and retries with the same navigationId do not duplicate it (E-42). 2) Withdrawal immediately stops collection, clears local analytics IDs/pending queues and does not backfill withdrawn-period visits. If false is selected while true is in flight, serialize cookie clearing according to the latest intent; out-of-order responses cannot reopen collection (E-43). 3) Use only section 11 minimalist-flat and sections 07/12 wiring. At 1920x1080/1440x900/390x844 retain actual-request GIF/computed-style evidence; keyboard and 44px touch targets remain usable.')

set_task('M5-T9',
 title='建立版本化IANA时区与自然日仓储规则',
 input='SiteSetting既有CAS、09节timezoneRevision与UTC事件规则',
 output='analytics-settings-domain；时区校验、版本CAS及本地日UTC边界服务',
 acceptance='1) 用Intl/IANA计算本地午夜至次日午夜的左闭右开UTC边界，测试23/25小时DST、午夜归属唯一和两种浏览器时区输入不影响站点日。2) 隔离Postgres中ADMIN当前角色通过版本CAS改有效timezone/revision并记录重算待办，非法IANA/旧version/非ADMIN拒绝且原值不变；保持UTC事件不改写；HTTP接线由M5-T4完成。',
 days='1d', deps=['M1-T2','M3-T1'], paths=['src/lib/server/analytics/settings.ts','src/lib/server/analytics/settings-repo.ts','src/lib/analytics/day-boundaries.ts','tests/analytics-settings.db.test.ts','tests/analytics-day-boundaries.test.ts'],
 provides=['analytics-settings-domain'], requires=[('M1-T2','contract-types'),('M3-T1','current-admin-permissions')], stage='primitive', integration='M5-T4',
 en_title='Establish versioned IANA time-zone and natural-day repository rules',
 en_input='Existing SiteSetting CAS and section 09 timezoneRevision/UTC-event rules',
 en_output='analytics-settings-domain; time-zone validation, version CAS and local-day UTC-boundary services',
 en_accept='1) Use Intl/IANA to compute left-closed/right-open UTC boundaries from local midnight to the next midnight. Test 23/25-hour DST, unique midnight membership and two browser time-zone inputs not changing the site day. 2) In isolated PostgreSQL, current-role ADMIN changes valid timezone/revision through version CAS and records pending recomputation; invalid IANA/stale version/non-ADMIN are rejected without changing the original. Preserve UTC events without rewriting them. M5-T4 completes HTTP wiring.')

set_task('M5-T3',
 title='以一致快照重算并原子替换日聚合',
 input='analytics-ingest、job-leases、analytics-settings-domain及完整原始覆盖边界',
 output='analytics-aggregate；AnalyticsDaily日/产品聚合服务与watermark发布',
 acceptance='1) 真Postgres同一重复事件仅计一次，聚合固定RepeatableRead快照/cutoff，新到事件留下一轮；同navigationId去重，整组目标日数据与watermark一次事务替换，进程中断保留上组（E-80、E-81）。2) 并发旧generation或旧timezoneRevision提交拒绝；只重算dayStart不早于完整原始覆盖起点的日，48h迟到重算该日，超范围保留原完整值并返回partial/unavailable及原口径，不延长原始保留、不用残片变小（E-82、E-83）。3) 聚合按站点IANA左闭右开日计算23/25小时DST及午夜单归属；变时区只用仍保留事件重算，30天外保留原标签/不可重算状态（E-56、E-57、E-58）。本服务由M5-T8接真实5分钟调度。',
 days='2d', deps=['M5-T6','M5-T1','M5-T9'], paths=['src/lib/server/analytics/aggregate.ts','src/lib/server/analytics/aggregate-repo.ts','prisma/schema.prisma','tests/analytics-aggregate.db.test.ts'],
 provides=['analytics-aggregate'], requires=[('M5-T6','analytics-ingest'),('M5-T1','job-leases'),('M5-T9','analytics-settings-domain')], stage='primitive', integration='M5-T8',
 en_title='Recompute daily aggregates from consistent snapshots and atomically replace them',
 en_input='analytics-ingest, job-leases, analytics-settings-domain and complete raw-coverage boundaries',
 en_output='analytics-aggregate; AnalyticsDaily daily/product aggregation services and watermark publication',
 en_accept='1) In real PostgreSQL count the same duplicate event once. Aggregation fixes a RepeatableRead snapshot/cutoff; newly arriving events wait for the next round. Deduplicate by navigationId and replace the whole target-day group plus watermark in one transaction; process interruption retains the previous group (E-80, E-81). 2) Reject commits by an old generation or timezoneRevision. Recompute only days whose dayStart is not earlier than complete raw coverage; late events within 48h recompute that day. Outside coverage preserve the old complete values and return partial/unavailable with their original definition, without extending raw retention or reducing counts from fragments (E-82, E-83). 3) Aggregate left-closed/right-open site-IANA days, including 23/25-hour DST and unique midnight membership. Time-zone changes recompute only still-retained events; beyond 30 days retain original labels/unavailable-recomputation state (E-56, E-57, E-58). M5-T8 wires this service into real five-minute scheduling.')

set_task('M5-T8',
 title='注册聚合作业并接通真实5分钟cron',
 input='job-leases、analytics-aggregate与M3共享HTTP防护',
 output='job-foundation、analytics-aggregate-runtime；固定registry、POST /api/admin/cron/operations及真实cron',
 acceptance='1) composition只注册已实现analytics-aggregate，deploy/cron.nbshiyan每5分钟POST /api/admin/cron/operations；固定key/Bearer常量时间校验，未知key/无凭据拒绝，不允许任意脚本。2) 真调度在重启后实际运行并提交JobState/watermark，batch≤500、55s截止、旧代次不能覆盖；停cron/失败保持上次成功watermark并显示安全状态NEVER/FAILED/旧值，不凭路由存在或手动调用宣称刚更新（E-81、E-84）。3) 真实浏览器同意后同日同浏览器完成两次页面访问并刷新/重试同eventId，实际job后UV仍1、真实新访问PV增加且重复事件不增加（E-44）；看板GET不触发任务，通知/邮件由M4注册，不导入未来服务或登记空实现。',
 days='1.5d', deps=['M5-T1','M5-T3','M3-T1'], paths=['src/lib/server/jobs/registry.ts','src/lib/server/composition.ts','src/app/api/admin/cron/operations/route.ts','deploy/cron.nbshiyan','deploy/deploy.sh','tests/jobs-runtime.http.test.ts'],
 provides=['job-foundation','analytics-aggregate-runtime'], requires=[('M5-T1','job-leases'),('M5-T3','analytics-aggregate'),('M3-T1','http-guards-metrics')], wiring=['backendRoutes','container','jobs','migrations'],
 en_title='Register the aggregation job and wire real five-minute cron',
 en_input='job-leases, analytics-aggregate and shared M3 HTTP protections',
 en_output='job-foundation and analytics-aggregate-runtime; a fixed registry, POST /api/admin/cron/operations and real cron',
 en_accept='1) composition registers only the implemented analytics-aggregate; deploy/cron.nbshiyan calls POST /api/admin/cron/operations every five minutes. Validate fixed keys/Bearer credentials in constant time; reject unknown keys/missing credentials and permit no arbitrary scripts. 2) Real scheduling executes after restart and commits JobState/watermark, with batch at most 500, a 55s deadline and no old-generation overwrite. Stopped cron/failure preserves the last successful watermark and exposes safe NEVER/FAILED/stale-value state; route existence/manual invocation does not justify claiming just updated (E-81, E-84). 3) After real-browser consent, complete two same-day page visits in the same browser and refresh/retry the same eventId. After the actual job UV stays 1, genuine new visits increase PV and duplicate events do not increase counts (E-44). Dashboard GET does not trigger jobs; M4 registers notification/mail jobs, without future-service imports or empty implementations.')

set_task('M5-T4',
 title='接通时区设置HTTP与重算范围查询',
 input='analytics-settings-domain、analytics-aggregate-runtime及现有ADMIN守卫',
 output='analytics-settings-api；GET/PATCH /api/admin/settings/analytics',
 acceptance='1) 真HTTP GET返回当前version/timezone/revision/recomputableFrom，PATCH携expectedVersion；ADMIN修改有效IANA后新revision及重算待办与审计同事务，下一真实作业只重算完整范围，旧范围保留原标签/partial（E-58）。2) 不存在IANA、旧version、SALES/EDITOR/未登录直接请求拒绝且原配置完全不变，不回退浏览器时区（E-59）；旧about/org设置不变，响应按10节schema通过。',
 days='1d', deps=['M5-T9','M5-T8'], paths=['src/app/api/admin/settings/analytics/route.ts','src/lib/server/composition.ts','tests/analytics-settings.http.test.ts'],
 provides=['analytics-settings-api'], requires=[('M5-T9','analytics-settings-domain'),('M5-T8','analytics-aggregate-runtime')], wiring=['backendRoutes','container'],
 en_title='Wire time-zone-settings HTTP and recomputation-coverage queries',
 en_input='analytics-settings-domain, analytics-aggregate-runtime and the existing ADMIN guard',
 en_output='analytics-settings-api; GET/PATCH /api/admin/settings/analytics',
 en_accept='1) Real HTTP GET returns current version/timezone/revision/recomputableFrom, and PATCH carries expectedVersion. An ADMIN change to a valid IANA time zone commits the new revision, pending recomputation and audit together; the next real job recomputes only complete coverage while older ranges retain original labels/partial (E-58). 2) Nonexistent IANA, stale version and direct SALES/EDITOR/unauthenticated requests are rejected with the original configuration entirely unchanged, without fallback to browser time zone (E-59). Existing about/org settings stay unchanged and responses pass section 10 schemas.')

set_task('M5-T12',
 title='呈现ADMIN时区表单与保存反馈',
 input='analytics-settings-api、admin-shell-profile-ui及visual-components',
 output='analytics-settings-ui；后台settings的analytics分区表单',
 acceptance='1) 真浏览器点settings-link→/admin/settings的analytics分区，GET读取后点击保存PATCH发送expectedVersion，显示服务端新revision/recomputableFrom及重算partial；非法IANA字段错误不清原值，非ADMIN不可进入且直接接口403（E-59）。2) 页面标明共同站点IANA时区，两种浏览器时区查看同一设置得到同值，此任务只验设置页，指标图表/导出由M6集成验共同标签；1920×1080/1440×900/390×844按form运行D1–D6与overflow，保留实际请求GIF/computed style，消费11节唯一风格。',
 days='1d', deps=['M5-T4','M3-T7','M1-T7'], paths=['src/components/admin/stats/AnalyticsSettingsContainer.tsx','src/app/admin/settings/','e2e/analytics-settings.spec.ts'],
 provides=['analytics-settings-ui'], requires=[('M5-T4','analytics-settings-api'),('M3-T7','admin-shell-profile-ui'),('M1-T7','visual-components')], wiring=['frontendRoutes'], ui=True,
 en_title='Present the ADMIN time-zone form and save feedback',
 en_input='analytics-settings-api, admin-shell-profile-ui and visual-components',
 en_output='analytics-settings-ui; the analytics-section form in admin settings',
 en_accept='1) In a real browser click settings-link to the analytics section of /admin/settings. After GET, clicking Save sends expectedVersion through PATCH and displays the server new revision/recomputableFrom and partial recomputation. Invalid-IANA field errors do not clear the old value; non-ADMIN cannot enter and direct API calls return 403 (E-59). 2) Label the common site-IANA time zone; two browser time zones see the same setting, this task verifies only the settings page, while M6 integration verifies common labels on charts/exports. At 1920x1080/1440x900/390x844 run form D1-D6/overflow checks, retain real-request GIF/computed-style evidence and consume the single style in section 11.')

set_task('M5-T5',
 title='实现分析保留候选与覆盖边界计划器',
 input='receivedAt/expiresAt规则、analytics-aggregate覆盖范围与09节保留参数',
 output='analytics-retention-plan；纯截止计算及只读候选仓储',
 acceptance='1) 注入时钟验证receivedAt+30天与13自然月expiresAt边界和等号到期；只读查询返回候选ID/数量，不执行删除，不含browserHash导出或业务PII。2) 计划器同时返回完整原始覆盖起点/不可重算自然日，部分清理日不得被标可重算；输出由M5-T11消费，真实事务/生产授权门禁由其集成。',
 days='0.5d', deps=['M5-T3'], paths=['src/lib/server/analytics/retention-plan.ts','tests/analytics-retention-plan.test.ts'],
 provides=['analytics-retention-plan'], requires=[('M5-T3','analytics-aggregate')], stage='primitive', integration='M5-T11',
 en_title='Implement an analytics-retention candidate/coverage planner',
 en_input='receivedAt/expiresAt rules, analytics-aggregate coverage and section 09 retention parameters',
 en_output='analytics-retention-plan; pure cutoff calculation and a read-only candidate repository',
 en_accept='1) With an injected clock verify receivedAt plus 30 days, 13-calendar-month expiresAt boundaries and equality-at-expiry. Read-only queries return candidate IDs/counts without deleting data or exporting browserHash/business PII. 2) The planner also returns the start of complete raw coverage/non-recomputable natural days; partially cleaned days cannot be marked recomputable. M5-T11 consumes this output and integrates real transactions/production-authorization gates.')

set_task('M5-T11',
 title='注册默认dry-run的分析保留任务',
 input='analytics-retention-plan、job-foundation与明确保留授权门禁',
 output='analytics-retention；固定每日job、候选/实际计数与授权拒绝',
 acceptance='1) operations固定analytics-retention→已实现服务→registry/每日cron实际注册；默认dryRun且真实清理关闭，无另行明确生产保留授权时启用/删除请求拒绝、实际删除0，只返回候选计数。2) 仅隔离Postgres数据验证receivedAt30天/聚合13自然月目标集合、计数与去标识；显示查询覆盖、不重建过期明细，不扩备份/既有数据删除权限（E-48）。3) 清理后调用既有聚合服务：只重算dayStart≥完整原始覆盖起点，48h迟到仍在完整范围时重算；部分清理日保留旧完整聚合并返回partial/unavailable与原口径，不用残片替换、不延长保留（E-82）；租约旧代次拒绝且不接触生产/恢复/备份数据。',
 days='1d', deps=['M5-T5','M5-T8'], paths=['src/lib/server/analytics/retention.ts','src/lib/server/jobs/registry.ts','src/lib/server/composition.ts','deploy/cron.nbshiyan','tests/analytics-retention.db.test.ts'],
 provides=['analytics-retention'], requires=[('M5-T5','analytics-retention-plan'),('M5-T8','job-foundation')], wiring=['jobs','container'],
 en_title='Register the default-dry-run analytics-retention job',
 en_input='analytics-retention-plan, job-foundation and explicit retention-authorization gates',
 en_output='analytics-retention; a fixed daily job, candidate/actual counts and authorization rejection',
 en_accept='1) Fixed operations analytics-retention leads to the implemented service and actual registry/daily-cron registration. Default to dryRun with actual cleanup off; without separate explicit production-retention authorization, reject enable/delete requests, delete zero and return only candidate counts. 2) Using only isolated PostgreSQL data, verify the expired set/counts/removal of identifiers for receivedAt 30 days and aggregates 13 calendar months. Show query coverage, do not reconstruct expired details, and do not extend deletion authority to backups/existing data (E-48). 3) After cleanup call the existing aggregation service: recompute only dayStart at or after complete raw coverage, including 48h-late events still inside complete coverage. For partially cleaned days preserve old complete aggregates and return partial/unavailable with the original definition; do not replace from fragments or extend retention (E-82). Reject old lease generations and do not touch production/recovery/backup data.')

set_task('M5-T10',
 title='同步隐私页面与指标范围说明',
 input='analytics-consent-ui、analytics-settings-api与当前en/ru隐私内容',
 output='analytics-privacy-copy；必要聊天/分析分离、保留及匿名浏览器定义',
 acceptance='1) 真浏览器footer privacy-link→/[locale]/privacy，en/ru对应内容明确写“已同意分析的匿名浏览器数”；隔离测试分别换设备context、清标识、换浏览器，核可形成新browserHash但报告仅记不同与否，不输出原值；不称唯一真人或跨设备识别（E-45）。2) 文案分别说明聊天必要cookie、分析同意、默认dry-run及实际保留授权边界；现有noindex完整度规则不改，页面展示站点IANA时区及原始/聚合查询范围，与后端配置读取一致。',
 days='0.5d', deps=['M5-T7','M5-T4'], paths=['src/app/','messages/en.json','messages/ru.json','e2e/privacy-analytics.spec.ts'],
 provides=['analytics-privacy-copy'], requires=[('M5-T7','analytics-consent-ui'),('M5-T4','analytics-settings-api')], wiring=['frontendRoutes'], ui=True,
 en_title='Synchronize privacy-page and metric-scope explanations',
 en_input='analytics-consent-ui, analytics-settings-api and current en/ru privacy content',
 en_output='analytics-privacy-copy; separation of necessary chat/analytics, retention and the anonymous-browser definition',
 en_accept='1) In a real browser use footer privacy-link to /[locale]/privacy. Corresponding en/ru content explicitly states Number of anonymous browsers that consented to analytics. Isolated tests separately change device contexts, clear identifiers and switch browsers, verifying that a new browserHash can form while recording only whether it differs, not its raw value. Do not claim unique real-person or cross-device identification (E-45). 2) Explain necessary chat cookies, analytics consent, default dry-run and actual retention-authorization boundaries separately. Preserve the existing noindex/completeness rules. Show the site-IANA time zone and raw/aggregate query ranges consistently with backend configuration reads.')

# Keep the bounded revision at 27 tasks: privacy copy belongs with consent UI.
privacy_task = tasks.pop('M5-T10')
privacy_en = english.pop('M5-T10')
settings_ui_task = tasks.pop('M5-T12')
settings_ui_en = english.pop('M5-T12')
settings_ui_task['id'] = 'M5-T10'
settings_ui_en['id'] = 'M5-T10'
tasks['M5-T10'] = settings_ui_task
english['M5-T10'] = settings_ui_en
consent = tasks['M5-T7']
consent_en = english['M5-T7']
consent['title'] = '接通同意UI、页面事件与隐私说明'
consent_en['title'] = 'Wire consent UI, page events and privacy explanations'
consent['days'] = '2d'
consent['deps'].append('M5-T9')
consent['requires'].append({'task':'M5-T9','capability':'analytics-settings-domain'})
consent['input'] += '；analytics-settings-domain的公开时区及现有en/ru隐私文案'
consent_en['input'] += '; the public time zone from analytics-settings-domain and existing en/ru privacy copy'
consent['provides'].append('analytics-privacy-copy')
consent['output'] += '；analytics-privacy-copy隐私页面及匿名浏览器/保留说明'
consent_en['output'] += '; analytics-privacy-copy privacy-page and anonymous-browser/retention explanations'
consent['acceptance'] += ' 4) ' + privacy_task['acceptance'].replace('1) ','',1).replace('2) ','5) ',1)
consent_en['accept'] += ' 4) ' + privacy_en['accept'].replace('1) ','',1).replace('2) ','5) ',1)
consent['paths'] = list(dict.fromkeys(consent['paths'] + ['src/app/','messages/en.json','messages/ru.json','e2e/privacy-analytics.spec.ts']))
tasks['M5-T8']['deps'].append('M5-T7')
tasks['M5-T8']['requires'].append({'task':'M5-T7','capability':'analytics-page-events'})
tasks['M5-T8']['days'] = '2d'

# Explicit source registration scopes for the revised backend split.
for key in ['M5-T1','M5-T3']:
    tasks[key]['wiring'] = ['migrations']
for key in ['M5-T2','M5-T6']:
    tasks[key]['supportPaths'] = ['src/lib/server/composition.ts']
tasks['M1-T8']['wiring'] = []

ordered = sorted(tasks.values(), key=lambda t: (int(t['module'][1:]), int(t['id'].split('-T')[1])))
OUT.mkdir(exist_ok=True)
(BASE / 'root-revised.json').write_text(json.dumps(ordered, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
(OUT / 'root-revised-en.json').write_text(json.dumps([english[t['id']] for t in ordered], indent=2)+'\n', encoding='utf-8')
audit = {'tasks':len(ordered), 'taskIds':[t['id'] for t in ordered], 'originalSourceSha256':hashlib.sha256((BASE/'all-tasks.json').read_bytes()).hexdigest(), 'modelCallsPerformed':False, 'stateFiles':[]}
for t in ordered:
    en = english[t['id']]
    refs = list(dict.fromkeys(re.findall(r'E-\d+',t['acceptance'])))
    assert set(refs)==set(re.findall(r'E-\d+',en['accept'])), t['id']
    assert all(e in edges for e in refs), (t['id'],refs)
    assert t['days'] in {'0.5d','1d','1.5d','2d'}, t['id']
    assert not any('tests/e2e' in p for p in t['paths']+t['supportPaths'])
    assert t['stage']!='primitive' or t.get('integrationTask') in tasks, t['id']
    for kind,state in [('task',{'task':{k:en[k] for k in ('title','input','output','accept')},'module':t['module'],'frontend_modules':['M1','M2','M6']}),('coverage',{'acceptance':en['accept'],'edges':{e:edges[e] for e in refs}})]:
        text=json.dumps(state,indent=2)+'\n'
        assert not re.search(r'[\u3400-\u9fff]',text),(t['id'],kind)
        p=OUT/f"{t['id']}.{kind}.state.json"
        p.write_text(text,encoding='utf-8')
        audit['stateFiles'].append(p.name)
(OUT/'root-revision-audit.json').write_text(json.dumps(audit,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'tasks':len(ordered),'states':len(audit['stateFiles']),'modelsCalled':False}))
