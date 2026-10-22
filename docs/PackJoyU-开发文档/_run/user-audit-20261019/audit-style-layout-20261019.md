# StyleKit 与布局规划复核（只读）

日期：2026-10-19。对象：D:/xiangmu/NBshiyan/docs/PackJoyU-开发文档 当前已交付源文件、配置与派发包。未改源、未重新选风格、未执行 TypeSafe、未运行产品页面。本报告不把规格审查当成产品验收。

## 结论

已依 unattended-run S3 调用安装的 StyleKit 工作流，真实取得 3 个候选，再通过真实 Jev design 调用选定 minimalist-flat；11/12 具备可执行的页面、组件、媒体、3D 和后台密度规划，已进入相关任务和实际 dispatch。

发现 1 项应补齐的文档覆盖缺口：旧后台业务页面的统一换肤回归未逐页列明。没有发现 07/11/12/19 中 3D 直接拖动、普通滚轮、首页媒体位置之间的相互矛盾。未验证产品代码或真实浏览器，不声称布局已经实现或当前页面损坏。

## 1. 实际风格选择证据

- 已读安装副本 C:/Users/admin/.agents/skills/stylekit/SKILL.md 及无人值守 references/stages.md S3 / references/density.md。S3 明确覆盖 StyleKit 默认更新动作：不跑 update-skill.py，不出页面或预览，不要求用户目视确认。
- `_run/style-catalog-evidence/catalog-research.md:9–25` 保存实际 search/fetch 过程：minimal 搜索真实命中后获取 minimalist-flat、scandinavian、korean-minimal。3 个完整 JSON 均存在，来源均为 http-api、degraded=false。
- `_run/stylekit-spec.json` 与 `_run/style-catalog-evidence/minimalist-flat.json` 字节完全一致；SHA-256 为 `4e4d407b9365a8543b2d5d39daa72f953984786b9fb7c83fcd393f005dea0914`，并非自行拼造的风格规格。
- `_run/s3-style-choice.state.json` 保存 3 个真实候选、视频/3D/后台密度/现有技术栈与自身品牌约束。`_run/judgments.jsonl:79` 是模型 `jev-1.13.0`，label=S3视觉方向，state_sha256=be4a68395922a24b，pick=A、confidence=.41/low、adopt=take A；register=brand/.85/high。低置信没有隐藏或改写为高置信。
- `_run/s3-3d-choice.state.json` 保存直接操控与显式激活两个选项；`judgments.jsonl:80` 为同模型，state_sha256=ac4850e3869d8dc5，pick=A/.80/high、adopt=take A。该调用的 commerce 分类低置信，没有据此扩成电商支付或改写项目品牌寄存器。
- 11:34–87 与 presentation 的 handoff.design 镜像定稿：品牌公开页 + product/back-office 后台，共用一套 token；黑白、#b45700 强调色、2px 边框、0 圆角/阴影；沿现有 CSS/原生控件，不安装 Tailwind、组件库或字体。

目录限制已如实写在 11:65–67：readiness.source=fallback、仅 light、darkMode missing；active/disabled/loading/skeleton/empty/error/success 以及 motion/accessibility 为 partial，performance=fallback。HTTP 获取成功不等于项目视觉验证完成。原 globalCss 内的渐变/模糊/位移动画、disabled opacity-40 等冲突未直接注入；11 明确逐项项目适配。未将目录 fallback 误称获取失败。

## 2. 布局规划的具体内容

| 区域 | 已定布局 | 主任务 |
|---|---|---|
| 首页首区 | ≥1024px 标题/联系动作与16:9生产视频左右两区；窄屏先标题后视频；不用动态画面压正文；12.27s视频静音、playsInline、可暂停、正确视频帧海报/失败回退 | M1-T4 |
| 城市 JPG/GIF | 首页产品精选后独立“品牌场景”，不冒充厂区/视频海报、不覆盖3D；近视区300px才赋GIF动态src；暂停/离开/隐藏/减少动态切等尺寸静帧，用户暂停优先 | M1-T3/T6 制作，M1-T4 接线 |
| 产品卡 | auto-fit minmax(min(100%,560px),1fr)，gap16；PC 最小卡宽560，模型高clamp(360px,28vw,440px)；窄屏4:3且≥240px；名称/必要规格/询盘和品类动作保留，只删重复介绍 | M2-T1 |
| PC 3D | pointer-down立即捕获当前模型、跨卡不换owner；悬停停自转且不scale；普通wheel滚页面，聚焦Ctrl/Cmd+wheel或明确按钮缩放；Esc/blur/cancel/卸载释放 | M2-T2 |
| 3D 可达性 | 键盘方向/缩放/复位/暂停/退出，Tab不锁住，触屏单指/双指有界；44px控件；任意视角复位完整模型；正确海报/重试/询盘回退 | M2-T3/T6 |
| 后台工作面 | DENSITY7，所有屏幕gutter/gap/pad16，row40/control36，touch44；rail224；main无max-width铺满；表/来源/会话网格不留空轨 | M3-T7、M4-T6/T14、M6-T4/T7 |
| 后台操作面 | 左对齐 minmax(0,800px)表单+320px当前值/来源旁栏；空间不足折叠；单卡登录/绑定/恢复宽≤520px；空/错/加载原区域左上pad16 | M3-T6/T8–T13、M5-T10 |
| 手机 | 390×844控制视口，16px边距、单列、抽屉导航、44px点击目标、safe-area和软键盘可达；表格只在具名区域内滚，不让body横溢出；聊天宽可用区减32px | 11响应表，各UI任务 |

