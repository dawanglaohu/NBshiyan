# 文档补丁 M2-T2-wheel-admission-A

任务：M2-T2
原分支：task/M2-T2
原 PR：504
依据：按 Chief 授权复用既有 Jev design A（jev-1.14.0，pick=A low 0.32，adopt=take(A)，state 9ea3590d36f75a75），只澄清桌面真实焦点归属与同模型视口/命名工具条命中，补齐必要支持路径；保留普通滚页、跨模型隔离、退出释放和触屏，基线与源码验收仍待独立回执

## 差异与复验范围

差异块省略未变化上下文；完整 before/after 保留在同名 JSON 的 sourceChanges 中。

- CATALOG-MERGE：sections
- CITY-STILL-WEBP：sections
- CLIENT-API-DEADLINE：sections
- DEPLOY-FIX-1：sections
- FE-378：sections
- FE-FAB-390：sections
- GIFT-CARD-ASSETS：sections
- M1-T1：sections
- M1-T2：上游契约变化或本次审查目标
- M1-T3：上游契约变化或本次审查目标
- M1-T4：sections
- M1-T5：sections
- M1-T6：上游契约变化或本次审查目标
- M1-T7：sections
- M1-T8：上游契约变化或本次审查目标
- M1-T9：sections
- M2-T1：sections
- M2-T2：definition、edges、effectivePaths、sections、task
- M2-T3：sections
- M2-T4：上游契约变化或本次审查目标
- M2-T5：sections
- M2-T6：sections
- M2-T7：sections
- M2-T8：sections
- M3-T1：上游契约变化或本次审查目标
- M3-T10：sections
- M3-T11：sections
- M3-T12：sections
- M3-T13：sections
- M3-T14：上游契约变化或本次审查目标
- M3-T15：上游契约变化或本次审查目标
- M3-T16：上游契约变化或本次审查目标
- M3-T17：上游契约变化或本次审查目标
- M3-T18：上游契约变化或本次审查目标
- M3-T19：上游契约变化或本次审查目标
- M3-T2：上游契约变化或本次审查目标
- M3-T20：上游契约变化或本次审查目标
- M3-T21：sections
- M3-T22：sections
- M3-T23：sections
- M3-T24：sections
- M3-T25：sections
- M3-T3：上游契约变化或本次审查目标
- M3-T4：上游契约变化或本次审查目标
- M3-T5：上游契约变化或本次审查目标
- M3-T6：sections
- M3-T7：sections
- M3-T8：sections
- M3-T9：sections
- M4-T1：上游契约变化或本次审查目标
- M4-T10：上游契约变化或本次审查目标
- M4-T11：上游契约变化或本次审查目标
- M4-T12：上游契约变化或本次审查目标
- M4-T13：上游契约变化或本次审查目标
- M4-T14：sections
- M4-T15：sections
- M4-T2：上游契约变化或本次审查目标
- M4-T3：上游契约变化或本次审查目标
- M4-T4：上游契约变化或本次审查目标
- M4-T5：sections
- M4-T6：sections
- M4-T7：上游契约变化或本次审查目标
- M4-T8：上游契约变化或本次审查目标
- M4-T9：sections
- M5-T1：上游契约变化或本次审查目标
- M5-T10：sections
- M5-T11：上游契约变化或本次审查目标
- M5-T2：上游契约变化或本次审查目标
- M5-T3：上游契约变化或本次审查目标
- M5-T4：上游契约变化或本次审查目标
- M5-T5：上游契约变化或本次审查目标
- M5-T6：上游契约变化或本次审查目标
- M5-T7：sections
- M5-T8：上游契约变化或本次审查目标
- M5-T9：上游契约变化或本次审查目标
- M6-T1：上游契约变化或本次审查目标
- M6-T2：上游契约变化或本次审查目标
- M6-T3：上游契约变化或本次审查目标
- M6-T4：sections
- M6-T5：上游契约变化或本次审查目标
- M6-T6：上游契约变化或本次审查目标
- M6-T7：sections
- M7-T1：sections
- M7-T10：上游契约变化或本次审查目标
- M7-T2：sections
- M7-T3：sections
- M7-T4：sections
- M7-T5：sections
- M7-T6：sections
- M7-T7：上游契约变化或本次审查目标
- M7-T8：上游契约变化或本次审查目标
- M7-T9：上游契约变化或本次审查目标
- R3-T09233008：上游契约变化或本次审查目标
- R3-T09598683：sections
- R3-T12074461：sections
- R3-T21757567：sections
- R3-T22883505：sections
- R3-T56876634：sections
- R3-T71889698：上游契约变化或本次审查目标
- R3-T75625096：上游契约变化或本次审查目标
- R3-T86511435：上游契约变化或本次审查目标
- R3-T87287564：sections
- R3-T92231765：sections
- R4-T16305211：上游契约变化或本次审查目标
- R4-T64765902：上游契约变化或本次审查目标
- R4-T76958784：上游契约变化或本次审查目标
- R4-T78812657：上游契约变化或本次审查目标
- R5-T10248697：上游契约变化或本次审查目标
- R5-T59021355：上游契约变化或本次审查目标

