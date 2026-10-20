# 原视频身份核查依据

`video2.mp4` 的 SHA256 为 `4fb4b5b362fc3fde5cf0245b3d736eed517d8d9b0ffee838a9d1e2545343960f`。输入来自桌面，来源要求见 `docs/PackJoyU-开发文档/01-约束/04-开发条件.md`。收到素材不能证明拍摄主体、工厂归属或客户关系。本次没有找到可核验的 PackJoyU 企业署名、生产归属或客户关系依据。

原片共 735 帧、60 fps。容器时长 12267 ms；视频轨时长 12250 ms，末帧 PTS 为 734/60 秒。全部帧经解码并按帧号连续排入 12 张接触表，逐张通览是否存在片头、片尾和叠加水印；另核 250 ms 采样及疑点原尺寸画面。缩略图不足以读清所有产品文字，模糊或被遮挡的标识仍为 UNKNOWN。`video-identity.json` 的时间范围是保守的镜头包络，不冒称每帧都能看清标识。

- `evidence/video2-f0180.jpg`：3000 ms，纸面红色条块中白字失焦且有遮挡，不能可靠转写，登记 UNKNOWN。
- `evidence/video2-f0483.jpg`：8050 ms，机器人机身可读 `YAMAHA` 及音叉圆形图形，登记 THIRD_PARTY、`role=equipment`。这只是实景设备商标，不作为企业署名，也不抹除。
- `evidence/video2-f0510.jpg`：8500 ms，背景机柜有三个菱形状黑色图形及模糊文字。图形疑似三菱标识，无法可靠核对完整文字，登记 UNKNOWN、`role=equipment`。
- `evidence/video2-f0600.jpg` 和 `evidence/video2-f0734.jpg`：10000 ms 及 12233.333333 ms，包装纸可读 `Holiland`、`好利来`，登记 THIRD_PARTY、`role=product_brand`；与 PackJoyU 的关系为 UNKNOWN。节庆图文中的 `YEAR OF HORSE`、`NEW`、`2014` 不是 PackJoyU 企业事实。
- 首帧是进纸设备实拍，末帧仍是带 Holiland 的包装生产场景。通览未见独立片头/片尾企业署名卡或固定叠加水印；企业归属仍为 UNKNOWN，不据此放行。

`releaseAllowed=false`。原片、整片压缩发布副本和海报发布副本均不得列入成品；仅保留 4500 ms 的原帧作为海报候选证据。没有裁切、遮挡、重剪或换标视频。后续须补可打开的己方身份依据并消除非设备角色的 UNKNOWN，再复核成片；设备商标的记录不能替代企业归属判断。
