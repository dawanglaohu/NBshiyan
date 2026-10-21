# M1-T3 静态媒体

任务未完成，发布集合为空。`brand-static-media.json` 的 `taskStatus=incomplete`、`releaseAllowed=false`。用户已授权账号图片生成功能替代 Dot；两次编辑结果、JPG、完整压缩视频和原帧海报均已保存。JPG 精确字形/场景保真未验收，视频缺己方身份依据，三类副本均留在 `held/`，不得接入 M1-T4。

已核字标为 `public/brand/packjoyu-logo-master.svg`。完整 `PackJoyU` 来自当前 SiteHeader：Manrope 800，Pack/U 为 `#000000`，Joy 为 `#c2381a`，字体转曲、无外部引用。`icon.svg` 仅核对来源，不拼进页头字标；后续 M1-T6/M1-T9 只引用这个 master。来源、字体/样式和导出哈希见 `logo-source-audit.json`。

用既有本机 Python/fontTools/Pillow/OpenCV 和仓库 Playwright 检查，不新增网站依赖：

```text
python -B docs/brand-media/static/export-logo-master.py --webfont docs/brand-media/static/evidence/current-manrope-latin.woff2 --browser-evidence docs/brand-media/static/evidence/current-header.json
python -B docs/brand-media/static/verify-static-media.py
python -B docs/brand-media/static/verify-static-media.py --originals-root C:/Users/admin/Desktop
python -B docs/brand-media/static/verify-static-media.py --require-release
```

前三条检查现存文件的完整性，不能证明任务完成。最后一条为发布验收：当前必须退出 2 并报告未完成。原件目录参数只读取点名的 JPG/MP4，不写入原件。

需要重新采集页头时，先从本任务工作树启动真实 Next 本地服务，再运行 `node docs/brand-media/static/capture-logo-evidence.mjs http://localhost:3123/en`；它使用独立无头 Chrome，等待字体加载，记录 computed style、逐字位置及实际 Latin WOFF2。运行前保留旧证据，新证据经导出器核验后再更新清单。该服务的数据库设置不可用，页头证据只证明字体与样式，不能扩写为网站端到端验收。

`image-generation-record.json` 保存实际图片工具调用、输入、提示词和结果；`image-edit-review.md` 记录保真限制。没有调用账号视频生成工具：本聊天未提供该接口；压缩使用既有 Windows MediaTranscoder，保留全部 735 帧和 AAC 双声道音轨，容器时长比原片多 42.125ms。海报是 4500ms 原帧的相同 JPEG 字节。生成图不能当作工厂实拍、客户证明或新的品牌 master。

`production-record.json` 区分已执行、待保真核对和身份禁发。`video-identity.json` 与 `identity-basis.md` 保留原片逐项身份观察及禁发原因。`heldFiles` 与 `releaseFiles` 分开；持有副本不等于已批准发布。接触表、抽帧、旧标放大、字体和截图为核查材料，字体证据附同源 OFL 许可。

目录内 `.gitattributes` 保留证据和导出文件的原始字节，避免 Git 自动换行转换使 SHA256 失效；OFL 副本保留来源中的空格。`sourceFiles` 记录此次 Windows 工作树源文件的实际字节。跨平台的源文件换行不同会使源哈希核查失败，须重新采集来源与网页核验，不能只改清单哈希绕过核对。

用户已确认纸艺 v2 图片达标。基于该图的新循环动画为 `held/packjoyu-papercraft-city-loop.gif`（1384×720，361帧，30.08秒，无限循环，约5.06MB），暂停帧为同名 `-poster.png`。固定机位下飞艇漂移、局部灯光和水面变化；实际制作是确定性图层动画与Pillow编码，不是账号视频生成或Dot操作。原GIF时序保留，源GIF及已验收PNG字节未改，不以此替代M1-T6对原GIF内容逐帧换标的正式验收。

本轮材质/人物修订：`held/packjoyu-industrial-city-v3.png` 是先修好的静态图；`held/packjoyu-industrial-city-v3-loop.gif` 为随后制作的1384×720原尺寸GIF（约13.88MB），`held/packjoyu-industrial-city-v3-loop-preview.gif` 为960×500预览（约8.66MB）。两者均361帧、30.08秒无限循环；云漂移、金属飞艇移动、真实水纹位移、烟粒子上升、载货叉车/司机整体往返。静态场景通过8项视觉检查后才进入动画；生成记录、分层参数和实际文件在style-generation-record.json与industrial-city-animation-record.json。