### 02-设计/07-前端架构.md

````diff
--- before/02-设计/07-前端架构.md
+++ after/02-设计/07-前端架构.md
@@ -140 +140 @@
-产品输入由`ProductGallery`及同域`use-product-interaction.ts`统一持有，状态为未操作、加载、可操作、正在操作、回退；`GalleryScene/OrbitControls`只消费当前activeSlug和回调，不再各自依靠悬停计时争夺滚轮。PC悬停可显示提示，实际按下拖动或“操作3D”才进入操作，pointer capture只属于当前模型；操作时暂停自动旋转，拖动不触发卡片跳转/加入询盘。普通滚轮始终交给页面；只有模型已聚焦且Ctrl/Cmd+wheel，或用户点明确缩放控件时才缩放模型，其余情况滚动页面；pointercancel、退出、Esc、失焦和卸载都释放捕获，触屏退出后恢复页面滚动。可见“完成/退出”“复位”及已有开盖/刀模按钮走同一状态机，键盘无需拖动也能查看与询盘；卡片名称/动作独立于Canvas点击区域，减去重复介绍不删除必要名称和操作。尺寸、触控阈值及反馈文案由第11/12节规定。分析事件从真实已发布条目的查看/模型发起及最终成功/失败回调产生，导航只记录page_view；品类slug不能未经映射就冒充单产品或GLB加载成功。
+产品输入由`ProductGallery`及同域`use-product-interaction.ts`统一持有，状态为未操作、加载、可操作、正在操作、回退；`GalleryScene/OrbitControls`只消费当前activeSlug和回调，不再各自依靠悬停计时争夺滚轮。PC悬停可显示提示，实际按下拖动或“操作3D”才进入操作，pointer capture只属于当前模型；操作时暂停自动旋转，拖动不触发卡片跳转/加入询盘。普通滚轮始终交给页面；Ctrl/Cmd+wheel仅在真实焦点归属某模型视口/命名工具条且指针命中同一模型视口/工具条时缩放该模型，用户点明确缩放控件仍可缩放；其他区域不拦截并保留浏览器默认行为，不使用整张卡片或缓存焦点代替准入判定，完整规则见[第12节](12-UX.md)；pointercancel、退出、Esc、失焦和卸载都释放捕获，触屏退出后恢复页面滚动。可见“完成/退出”“复位”及已有开盖/刀模按钮走同一状态机，键盘无需拖动也能查看与询盘；卡片名称/动作独立于Canvas点击区域，减去重复介绍不删除必要名称和操作。尺寸、触控阈值及反馈文案由第11/12节规定。分析事件从真实已发布条目的查看/模型发起及最终成功/失败回调产生，导航只记录page_view；品类slug不能未经映射就冒充单产品或GLB加载成功。
````

### 02-设计/11-UI.md

````diff
--- before/02-设计/11-UI.md
+++ after/02-设计/11-UI.md
@@ -249 +249 @@
-视口内pointer-down直接捕获起始模型，拖动跨卡仍只操作它，不先要求额外点击激活；悬停暂停自动旋转，用户显式暂停不被重新可见覆盖。普通wheel始终滚动页面，模型已聚焦时Ctrl/Cmd+wheel或明确缩放按钮才改变相机；缩放受产品边界约束。Escape、blur、pointercancel、路由切换和卸载释放capture/监听并恢复正常滚动。提示文字是“拖动旋转 · Ctrl/Cmd+滚轮缩放”，不把“点击开始”设为鼠标必经步骤。
+视口内pointer-down直接捕获起始模型，拖动跨卡仍只操作它，不先要求额外点击激活；悬停暂停自动旋转，用户显式暂停不被重新可见覆盖。普通wheel始终滚动页面；Ctrl/Cmd+wheel仅在真实焦点归属某模型视口/命名工具条且指针命中同一模型视口/工具条时改变该相机，明确缩放按钮仍可点击；缩放受产品边界约束。标题、说明、规格、链接及其他模型命中保留浏览器行为，不以整张卡片作为模型控制区；完整焦点与命中矩阵见[第12节](12-UX.md)。Escape、blur、pointercancel、路由切换和卸载释放capture/监听并恢复正常滚动。提示文字是“拖动旋转 · Ctrl/Cmd+滚轮缩放”，不把“点击开始”设为鼠标必经步骤。
````

### 02-设计/12-UX.md

