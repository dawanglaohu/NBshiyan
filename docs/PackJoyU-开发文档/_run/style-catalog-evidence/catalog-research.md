# S3 前置 StyleKit 目录研究（未裁决）

研究日期：2026-10-19。此文件只存真实目录证据及待裁问题，不构成 S3 方向定稿。11/12 正文、最终 `_run/stylekit-spec.json`、页面、HTML、预览均未创建。

已读 installed StyleKit `C:/Users/admin/.agents/skills/stylekit/SKILL.md` 与 unattended-run `C:/Users/admin/.codex/skills/unattended-run/references/doc-structure.md` 的 S3 段。后者覆盖默认更新/提问流程：未运行 update-skill.py，未询问用户，未生成页面/预览；未读正文 04，未调用 GPTDot 或图片生成，未打开或修改桌面素材原件。

输入上下文由主会话提供：PackJoyU 包装展示/询盘；前台英语/俄语；主页使用 12.27 秒生产视频及城市 JPG/GIF；扩大产品卡片/3D 区域；后台含登录、用户资料、咨询收件箱、数据看板；Next 15 / React 19 / 既有 CSS，不引入 Tailwind 或新组件库。用户参照 URL 仅作为上下文记录，本次没有审阅该站内容，也不对其视觉作事实断言。

## 目录证据

使用安装副本 `C:/Users/admin/.agents/skills/stylekit/scripts/fetch-style.py`。共 3 次 search，没有遍历搜索网格：

| 命令参数 | 真实结果 |
| --- | --- |
| `--search "industrial packaging video brand"` | exit 0；No styles match；返回全目录链接 `https://www.stylekit.top/api/styles` |
| `--search "minimal dashboard"` | exit 0；No styles match；返回同一全目录链接 |
| `--search "minimal"` | exit 0；`minimalist-flat`、`scandinavian`、`kawaii-minimal`、`korean-minimal` |

从该真实结果中取下列 3 个候选。`kawaii-minimal` 未获取：其可爱语义与既知 B2B 包装制造场景不够直接，搜索命中不等于适合。没有新增或猜测 slug。

| 候选 slug | 保存的完整 JSON | brief 实际来源 | 内容哈希 | SHA-256（本地文件） |
| --- | --- | --- | --- | --- |
| `minimalist-flat` | `minimalist-flat.json` | https://www.stylekit.top/api/styles/minimalist-flat/brief | `fnv1a32:63054a3b` | `4e4d407b9365a8543b2d5d39daa72f953984786b9fb7c83fcd393f005dea0914` |
| `scandinavian` | `scandinavian.json` | https://www.stylekit.top/api/styles/scandinavian/brief | `fnv1a32:a726ec47` | `f816db3325cf013a7181e76ec169090636e1df6e8f3a76e3f8e02fa6887d546c` |
| `korean-minimal` | `korean-minimal.json` | https://www.stylekit.top/api/styles/korean-minimal/brief | `fnv1a32:5559cb46` | `4ac6824d4f247e5f4f9a5fa14c3ffe2f6dc77bb57cb9f451674ce4bcb80aace6` |

三个 fetch 均 exit 0，响应可解析为完整 `stylekit-brief-v1` JSON，`_stylekitSource.kind=http-api`、`_stylekitSource.degraded=false`，`provenance.source=static`。这只表明 brief 接口获取成功。不要把下方 readiness 内部 fallback 误写为 HTTP fetch 降级，也不要把它省略。

## 候选的适配边界及直接证据

### `minimalist-flat` — Minimalist Flat

目录描述：Ultra-minimal flat design with no shadows or gradients, creating hierarchy through color and whitespace. Ideal for portfolios, creative agencies, and art websites.

适配判断：高对比黑白平面语法能让生产视频、城市素材、包装产品和 3D 画面成为主角；清晰边界及无阴影层级也可用于咨询收件箱、资料表单、数据看板。这是基于需求的适配判断，不是目录对 PackJoyU 的认证。

前后台共用条件：前台可保留影像主导的 brand 页面，后台改用 product/back-office 的表格、列表和表单密度，仅共享色彩、字体规则、边界及交互 token。该候选的 2px 黑边和强调色会影响品牌气质，须与现有品牌资产及 euproprt 参照的实际观察一起交 S3 裁决。

