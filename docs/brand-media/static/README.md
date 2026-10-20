# M1-T3 静态媒体

任务未完成，发布集合为空。`brand-static-media.json` 的 `taskStatus=incomplete`、`releaseAllowed=false`；不得把证据图或海报候选接入 M1-T4。JPG 尚未换标，视频缺可核验的己方身份依据，压缩视频与海报发布副本尚未制作。

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

`production-record.json` 区分已执行的本地导出/核对与尚未执行的 Dot 软件制作。`video-identity.json` 和 `identity-basis.md` 保留原片逐项身份观察及禁发原因。接触表、抽帧、旧标局部放大、字体和截图均为核查材料，不属于媒体发布集合。字体证据附同源 OFL 许可。

目录内 `.gitattributes` 保留证据和导出文件的原始字节，避免 Git 自动换行转换使 SHA256 失效；OFL 副本保留来源中的空格。`sourceFiles` 记录此次 Windows 工作树源文件的实际字节。跨平台的源文件换行不同会使源哈希核查失败，须重新采集来源与网页核验，不能只改清单哈希绕过核对。
