# 文档补丁 M3-T23-CI-EVIDENCE-20261106

任务：M3-T23
原分支：task/M3-T23
原 PR：None
依据：保存既有模型工作流真实验收的脱敏JSON和状态帧

## 差异与复验范围

- M3-T23：definition、effectivePaths
- M7-T10：上游契约变化或本次审查目标
- M7-T9：上游契约变化或本次审查目标

### _run/task-contracts.json

````diff
--- before/_run/task-contracts.json
+++ after/_run/task-contracts.json
@@ -3712,7 +3712,8 @@
       ],
       "supportPaths": [
         "e2e/admin-legacy-model-visual.spec.ts",
-        "tests/admin-legacy-model-style.test.ts"
+        "tests/admin-legacy-model-style.test.ts",
+        ".github/workflows/ci.yml"
       ],
       "stage": "integration",
       "wiring": [],
````

新旧任务契约在同名 JSON 的 changes、源条款在 sourceChanges。只复验变化及其影响，不重新初始化分支。

## 原任务续做

# 继续原任务 M3-T23：迁移既有模型上传和预览工作流视觉
沿用分支 task/M3-T23、现有工作树和原 PR；不要创建新任务或重新初始化分支。
任务契约版本：463705c8e567d50bf41e234505d3ccb7af8d3d8b7358368a76566e2bcfed9b24
读取 _run/patches/ 中本次补丁的差异和复验清单，只处理列出的条目及其直接影响。没有差异说明时先核对现有 PR 的返工记录，不按完整实施流程重做。
修正后的验收：
1) 真实ADMIN/EDITOR登录点“3D 模型”→/admin/models/new
点击上传页“3D 模型”面包屑→/admin/models后仍按现状重定向/new，不新建列表。用隔离合成GLB/海报走原POST /api/admin/models、GET/PATCH /api/admin/models/[id]、POST process/publish，真实结果仍受既有大小/READY/发布确认约束，不能因样式改造跳过检查。
2) models.css与ModelUpload/ModelPreview的旧背景/圆角/按钮/步骤条沿唯一token
预览Canvas仍显示真实GLB与既有主题能力，不把预览本身变成界面装饰
上传/处理/错误/阻断原因/预览/确认各步骤动作、文件输入可访问名称及取消返回询盘保留。必读07/11/12，消费唯一minimalist-flat和M1视觉组件，不重搜或改slug。实际服务真实登录，在1920×1080、1440×900、390×844记录真实操作GIF、computed style（2px黑边、0圆角、无阴影/渐变、强调色#b45700）、D1–D6/overflow
density7/gutter16/gap16/pad16，work铺满/form左对齐，44px触屏目标，loading/empty/error/success/disabled/focus逐态可判。权限和业务动作、旧API/邮件gate均保持。（E-108）
有效范围：
.github/workflows/ci.yml
e2e/admin-legacy-model-visual.spec.ts
src/components/admin/models/ModelPreview.tsx
src/components/admin/models/ModelUpload.tsx
src/components/admin/models/models.css
tests/admin-legacy-model-style.test.ts
保留已有代码和回填；修改后运行必要检查、追加提交并 push，继续原 PR 审查。
## 自行裁决：交 Jev，不交用户
实施、审查、查 bug、批次收口过程中出现的每一条「自行裁决」，以及验收冲突、文档缺口、栈外依赖、UI/UX 未定项，都先列出 2–5 个真实可行的选项；不能把你想要的答案当唯一候选。
把原始需求、任务标题与验收、冲突和选项忠实译成英文写入 state.json（文档与回报仍用中文）；UI/UX 取舍使用 design，其余使用 adjudicate。
运行 python "docs/PackJoyU-开发文档/_run/typesafe_ask.py" --log "docs/PackJoyU-开发文档/_run/judgments.jsonl" --label "M3-T23:resume" run adjudicate --state <state.json>；UI/UX 将 adjudicate 换成 design。若 language_warning 提示中文过多，重译后重跑。
仅 status=ok 且 verdicts.adopt.action=take 才按 option 执行；confidence=low 仍用 Jev 的 option，记低置信风险。spec_change=yes 走文档补丁，outside_stack=yes 在回报点名，不自动扩权。
adopt=red_line 仅涉及付费、不可逆删除、改变已定范围或对外承诺时请求用户授权；status=skipped/error 或缺有效 pick 时留下待 Jev 裁决，不得由人代答、判 pass、声称已落地或写 clean/fixed。
回报逐条写：冲突 → 全部候选 → Jev line/model/采纳的 option → 代码或文档动作；没有写「无」。
