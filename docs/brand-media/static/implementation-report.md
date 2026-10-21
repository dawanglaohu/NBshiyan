# M1-T3 实施回报

**已有真实制作结果，整卡仍未完成，PR 保持草稿。** 用户明确授权用当前账号图片/视频能力替代 Dot 等待；内置图片工具已实际执行两次，JPG、压缩视频和原帧海报都已保存。旧局部换标 JPG 的精确字形与非换标区保真尚未通过；用户已确认保存最新工业场景静态图和 GIF，视频企业归属/产品关系仍 UNKNOWN，发布集合为空。没有合并、落地或部署。

## 制作文件与验收对应

| 验收条款 | 文件与位置 | 已完成与限制 |
|---|---|---|
| 1 原件、两处旧标、视频和海报 | `brand-static-media.json:72` 原件哈希；`:98` 两处换标；`video-identity.json:250` 副本来源/时间 | 原 JPG/MP4 哈希未变。两版 AI 图中飞艇“合兴包装”和墙面符号＋HXPP 均已消失；完整 PackJoyU 可读。JPG 保真未验收。视频保留 735 帧/60fps 及音轨；海报来自 4500ms 原帧，非生成画面。 |
| 2 现用标识 / E-28 | `public/brand/packjoyu-logo-master.svg:1`；`image-generation-record.json:5` 两次真实调用 | 每次均提供现用 master 的渲染参考，不设计候选新标；生成图不替换 master。JPG 模型字形不能直接冒称与 master 逐轮廓一致。 |
| 3 实际制作 / E-29 与用户补充指令 | `image-generation-record.json:1`；`production-record.json:1`；`evidence/video-transcode-command.ps1:1` | 图片实际工具为 `image_gen.imagegen`，未调用 API 付费回退。视频实际工具为既有 Windows MediaTranscoder，未调用 Dot，也未调用账号视频生成接口：本聊天未提供该接口。输入、提示词、输出和核对记录均留存。 |
| 4 完整 master 与来源 | `logo-source-audit.json:4` 来源哈希；`:46` 导出；`:132` 网页核验；`export-logo-master.py:143` | master SHA256 `7b585370f85ceabd7ff221dfa0c9dbcc36a9c9c7b3480c0aebc99e05e308e099`。8 个转曲路径无字体/脚本/外链/私有 metadata；现有源码、CSS、icon 和字体均未改。真实网页字形/advance/kerning 与提交字体一致，Pack/U 黑、Joy 为 #c2381a。 |
| 5 清单与禁发 | `brand-static-media.json:140` 逐文件哈希/尺寸；`:391` heldFiles；`verify-static-media.py:62` | 54 个图像（含3个GIF）和 2 段视频逐值核对通过。heldFiles 十二个文件均不在 public 或 releaseFiles；UNKNOWN 企业归属与 JPG 保真问题阻止发布。副本存在不等于已批准发布，任务卡仍为 todo。 |

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
- `python -B docs/brand-media/static/verify-static-media.py --originals-root C:/Users/admin/Desktop`：56 个媒体文件哈希/尺寸一致；原件重读哈希不变；原视频完整 735 帧重解、7 个原帧重建一致，压缩副本 735 帧可解码。图片调用的提示词、输入与输出哈希也被核查。
- `python -B docs/brand-media/static/verify-static-media.py --require-release`：原生退出 2，正确拒绝当前未完成集合。
- master 默认导出器 check、页头采集脚本 `node --check` 和独立 ESLint 通过；此前同分支 d601ce3 的 pnpm lint 退出0，仅既有警告。素材增量未改应用源码，不重复全库构建/DB/e2e。CI 结果只对应各自远端 head，不把旧 head 的绿色检查当作新提交结果。
- 原 master 从任务工作树真实 Next 服务返回200并由 Chrome/Sharp 解码核查；该页头服务数据库设置不可用，此证据仅证明字体与样式。冻结依赖安装成功、锁文件未改。

入口可达证据：无产品接线要求。没有新增界面控件或 GUI 行为，不录制产品操作 GIF；实际制作记录按内置图片工具和系统转码工具登记。旧 Dot 通道探测记录作为历史保留，不能当作本轮已调用 Dot 的证据。

