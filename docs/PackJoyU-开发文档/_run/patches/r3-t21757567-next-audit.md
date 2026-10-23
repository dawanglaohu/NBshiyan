# 文档补丁 r3-t21757567-next-audit

任务：R3-T21757567
原分支：task/R3-T21757567
原 PR：413
依据：用户已明确授权应用已独立安全审查的Next15.5.28单锁文件补丁，并因指定bot开发取消授权该身份门禁的管理员例外；保留构建审计E2E验证，补齐pnpm-lock.yaml必要支持路径，不改原验收或批次结论。

## 差异与复验范围

- R3-T21757567：definition、effectivePaths

### _run/batches/batch-3-20261022.md

````diff
--- before/_run/batches/batch-3-20261022.md
+++ after/_run/batches/batch-3-20261022.md
@@ -129,7 +129,7 @@
 output: 可配置Python测试运行入口及启动失败诊断
 acceptance: 1) 真Windows/Linux各跑七项导入/placeholder/food-claim/links保护用例通过。2) 错误解释器仍明确失败并保留stderr；不删除保护断言或把9009当通过。3) 与已提交import.ndjson一致性在真实解释器验证。
 edges: none
-paths: tests/sanity-import.test.ts, docs/content/sanity-import/build.py, docs/content/sanity-import/linkmap.py
+paths: tests/sanity-import.test.ts, docs/content/sanity-import/build.py, docs/content/sanity-import/linkmap.py, pnpm-lock.yaml
 estimate: 0.5d
 severity: S2
 jev: model=jev-1.14.0; adjudicate pick=A(high 0.98); adopt=take(A); judgments.jsonl label=batch-3:baseline
````

新旧任务契约在同名 JSON 的 changes、源条款在 sourceChanges。只复验变化及其影响，不重新初始化分支。

## 原任务续做

# 继续原任务 R3-T21757567：让内容导入用例使用实际Python并执行全部保护断言
沿用分支 task/R3-T21757567、现有工作树和原 PR；不要创建新任务或重新初始化分支。
任务契约版本：a1c9bc478d0e5d86c22efc3705c6e7332cc7243241003b40550c49536a241b16
读取 _run/patches/ 中本次补丁的差异和复验清单，只处理列出的条目及其直接影响。没有差异说明时先核对现有 PR 的返工记录，不按完整实施流程重做。
修正后的验收：
1) 真Windows/Linux各跑七项导入/placeholder/food-claim/links保护用例通过。2) 错误解释器仍明确失败并保留stderr
不删除保护断言或把9009当通过。3) 与已提交import.ndjson一致性在真实解释器验证。
有效范围：
docs/content/sanity-import/build.py
docs/content/sanity-import/linkmap.py
pnpm-lock.yaml
tests/sanity-import.test.ts
保留已有代码和回填；修改后运行必要检查、追加提交并 push，继续原 PR 审查。
## 自行裁决：交 Jev，不交用户
实施、审查、查 bug、批次收口过程中出现的每一条「自行裁决」，以及验收冲突、文档缺口、栈外依赖、UI/UX 未定项，都先列出 2–5 个真实可行的选项；不能把你想要的答案当唯一候选。
把原始需求、任务标题与验收、冲突和选项忠实译成英文写入 state.json（文档与回报仍用中文）；UI/UX 取舍使用 design，其余使用 adjudicate。
运行 python "docs/PackJoyU-开发文档/_run/typesafe_ask.py" --log "docs/PackJoyU-开发文档/_run/judgments.jsonl" --label "R3-T21757567:resume" run adjudicate --state <state.json>；UI/UX 将 adjudicate 换成 design。若 language_warning 提示中文过多，重译后重跑。
仅 status=ok 且 verdicts.adopt.action=take 才按 option 执行；confidence=low 仍用 Jev 的 option，记低置信风险。spec_change=yes 走文档补丁，outside_stack=yes 在回报点名，不自动扩权。
adopt=red_line 仅涉及付费、不可逆删除、改变已定范围或对外承诺时请求用户授权；status=skipped/error 或缺有效 pick 时留下待 Jev 裁决，不得由人代答、判 pass、声称已落地或写 clean/fixed。
回报逐条写：冲突 → 全部候选 → Jev line/model/采纳的 option → 代码或文档动作；没有写「无」。
