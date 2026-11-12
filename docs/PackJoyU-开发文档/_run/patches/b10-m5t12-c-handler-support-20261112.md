# 文档补丁 b10-m5t12-c-handler-support-20261112

任务：M5-T12
原分支：task/M5-T12
原 PR：None
依据：C real route consumer test needs internal handler seam module for dependency injection without Next route export whitelist

## 差异与复验范围

- M3-T10：上游契约变化或本次审查目标
- M3-T11：上游契约变化或本次审查目标
- M3-T12：上游契约变化或本次审查目标
- M3-T13：上游契约变化或本次审查目标
- M3-T25：上游契约变化或本次审查目标
- M3-T6：上游契约变化或本次审查目标
- M3-T8：上游契约变化或本次审查目标
- M3-T9：上游契约变化或本次审查目标
- M5-T12：definition、effectivePaths
- M6-T1：上游契约变化或本次审查目标
- M6-T2：上游契约变化或本次审查目标
- M6-T3：上游契约变化或本次审查目标
- M6-T4：上游契约变化或本次审查目标
- M6-T5：上游契约变化或本次审查目标
- M6-T6：上游契约变化或本次审查目标
- M6-T7：上游契约变化或本次审查目标
- M7-T10：上游契约变化或本次审查目标
- M7-T2：上游契约变化或本次审查目标
- M7-T3：上游契约变化或本次审查目标
- M7-T5：上游契约变化或本次审查目标
- M7-T6：上游契约变化或本次审查目标
- M7-T7：上游契约变化或本次审查目标
- M7-T8：上游契约变化或本次审查目标
- M7-T9：上游契约变化或本次审查目标

### _run/task-contracts.json

````diff
--- before/_run/task-contracts.json
+++ after/_run/task-contracts.json
@@ -2621,7 +2621,8 @@
         "tests/jobs-runtime.http.test.ts",
         "src/lib/server/analytics/retention-cleanup.ts",
         "src/app/api/admin/cron/retention-cleanup/route.ts",
