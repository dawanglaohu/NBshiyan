# 文档补丁 r3-t87287564-type-decl

任务：R3-T87287564
原分支：task/R3-T87287564
原 PR：416
依据：本PR新增fileId/sameFile导出,scripts/lint-ru-yo.d.mts未声明导致tsc --noEmit 5条错误(17节:41要求tsc核验,batch-3:42以tsc通过为收口证据);需把scripts/lint-ru-yo.d.mts加入有效路径

## 差异与复验范围

- R3-T87287564：definition、effectivePaths

### _run/batches/batch-3-20261022.md

````diff
--- before/_run/batches/batch-3-20261022.md
+++ after/_run/batches/batch-3-20261022.md
@@ -97,7 +97,7 @@
 output: 只读文件发现与测试身份比较适配
 acceptance: 1) 实际Windows与Linux运行三条用例通过。2) 生产mock剔除、俄文校验与扫描覆盖保持，新增slash/backslash同文件身份及真实坏文件负例。3) 不通过缩小发现范围或改空列表过关。
 edges: none
-paths: tests/lint-ru-yo.test.ts, tests/prod-mocks-strip.test.ts, scripts/lint-ru-yo.mjs
+paths: tests/lint-ru-yo.test.ts, tests/prod-mocks-strip.test.ts, scripts/lint-ru-yo.mjs, scripts/lint-ru-yo.d.mts
 estimate: 1d
 severity: S2
 jev: model=jev-1.14.0; adjudicate pick=A(high 0.98); adopt=take(A); judgments.jsonl label=batch-3:baseline
````

新旧任务契约在同名 JSON 的 changes、源条款在 sourceChanges。只复验变化及其影响，不重新初始化分支。

## 原任务续做

# 继续原任务 R3-T87287564：统一文件身份比较以通过Windows路径负例
沿用分支 task/R3-T87287564、现有工作树和原 PR；不要创建新任务或重新初始化分支。
任务契约版本：2dd4edc4ad7304f795ac7c45977092a81d4c90ee6472af91a20577a62e803c7c
读取 _run/patches/ 中本次补丁的差异和复验清单，只处理列出的条目及其直接影响。没有差异说明时先核对现有 PR 的返工记录，不按完整实施流程重做。
修正后的验收：
1) 实际Windows与Linux运行三条用例通过。2) 生产mock剔除、俄文校验与扫描覆盖保持，新增slash/backslash同文件身份及真实坏文件负例。3) 不通过缩小发现范围或改空列表过关。
有效范围：
scripts/lint-ru-yo.d.mts
scripts/lint-ru-yo.mjs
tests/lint-ru-yo.test.ts
tests/prod-mocks-strip.test.ts
保留已有代码和回填；修改后运行必要检查、追加提交并 push，继续原 PR 审查。
## 自行裁决：交 Jev，不交用户
实施、审查、查 bug、批次收口过程中出现的每一条「自行裁决」，以及验收冲突、文档缺口、栈外依赖、UI/UX 未定项，都先列出 2–5 个真实可行的选项；不能把你想要的答案当唯一候选。
把原始需求、任务标题与验收、冲突和选项忠实译成英文写入 state.json（文档与回报仍用中文）；UI/UX 取舍使用 design，其余使用 adjudicate。
运行 python "docs/PackJoyU-开发文档/_run/typesafe_ask.py" --log "docs/PackJoyU-开发文档/_run/judgments.jsonl" --label "R3-T87287564:resume" run adjudicate --state <state.json>；UI/UX 将 adjudicate 换成 design。若 language_warning 提示中文过多，重译后重跑。
仅 status=ok 且 verdicts.adopt.action=take 才按 option 执行；confidence=low 仍用 Jev 的 option，记低置信风险。spec_change=yes 走文档补丁，outside_stack=yes 在回报点名，不自动扩权。
adopt=red_line 仅涉及付费、不可逆删除、改变已定范围或对外承诺时请求用户授权；status=skipped/error 或缺有效 pick 时留下待 Jev 裁决，不得由人代答、判 pass、声称已落地或写 clean/fixed。
回报逐条写：冲突 → 全部候选 → Jev line/model/采纳的 option → 代码或文档动作；没有写「无」。
