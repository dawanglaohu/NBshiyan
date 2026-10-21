# M1-T3 第1轮返工记录

沿用task/M1-T3、工作树NBshiyan-m1-t3和PR397，待第2轮审查；未合并、未执行--landed。选定发布集合为工业PNG、原尺寸GIF及预览GIF、v3视频1080p/720p及实际第734帧海报，共6项；全部为已确认held文件的同字节公开副本。125项媒体、18份held历史和3份原件保留。原片身份观察逐字段与返工前快照相等。

## R1：复核实际选定成片

修复前，旧版门禁针对真实当前选定状态产生JPG_REPLACEMENT_NOT_VERIFIED、VIDEO_CORPORATE_IDENTITY_NOT_VERIFIED、NON_EQUIPMENT_IDENTITY_NOT_VERIFIED三项错误阻断，3项分类断言失败；原发布CLI退出2。证据为evidence/rework-round1/before-selected-gate.{json,txt}及before-release.log。

verify-static-media.py在有selectionRecordPath时调用selected_release_checks.py，核明确6项public/held绑定、实际文件SHA和尺寸。video-identity.json保留原VID-01至VID-06及原corporateAuthorship/watermarkReview；selectedFinalReview另绑定实际v3的两版输出、source-attestation原话、原片SHA、现用master、制作记录及真实抽帧。两版各735帧解码，26张JPEG92抽帧具有精确时刻；发布校验重新从对应视频编码抽帧核SHA。海报从1080p第734帧JPEG95复现。

原产品商标已替换且成片复核无残留，不再单独用旧历史拒绝；设备商标保留并单列。成片来源或企业署名UNKNOWN、缺来源/帧/依据、输出SHA错误、错时刻、旧版混入、海报错绑及只设布尔通过均拒绝。来源仅支持员工在工厂拍摄与后加Logo，不证明产权、客户、认证或产能。

## R2：选定交付与网站消费

selected-media-release.json、brand-static-media.json、production-record.json、saved-media-index.json同步同一6项发布集合；工业PNG飞艇/工厂两处品牌各有原像素PNG裁剪，发布校验可重现。requiredOperationIds仅要求当前实际制作与复核，历史JPG候选、旧视频和未用Dot记录保留，不永久阻断选定成品。原制作文件与返工前状态在history/selected-release-before/，未补造工具调用。

按用户本轮明确要求，网站Hero改为v3视频及对应海报，所有断点16:9 contain，移除遮挡实拍内容的旧参考视频overlay；既有页面h1保留。工业场景默认PNG，用户播放时加载确认的预览GIF，保持原始产品品类照片。EN/RU分别描述实拍与插画，不添加企业硬事实。旧参考URL不再接线，原文件保留。

首页OG生成器原先在顶层regex解析旧hero海报，改动引用后实际导入报错；已改用当前选定海报，并只重新导出EN/RU首页分享图及版本号。原版式左文字列用原背景恢复可读性，字体/文案/位置不改。两张实际图尺寸、SHA及源海报绑定见website-media-integration.json。

## 验证

- 原12项加新增28项媒体回归，共40项通过；原断言未降低，legacy两项从真实旧快照读取。证据evidence/rework-round1/after-tests.txt。
- verify-static-media.py --originals-root C:/Users/admin/Desktop退出0：125项媒体/117项图像、原件重读通过、releaseAllowed=true、blockers=[]。
- verify-static-media.py --require-release退出0，同样无阻断；证据after-integrity.json、after-release.json。
- pnpm lint退出0，保留既有img优化/废弃命令等警告，不屏蔽规则；证据lint-final.txt。
- 网站媒体/OG直接回归24项通过；原旧媒体引用/缺副本及OG顶层解析错误均有修复前真实失败记录。浏览器以独立Chrome fresh context核实际production服务、EN/RU、1440/1920/390视口、播放/暂停/跳过、GIF按需加载和减少动效。最终准确提交的真实浏览器GIF另发布至媒体分支并嵌入PR397。
- 媒体CSS变更使旧字标来源SHA失效，已通过真实production页头重新抓取字体、字距、颜色，再由原exporter生成/核对；master SVG SHA仍为7b585370f85ceabd7ff221dfa0c9dbcc36a9c9c7b3480c0aebc99e05e308e099。旧审计/截图/字体完整归档，并非只改清单哈希。

## 自行裁决

1. 本轮明确要求网站消费已确认素材，而旧路径契约只列媒体目录。候选A为最小Hero/PNG/GIF引用接线并登记确切支持路径，B为只做清单、留旧网页引用待T4。初次未带直接授权原话的判断为red_line；补入本轮已有的人类原话后，Jev模型jev-1.13.0返回adjudicate: pick=A(high 0.76) spec_change=unsure(0.39) outside_stack=no(0.19) needs_owner=no(0.10) reversible=unsure(0.59) adopt=take(A)。已落实A并按原补丁流程同步支持路径。
2. GIF候选A为静态默认、用户触发加载，B为默认循环GIF。Jev同模型返回design: pick=A(high 0.80) register=brand(high 1.00) stated=yes(0.67) token_only=no(0.04) adopt=take(A)，已落实A。
3. 精确支持路径使本任务审查提示词超过既有20000字符预算。候选A为仅等义压缩本任务验收重复文字，B为保留文字并留下新预算问题。Jev同模型返回adjudicate: pick=A(low 0.44) spec_change=no(0.24) outside_stack=no(0.11) needs_owner=no(0.12) reversible=yes(0.80) adopt=take(A)。低置信风险保留，独立逐条比较后补回“可供软件导入”与“与当前标识一致”，未删断言；本任务预算恢复。原/新文字、全部候选与真实结果在evidence/rework-round1/对应state、comparison和decisions.json。

## 范围外或环境限制

本机pnpm build编译、类型检查和60静态页生成完成，standalone复制阶段因Windows依赖symlink EPERM退出1；未更改系统权限或CSP，不宣称完整打包通过。浏览器使用同次编译产物的真实next start。文档sync仍报告M1-T9审查提示词超预算（返工前21940，本轮20903），未修改该范围外任务或提高预算；build_vault本身退出0。本轮仅交R1/R2及直接回归审查，不代表任务已落地。
