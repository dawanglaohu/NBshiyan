# M1-T3 实施回报

**已有真实制作结果，整卡仍未完成，PR 保持草稿。** 用户明确授权用当前账号图片/视频能力替代 Dot 等待；内置图片工具已实际执行两次，JPG、压缩视频和原帧海报都已保存。JPG 的精确字形与非换标区保真尚未通过，视频企业归属/产品关系仍 UNKNOWN，发布集合为空。没有合并、落地或部署。

## 制作文件与验收对应

| 验收条款 | 文件与位置 | 已完成与限制 |
|---|---|---|
| 1 原件、两处旧标、视频和海报 | `brand-static-media.json:72` 原件哈希；`:98` 两处换标；`video-identity.json:250` 副本来源/时间 | 原 JPG/MP4 哈希未变。两版 AI 图中飞艇“合兴包装”和墙面符号＋HXPP 均已消失；完整 PackJoyU 可读。JPG 保真未验收。视频保留 735 帧/60fps 及音轨；海报来自 4500ms 原帧，非生成画面。 |
| 2 现用标识 / E-28 | `public/brand/packjoyu-logo-master.svg:1`；`image-generation-record.json:5` 两次真实调用 | 每次均提供现用 master 的渲染参考，不设计候选新标；生成图不替换 master。JPG 模型字形不能直接冒称与 master 逐轮廓一致。 |
| 3 实际制作 / E-29 与用户补充指令 | `image-generation-record.json:1`；`production-record.json:1`；`evidence/video-transcode-command.ps1:1` | 图片实际工具为 `image_gen.imagegen`，未调用 API 付费回退。视频实际工具为既有 Windows MediaTranscoder，未调用 Dot，也未调用账号视频生成接口：本聊天未提供该接口。输入、提示词、输出和核对记录均留存。 |
| 4 完整 master 与来源 | `logo-source-audit.json:4` 来源哈希；`:46` 导出；`:132` 网页核验；`export-logo-master.py:143` | master SHA256 `7b585370f85ceabd7ff221dfa0c9dbcc36a9c9c7b3480c0aebc99e05e308e099`。8 个转曲路径无字体/脚本/外链/私有 metadata；现有源码、CSS、icon 和字体均未改。真实网页字形/advance/kerning 与提交字体一致，Pack/U 黑、Joy 为 #c2381a。 |
| 5 清单与禁发 | `brand-static-media.json:140` 逐文件哈希/尺寸；`:391` heldFiles；`verify-static-media.py:62` | 30 个图像和 1 段视频逐值核对通过。heldFiles 四个文件均不在 public 或 releaseFiles；UNKNOWN 企业归属与 JPG 保真问题阻止发布。副本存在不等于已批准发布，任务卡仍为 todo。 |

表中短路径相对 `docs/brand-media/static/`，public 路径相对项目根。

- `held/packjoyu-city-edited.jpg`：选用第二次图片工具结果，1738×905。模型确实重绘/平滑了非目标区域，未冒称 1920×1000 原生输出或只改两个像素区域；详 `image-edit-review.md`。
- `held/video2-720p60.mp4`：H.264 1280×720、60fps、735 帧，AAC 48kHz 双声道音轨重新编码，4,456,406 bytes，为原文件约 55.35%。容器 12309.125ms 比原 12267ms 多 42.125ms，视频轨 12249.983333ms；未声称时长完全相等、未剪裁时间线。实测见 `evidence/video-transcode-verification.json`。全部同索引帧对比、首尾和切镜头对齐，平均 PSNR 32.27dB；这不是企业身份放行依据。
- `held/video2-poster-4500ms.jpg`：1920×1080，与原视频第270帧、4500ms 的已登记 JPEG 导出字节相同。

JPG 两个 before 标记与生成后的逐项观察均在清单中。原视频保留 YAMAHA 等 equipment 商标，不抹除或推导企业署名；Holiland/好利来为 product_brand，与 PackJoyU 关系 UNKNOWN；模糊印字仍 UNKNOWN。没有生成虚构工厂实拍、企业背书、客户实绩、产能或认证。

## 自行裁决与范围

三条真实 Jev 记录及全部候选见 `judgments.json` 和三个 state 文件，原日志按提示词追加到开发文档 `_run/judgments.jsonl`。

