# 既有后台视觉覆盖补丁草案（仅planning）

原16个路由模式加下列7个既有模式，共23个；这7项是补齐本轮视觉验收范围，并非新增产品页面。`/admin/settings`和`/admin/users`仍是原表中的两行，只扩完整控件视觉验收。旧业务、角色、API、语言、邮件gate均不变化。没有`MailWorkspace.tsx`，实际邮件工作区由`mail/MailThread.tsx`和`MailParts.tsx`组成。

## 第07节路由表新增7行

| 路由模式 | 页面文件/状态 | 本轮触达与权限 |
|---|---|---|
| /admin/inquiries | src/app/admin/inquiries/page.tsx，既有 | 询盘列表/筛选/分页/匿名化标签视觉；ADMIN/SALES，原服务端scope不变 |
| /admin/inquiries/[id] | src/app/admin/inquiries/[id]/page.tsx，既有 | 详情/状态/分配/笔记/历史/邮件往来视觉；ADMIN或获原scope授权SALES；匿名化限制不变 |
| /admin/models | src/app/admin/models/page.tsx，既有redirect | 保留重定向/admin/models/new；不新建模型列表，目标页当前角色守卫继续生效 |
| /admin/models/new | src/app/admin/models/new/page.tsx，既有 | 模型上传/检查/预览/发布确认视觉；ADMIN/EDITOR；原大小与READY限制不变 |
| /admin/specs | src/app/admin/specs/page.tsx，既有 | SSR categoryMeta品类列表视觉；ADMIN/EDITOR；不开放新类别 |
| /admin/specs/[category] | src/app/admin/specs/[category]/page.tsx，既有 | 原品类规格表单/错误/保存视觉；ADMIN/EDITOR，未知category仍404 |
| /admin/mail/unassigned | src/app/admin/mail/unassigned/page.tsx，既有条件关闭 | UNASSIGNED_MAIL_LIVE=false且后端未实现，保持入口隐藏/页面404/零相关请求；仅迁移已有组件样式，不开gate或新建接口 |

## 第07节入口表新增7行

`/admin/mail/unassigned`为有意关闭的例外，不伪造当前不存在的可见入口；其验收是入口不显示与真实404。`/admin/models`是可点击面包屑到原重定向，不声称独立列表。

| 目标路由 | 起点页面与可见控件 | 可见角色/条件 | 点击后请求或状态 |
|---|---|---|---|
| /admin/inquiries | 已登录后台壳“询盘” | ADMIN/SALES | GET /api/admin/inquiries，用户筛选取GET /api/admin/users；保留q/date/status/assignee/page及原scope |
| /admin/inquiries/[id] | 原询盘列表中的实际编号链接/可键盘行 | ADMIN及原scope可见SALES；真实持久id | GET /api/admin/inquiries/[id]及history；状态/负责人PATCH同id，笔记POST notes；mail/config允许时沿既有GET/POST mail与status/retry |
| /admin/models | 上传页“3D 模型”面包屑 | 可访问上传页的ADMIN/EDITOR | 点击后仍重定向/admin/models/new；无新模型列表请求 |
| /admin/models/new | 后台壳“3D 模型”；或上述重定向目标 | ADMIN/EDITOR | 原POST /api/admin/models上传、GET/PATCH /api/admin/models/[id]，POST process/publish；本轮不引入新后台接口 |
| /admin/specs | 后台壳“产品规格” | ADMIN/EDITOR | SSR读取categoryMeta构成真实品类列表，无需虚构列表API |
| /admin/specs/[category] | 规格列表真实品类链接；编辑页“全部品类”返回 | ADMIN/EDITOR且categoryMeta存在 | GET/PUT /api/admin/specs/[category]；原字段校验和保存反馈不变 |
| /admin/mail/unassigned | 当前无可见入口，必须保持隐藏；从原后台导航验证不存在 | UNASSIGNED_MAIL_LIVE=false；ADMIN登录也不开放 | 真实直接请求仍404；无unassigned/count、列表、assign/ignore或附件请求；不把客户端预留URL当已实现HTTP能力 |

## 第11节页面表新增7行

