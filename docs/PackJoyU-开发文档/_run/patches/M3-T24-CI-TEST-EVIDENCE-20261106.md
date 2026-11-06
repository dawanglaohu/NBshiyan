# 文档补丁 M3-T24-CI-TEST-EVIDENCE-20261106

任务：M3-T24
原分支：task/M3-T24
原 PR：None
依据：登记 M3-T24 成功测试证据的 CI 上传 glob 与旧测试 spec-editor-render 定点断言适配支持路径

## 差异与复验范围

- M3-T24：definition、effectivePaths
- M7-T10：上游契约变化或本次审查目标
- M7-T9：上游契约变化或本次审查目标

### _run/task-contracts.json

````diff
--- before/_run/task-contracts.json
+++ after/_run/task-contracts.json
@@ -3752,7 +3752,9 @@
       ],
       "supportPaths": [
         "e2e/admin-legacy-specs-visual.spec.ts",
-        "tests/admin-legacy-specs-style.test.ts"
+        "tests/admin-legacy-specs-style.test.ts",
+        "tests/spec-editor-render.test.ts",
+        ".github/workflows/ci.yml"
       ],
       "stage": "integration",
       "wiring": [],
````

新旧任务契约在同名 JSON 的 changes、源条款在 sourceChanges。只复验变化及其影响，不重新初始化分支。

## 原任务续做

# 继续原任务 M3-T24：迁移规格列表及品类编辑器视觉
沿用分支 task/M3-T24、现有工作树和原 PR；不要创建新任务或重新初始化分支。
任务契约版本：3d928681bb561c81559551e01373c3f24a184e954a88900909e06bbca0b3a623
读取 _run/patches/ 中本次补丁的差异和复验清单，只处理列出的条目及其直接影响。没有差异说明时先核对现有 PR 的返工记录，不按完整实施流程重做。
修正后的验收：
1) 真实ADMIN和EDITOR分别登录，点击后台“产品规格”到/admin/specs
服务端HTML中categoryMeta每个key恰有一个/admin/specs/{key}链接。点击corrugated-boxes链接后pathname=/admin/specs/corrugated-boxes，GET /api/admin/specs/corrugated-boxes=200，JSON.category=corrugated-boxes且Cache-Control含no-store
点击“全部品类”后pathname=/admin/specs。登录SALES直接开这两页均404，GET/PUT规格接口403
ADMIN请求未知category的GET/PUT为404、error=not_found。
2) 在隔离数据库通过原编辑控件设置material en=Visual test EN、material ru=Visual test RU、notes en=note EN、notes ru=note RU，size min的l/w/h=10/20/30、size max=40/50/60、单位mm，moq value=123、单位pcs，lead time min/max=7/14、单位day，样品费选择free
清空认证，贸易术语只选FOB。点击唯一submit“保存”只发一次PUT /api/admin/specs/corrugated-boxes，body恰含size/material/moq/sampleFee/leadTime/certifications/tradeTerms/notes八键，各嵌套值等于上述输入，certifications=null、sampleFee={free:true}、tradeTerms=[FOB]。响应200，category等于corrugated-boxes、updatedAt为ISO时间，八字段逐项等于body
随后真实GET=200且八字段及updatedAt逐项等于PUT响应。刷新浏览器触发GET后material/notes、六尺寸、MOQ、交期、free与FOB控件值逐项等于上述输入，status结果区可见已保存文案。
3) 在同一表单只将moq value改0并点击保存，观察1秒PUT请求增加0，role=alert含1与100000000的范围提示，material en和moq value仍分别为Visual test EN和0。服务端原错误协议复用既有API用例：ADMIN同源PUT含moq.value=0返回400/error=invalid，issues中含path=moq.value
随后GET的moq.value仍123。测试只消费现有规则，不增加端点、字段、品类或PDP。
4) 必读07/11/12，只消费minimalist-flat。1920×1080、1440×900、390×844逐项记录真实列表→编辑→保存→返回GIF和GET/PUT网络证据。对.spec-sec、material en输入和保存按钮测border各边=2px且rgb(0,0,0)、borderRadius各角=0px、boxShadow=none、backgroundImage=none
Tab到material en后document.activeElement就是该input，focus-visible的outlineWidth=2px/offset=2px/color=rgb(180,87,0)。桌面按钮/单行输入高36px、触屏目标矩形至少44×44px，单行输入字号16px、表格标签14px/20px
D1–D6/overflow按列表work、编辑form记录，gutter/gap/pad=16px、work fill≥0.85、form fill≥0.55且左边缘≤gutter+24px、block gap≤24px/card pad≤20px、页面scrollWidth≤clientWidth。在相同表单数据/展开状态下比较迁移前后，六尺寸、MOQ、费用、认证与双语字段的DOM数量相等，必要文字可换行
loading/empty/error/success/disabled/focus逐态留下断言，不删字段或动作取得通过。（E-109）
有效范围：
.github/workflows/ci.yml
e2e/admin-legacy-specs-visual.spec.ts
src/app/admin/specs/page.tsx
src/components/admin/specs/SpecEditor.tsx
src/components/admin/specs/specs.css
tests/admin-legacy-specs-style.test.ts
tests/spec-editor-render.test.ts
保留已有代码和回填；修改后运行必要检查、追加提交并 push，继续原 PR 审查。
## 自行裁决：交 Jev，不交用户
实施、审查、查 bug、批次收口过程中出现的每一条「自行裁决」，以及验收冲突、文档缺口、栈外依赖、UI/UX 未定项，都先列出 2–5 个真实可行的选项；不能把你想要的答案当唯一候选。
把原始需求、任务标题与验收、冲突和选项忠实译成英文写入 state.json（文档与回报仍用中文）；UI/UX 取舍使用 design，其余使用 adjudicate。
运行 python "docs/PackJoyU-开发文档/_run/typesafe_ask.py" --log "docs/PackJoyU-开发文档/_run/judgments.jsonl" --label "M3-T24:resume" run adjudicate --state <state.json>；UI/UX 将 adjudicate 换成 design。若 language_warning 提示中文过多，重译后重跑。
仅 status=ok 且 verdicts.adopt.action=take 才按 option 执行；confidence=low 仍用 Jev 的 option，记低置信风险。spec_change=yes 走文档补丁，outside_stack=yes 在回报点名，不自动扩权。
adopt=red_line 仅涉及付费、不可逆删除、改变已定范围或对外承诺时请求用户授权；status=skipped/error 或缺有效 pick 时留下待 Jev 裁决，不得由人代答、判 pass、声称已落地或写 clean/fixed。
回报逐条写：冲突 → 全部候选 → Jev line/model/采纳的 option → 代码或文档动作；没有写「无」。