规格中的实际 palette：`{"primary": "#000000", "secondary": "#ffffff", "accent": ["#ff3366", "#00d4aa", "#ffcc00", "#b45700"]}`。

实际 typography（目录只给通用字体类别/类名，没有具名字体或俄文字形承诺）：

```json
{
  "heading": "font-bold tracking-tight",
  "body": "font-sans",
  "mono": "font-mono",
  "sizes": {
    "hero": "text-4xl md:text-6xl lg:text-8xl",
    "h1": "text-3xl md:text-5xl",
    "h2": "text-2xl md:text-3xl",
    "h3": "text-lg md:text-xl",
    "body": "text-sm md:text-base",
    "small": "text-xs md:text-sm"
  }
}
```

从实际 globalCss 原样摘出的变量块（不是为 PackJoyU 新定的 token）：

```css
:root {
  --minimalist-flat-primary: #000000;
  --minimalist-flat-secondary: #ffffff;
  --minimalist-flat-accent: #ff3366;
  --minimalist-flat-glow: rgba(0, 0, 0, 0.3);
}
```

实际组件 recipe 概要（下面是目录类名形式的值；不能据此向现有项目安装 Tailwind）：

| recipe | baseClasses（原值） | variants | 明确存在的状态 |
| --- | --- | --- | --- |
| `button` | `font-medium ; border-2 border-black ; transition-colors duration-200` | `primary: bg-black text-white ; secondary: bg-white text-black ; outline: bg-transparent text-black` | `hover: hover:bg-white hover:text-black ; active: active:bg-gray-100 ; disabled: opacity-40 cursor-not-allowed` |
| `card` | `bg-white ; border-2 border-black ; transition-colors duration-200` | `default:  ; inverted: bg-black text-white border-black ; accent: bg-[#ff3366] text-white border-[#ff3366]` | `hover: hover:bg-black hover:text-white` |
| `input` | `w-full ; bg-transparent ; border-0 border-b-2 border-black ; text-black ; placeholder:text-gray-500 ; focus:outline-none ; transition-colors duration-200` | `default:  ; boxed: border-2 border-black px-4` | `focus: focus:border-[#ff3366] ; disabled: opacity-40 cursor-not-allowed` |

实际 border / interaction：

```json
{
  "border": {
    "width": "border-2",
    "color": "border-black",
    "radius": "rounded-none",
    "style": "border-solid"
  },
  "interaction": {
    "transition": "transition-colors duration-200",
    "active": "active:opacity-80",
    "hoverOpacity": "hover:opacity-90"
  }
}
```

限制或冲突：目录定位是 portfolios / creative agencies / art websites，未提供工业包装专属布局。globalCss 同时含 gradient、frosted 和半透明 ::before 工具，与 dontList 的禁渐变/低透明色存在文本冲突；verify-spec 没有报出这些全局样式冲突，不能照搬完整 globalCss。button recipe 的 disabled opacity-40 与 dontList 禁低于 0.5 透明度也有冲突。

只读 verify-spec 结果：exit 0; Verified 1 of 1 styles: pass, 0 issue(s), 0 notice(s). 此处只是规格静态检查，未证明 CSS 编译、对比度、页面或媒体流程通过。

### `scandinavian` — Scandinavian Minimalism

目录描述：Warm minimalist design rooted in Scandinavian tradition, emphasizing natural materials, generous whitespace, wood tones, and Hygge living aesthetics for a serene, cozy visual experience.

适配判断：暖白、木色和鼠尾草绿能与纸材、包装实物、城市照片及生产视频共存；低装饰能留出放大的产品卡片和 3D 展示。适合作为自然材料/温暖包装方向的候选，不代表用户已选择可持续叙事。

前后台共用条件：若选此 slug，前后台只共享其品牌色、文本色、边框及克制交互；后台必须按 product/back-office 降低留白并提高扫描密度。原 dontList 明写不要密集排布，因此主会话需裁决这条在品牌页面与后台工作面的适用边界，不能一边宣称逐字遵循、一边无记录地覆写。

规格中的实际 palette：`{"primary": "#3d3d3d", "secondary": "#f5f0eb", "accent": ["#5a7a6b", "#7ba0b8", "#c9a88c", "#607683"]}`。

实际 typography（目录只给通用字体类别/类名，没有具名字体或俄文字形承诺）：

