# 文档补丁 m1-t4-review-r2-test-support

任务：M1-T4
原分支：task/M1-T4
原 PR：406
依据：Jev裁决A：精确补齐共享Button和集中路由直接回归的两项既有测试支持路径，不扩大生产范围

## 差异与复验范围

- M1-T4：definition、effectivePaths
- M1-T5：上游契约变化或本次审查目标
- M2-T1：上游契约变化或本次审查目标
- M2-T2：上游契约变化或本次审查目标
- M2-T3：上游契约变化或本次审查目标
- M2-T5：上游契约变化或本次审查目标
- M2-T6：上游契约变化或本次审查目标
- M2-T7：上游契约变化或本次审查目标
- M2-T8：上游契约变化或本次审查目标
- M3-T10：上游契约变化或本次审查目标
- M3-T11：上游契约变化或本次审查目标
- M3-T12：上游契约变化或本次审查目标
- M3-T13：上游契约变化或本次审查目标
- M3-T25：上游契约变化或本次审查目标
- M3-T6：上游契约变化或本次审查目标
- M3-T8：上游契约变化或本次审查目标
- M3-T9：上游契约变化或本次审查目标
- M6-T1：上游契约变化或本次审查目标
- M6-T2：上游契约变化或本次审查目标
- M6-T3：上游契约变化或本次审查目标
- M6-T4：上游契约变化或本次审查目标
- M6-T5：上游契约变化或本次审查目标
- M6-T6：上游契约变化或本次审查目标
- M6-T7：上游契约变化或本次审查目标
- M7-T1：上游契约变化或本次审查目标
- M7-T2：上游契约变化或本次审查目标
- M7-T3：上游契约变化或本次审查目标
- M7-T4：上游契约变化或本次审查目标
- M7-T5：上游契约变化或本次审查目标
- M7-T6：上游契约变化或本次审查目标
- M7-T7：上游契约变化或本次审查目标
- M7-T8：上游契约变化或本次审查目标
- M7-T9：上游契约变化或本次审查目标

### _run/task-contracts.json

````diff
--- before/_run/task-contracts.json
+++ after/_run/task-contracts.json
@@ -149,7 +149,9 @@
       "supportPaths": [
         "src/lib/navigation/routes.ts",
         "src/i18n/routing.ts",
-        "src/i18n/navigation.ts"
+        "src/i18n/navigation.ts",
+        "tests/hero-video.test.ts",
+        "tests/about-350.test.ts"
       ],
       "outputPaths": [
         "src/components/layout/",
````

新旧任务契约在同名 JSON 的 changes、源条款在 sourceChanges。只复验变化及其影响，不重新初始化分支。

## 原任务续做

# 继续原任务 M1-T4：接好首页视频与分区JPG/GIF场景
沿用分支 task/M1-T4、现有工作树和原 PR；不要创建新任务或重新初始化分支。
任务契约版本：f234d6bcf4bf2e54fcb4e2faaf12fd8c1eeae5973dff7a75d83526c51e7de8aa
读取 _run/patches/ 中本次补丁的差异和复验清单，只处理列出的条目及其直接影响。没有差异说明时先核对现有 PR 的返工记录，不按完整实施流程重做。
修正后的验收：
1) 点击字标home-link→/[locale]、products-link→产品、contact-link→联系，并核实际SSR内容来源
目录沿loadCatalog(listPublishedModels)，不要求浏览器GET /api/models
12.27秒视频muted/playsinline且播放/暂停可点击，阻止autoplay后保留海报及播放入口，解码失败/减少动态效果显示语义JPG而不强制持续播放（E-21、E-22）。2) 城市JPG/GIF位于产品区后
网络断言接近视区300px前没有GIF下载，进入后才加载
点击暂停、离开视区、后台页均切同尺寸静帧，恢复可见不覆盖用户暂停（E-23、E-24）。3) 1440/1920/390逐项测媒体宽高比与源一致，媒体DOM矩形不与导航/正文/3D操作区的可点击矩形相交，渲染媒体的完整源图像四角及主体均在容器内
不得删主体或控件通过，保留按钮动作真实GIF（E-25）。4) 本层在src/lib/navigation/routes.ts建立home/products/contact的路径与入口ID登记，由SiteHeader消费并经既有i18n/navigation输出本地化href
后续任务在同一表补各自产出的入口。接线核查限本层首页、产品、联系三入口及首页媒体装配，不要求改动后台页面或建立第二套路由。
有效范围：
e2e/home-media.spec.ts
messages/en.json
messages/ru.json
src/app/
src/components/layout/
src/i18n/navigation.ts
src/i18n/routing.ts
src/lib/navigation/routes.ts
tests/about-350.test.ts
tests/hero-video.test.ts
保留已有代码和回填；修改后运行必要检查、追加提交并 push，继续原 PR 审查。
## 自行裁决：交 Jev，不交用户
实施、审查、查 bug、批次收口过程中出现的每一条「自行裁决」，以及验收冲突、文档缺口、栈外依赖、UI/UX 未定项，都先列出 2–5 个真实可行的选项；不能把你想要的答案当唯一候选。
把原始需求、任务标题与验收、冲突和选项忠实译成英文写入 state.json（文档与回报仍用中文）；UI/UX 取舍使用 design，其余使用 adjudicate。
运行 python "docs/PackJoyU-开发文档/_run/typesafe_ask.py" --log "docs/PackJoyU-开发文档/_run/judgments.jsonl" --label "M1-T4:resume" run adjudicate --state <state.json>；UI/UX 将 adjudicate 换成 design。若 language_warning 提示中文过多，重译后重跑。
仅 status=ok 且 verdicts.adopt.action=take 才按 option 执行；confidence=low 仍用 Jev 的 option，记低置信风险。spec_change=yes 走文档补丁，outside_stack=yes 在回报点名，不自动扩权。
adopt=red_line 仅涉及付费、不可逆删除、改变已定范围或对外承诺时请求用户授权；status=skipped/error 或缺有效 pick 时留下待 Jev 裁决，不得由人代答、判 pass、声称已落地或写 clean/fixed。
回报逐条写：冲突 → 全部候选 → Jev line/model/采纳的 option → 代码或文档动作；没有写「无」。