VIBEHUB: [标志（Logo）](https://vibe-hub.org/logo)。

回填：任务卡「代码位置」「实施沉淀」已更新，build_vault 已运行。后续须通过 JPG 精确字形/保真核验、补视频己方来源与产品关系依据并复核发布集合，才能标记完成。工作树和 planning 保留，主检出没有切分支或提交。

## 用户授权的新风格图

用户明确原图仅作参考，要求不同风格且logo显示。`held/packjoyu-papercraft-city-v1.png` 为新的手工纸艺微缩场景，飞艇与工厂均显示完整 PackJoyU。它不套用旧图“只改两处像素”的约束，不冒充工厂实拍；实际第三次图片工具结果和提示词见 `style-generation-record.json`。原有两轮局部编辑记录保留，尚未直接替换选2 JPG，原视频身份禁发不变。

### 标注细节修订

`held/packjoyu-papercraft-city-v2.png` 按用户四处百分比标注及类似位置实际编辑：移除货车重复后车头；将裸瓦楞/纸盒状楼体改为有完整窗面和屋顶的建筑；工厂屋顶采用通风设备、天窗和少量太阳能板；增加克制的暖窗光、路灯与冷色装卸区灯带。两处 PackJoyU 均保留，原 v1 不覆盖，生成提示词和逐项观察在 style-generation-record.json 的 revisions。

### 基于已验收图片的 GIF

用户明确确认纸艺 v2 图片达标，并要求据此制作 GIF。`held/packjoyu-papercraft-city-loop.gif` 为确定性分层动画导出：固定镜头、飞艇缓慢周期漂移、局部灯光呼吸和水面流光，字标随飞艇原图层移动；不是模型视频生成或 Dot 操作。361帧、1384×720、原80/90ms时序逐帧相同，总长30.08秒、loop0，约5.06MB；同尺寸暂停帧另附PNG。每帧均可解码，原GIF/已验收PNG哈希不变。新动画不冒称原GIF内容逐帧品牌替换已验收，未标记M1-T6落地；视频身份禁发仍独立保留。

GIF 专项负例：test_approved_image_gif.py 的2项测试（4个错误数据案例）通过，实际编码帧数/循环/时长与逐帧时间表均不能用错误清单绕过；39个媒体文件完整性通过。原型过大GIF仅为本机中间输出，未进入仓库或交付集合。

### 金属飞艇、自然云与作业场景修订

按用户顺序先生成并核验静态 v3，再制作独立新 GIF。`held/packjoyu-industrial-city-v3.png` 已核：自然云、金属飞艇、真实水纹、轮船烟囱及烟、混凝土隧道、完整叉车/司机/托盘货物、装卸区工作人员和双处logo。`held/packjoyu-industrial-city-v3-loop.gif` 采用独立图层动画：两朵云漂移、金属飞艇保持原字标像素移动、河面纹理位移、烟囱发射渐隐粒子、叉车司机/货物/投影整体往返且不镜像；近景托盘遮挡恢复。原停车位以局部重建清除原车辆，少部分地面接缝简化，未冒称恢复遮挡背景真值。旧图片与GIF保留。GIF为1384×720、361帧、30.08秒、loop0，约13.88MB；PNG保留完整色彩，GIF受全局255色调色板限制。

最终水流遮罩覆盖反射和深色河水，保护船/桥/树岛与岸边；用户标注河水区域0→10帧约76.2%像素变化，工厂字标与混凝土隧道区域变化为0。960×500轻量GIF预览约8.66MB，361帧/30.08秒/loop0与原尺寸版一致；最终静态图未在动画处理中改写。

最终独立视觉复核通过：0/10/20帧确认用户标注河段纹理流动与烟粒子上升可见，叉车/司机/货物整体往返，无第二车或前景穿插，双logo/楼/混凝土隧道稳定；361帧/30.08秒/loop0与原时序一致。55个媒体文件完整性通过，GIF专项2项测试（4个错误时序数据案例）通过。


### 视频高清网页副本

`held/video2-web-1080p60.mp4` 保留原片1920×1080、60fps、735帧和全部音轨，时长仍为12.267秒，大小8,051,146 bytes。qt-faststart 将原moov从8036147移动到32字节，mdat随后从15039字节开始，chunk offsets随之更新；没有重编码或改时间线。独立OpenCV逐帧核对735帧像素全部相同；735个H264包和576个AAC包的payload SHA256、PTS、DTS、duration逐个相等。原视频SHA256不变，成片SHA256为 `4f63bb11f07b048fff2e6344a3a3d027effbfabcc54c97d98407cc71d5e65c92`。720p压缩版和4500ms原帧海报仍可交付作对照；生成图片/GIF的已确认版本未改写。

自行裁决：A为无损1080p索引前置并保留小体积720p，B为第三次受限码率1080p有损编码，C为仅保留720p。Jev实际返回 `status=ok`，模型 `jev-1.13.0`，line `adjudicate: pick=A(high 0.98) spec_change=no(0.12) outside_stack=no(0.12) needs_owner=no(0.09) reversible=yes(0.76) adopt=take(A)`；已落实A。原始英文候选与真实日志分别保存在 `video-web-delivery.state.json`、`evidence/video-web-adjudication.jsonl`，同一记录追加至指定_run/judgments.jsonl。

制作记录和ffprobe结果见 `video-web-processing-record.json`、`evidence/video-web1080-{source,output}-probe.json`，命令见 `evidence/video-web1080-command.ps1`。浏览器URL策略拒绝本地核对页，播放器实测未执行，未转用其他浏览器或localhost绕过。已完成本地全帧及音视频包核验，不能据此声称线上端到端播放通过。视频企业归属与产品关系仍UNKNOWN，releaseAllowed=false，任务todo、PR草稿。
