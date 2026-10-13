# 俄语版（/ru）全站设计走查（Refs #108）

- 基于 main 894140b，本机 `pnpm build && pnpm start`，Playwright（Chromium，locale ru-RU）截图。
- 视口：1440×900 桌面、390×844、360×780 移动。文件名：`ru-<页面>-<视口>.png`（整页），`*-fold-cookie.png` 为首屏 + Cookie 条。
- 页面：`/ru`、`/ru/products`、`/ru/contact`、`/ru/privacy`、`/ru/s/expired`、不存在的路径（404）。
- 表单：`ru-contact-step3-empty-*`、`ru-contact-error-{429,sample_recent,400,503,500,network}-*`（接口用 Playwright 模拟返回）。
- 不评判 3D 颜色和光照（本机无 GPU）。

## 结论
| 检查项 | 结果 |
|---|---|
| 文字溢出/截断 | ❌ 产品卡片标题被省略号截断（1440、360）；❌ 隐私页 H1 在 360 撑出横向滚动。导航、按钮、页脚、Cookie 条、表单无溢出 |
| 英文残留 / 翻译键 | ❌ 404 页是 Next 默认英文页。其余只有品牌名、语言切换 “English”、隐私草稿里的服务商名和 [占位符]，属正常 |
| 西里尔字体 | ✅ 全部文字都是 Manrope（已加载 cyrillic 子集），没有混用回退字体 |
| 换行/断词 | 长词（конфиденциальности）在 360 无法断开，见上；其余正常 |
| 表单错误 | ✅ 429/400/503/500/网络错误均为俄语。⚠️ `sample_recent` 目前落到通用 429 文案「请几分钟后再试」，不符合 #137（30 天内已申请过）。main 上还没有前台样品申请入口，等入口上线时一起处理 |
| 主题 | ✅ 主站为主题 C（暖白 #FBF8F3 + 珊瑚）；礼盒、酒盒卡片为主题 B（深色 + 金色） |
| 悬浮按钮 | ✅ 390/360 悬浮按钮底边离 Cookie 条 12px；展开后不压页面底部按钮。⚠️ main 上没有 `--fab-clearance` 变量（#61 的改动尚未合入），无法验证该变量 |

浏览器原生必填提示（“Please fill out this field.”）跟随浏览器语言，headless Chromium 固定英文，俄语浏览器下会是俄语，不算缺陷。