````diff
--- before/02-设计/12-UX.md
+++ after/02-设计/12-UX.md
@@ -61 +61,10 @@
-普通滚轮和触控板始终滚动页面。只有模型控制区已聚焦时的 Ctrl/Cmd + wheel 或可见 Zoom in / Zoom out 按钮才缩放相机；拦截仅作用于该模型的修饰键缩放手势，其他区域保留浏览器行为。Escape、窗口失焦、pointercancel、卸载和切页均释放捕获及监听。该输入规则适用于共用 Canvas 内的每个产品视口，不能靠鼠标移过另卡改变 activeSlug。
+普通滚轮和触控板始终滚动页面。桌面模型控制区包含该模型视口及其命名工具条，不包含产品标题、说明、规格、品类链接或询盘入口。Ctrl/Cmd + wheel 仅在当前真实 DOM 焦点位于某模型的视口或工具条控件内，且指针命中同一模型的视口或工具条时缩放该模型相机；只对这一事件拦截浏览器默认行为。可见 Zoom in / Zoom out 按钮点击仍是独立缩放入口，缩放受该产品相机边界约束。其他区域保留浏览器行为，不能因事件冒泡到整张卡片、DOM 包含关系或几何叠入而扩大准入范围。
+
+控制区内部移动焦点保持模型归属，Tab 到非控制元素或其他模型即解除原归属；hover 不取得或转移焦点。焦点在模型 i、指针在模型 j 或非控制区时，不改变任一模型相机，也不拦截该 wheel。Escape、窗口失焦、pointercancel、卸载和切页均释放捕获及监听；已解除的交互不能仅凭缓存的 focusedSlug 或遗留 DOM 焦点再次接管输入。该输入规则适用于共用 Canvas 内的每个产品视口，不能靠鼠标移过另卡改变 activeSlug。
+
+下表针对 Ctrl/Cmd + wheel；普通 wheel 在所有格始终滚页。浏览器默认行为由目标浏览器决定，不把纯函数的 scroll-page 返回值当作真实浏览器页缩放证据。
+
+| 当前真实焦点 | 指针在同模型视口 | 指针在同模型命名工具条 | 指针在标题/说明/链接或另一模型 |
+|---|---|---|---|
+| 本模型视口或命名工具条 | 只缩放本模型，拦截本次事件 | 只缩放本模型，拦截本次事件 | 所有模型相机不变，保留浏览器默认行为 |
+| 无模型控制区焦点，或已解除交互 | 所有模型相机不变，保留浏览器默认行为 | 所有模型相机不变，保留浏览器默认行为 | 所有模型相机不变，保留浏览器默认行为 |
@@ -79 +88 @@
-        else 聚焦模型的Ctrl/Cmd+wheel或Zoom按钮
+        else 本模型控制区聚焦且指针命中其视口/工具条的Ctrl/Cmd+wheel，或Zoom按钮
````

### 03-质量/13-边界问题与异常处理.md

````diff
--- before/03-质量/13-边界问题与异常处理.md
+++ after/03-质量/13-边界问题与异常处理.md
@@ -104 +104 @@
-| E-98 | 页面滚动与缩放 | 指针经过模型并滚普通鼠标滚轮或触控板 | 页面仍正常滚动；只有聚焦模型的Ctrl/Cmd+wheel或明确缩放按钮改变模型相机，退出后释放所有滚轮拦截 | M2 |
+| E-98 | 页面滚动与缩放 | 指针在模型视口、工具条、正文或另一模型上使用普通滚轮、触控板或 Ctrl/Cmd+wheel | 普通滚轮和触控板始终正常滚页；Ctrl/Cmd+wheel仅在真实焦点归属某模型视口/命名工具条且指针命中同一模型视口/工具条时改变该相机，明确缩放按钮仍可点击。焦点与指针分属不同模型，或指针落在标题/说明/规格/链接等非控制区时，所有模型相机不变且保留浏览器行为；退出后释放所有滚轮拦截，不凭缓存焦点再次接管。 | M2 |
````

### 04-执行/19-模块任务拆分.md