1. 当前完整字标是 DOM/CSS，Dot 不可达，现有字体需转为软件可导入图形。候选 A 为已安装 fontTools 离线转曲并与实际网页核对，B 为 SVG 内嵌字体，C 为 master 也保持未执行。Jev 模型 `jev-1.13.0`，line：`adjudicate: pick=A(high 0.82) spec_change=no(0.23) outside_stack=unsure(0.62) needs_owner=no(0.13) reversible=yes(0.80) adopt=take(A)`。采纳 A：仅使用现有本机制作工具，不新增网站依赖，不改字体/组件/样式。outside_stack 的不确定结果保留，不冒称它属于网站技术栈。
2. 通用交付指令要求 `--open`/READY_FOR_REVIEW，但本卡缺少成品和真实远程制作记录。候选 A 为明确未完成的草稿 PR，B 为仅本地提交等待条件恢复。Jev 模型 `jev-1.13.0`，line：`adjudicate: pick=A(high 0.78) spec_change=no(0.17) outside_stack=no(0.28) needs_owner=no(0.11) reversible=yes(0.82) adopt=take(A)`。采纳 A：`gh stack submit --auto`，保持草稿与未落地，不发完成/验收通过信号。
3. 用户已明确授权账号图片/视频制作替代 Dot，当前仅有图片工具和现成本地完整视频转码能力。候选 A 为实际图片编辑并存档三个待核副本；B 为只做图片、视频继续等待账号接口；C 为全部仍只保留实验。Jev 模型 `jev-1.13.0`，line：`adjudicate: pick=A(high 0.89) spec_change=no(0.31) outside_stack=no(0.24) needs_owner=no(0.17) reversible=yes(0.82) adopt=take(A)`。采纳 A：制作与存档真实副本，保持质量/身份闸门，不虚构账号视频调用、不增加付费 API 或网站依赖。

任务定义和验收标准未降低。范围外仅更新用户明确要求的任务卡两个受保护区块和指定 Jev 日志；已运行 build_vault，没有修改其他任务、生成器、应用控件、路由、依赖或源字标。目录内 .gitattributes 保留资产字节；源文件 SHA 按本次 Windows 工作树实际字节登记，跨平台换行不同需重新核验来源。

## 验证与入口

TESTS: pass（已交文件完整性）；发布验收未通过。

- `python -B -m unittest discover -s docs/brand-media/static -p "test_*.py" -v`：10 项通过。包括错误主标/源哈希、伪造帧时间、缺文件、held 移入 public/发布集合、海报换帧和设备角色负例。
- `python -B docs/brand-media/static/verify-static-media.py --originals-root C:/Users/admin/Desktop`：31 个媒体文件哈希/尺寸一致；原件重读哈希不变；原视频完整 735 帧重解、7 个原帧重建一致，压缩副本 735 帧可解码。图片调用的提示词、输入与输出哈希也被核查。
- `python -B docs/brand-media/static/verify-static-media.py --require-release`：原生退出 2，正确拒绝当前未完成集合。
- master 默认导出器 check、页头采集脚本 `node --check` 和独立 ESLint 通过；此前同分支 d601ce3 的 pnpm lint 退出0，仅既有警告。素材增量未改应用源码，不重复全库构建/DB/e2e。CI 结果只对应各自远端 head，不把旧 head 的绿色检查当作新提交结果。
- 原 master 从任务工作树真实 Next 服务返回200并由 Chrome/Sharp 解码核查；该页头服务数据库设置不可用，此证据仅证明字体与样式。冻结依赖安装成功、锁文件未改。

入口可达证据：无产品接线要求。没有新增界面控件或 GUI 行为，不录制产品操作 GIF；实际制作记录按内置图片工具和系统转码工具登记。旧 Dot 通道探测记录作为历史保留，不能当作本轮已调用 Dot 的证据。

VIBEHUB: [标志（Logo）](https://vibe-hub.org/logo)。

回填：任务卡「代码位置」「实施沉淀」已更新，build_vault 已运行。后续须通过 JPG 精确字形/保真核验、补视频己方来源与产品关系依据并复核发布集合，才能标记完成。工作树和 planning 保留，主检出没有切分支或提交。

## 用户授权的新风格图

用户明确原图仅作参考，要求不同风格且logo显示。`held/packjoyu-papercraft-city-v1.png` 为新的手工纸艺微缩场景，飞艇与工厂均显示完整 PackJoyU。它不套用旧图“只改两处像素”的约束，不冒充工厂实拍；实际第三次图片工具结果和提示词见 `style-generation-record.json`。原有两轮局部编辑记录保留，尚未直接替换选2 JPG，原视频身份禁发不变。
