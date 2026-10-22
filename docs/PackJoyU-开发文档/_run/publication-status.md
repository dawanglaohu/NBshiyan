# 恢复成果发布记录

核对时间（UTC）：2026-10-20T02:29:06.522612+00:00

7个独立草稿PR均OPEN、base=main；未合并、未部署。所有精确head的构建与浏览器CI通过；其中2个安全门禁等待指定机器人批准。

| PR | 内容 | Head | 检查状态 |
|---|---|---|---|
| [#386](https://github.com/dawanglaohu/NBshiyan/pull/386) | 八篇文章与运维草稿 | `df58d08c9a590f55f1ae5d4a3bf0bd303fa21227` | 构建、E2E、安全门禁通过 |
| [#387](https://github.com/dawanglaohu/NBshiyan/pull/387) | JSON-LD URL安全后续 | `b8b4990236230984d17b2050199dbad6dcf62e39` | 构建、E2E、安全门禁通过 |
| [#388](https://github.com/dawanglaohu/NBshiyan/pull/388) | 一次性绑定链接前端 | `222016a4cef8d74fe5831ecccc8d566aae909b2a` | 构建、E2E、安全门禁通过 |
| [#389](https://github.com/dawanglaohu/NBshiyan/pull/389) | 可选IndexNow共享端点 | `aff2f8d9a93afb6929e9601aae24b50e504eda0f` | 构建、E2E、安全门禁通过 |
| [#390](https://github.com/dawanglaohu/NBshiyan/pull/390) | 六语言源资料草稿（未启用） | `362c0c148664792113c6c1f0e3895ab6de5b6ba5` | 构建、E2E、安全门禁通过 |
| [#391](https://github.com/dawanglaohu/NBshiyan/pull/391) | i18n phase0与品类接线 | `a6fcbbd8789c97840ff470a59389dadc6dc18b20` | 构建/E2E通过；安全门禁缺指定机器人APPROVED |
| [#392](https://github.com/dawanglaohu/NBshiyan/pull/392) | Sanity签名协议迁移候选 | `2422c7b88d11b35ae56d90b3b418a8aebec0fec7` | 构建/E2E通过；安全门禁缺指定机器人APPROVED |

安全门禁不等同于自动审批：#391和#392的安全门禁均因敏感路径需要 `packjoyu-security-reviewer[bot]` 对当前提交批准而失败，未修改策略或伪造审查。#391本机隔离服务启动另被自动审批拒绝，返回 blocked by policy、无详细理由，已停止；本机GUI录像尚未完成。

#388已附精确head的真实入口GIF，证明范围仅为无绑定令牌页面与返回登录。缺ffprobe时以Pillow编码并解码核查；没有把单测桩或历史版本画面冒充完整业务链路。

#390保留97/97原源文件哈希，缺8个主线新文案键，所有材料仍为待审核译稿；不修改运行时语言。JPG/GIF品牌替换和公司介绍重绘属于后续实施，原附件未改，也未声称GPT Dot已执行。

S1仅完成01–05、12项决策与67条边界；完整24节、图谱和离线阅读器尚未生成。
