# 文档补丁 r3-home-fill-1489

任务：R3-T09598683
原分支：batch/3-20261024-r5
原 PR：440
依据：UX 复验 4aff200 通过的铺满门槛是 1489px，1488px 及以下含 1440 保持居中 1240 上限。验收原文仍要求 1440 铺满，与已合入实现矛盾。e2e/home-media.spec.ts 也要补进该任务有效路径。

## 差异与复验范围

- R3-T09598683：definition、effectivePaths、task

### _run/batches/batch-3-20261024-r4.md

````diff
--- before/_run/batches/batch-3-20261024-r4.md
+++ after/_run/batches/batch-3-20261024-r4.md
@@ -61,9 +61,9 @@
 depends-on: M1-T6, M1-T1, M1-T7
 input: 真实 next dev 在 127.0.0.1:3107 打开 /en。1920×1080 的主内容宽约 1240、填充率 0.627；1440×900 的填充率 0.836。src/styles/tokens.css 的 --container 为 1240px，src/app/globals.css 的 .container 用该宽度居中。11 节 publicBrand 在不小于 1024px 时边距 24px、区块间距 48px、卡片内边距 24px，并要求首页与品牌媒体区填满扣除边距后的宽度。用后台密度参数 density 7、gutter 16、gap 16、pad 16 跑探针会失败，那些参数不是本项验收。
 output: 首页在 1920 与 1440 上按 publicBrand 边距铺满的样式，以及一条会在 1240 上限仍存在时失败的回归
-acceptance: 1) 在真实页面上，1920×1080 与 1440×900 的首页主内容宽度等于视口减去两侧 publicBrand 边距，不再被 1240px 上限截断。2) 不小于 1024px 时边距保持 24px，区块间距可以到 48px，卡片内边距可以到 24px。3) 回归在修复前因 1240 上限失败，修复后通过。4) 不改后台页面的容器，不用后台 16px 间距或 16px 内边距当作首页验收。
+acceptance: 1) 在真实页面上，首页铺满从 min-width 1489px 起：主内容宽度等于视口减去两侧 publicBrand 边距（各 24px），不再被 1240px 上限截断。1488px 及以下，包括 1440×900、1280、1024 和 390，仍是居中的 1240px 上限。2) 不小于 1024px 时边距保持 24px，区块间距可以到 48px，卡片内边距可以到 24px。这两项是上限，现有 64px 区块上下 padding 和 12px 卡片内边距可以保留。3) 回归在 1240 上限仍截断 1489px 及以上宽度时失败，修复后通过；1440 仍断言 1240 上限。4) 不改后台页面的容器，不用后台 16px 间距或 16px 内边距当作首页验收。
 edges: none
-paths: src/styles/tokens.css, src/app/globals.css, e2e/brand-smoke.spec.ts
+paths: src/styles/tokens.css, src/app/globals.css, e2e/brand-smoke.spec.ts, e2e/home-media.spec.ts
 estimate: 1d
 severity: S3
 jev: model=jev-1.14.0; adjudicate pick=B(medium 0.70); adopt=take(B); judgments.jsonl label=batch-3:wrapup state_sha256=c39d526c5a3fb65f9cedbd70525db684fd69c19852191599b19e95f53000c02c
````

新旧任务契约在同名 JSON 的 changes、源条款在 sourceChanges。只复验变化及其影响，不重新初始化分支。

## 原任务续做

# 继续原任务 R3-T09598683：让首页在扣除公开品牌边距后铺满宽度
沿用分支 task/R3-T09598683、现有工作树和原 PR；不要创建新任务或重新初始化分支。
任务契约版本：6c2094181f3ab22b22bac0ca5aed192e3c45f0b4313152ef72a831ca7897c360
读取 _run/patches/ 中本次补丁的差异和复验清单，只处理列出的条目及其直接影响。没有差异说明时先核对现有 PR 的返工记录，不按完整实施流程重做。
修正后的验收：
1) 在真实页面上，首页铺满从 min-width 1489px 起：主内容宽度等于视口减去两侧 publicBrand 边距（各 24px），不再被 1240px 上限截断。1488px 及以下，包括 1440×900、1280、1024 和 390，仍是居中的 1240px 上限。2) 不小于 1024px 时边距保持 24px，区块间距可以到 48px，卡片内边距可以到 24px。这两项是上限，现有 64px 区块上下 padding 和 12px 卡片内边距可以保留。3) 回归在 1240 上限仍截断 1489px 及以上宽度时失败，修复后通过
1440 仍断言 1240 上限。4) 不改后台页面的容器，不用后台 16px 间距或 16px 内边距当作首页验收。
有效范围：
e2e/brand-smoke.spec.ts
e2e/home-media.spec.ts
src/app/globals.css
src/styles/tokens.css
保留已有代码和回填；修改后运行必要检查、追加提交并 push，继续原 PR 审查。
## 自行裁决：交 Jev，不交用户
实施、审查、查 bug、批次收口过程中出现的每一条「自行裁决」，以及验收冲突、文档缺口、栈外依赖、UI/UX 未定项，都先列出 2–5 个真实可行的选项；不能把你想要的答案当唯一候选。
把原始需求、任务标题与验收、冲突和选项忠实译成英文写入 state.json（文档与回报仍用中文）；UI/UX 取舍使用 design，其余使用 adjudicate。
运行 python "docs/PackJoyU-开发文档/_run/typesafe_ask.py" --log "docs/PackJoyU-开发文档/_run/judgments.jsonl" --label "R3-T09598683:resume" run adjudicate --state <state.json>；UI/UX 将 adjudicate 换成 design。若 language_warning 提示中文过多，重译后重跑。
仅 status=ok 且 verdicts.adopt.action=take 才按 option 执行；confidence=low 仍用 Jev 的 option，记低置信风险。spec_change=yes 走文档补丁，outside_stack=yes 在回报点名，不自动扩权。
adopt=red_line 仅涉及付费、不可逆删除、改变已定范围或对外承诺时请求用户授权；status=skipped/error 或缺有效 pick 时留下待 Jev 裁决，不得由人代答、判 pass、声称已落地或写 clean/fixed。
回报逐条写：冲突 → 全部候选 → Jev line/model/采纳的 option → 代码或文档动作；没有写「无」。