| 路由模式 | 用途 | 主要区域 | 关键组件 | 数据来源 | 页面类型 |
|---|---|---|---|---|---|
| /admin/inquiries | 扫描和筛选原询盘 | 后台壳；状态/搜索/日期/产品/负责人；真实列表；分页；匿名化标签 | InquiryList、DateRange、StatusBadge、DeletedTag、AdminTime | 既有GET inquiries/users，原scope及筛选协议 | 工作面 |
| /admin/inquiries/[id] | 阅读与处理原询盘 | 标题/返回；状态/负责人；正文/产品；笔记/历史；原邮件区；匿名化提示 | InquiryDetail、InquiryHistory、anonymized、MailThread、MailParts | 既有详情/history/notes/reply/PATCH；邮件由config及原gate限制 | 工作面（含原处理操作区） |
| /admin/models | 保持原上传入口重定向 | 无独立页面区域 | Next redirect | 既有redirect('/admin/models/new')；不增加列表API | 重定向（无独立密度测量） |
| /admin/models/new | 维持模型上传到发布流程 | 步骤；文件/大小反馈；检查结果；GLB预览；确认；取消 | ModelUpload、ModelPreview、models.css | 既有upload/get/update/process/publish HTTP及实际GLB | 操作面（左对齐，可用预览旁栏） |
| /admin/specs | 选择已有品类编辑 | 后台壳；品类真实列表；品类链接 | 原SSR列表、spec-list | categoryMeta；无需增加API | 工作面 |
| /admin/specs/[category] | 编辑已有品类规格 | 标题/返回；材料/尺寸/MOQ/交期/费用/认证；错误；保存 | SpecEditor、specs.css | 既有GET/PUT specs/[category]、原校验 | 操作面 |
| /admin/mail/unassigned | 保持现有关闭能力和预留组件视觉一致 | 当前不渲染业务区；组件内原分类/列表/详情/归类/忽略状态只作组件层检查 | UnassignedInbox、UnassignedNav、mail.css共享值 | 当前无可调用后端，入口隐藏/路由404/零请求；不得开gate | 条件关闭；工作面仅为组件结构，真实密度记gate-off/not-rendered |

## 原有两行更新（不增加路由数量）

- `/admin/settings`：用途扩为现有about/org/图片设置及analytics分区；AboutSettings、OrgSettings、AboutImages、ImageTextField、ConfirmDialog、SettingsSections全部消费唯一视觉值。真实来源是GET about、PUT about/[locale]/enabled、GET/PUT organization、GET/POST assets、PUT about/images、DELETE assets/[id]与已实施GET/PATCH settings/analytics。保持原富文本净化、语言/完整度发布、脏草稿、expectedVersion/409刷新确认；仍ADMIN操作面，800px主列/可用旁栏按11，不把整页居中缩卡。
- `/admin/users`：用途扩为完整账号表/建账号/角色和停用控件及已完成恢复授权；GET users?all=1、POST users、PATCH users/[id]沿原契约，恢复只复用M3-T9的新鲜授权链。仍ADMIN工作面；自修改/最后有效管理员限制不变，旧直接reset旁路不恢复。

## 实际源码依据

- src/components/admin/AdminShell.tsx：现有询盘、模型new、规格、设置、账号入口；未归类导航受双gate。
- src/app/admin/models/page.tsx:3：只redirect，不是缺少本轮需补齐的新列表。
- src/lib/admin/mail/features.ts:4：UNASSIGNED_MAIL_LIVE=false；其系列接口尚无后端，MAIL_ATTACHMENTS_LIVE亦false。
- src/lib/admin/http.ts:63-79：原询盘method/path及用户/历史/上传图读取。
- src/lib/admin/mail/http.ts:60-64：原config/thread/send/retry/status；后续unassigned函数均gated，不当成已实现接口。
- src/lib/admin/models-http.ts:15-30：原上传/读取/更新/处理/发布。
- src/components/admin/specs/SpecEditor.tsx:27/37/61：既有GET/PUT规格接口。
- src/lib/admin/site-settings-http.ts:4-10：about GET/PUT及enabled/409协议。
- src/lib/admin/org-settings.ts:262：organization GET/PUT；src/lib/admin/about-images.ts:369-425：assets/images原协议。

## 最终验收依赖建议

M7-T9在原依赖上追加M3-T21..T25，并在最终同head交付清单逐项核5份视觉/门禁证据。不增加新的最终模块，也不让M7重实现样式。M3-T22的gate-off与/models的redirect明确保留，不以新页面或接口数量作为完成指标。

