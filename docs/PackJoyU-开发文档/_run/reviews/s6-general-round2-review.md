# S6 综合文档契约审查 · 第二轮（差异复核）

VERDICT: pass。首轮唯一阻断G-B1已修；原10项（M1-T1及M7-T1–T9）全部按当前contractHash通过文档可实施性审查。没有新增范围，也没有第三轮重新拆卡。此结论不是产品实现、测试、媒体换标或生产发布通过。

## 当前输入与方法

本轮只核首轮后的实际源/dispatch差异，读取18末节、19 M7-T9、06/07/12新增实施顺序、21分类、24素材任务引用、presentation约定与M1-T7 sections。重新运行原10项status，实际sourceVersion为`fca77b4d96bc9bd35e46494b75fa3f052764a5c0921a3a29c3d9f259741136e7`，所有hash逐项与当前dispatch相等，无stale/runtimeDrift/blocker。输入/状态快照保存在`s6-general-round2-inputs/`，原负证据未覆盖；未调用TypeSafe、未verify、未改源或提交。

## G-B1关闭证据

- `18-部署与运维.md`末节“代理验收的构建工作区”识别旧build-offbox内部mktemp/git clone，并明确代理不得直接执行此包装。
- `19-模块任务拆分.md:88`及实际M7-T9 implementation同步改为：现有任务worktree确认已合入main的完整SHA；git archive导出到唯一planning/build-source，不创建另一Git仓库或第三个开发目录。
- 只复用既有受审核Dockerfile/BuildKit、公开build-args白名单、revision/buildarg、runner+migrate构建、镜像检查、manifest/SHA、import-and-scan、schema与restore子步骤；真实命令/结果必须留证，泄漏/平台/版本检查不可省，隔离PG与挂载不接生产。
- 任务有效改动范围仍是已有e2e与报告，没有要求M7重写构建平台、改分发/托管/反代/生产配置或扩张删除权限。源、最终包和AGENTS两个目录纪律能够同时执行，原冲突关闭。

## 首轮其他建议与关联差异

1. 21的incomplete列表已移除D10，与22原表一致；24明确JPG/海报M1-T3、GIF M1-T6。
2. presentation conventions重复primitive句已去重；M1-T7 sections新增07/11/12，实际UI原语规格源被跟踪。
3. 06/07/12明确基础能力与具体UI顺序：M3认证基础先支持M6，M3-T7先在既有Auth.js和现有后台页交壳/活动客户端；M6-T4真实stats目标就绪后M3-T6再注册自定义登录页。没有以404当登录成功，也不引入M3服务反调M6。
4. 原M1-T1、M7-T1–T8任务行与声明契约逐项未变；M7-T9只改变隔离构建输入/执行方式。首轮H12 10项、T10 11项逐项语义判断及H13=0的结论保留；其余前端差异由对应审查员核。
5. 当前78项、105条边界、21依赖批次、100.5人日；21/20仍明确估计不是日历承诺或实测。两窗口结果应取最终交接台实际预测，首轮74日不能复用作当前数值。

## 交付边界

所有实施任务仍待派/未落地，原件/媒体制作和产品运行证据没有被文档完成替代。原本地规格分支已有初版提交；最终更新仍须在交付前提交保存到本机规格分支，M1-T1导入最终本地基线后再随首PR进入main。此为已定义交付动作，不构成新增用户批准门槛。

生产发布、不可逆业务清理、采购与外部承诺仍不自动执行；未发现新的阻断。10项pass证据已输出`s6-general-round2-evidence.json`，仅供根会话按真实审查结果登记，不代表代码落地。