````diff
--- before/04-执行/19-模块任务拆分.md
+++ after/04-执行/19-模块任务拆分.md
@@ -21 +21 @@
-| M2-T2 | 修正模型直接拖动与滚轮焦点 | M2 | M2-T1 | 现有真实GLB和OrbitControls、D20 | 可取消的精确指针/焦点控制 | 1) 从产品卡模型viewport直接pointer-down捕获当前模型，hover停自转且不几何缩放；普通wheel页面滚动，仅模型聚焦Ctrl/Cmd+wheel或zoom控件缩放，不先强制激活（E-97、E-98、E-99）。2) pointercancel/blur/Escape/卸载均释放，重新操作正确目标且不残留锁页；用户暂停优先于隐藏/显示恢复；测试保留修改前失败与修改后通过（E-100）。 | 2d |
+| M2-T2 | 修正模型直接拖动与滚轮焦点 | M2 | M2-T1 | 现有真实GLB和OrbitControls、D20 | 可取消的精确指针/焦点控制 | 1) 从产品卡模型viewport直接pointer-down捕获当前模型，hover停自转且不几何缩放；普通wheel始终页面滚动；Ctrl/Cmd+wheel仅在真实DOM焦点归属本模型视口/命名工具条且指针命中同一模型视口/工具条时缩放该相机，zoom控件点击仍可缩放；标题/说明/规格/链接与跨模型命中不缩放任一模型并保留浏览器行为，不以整张卡片或缓存焦点代替判定，不先强制激活（E-97、E-98、E-99）。2) pointercancel/blur/Escape/卸载均释放，重新操作正确目标且不残留锁页；用户暂停优先于隐藏/显示恢复；测试保留修改前失败与修改后通过（E-100）。 | 2d |
````

### _run/task-contracts.json

````diff
--- before/_run/task-contracts.json
+++ after/_run/task-contracts.json
@@ -390 +390,5 @@
-      "supportPaths": [],
+      "supportPaths": [
+        "tests/m2-t2-model-pointer.test.ts",
+        "messages/en.json",
+        "messages/ru.json"
+      ],
````

新旧任务契约在同名 JSON 的 changes、源条款在 sourceChanges。只复验变化及其影响，不重新初始化分支。

## 原任务续做

# 继续原任务 M2-T2：修正模型直接拖动与滚轮焦点
沿用分支 task/M2-T2、现有工作树和原 PR；不要创建新任务或重新初始化分支。
任务契约版本：9897db49876a6a83dbfcd8e1011d2f180746e55606d2f21f41824d29519a6358
读取 _run/patches/ 中本次补丁的差异和复验清单，只处理列出的条目及其直接影响。没有差异说明时先核对现有 PR 的返工记录，不按完整实施流程重做。
修正后的验收：
1) 从产品卡模型viewport直接pointer-down捕获当前模型，hover停自转且不几何缩放
普通wheel始终页面滚动
Ctrl/Cmd+wheel仅在真实DOM焦点归属本模型视口/命名工具条且指针命中同一模型视口/工具条时缩放该相机，zoom控件点击仍可缩放
标题/说明/规格/链接与跨模型命中不缩放任一模型并保留浏览器行为，不以整张卡片或缓存焦点代替判定，不先强制激活（E-97、E-98、E-99）。2) pointercancel/blur/Escape/卸载均释放，重新操作正确目标且不残留锁页
用户暂停优先于隐藏/显示恢复
测试保留修改前失败与修改后通过（E-100）。
有效范围：
e2e/model-pointer.spec.ts
messages/en.json
messages/ru.json
src/app/
src/app/admin-enroll/
src/app/admin-login/
src/app/admin-recovery/
src/app/admin/account/
src/app/admin/chat/
src/app/admin/settings/
src/app/admin/stats/
src/app/admin/users/
src/components/admin/AdminShell.tsx
src/components/layout/SiteFooter.tsx
src/components/layout/SiteHeader.tsx
src/components/three/
src/i18n/navigation.ts
src/i18n/routing.ts
src/lib/navigation/routes.ts
src/lib/three/
tests/m2-t2-model-pointer.test.ts
保留已有代码和回填；修改后运行必要检查、追加提交并 push，继续原 PR 审查。
## 自行裁决：交 Jev，不交用户
实施、审查、查 bug、批次收口过程中出现的每一条「自行裁决」，以及验收冲突、文档缺口、栈外依赖、UI/UX 未定项，都先列出 2–5 个真实可行的选项；不能把你想要的答案当唯一候选。
把原始需求、任务标题与验收、冲突和选项忠实译成英文写入 state.json（文档与回报仍用中文）；UI/UX 取舍使用 design，其余使用 adjudicate。
运行 python "docs/PackJoyU-开发文档/_run/typesafe_ask.py" --log "docs/PackJoyU-开发文档/_run/judgments.jsonl" --label "M2-T2:resume" run adjudicate --state <state.json>；UI/UX 将 adjudicate 换成 design。若 language_warning 提示中文过多，重译后重跑。
仅 status=ok 且 verdicts.adopt.action=take 才按 option 执行；confidence=low 仍用 Jev 的 option，记低置信风险。spec_change=yes 走文档补丁，outside_stack=yes 在回报点名，不自动扩权。
adopt=red_line 仅涉及付费、不可逆删除、改变已定范围或对外承诺时请求用户授权；status=skipped/error 或缺有效 pick 时留下待 Jev 裁决，不得由人代答、判 pass、声称已落地或写 clean/fixed。
回报逐条写：冲突 → 全部候选 → Jev line/model/采纳的 option → 代码或文档动作；没有写「无」。
