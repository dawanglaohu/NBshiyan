# R5-T10248697 已合实现的分层证据

实现已由 [#501](https://github.com/dawanglaohu/NBshiyan/pull/501) 合并，已审 head 为 `d84f0056293bb6e8b865b9bfe0e9da94aedcd7fb`，合并提交为 `b2db0294da689759424c3ec8c777f90ec89ff477`。W4 固定核验 main 为 `a9172b2f2601a4e5605fdbac274050fb09347e0f`；三个实际 owner/测试 Git blob 与已审 head 一致，见 [来源与归档 SHA-256](provenance.json)。

这里保存的是已取得的证据，不把文档收尾登记当作新的业务实现或测试运行。

| 材料 | 已取得结果 | 证据边界 |
|---|---|---|
| [修改前目标回归](before-gap.log) | 同一新回归在旧 owner `18ae999b` 抛 `invalid_date`，1 fail、0 skip，为预期红 | 原始日志原样保留，不是当前实现失败 |
| [固定 main 日界测试](fixed-day-boundaries.log) | 8 pass，fail/skip/todo/cancelled 均0 | 覆盖缺午夜首尾相接、纽约23/25小时、查看者时区与进程TZ、重复午夜和半小时/45分钟偏移 |
| [固定实际设置服务补验](fixed-settings-service.log) | 9 pass，fail/skip/todo/cancelled 均0 | 调用实际服务但注入内存 repo；两时区日界前/等号/后1ms，非法IANA、同值和版本冲突。不证明PG锁/事务或HTTP路由 |
| [历史 CI 原记录摘取](history-ci-evidence.json) | run 40333923945 的具名日界通过；设置PG7 pass、0 skip | 实际检出为测试合并 `867dca9`（d84f0056合入旧main6ff4934c），不是本次main。设置PG使用普通六月日期，不冒称PG缺午夜覆盖。旧Unit29项skip保留说明 |
| [W4 原始结构化快照](w4-verification-evidence.json) | 源文件/日志哈希、PR父节点、运行计数与未跑项 | 快照中的todo及未登记描述属于W4结束时历史状态；当前收尾登记须读任务笔记和交接台持久数据，不改写此快照 |

W4 运行时为 Node v24.21.0、ICU78.3、tzdata2026c。本次文档收尾复用这些证据，没有重新执行PG、HTTP设置端点、全套测试、构建或生产作业。

正式代码引用：[日界 owner](https://github.com/dawanglaohu/NBshiyan/blob/a9172b2f2601a4e5605fdbac274050fb09347e0f/src/lib/analytics/day-boundaries.ts#L113-L206)、[设置服务](https://github.com/dawanglaohu/NBshiyan/blob/a9172b2f2601a4e5605fdbac274050fb09347e0f/src/lib/server/analytics/settings.ts#L176-L225)、[直接回归](https://github.com/dawanglaohu/NBshiyan/blob/a9172b2f2601a4e5605fdbac274050fb09347e0f/tests/analytics-day-boundaries.test.ts#L43-L170)。任务保护区使用仓库相对路径及实际行号，不引用规划副本。
