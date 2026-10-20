# 未发布翻译源资料

本目录保存 Grok Bot 翻译工作区的未提交成果，供后续审核和整合。它是历史源资料归档，不是发布输入。网站仍仅发布英语和俄语；本次没有改 messages、语言路由、Sanity 数据、邮件模板装载或上线开关。

## 来源和核对

原工作区为 nb-i18n，源提交 `a75b9c9cc0d7d6455e47e6d0304704fb60184882`。`source/` 按原相对路径保存 97 个变更文件（1,086,019 字节）；`source-manifest.json` 记录逐文件大小和 SHA-256，原始工作区未改动。`working-changes.patch` 只包含该源提交之后的 tracked 修改，不能直接当作当前 main 的补丁执行。

内容包括西班牙语、德语、法语、日语、印地语、阿拉伯语六套 messages；西/德/法 33 个品类页、FAQ、询盘邮件及术语草稿；俄语文案修改；生成脚本和中间翻译稿。`.i18n-src` 中标记 SUPERSEDED 的内容仅供追溯，不优先于较新译文。Python 与 TypeScript 文件均作为资料保存，不参与产品构建，不应从本目录直接运行。

## 整合前置条件

每套新语言有 383 个标量叶值；当前 main 英文有 391 个，缺少 Home.entryAll、About.crumbLabel、About.eyebrow、About.statsTitle、About.imagesTitle、About.ctaTitle、About.home.eyebrow、About.home.more 共 8 键。不得用本目录 en.json/ru.json 整文件覆盖现行翻译，以免删除当前页面文案。应逐键审核后再补译和集成；未补齐键不算语言可发布。

所有文案、邮件、SEO 元数据、Sanity NDJSON 都是待审核草稿。本次不执行导入，也不承诺邮件模板、元数据长度和全文术语已经通过发布验收。PackJoyU 自有工厂身份来自后续用户确认；具体产能、认证、面积、交期、MOQ、客户品牌和环保承诺仍需自身证据，不能从参考目录或旧占位推定。Gift Cards 指印刷贺卡。

## 后续实施

以当前主线逐项重放有效译文，保持所有现行键；验证术语、RTL、链接、元数据和真实语言切换。只有发布门槛通过后，才另行修改语言发布名单。此归档草稿 PR 的合并或保存本身不代表批准语言上线。