```json
{
  "heading": "font-light tracking-wide",
  "body": "font-light",
  "mono": "font-mono font-light",
  "sizes": {
    "hero": "text-3xl md:text-5xl lg:text-7xl",
    "h1": "text-2xl md:text-4xl",
    "h2": "text-xl md:text-3xl",
    "h3": "text-lg md:text-xl",
    "body": "text-sm md:text-base",
    "small": "text-xs"
  }
}
```

从实际 globalCss 原样摘出的变量块（不是为 PackJoyU 新定的 token）：

```css
:root {
  --scandinavian-bg: #f5f0eb;
  --scandinavian-text: #3d3d3d;
  --scandinavian-muted: #a89279;
  --scandinavian-accent: #5a7a6b;
  --scandinavian-border: #d4cdc5;
}
```

实际组件 recipe 概要（下面是目录类名形式的值；不能据此向现有项目安装 Tailwind）：

| recipe | baseClasses（原值） | variants | 明确存在的状态 |
| --- | --- | --- | --- |
| `button` | `font-sans ; font-medium ; rounded-lg ; transition-all duration-200` | `primary: bg-[#5a7a6b] text-white ; secondary: bg-[#f5f0eb] text-[#3d3d3d] border border-[#d4ccc4] ; outline: bg-transparent text-[#5a7a6b] border border-[#5a7a6b]` | `hover: hover:opacity-90 hover:shadow-sm ; active: active:scale-[0.98] ; disabled: opacity-40 cursor-not-allowed` |
| `card` | `bg-[#f5f0eb] ; border border-[#e0d8cf] ; rounded-lg ; overflow-hidden ; transition-all duration-200` | `default: shadow-sm ; white: bg-white border-[#e8e2da] ; sage: bg-[#5a7a6b]/5 border-[#5a7a6b]/20` | `hover: hover:shadow-md hover:border-[#d4ccc4]` |
| `input` | `w-full ; bg-white ; border border-[#d4ccc4] ; rounded-lg ; text-[#3d3d3d] ; placeholder:text-[#a09888] ; focus:outline-none ; transition-all duration-200` | `default:  ; beige: bg-[#f5f0eb] border-[#e0d8cf]` | `focus: focus:border-[#5a7a6b] focus:ring-1 focus:ring-[#5a7a6b]/20 ; disabled: opacity-40 cursor-not-allowed bg-[#f5f0eb]` |

实际 border / interaction：

```json
{
  "border": {
    "width": "border",
    "color": "border-[#d4cdc5]/40",
    "radius": "rounded-sm",
    "style": "border-solid"
  },
  "interaction": {
    "transition": "transition-colors duration-500",
    "active": "active:scale-[0.98]"
  }
}
```

限制或冲突：tokens.border.radius=rounded-sm，但 button/card/input recipes 用 rounded-lg；tokens.interaction.transition 为 500ms，button recipe 为 200ms，component button 示例又为 700ms；tokens.interaction.active 和 recipe 的 scale(.98) 与 dontList 禁 strong press/仅亮度变化的说明存在冲突。globalCss 另含渐变、毛玻璃、切角等通用工具，不等于此项目要使用。

只读 verify-spec 结果：exit 0; pass, 0 issue(s), 1 notice: button required-table drift: transition-colors duration-300. 需在最终组件约束中明确以哪一字段为准，不能忽略 notice。

### `korean-minimal` — Korean Minimal

目录描述：Korean minimalist design aesthetic influenced by K-beauty and Korean architecture. Soft pastel tones, generous whitespace, refined rounded corners, and restrained ornamentation.

适配判断：暖白、低饱和粉/鼠尾草/砂色与简洁圆角，能让包装照片和 3D 产品成为页面重点；石板蓝正文色可作为前后台共同的可读基础。它在精致消费包装方向有条件适配，柔和气质对工业供应商是否合适仍待裁。

前后台共用条件：后台可共享石板蓝/暖白和薄边框，但不照搬大留白、轻字重或大圆角卡片作为所有工作面；需从收件箱和数据看板的任务密度反推组件尺寸。原风格禁止深黑背景，因此视频区域若要深色蒙层/控件，应裁定是媒体本身还是需要例外的 UI 表面。

规格中的实际 palette：`{"primary": "#3d4a5c", "secondary": "#faf9f7", "accent": ["#d4a5a5", "#a8c5b8", "#e8d4b8", "#b9b08a"]}`。