-        "tests/retention-cleanup.test.ts"
+        "tests/retention-cleanup.test.ts",
+        "src/lib/server/analytics/retention-cleanup-handler.ts"
       ],
       "outputPaths": [
         "prisma/schema.prisma",
````

新旧任务契约在同名 JSON 的 changes、源条款在 sourceChanges。只复验变化及其影响，不重新初始化分支。

## 原任务续做

# 继续原任务 M5-T12：补齐13个自然月无身份日聚合的3D耗时、配对终态与日级独立访客
沿用分支 task/M5-T12、现有工作树和原 PR；不要创建新任务或重新初始化分支。
任务契约版本：5dd0bb1fd4a4c07e68455b124e79a3b405fbcfd40130808615dab7b9e029c84d
读取 _run/patches/ 中本次补丁的差异和复验清单，只处理列出的条目及其直接影响。没有差异说明时先核对现有 PR 的返工记录，不按完整实施流程重做。
修正后的验收：
1) 真PG按(localDate,timezoneRevision,dimension)写13个自然月无身份聚合
durationMsSum为精确BigInt总和、loadDurationSamples只计配对终态有效样本
distinct可用SQL/DB COUNT(DISTINCT)，落库只留计数
不落browserHash/eventId/viewId/navigationId/IP/UA或任何可回连身份。2) 配对按(browserHash,viewId)
终态读取不受occurredAt窗口限制，但按occurredAt<=notAfter分区（计入/并入最早defer），跨午夜/DST终态归start所在站点日
不得出现终态日starts=0而successes>0
Q2/Q5用与Q1/Q3/Q4同一真实路径冒烟谓词（去query/fragment后，仅整条路径或任一路径段以nbs-smoke-开头才排除，段中出现不匹配，NULL放行），冒烟-only start→late_unattributable gap，真实start不被更早冒烟start遮蔽。3) 均值=ΣdurationMsSum/ΣloadDurationSamples，不对日均值再平均
samples=0→null/no_data
有start分母(modelStarts>0)且successes=0→0%
samples不是成功率分母
拒绝/撤回/未同意/无start不补分母、不进样本
product pageViews=NULL、M6返回no_data。4) 站点/产品日UV各自distinct
同一浏览器跨locale/跨产品在每个维度只计一次，同产品en+ru仍product UV=1
locale/产品/日UV不可相加，产品UV不得相加成站点UV。5) marker/live＋day-state：ingest在同一事务bump AnalyticsDayChange(utcDate,version)（该表无id、只以utcDate为键）
聚合日事务写day-state(markerVersions/deferUntil/gapKind/timezone)，deferUntil存最早未到期值（旧defer仅在>notAfter时保留，与Q1/Q3新延期事实取min
到期未重算仍partial）
所有写state的事务（commit/gap/coverage/bootstrap）与GC同受租约/代次守卫
M6同一读快照三查site行（取该revision行内timezone）、day-state、映射UTC日live marker
complete=site行＋无gap＋defer空＋映射UTC日的live与consumed按缺省0比较相等（缺键即0
零事件日不因此partial）
无site行no_data（+gap），缺state/gap/defer/live前进partial
旧revision按行内timezone映射
产品状态继承站点日，只有complete日缺产品行才可证0。6) 覆盖：coverageStart=max(recomputableFrom(now,tz),首个dayStart>eventCutoff+5min的本地日界)
覆盖检查作用于base/脏日/闭包
不可重算→独立CAS元数据事务消费marker置raw_partial、保留旧行、不读raw不改指标
bootstrap用ON CONFLICT DO NOTHING写state＋not_backfilled、不写指标
成功先提交后迟到gap CAS 0行不复活、commit未知不宣称必回滚或绝不消费
历史残片不改写旧完整行。7) 保留：AnalyticsDaily仅按行内timezone的expiresAt＝13个自然月到期（等号到期、月末/闰年夹取），扫描域缓冲13个自然月＋2天单列
state按自身timezone的13个自然月到期（无未到期AnalyticsDaily才删
13月到期优先于永久gap/远期defer/live-ahead
合法终止gap不是损坏
坏timezone只诊断并定向保守保留、不宣称其有界删除）
marker按UTC日反推shiftLocalDays(shiftCalendarMonths(utcToday,-13),-2)、删utcDate<cutoffUtc，并保留仍存续state覆盖的UTC日∪markerVersions键
先state后marker
03:30旧链保持三表，04:30 analytics-retention在实施后才是新三表唯一清理者（共用租约、每批事务＋续租＋revision守卫），不新增cron行
500是聚合站点日/目标日上限（不是行数），DELETE单批5,000行，四类数据表每轮删除总上限20,000行，AnalyticsDaily≤1,000行
两元数据表各500行/轮（=单批上限、整轮实际删除总额）、合计1,000/轮、独立于四表
读页与删除额度分开，覆盖读取＋安全集合删除在同一批事务内完成，分页仅在本轮剩余额度内继续、用尽即结束该表本轮，下一轮从空游标重扫
candidateCount与deletedCount分列、实际删除数单列，不承诺每轮必删19,000行
只有已确认提交批次计数，提交未知不计数并停止metadata阶段
不延长原始30天、不重建历史、不填0。8) 纯函数测试＋真PG测试全绿
不改统计HTTP路由/contracts/ops/生产开关/cron时刻
product pageViews跨导航扩展不在本任务（E-48、E-55、E-56、E-57、E-63、E-80、E-81、E-82、E-83）。
有效范围：
.github/workflows/ci.yml
deploy/cron.nbshiyan
deploy/deploy.sh
docs/data-retention.md
prisma/schema.prisma
src/app/api/admin/cron/retention-cleanup/route.ts
src/auth.ts
src/lib/analytics/daily-aggregate.ts
src/lib/analytics/day-boundaries.ts
src/lib/server/analytics/aggregate-day-state.ts
src/lib/server/analytics/aggregate-repo.ts
src/lib/server/analytics/aggregate.ts
src/lib/server/analytics/event-repo.ts
src/lib/server/analytics/ingest.ts
src/lib/server/analytics/retention-cleanup-handler.ts
src/lib/server/analytics/retention-cleanup.ts
src/lib/server/analytics/retention-plan.ts
src/lib/server/analytics/retention.ts
src/lib/server/composition.ts
src/lib/server/db.ts
src/lib/server/jobs/registry.ts
tests/analytics-aggregate.db.test.ts
tests/analytics-daily.db.test.ts
tests/analytics-daily.test.ts
tests/analytics-day-state.db.test.ts
tests/analytics-ingest.http.db.test.ts
tests/analytics-ingest.test.ts
tests/analytics-retention-plan.test.ts
tests/analytics-retention.db.test.ts
tests/jobs-runtime.http.test.ts
tests/retention-cleanup.test.ts
保留已有代码和回填；修改后运行必要检查、追加提交并 push，继续原 PR 审查。
## 自行裁决：交 Jev，不交用户
实施、审查、查 bug、批次收口过程中出现的每一条「自行裁决」，以及验收冲突、文档缺口、栈外依赖、UI/UX 未定项，都先列出 2–5 个真实可行的选项；不能把你想要的答案当唯一候选。
把原始需求、任务标题与验收、冲突和选项忠实译成英文写入 state.json（文档与回报仍用中文）；UI/UX 取舍使用 design，其余使用 adjudicate。
运行 python "docs/PackJoyU-开发文档/_run/typesafe_ask.py" --log "docs/PackJoyU-开发文档/_run/judgments.jsonl" --label "M5-T12:resume" run adjudicate --state <state.json>；UI/UX 将 adjudicate 换成 design。若 language_warning 提示中文过多，重译后重跑。
仅 status=ok 且 verdicts.adopt.action=take 才按 option 执行；confidence=low 仍用 Jev 的 option，记低置信风险。spec_change=yes 走文档补丁，outside_stack=yes 在回报点名，不自动扩权。
adopt=red_line 仅涉及付费、不可逆删除、改变已定范围或对外承诺时请求用户授权；status=skipped/error 或缺有效 pick 时留下待 Jev 裁决，不得由人代答、判 pass、声称已落地或写 clean/fixed。
回报逐条写：冲突 → 全部候选 → Jev line/model/采纳的 option → 代码或文档动作；没有写「无」。