源定位：11:7 页面清单16模式；11:158 组件及全状态；11:186 间距与容器；11:217 密度门槛；11:235 大卡与输入；11:245 媒体位置；11:253 响应设备；12:57 3D关键流程；12:338 错误/恢复反馈；12:378 可访问性；12:410 真实证据。

后台量化验收：1920×1080、1440×900、390×844；work fill≥.85，form fill≥.55且左边距≤gutter+24；gap≤24/pad≤20，无空轨，横向空白带≤15%，body overflowX=0。brand主寄存器不豁免后台。手机保留探针真实n/a，不伪填全pass。

## 3. 是否真正进入派活

19:11/14/17 将视觉核心、共享包装和首页媒体分开，M1是唯一token owner；19:19–26 是 M2 的8项3D/产品任务；19:32–33 规定登录UI与后台壳。M3-T7先既有真实登录交壳，M6-T4交真实看板后M3-T6才注册自定义页，避免登录到404。

`presentation.handoff.frontendModules=[M1,M2,M6]`，M3/M4/M5的UI任务另有 taskSkills，避免模块分类漏掉 UI约束。实际 dispatch 的以下实施提示词逐份检查，均有 stylekit、唯一 minimalist-flat、record-browser-gif、D1–D6 与07/11/12读取指示：

- M1-T1/T4/T5/T7、M2-T1/T2/T3/T5/T6/T7/T8。
- M3-T6/T7/T8/T9/T10/T11/T12/T13。
- M4-T5/T6/T9/T14/T15、M5-T7/T10、M6-T4/T7。
- M7-T1–T6 最终集成也保留上述技能与来源要求；T2–T6使用“三尺寸”而不是在提示里再抄三个数字，11/17仍为权威数值，不能说缺了验收条件。

相关 task-contracts 的 sections 已列07/11/12；source 11 派发摘要与 presentation 中 tokens/components/spacing 相同；最终媒体交付/真实来源在M7-T1，真实产品链路在17。3D由代码任务修改 R3F/OrbitControls，这些任务未声明用GPT Dot操作模型编辑软件。JPG/GIF另有素材任务与真实远程软件证据要求。

## 4. 确定的遗漏：旧后台页面共享换肤回归

级别：文档覆盖缺口，建议修复；不是已经复现的产品缺陷。

07:70 明确仅16个本轮路由验收。11页面表、17 UI矩阵、19 M3-T7 与所有实际 implementation 提示词均没有对以下7个既有路由逐页列明共享换肤与关键操作回归：

1. /admin/inquiries
2. /admin/inquiries/[id]
3. /admin/mail/unassigned
4. /admin/models
5. /admin/models/new
6. /admin/specs
7. /admin/specs/[category]

这些实际路由取自 `_run/source-map.json.entrypoints.pageRoutes`，不是推测出来的新页面。M3-T7的 outputPaths 是 AdminShell、AdminSessionActivity、admin.css、admin/layout，验收当前只写“当前角色既有可访问后台页面”与泛化“逐页”；未列上述矩阵，也没有这些领域组件的显式样式兼容落点。用户要求“同步更换管理后台风格”，只验新看板/聊天/账号和外壳不足以证明这些旧页面已经统一。

建议最小修复：在M3-T7或独立受依赖约束的小任务明确“旧后台7路由的共享样式兼容与原关键操作回归”，补11页类矩阵、17检查矩阵、19验收与真实文件范围。只改视觉消费/容器，不迁移询盘、邮件、模型、规格业务规则。先查实际领域组件硬编码色值/间距，范围按事实补，不泛加整目录。保存同一登录会话从可见菜单/列表进入这些路由的样式、数据来源、关键动作和3尺寸证据；本轮文档审查不冒称已跑产品。

除该项外，本审查范围未发现可确认的前端布局承诺遗漏。风格低置信与目录partial、真实UI尚未实施是已记录限制，不是把它们隐藏为“全部完成”的理由。
