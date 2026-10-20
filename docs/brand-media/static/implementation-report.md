# M1-T3 实施回报

**未完成，禁止发布；仅交草稿 PR。** 已交付现用字标 master 和真实核查证据。JPG 换标、压缩视频、海报发布副本及远程软件制作记录缺失；视频企业归属和部分印字仍 UNKNOWN。任务卡保留 `status: todo`，没有登记落地，没有合并或部署。

## 文件与验收对应

| 验收条款 | 已核实的文件与位置 | 结论及缺项 |
|---|---|---|
| 1 原件、JPG 两处、视频/海报与身份 | `brand-static-media.json:72` 原件前后哈希；`:98` 飞艇与墙面位置；`video-identity.json:1` 原片时长、角色、时间和证据；`:239` 4500 ms 原帧候选 | 原件哈希不变，735 帧可解码，7 个证据帧可从原片重建。两处 JPG 尚未换标；海报候选不是发布副本；视频不入成品。 |
| 2 现用标识 / E-28 | `public/brand/packjoyu-logo-master.svg:1`；`logo-source-audit.json:46` 导出哈希 | 使用现用完整 PackJoyU，不使用候选设计，不等待用户回看。master SHA256 `7b585370f85ceabd7ff221dfa0c9dbcc36a9c9c7b3480c0aebc99e05e308e099`。 |
| 3 真正软件制作 / E-29 | `tool-availability.json:1`；`production-record.json:27`、`:34`、`:40` | 浏览器库存无 Dot；本机软件控制 helper 可用，但没有远程 Dot 或图形编辑器会话。未调用 Dot、未作远程软件操作、无远程输出；三项制作均明确 not_executed。 |
| 4 当前 master 与来源 | `logo-source-audit.json:4` 来源 SHA256；`:52` 字体；`:132` 实际网页比对；`export-logo-master.py:143` 可重现核查 | 已核 SiteHeader、CSS cascade、Manrope 字体及 icon 来源；不修改源字标/icon。8 个转曲路径无字体依赖、脚本、外部引用或私有 metadata；实际网页字体轮廓、advance、kerning 与提交字体严格相同。Pack/U 为黑，Joy 为 `#c2381a`。 |
| 5 清单与发布禁止 | `brand-static-media.json:134` 24 个图像逐文件 path/hash/解码尺寸；`video-identity.json:22` 起逐项时间/角色；`verify-static-media.py:62` | 已交文件逐值一致。非设备 UNKNOWN、企业归属未知及缺失制作记录使 releaseAllowed=false、releaseFiles=[]。缺少的发布副本没有被清单代替，因此整卡不满足完成标准。 |

上表中的短路径均相对 `docs/brand-media/static/`，`public/` 路径相对项目根。

主要新增文件为 master、两个要求的 JSON 清单、来源审计、制作/通道记录、身份依据、5 个负例测试、只读校验器和页头采集/转曲工具。`evidence/` 保存 12 张连续覆盖全帧的接触表、7 个原尺寸抽帧、2 处旧标放大、真实页头与 master 渲染截图，以及来源字体/许可/帧时间记录。所有证据图均未进入发布集合。

## 身份与边界

飞艇“合兴包装”和工厂墙面完整红灰符号＋“HXPP”各占一项，均保留 before 证据和未执行标记。临近 PAPER、LOGISTIC 和停机坪 H 不被误算为企业换标对象。

原视频的 YAMAHA 和背景模糊几何标是 `equipment`，不抹除、不当企业署名。Holiland/好利来是 `product_brand`，与 PackJoyU 关系 UNKNOWN；红底白字不能可靠转写。全帧缩略图通览未见独立片头/片尾企业署名卡或叠加水印，但缩略图不保证能识别失焦印字。`identity-basis.md` 明确这些限制与来源缺口；没有 OWN_VERIFIED 的企业归属依据。原视频没有修改、裁切或重剪。

E-28 通过当前字标来源与哈希落实。E-29 通过实际通道探测和逐项未执行记录落实，不称素材制作完成。后继 T6/T9 的字标基准是这个已核 master；T4 不能把当前视频或候选帧称为已通过发布。

## 自行裁决