实际 typography（目录只给通用字体类别/类名，没有具名字体或俄文字形承诺）：

```json
{
  "heading": "font-light tracking-wide text-[#3d4a5c]",
  "body": "font-sans font-light",
  "mono": "font-mono",
  "sizes": {
    "hero": "text-3xl md:text-5xl lg:text-6xl",
    "h1": "text-2xl md:text-4xl",
    "h2": "text-xl md:text-3xl",
    "h3": "text-lg md:text-xl",
    "body": "text-sm md:text-base",
    "small": "text-xs md:text-sm"
  }
}
```

从实际 globalCss 原样摘出的变量块（不是为 PackJoyU 新定的 token）：

```css
:root {
  --km-slate-blue: #3d4a5c;
  --km-warm-white: #faf9f7;
  --km-blush: #d4a5a5;
  --km-sage: #a8c5b8;
  --km-sand: #e8d4b8;
}
```

实际组件 recipe 概要（下面是目录类名形式的值；不能据此向现有项目安装 Tailwind）：

| recipe | baseClasses（原值） | variants | 明确存在的状态 |
| --- | --- | --- | --- |
| `button` | `font-light ; tracking-wide ; rounded-full ; border ; transition-all duration-300 ease-in-out` | `primary: bg-[#3d4a5c] text-[#faf9f7] border-[#3d4a5c] ; secondary: bg-transparent text-[#3d4a5c] border-[#3d4a5c]/20 ; soft: bg-[#d4a5a5]/20 text-[#3d4a5c] border-[#d4a5a5]/30` | `hover: hover:shadow-sm hover:opacity-80 ; active: active:scale-[0.98] ; disabled: opacity-50 cursor-not-allowed` |
| `card` | `bg-[#faf9f7] ; rounded-2xl ; border border-[#3d4a5c]/10 ; shadow-sm ; transition-all duration-300 ease-in-out` | `default:  ; blush: border-[#d4a5a5]/20 bg-gradient-to-br from-[#faf9f7] to-[#d4a5a5]/5` | `hover: hover:shadow-md hover:border-[#3d4a5c]/20` |
| `input` | `w-full ; rounded-xl ; border border-[#3d4a5c]/15 ; bg-[#faf9f7] ; text-[#3d4a5c] ; placeholder:text-[#3d4a5c]/30 ; font-light ; tracking-wide ; focus:outline-none ; transition-all duration-300 ease-in-out` | `default:  ; blush: border-[#d4a5a5]/25 placeholder:text-[#d4a5a5]/40` | `focus: focus:border-[#3d4a5c]/30 focus:shadow-[0_0_8px_rgba(61,74,92,0.08)] ; disabled: opacity-50 cursor-not-allowed` |

实际 border / interaction：

```json
{
  "border": {
    "width": "border",
    "color": "border-[#3d4a5c]/8",
    "radius": "rounded-2xl",
    "style": "border-solid"
  },
  "interaction": {
    "transition": "transition-all duration-300 ease-in-out",
    "active": "active:scale-[0.98]",
    "hoverScale": "hover:translate-y-[-1px]"
  }
}
```

限制或冲突：tokens.required.button 要求 rounded-2xl、shadow-sm、font-normal；button recipe 却使用 rounded-full、font-light 且 base 无 shadow-sm。tokens.required.card 边框 /8，而 recipe /10；tokens.required.input 要 rounded-2xl，而 recipe rounded-xl；focus ring 为粉色 10%/15% 透明度，须做对比度和可见性核查。目录叙述源于 K-beauty/lifestyle，不能擅自把包装供应商定位改成美妆品牌。

