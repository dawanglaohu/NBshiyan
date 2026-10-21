# M1-T3 选定发布素材

正式选定的是已确认工业风PNG、原尺寸GIF及GIF预览、换标视频v3的1080p/720p版及其第734帧海报，6个文件均在 `public/brand/`，逐字节对应保留在 `held/` 的成品。`selected-media-release.json` 与 `brand-static-media.json` 登记路径、SHA256、尺寸和实际核验；`saved-media-index.json` 汇总选定发布集合与全部历史媒体。网站首页只引用这些选定副本，真实品类照片保持原内容。

`video-identity.json` 的原片观察保留原样，`selectedFinalReview` 单独核实际v3及海报。来源依据为 `source-attestation.json` 中用户关于员工工厂拍摄、助手后加Logo的原话；它不证明工厂产权、客户合作、认证或产能。片头/片尾/水印、两个产品换标区和设备标识分别绑定成片SHA、准确帧时刻、可重现抽帧及依据。两版均735帧，原576个AAC包及时序保留；容器12.288秒，比原容器多21ms。

工业PNG两处品牌位于飞艇和工厂墙面，实际裁剪及成片联系表在 `evidence/final-v3/`；抽帧与独立视觉复核在 `selected-output-{decode-evidence,visual-review}.json`。PNG/GIF是用户确认的插画与动画，不作为工厂实拍或其他企业事实证明。既有品牌master及真实工具记录保留，不补造Dot或账号视频生成调用。

原JPG/GIF/视频和所有旧副本保留。旧局部换标JPG及原片身份待核记录属于历史，不能混入当前发布集合；返工前清单、制作与身份状态在 `history/selected-release-before/`，v2复现提交见 `product-video/v2-output-archive.json`。媒体校验通过不等于任务已经合并或落地，PR397继续交第2轮审查。

核验命令：

```text
python -B -m unittest discover -s docs/brand-media/static -p "test_*.py" -v
python -B docs/brand-media/static/verify-static-media.py --originals-root C:/Users/admin/Desktop
python -B docs/brand-media/static/verify-static-media.py --require-release
pnpm lint
```