两次真实调用和全部候选分别保存在 `master-export.state.json`、`incomplete-handoff.state.json` 与 `judgments.json`，原日志按提示词追加到开发文档 `_run/judgments.jsonl`。

1. 当前完整字标是 DOM/CSS，Dot 不可达，现有字体需转为软件可导入图形。候选 A 为已安装 fontTools 离线转曲并与实际网页核对，B 为 SVG 内嵌字体，C 为 master 也保持未执行。Jev 模型 `jev-1.13.0`，line：`adjudicate: pick=A(high 0.82) spec_change=no(0.23) outside_stack=unsure(0.62) needs_owner=no(0.13) reversible=yes(0.80) adopt=take(A)`。采纳 A：仅使用现有本机制作工具，不新增网站依赖，不改字体/组件/样式。outside_stack 的不确定结果保留，不冒称它属于网站技术栈。
2. 通用交付指令要求 `--open`/READY_FOR_REVIEW，但本卡缺少成品和真实远程制作记录。候选 A 为明确未完成的草稿 PR，B 为仅本地提交等待条件恢复。Jev 模型 `jev-1.13.0`，line：`adjudicate: pick=A(high 0.78) spec_change=no(0.17) outside_stack=no(0.28) needs_owner=no(0.11) reversible=yes(0.82) adopt=take(A)`。采纳 A：`gh stack submit --auto`，保持草稿与未落地，不发完成/验收通过信号。

没有改变任务定义或验收标准。两个清单目录外仅更新提示词明确要求的任务卡受保护区块，以及指定的 Jev 追加日志。已运行 `build_vault.py`，没有修改其他任务、生成器、依赖、路由或源字标。

两处目录内 `.gitattributes` 固定证据与 master 字节，避免 Windows Git 换行转换损坏已登记哈希；只覆盖本素材目录，未更改仓库根配置。源文件原始哈希仍按此次 Windows 工作树登记，跨平台换行差异需重新核验来源。

## 验证与入口

TESTS: pass（已交文件完整性），发布验收仍未通过。

- `npx --yes pnpm@10.34.6 install --frozen-lockfile` 成功，锁文件不变。
- master 导出器默认 check：来源哈希、实际 WOFF2/TTF 轮廓与字距、浏览器样式/位置、安全 SVG 均通过。
- `python -B docs/brand-media/static/verify-static-media.py --originals-root C:/Users/admin/Desktop`：24 个图像哈希/解码尺寸通过，原件重读哈希一致；完整重解 735 帧，7 个抽帧重新编码的 SHA256 一致。
- `python -B -m unittest discover -s docs/brand-media/static -p "test_*.py" -v`：5 项测试通过，含错误主标哈希/路径、源视频哈希、抽帧时刻、海报哈希、缺发布文件和设备角色负例。独立复核另做 8 个内存变异，均拒绝错误完整性或错误放行。
- `python -B docs/brand-media/static/verify-static-media.py --require-release`：原生退出 2，正确拒绝当前未完成集合；这是预期的禁发负例，不能报为发布通过。
- `npx --yes pnpm@10.34.6 lint`：退出 0；既有 img/unused-disable 警告保留。新增采集脚本的独立 ESLint 和 `node --check` 通过。
- master 从真实任务工作树 Next 开发服务返回 HTTP 200，Chrome 渲染 8 个路径；Sharp 完整解码为 927×192。页头服务的数据库设置不可用，未声称整站端到端、DB 或生产构建通过。纯素材增量未运行全库构建/DB/e2e。

入口可达证据：无产品接线要求；没有新增或修改界面控件。`http://localhost:3123/en` 用于读取现有页头，`/brand/packjoyu-logo-master.svg` 用于核查资产响应与渲染，不冒称从可见控件进入了新产品功能。没有 GUI 行为变更，未录制产品 GIF；真实 Dot 制作 GIF/操作记录仍缺失。

VIBEHUB: [标志（Logo）](https://vibe-hub.org/logo)。未采用 video poster 的低分匹配。

回填：任务卡「代码位置」「实施沉淀」均已写入，`build_vault.py` 已运行。仍需恢复授权软件制作通道、补齐身份依据、制作并核对三类发布副本及真实制作记录，才能交正式审查。工作树保留给后续实施与审查，主检出未切分支、未提交。