只读 verify-spec 结果：exit 0; pass, 0 issue(s), 2 notices: button required-table drift: shadow-sm font-normal duration-300; card required-table drift: border-[#3d4a5c]/8 shadow-sm.

## 三个候选共有的字段缺口

- `readiness.source=fallback`；`themeModes=[light]`；`darkMode.support=missing`、strategy=fallback。没有 curated 暗色契约；并非项目已需要暗色模式。
- `readiness.states.default/hover/focus-visible=complete`；active/disabled/loading/skeleton/empty/error/success 全部 partial。readiness 的通用说明不等于每个按钮/输入/卡片都已给出这些状态的确定尺寸和颜色。
- `readiness.motion.support=partial`，通用 duration=120–220ms、easing=`cubic-bezier(0.2, 0, 0, 1)`；与各风格 interaction/recipe 的 200–700ms 字段不完全一致。
- `readiness.accessibility.support=partial`；通用要求是 2px 可见焦点环、触摸目标至少 44px、原生控件优先。没有提供 EN/RU 文案扩展、视频控件、3D 操作、GIF/减弱动态的项目级无障碍完成证据。
- `readiness.performance.support=fallback`，无风格专属成本分析；需后续以实际视频/3D 素材及服务流程验证。
- 每个 spec 只有 button/card/input 三个完整 recipe；readiness 列出 table/modal/toast/form/empty-state 的通用 guidance，但没有对应品牌完整 recipe。咨询收件箱、图表、状态标签、登录/资料表单需要在唯一最终 token 体系里补齐。
- 目录 typography 没有具名字体，也没有 Cyrillic 覆盖信息；明确的组件高度、loading/empty/error/success 色彩和保持尺寸规则并未完整给出。
- 所有 spacing/container 都含营销留白；unattended S3 明确禁止直接采用，尤其后台。应从 density.md 定工作面、操作面及登录单卡容器，不能把 `p-8/md:p-12/lg:p-16` 等照搬进后台。
- recipe/token 多用 Tailwind 类名，minimalist-flat 的 globalCss 还有 `@apply`。这些是取值证据，现有 CSS 项目不能直接编译此类源码；最终需由现有 CSS 表达相同 token/状态，无需引入组件库。

## 许可来源与未验证部分

已读取本机安装副本 `C:/Users/admin/.agents/skills/stylekit/LICENSE`：MIT License，Copyright (c) 2026 AnxForever；复制/分发其软件或实质部分时保留版权与许可声明。安装副本 README 第 7、159 行链接同目录 LICENSE，并在第 9 行把此 skill 指向 `https://github.com/AnxForever/stylekit`。本次没有独立抓取 GitHub LICENSE，因此当前证据是安装副本许可，而非一个已验证的远端 LICENSE URL。

三个 API brief 没有 `license` 或 asset-license 字段；它们的 provenance 仅给 static、contentHash、brief URL。不能仅从 skill 的 MIT 声明推定任何外部视频、城市图片、GIF、3D 模型、字体或 euproprt 站内素材的使用许可。此次未检索、下载或选用任何此类资产，用户桌面原件保持未触碰。

## 留给主会话 S3 的寄存器及裁决问题

寄存器仍为 pending；本任务不定最终方向。以下是真实可裁的选项和边界，不向用户提问：

1. 公开站采用 brand，登录/用户资料/咨询收件箱/数据看板采用 product/back-office，共享一个选定 slug 的品牌 token，但按 page role 分离密度；或将公开站内的产品发现/询盘页归为 commerce 风格的展示列表（没有购物车/支付，不能自动扩为交易电商）。这一区分应由主会话结合已通过 S2 的真实页面清单送 Jev design。
2. 后台以成批用户/咨询对象为中心，现有上下文倾向 back-office；若实际目标是操作员反复清理咨询这一单项工作，则 workbench 是另一个真实选项。需要列出业务事实再裁，不能仅因有 dashboard 就套 workbench。
3. 三个真实候选可构成 3 个可裁方向：`minimalist-flat` 的高对比影像主导；`scandinavian` 的自然材料/暖色；`korean-minimal` 的精致柔和包装。此处不排序、不推荐、不假定原有品牌色可任意重置。
4. 是否采用“同一 slug + brand/product 角色分层”而不是两套 slug：前者更直接约束统一品牌；后者若被选，必须明确唯一共享语义 token、冲突优先级和同一品牌系统的边界，不能后台另造第二 palette。
5. 对 scandinavian 的“不要密集排布”与后台密度、korean-minimal 的浅色 UI 与媒体表面、以及各自 recipe/token 冲突，需作为具体候选的代价送同一次 Jev design；不能静默删掉 dontList。
6. S3 选定后，主会话才把获胜的完整 JSON 保存到文档 `_run/stylekit-spec.json`，并由该唯一 spec 提取/补齐 11/12 与 handoff.design；所有 state、字体、CSS 转译、视频/3D 操作和后台密度都在该裁定内闭合。

没有最终 stylekit-spec；未写 11/12；未创建 HTML、CSS 页面文件、_preview 或 UI 原型。
