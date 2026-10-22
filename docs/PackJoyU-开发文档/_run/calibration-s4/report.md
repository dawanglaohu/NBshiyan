# 104条边界真实校准证据

生成时间：2026-10-20T04:12:17.259769+00:00。本报告只写 planning，不写13节，不改边界台账、产品或主 `_run/judgments.jsonl`。

## 结论与使用边界

104/104次真实调用成功，模型均为 `jev-1.13.0`；104个独立日志、104个state哈希均与实际输入匹配，0项skipped/error，0项language_warning。英文state只含edge.scene/trigger/expect与7个简短职责；职责文本总长832字符。并发上限3。

可执行性：yes=76、unsure=27、no=1。**进入13前须具体化：E-30**。另外27条unsure提供具体化建议供主线复核，不伪称已通过，也不把unsure自动改成no。

职责分歧9条：E-27、E-29、E-62、E-86、E-87、E-88、E-92、E-93、E-94。校准模型不能代替主线裁决；所有台账归属保持原样，分歧的源职责解释见下表。

真实用量：input_tokens=118633，output_tokens=13416。未读取.env/密钥内容；helper按其既有受支持机制取得凭据，仅保留helper原样输出。

建议文本尚未再次校准，也未写入13或任何源文档。本报告不是实施完成或阶段过关声明。S3状态由主线处理。

## 输入与证据格式

- 源台账快照：`source-edges.md`；逐行中文来源：`source-rows.json`；06职责快照：`source-06.md`。
- 每项`NN.state.json`为实际输入，`NN.response.json`与`NN.stdout.txt`为helper完整原样JSON响应；`NN.jsonl`独立保留template/model/state_sha256/verdicts/usage/label。
- 每项`NN.meta.json`保留真实命令、起止时刻、退出码；`NN.stderr.txt`保留标准错误。NN按01..99、100..104命名。
- `results.json`为只读汇总；`summary.json`为计数；`audit_results.py`逐项验证哈希、标签、模型、结论、用量与英文输入。没有合并主judgments。
- 调用形态：`python <工作树>/_run/typesafe_ask.py --log <planning>/NN.jsonl --label S4-E-NN run edge --state <planning>/NN.state.json`。
- helper哈希口径为排序键/ensure_ascii=False的JSON序列化后SHA256前16位；保留该真实值，不伪造完整64位调用日志。

## 必须具体化的条目（executable=no）

### E-30

中文原期望：继续修复发布副本，未通过质量核查的文件不作为已完成成品；原始 JPG/GIF 始终保留用于回退。

校准解释：原句中的“保持原时序、画面稳定或正确品牌覆盖”“通过质量核查”没有逐项可判定标准。模型给 executable=no，p=0.32；这只是需具体化信号，不能用它降低承诺。

最小具体改写建议：沿原 GIF 时间轴逐帧对照发布副本：帧呈现时刻、顺序与循环总时长保持不变；每次旧品牌出现、透视变化、转场及遮挡后再现均由 PackJoyU 完整覆盖，不出现替换新增的错位、漏标或抖动。任一项失败则继续修复该发布副本，将文件标为未完成且不纳入发布成品；原始 JPG/GIF 始终保留用于回退。

真实 TS_CHECK：`edge: severity=a feature degrades or a user is blocked until retry(low 0.47) likelihood=occasional(low 0.27) executable=no(0.32) owner=M1(high 0.97)`

## unsure条目的保承诺具体化建议

这些建议解释既有09/10条款和原承诺，不新增产品能力。主线应结合各自完整条款判断是否采用；本次不修改ledger。

| 编号 | p | 中文最小建议 |
|---|---:|---|
| E-04 | 0.54 | 补充可测分支：关闭并重开浏览器后，未到期且未撤销的真实凭据按既有策略处理；过期或撤销凭据的受保护请求拒绝。测试不得以浏览器关闭即销毁 Cookie 为前提。 |
| E-08 | 0.63 | 把四种触发分别测试，并在最终事务复核待绑定记录、有效期和当前凭证版本；错误/过期/重放不提交，两个并发切换最多一个成功，失败后查询仍存在至少一种已验证登录方式。沿09节规则，不另造登录方式。 |
| E-14 | 0.57 | 明确 restricted 凭据访问受保护后台必须拒绝；中断或过期不提交待绑定新因素，原有效绑定保持；持有效 restricted cookie 可重入同一 enroll，失效则按10节已定义恢复码/授权路径重启，不能换取完整后台会话。 |
| E-25 | 0.50 | 列明在已定义的 PC 1440/1920 和窄屏验收尺寸检查：容器宽高比与素材一致，导航、正文及 PC 3D 控件的可见点击区域不被媒体覆盖，裁切后仍显示原图主体；不得以删除主体或操作区域通过检查。 |
| E-32 | 0.64 | 直接请求读取/回复接口分别验未登录、EDITOR、撤权账号、他人访客凭据均无内容且无写入；ADMIN/SALES 仅按当前权限返回；不以隐藏按钮作为权限证据。 |
| E-33 | 0.60 | 明确以服务端 seq 排序并展示真实 author；同会话同 clientMessageId 同载荷仅一条消息、一个出箱项和一次未读增加；并发人工回复各自保存，不由后返回响应覆盖先保存回复。 |
| E-34 | 0.64 | 补入已定义 seq 游标与已读 MAX 规则：在分页间插入消息，补齐范围内消息 ID 恰一次；已读只推进到用户实际确认的 seq，新到且 seq 更大的消息仍未读。 |
| E-35 | 0.63 | 将“真实通知状态”落到已定义 queued/sending/sent/failed 或其现有 DTO 映射，保存消息后的通知失败只改变该通知状态，不改变消息 received 或 inbox 可处理状态；未接通不得显示已发送。 |
| E-39 | 0.56 | 镜像10节已定字段：email 可省略；填写时 trim 后≤254、单个合法邮箱、不接收显示名/CRLF；空值按不填处理，非法或过长返回字段错误并保留当前标签页原消息，不升级为已验证身份或投递保证。 |
| E-45 | 0.58 | 在访客数的定义/提示处写明“已同意分析的匿名浏览器数”；分别用换设备、清标识、换浏览器验证可能形成新 browserHash，不出现“唯一真人”或跨设备识别宣称。 |
| E-48 | 0.55 | 沿09节把保留边界写成 receivedAt+30天及无身份聚合 expiresAt 的13个自然月，并显示查询覆盖范围；清理只在另有明确生产保留授权且显式启用时执行，默认 dry-run/关闭真实清理，无授权请求拒绝实际删除；隔离测试验证过期目标集合、计数、去标识及不重建已过期明细，不扩大备份或已有数据删除权限。 |
| E-60 | 0.49 | 直接引用09节既定 now-48h≤occurredAt≤now+5min：超界拒绝，准入的未来事件到其真实时间后才参与聚合；闭区间历史按原始完整覆盖和既定迟到窗口处理，禁止任意客户端时间污染未来日或已关闭区间。 |
| E-61 | 0.50 | 列出一轮真实产品动作证据：同意→实际页面/产品访问→实际 GLB start/terminal→真实五分钟作业提交→看板读取真实日/产品聚合，逐项核今日授权浏览器、PV、归因和3D指标。核心来源不得以未接入或固定值交差。 |
| E-62 | 0.57 | 明确业务计数读取已成功持久化的 inquiry/conversation/message 稳定业务标识；同标识重试与被拒垃圾不加计数；M6只读来源，结果 DTO 不含 email、body 等个人字段，不要求业务写入等待看板。 |
| E-63 | 0.56 | 引用09节既定口径：分母为获同意后真实 model_view_start；同 viewId 最多一个 success/failure 终态，超时记 failure；终态 durationMs 的有效样本算平均耗时并带 samples，无样本为 null，零成功且有样本才为0%，拒绝分析样本不补分母。 |
| E-66 | 0.51 | 按09/10节来源矩阵直接测：ADMIN全来源、SALES受既有 scope 的业务聚合、EDITOR公开流量/产品/3D；直接请求系统敏感来源403，混合来源响应在查询前裁剪且不含被隐藏计数。 |
| E-75 | 0.55 | 把“D3”指向09/10节已定义受限恢复路径和一次性 permit/restricted cookie；普通无密码登录不改，敏感设置缺当前密码时不得签发普通 ActionGrant，仅凭已登录会话或一枚TOTP的直接请求拒绝并无变更，受限恢复只可新绑定且审计。 |
| E-79 | 0.51 | 把“有界页”引用到既定分页上限并验每次请求不越界、seq 连续补齐；轮询只更新已确认收件游标，不推进用户已读位置，不创建客服在线或已读承诺。 |
| E-82 | 0.44 | 明示仅重算 dayStart 不早于完整原始覆盖起点的自然日；超范围保留原聚合并返回 partial/unavailable 及原口径/覆盖，不以清理后的残片替换旧完整计数。迟到范围沿09节48h，不扩原始保留期。 |
| E-88 | 0.57 | 新增纯授权门禁的可测表述：生产真实清理默认关闭且 dry-run 为默认模式；不存在另行明确的保留策略授权时，启用或请求真实删除必须拒绝且删除计数为0，可返回候选计数/未启用状态。文档、任务派发、模型或代理结论均不能充当授权。只用隔离数据验证，不触碰生产/恢复/备份现有数据。 |
| E-92 | 0.49 | 用隔离 SMTP 受控接收后中断 worker，再重启验证可按至少一次重试并复用 stable Message-ID；允许 SMTP 实际重复，但本地状态不标精确一次或客服已读，聊天 received 不变；按09节 unknown-delivery/租约规则呈现真实状态。 |
| E-93 | 0.57 | 把有界重试引用到09/10节持久任务/次数上限和退避规则，注入 SMTP不可达/缺配置/暂拒后重启验证从持久出箱恢复；日志和计数只含脱敏错误码及数量，不含主动邮箱/body；不得用 Next after() 的完成代替持久记录。 |
| E-94 | 0.60 | 分别验无权限调用拒绝、chat-notifications 使用独立受限适配器且不扩展旧 mail UI；deploy/cron.nbshiyan 确有每分钟注册，重启后实际消费已提交出箱，不能只有手工调用或未来空注册。M4随交付注册，M7仅最终验收。 |
| E-96 | 0.62 | 列明每种非法 mode、未由本人开启的totp、普通Credentials带非空recoveryCode都沿同一通用Auth.js失败结果，不签后台会话且响应不区分账号存在；合法password/totp只校验相应方式，并按既定限流/错误协议测试，保留有效用户登录。 |
| E-102 | 0.64 | 以单指模型拖动、双指缩放、文字区滑动分别验证：仅模型操作区接管拖动，缩放不能越该产品已定义 min/max，文字/页面滚动可用；测量每个控件点击目标≥44 CSS px，任一手势不触发询盘提交。 |
| E-103 | 0.60 | 分别注入GLB下载失败、不支持WebGL、context lost、仅poster/FoldBox，检查对应产品静态回退、重试和询盘；同viewId最多一个终态，poster/程序演示均不发GLB success。真实模型重试若新建尝试按既定viewId规则处理。 |
| E-104 | 0.62 | 以产品已有初始相机/缩放边界作基准，任意操控后复位需回到该值；在1440/1920及窄屏检查完整模型可见、名称及关键操作可辨；移除底部重复介绍后规格与询盘入口仍可见可用，不靠删内容消除裁切。 |

## 清理授权的可测门禁

E-48、E-87、E-88及任何生产保留清理测试均不得把规格、代理或模型结论当作既有数据删除授权。只实现并在隔离数据验证候选选择/并发复核；真实清理开关默认关闭，未获另行明确保留策略授权时保持dry-run并拒绝实际删除，返回未启用及候选/实际计数。备份、恢复数据与原始JPG/GIF不得因本报告新增删除权限。E-87测试仍须验证消息并发时跳过旧截止；关闭实际清理不能用来免除这项实现承诺。

## 职责分歧：源职责解释

| 编号 | ledger | 模型/置信 | 来源解释及主线复核建议 |
|---|---|---|---|
| E-27 | M1 | M6/0.39 | 06:9 明定 M1 拥有己方可证公司内容及品牌素材；PDF企业事实核验属于该职责。M6（06:14）只读取统计/运维真实来源，不负责企业宣传事实。模型M6仅0.39低置信；建议主线按源职责复核，台账M1本次不改。 |
| E-29 | M1 | M7/0.85 | 06:9 的 M1 制作/保管发布素材与操作来源证据；06:15 的 M7负责跨模块最终验收收口。句中证据让模型偏M7(0.85)，可在任务中区分M1出证与M7终验，不能把素材制作整体移交M7；台账不改。 |
| E-62 | M6 | M5/0.55 | 06:14 的 M6读取询盘/聊天真实来源并解释业务趋势；M5(06:13)负责匿名分析账本而非业务内容真值。M4提供已持久化消息事实；M6按权限只读计数，不能引出M4依赖M6。模型偏M5(0.55)，应由主线按来源区分，台账M6不改。 |
| E-86 | M4 | M5/0.76 | 06:12及09:62的M4拥有咨询消息/邮箱和最后成功咨询活动，90天聊天保留与cookie期限分开；M5(06:13)的原始/聚合保留指分析账本，不能把所有“保留”都交M5。模型M5(0.76)，台账M4不改。 |
| E-87 | M4 | M5/0.98 | 清理与新消息并发的事务重查发生在M4咨询记录，依据06:12、09:62；M5只交付共享固定作业基础（06:78），M4自行追加chat-retention。模型M5(0.98)虽高置信也不取代明确源职责；台账不改。 |
| E-88 | M4 | M5/0.70 | 本条约束M4聊天生产清理的授权门禁，06:12/78和09:73/85/87均把chat-retention放M4并要求另行授权。M5分析保留或共享registry不获得聊天数据删除权；M7可核最终证据。模型偏M5(0.70)，台账M4不改。 |
| E-92 | M4 | M7/0.85 | 06:12的M4保存真实聊天通知结果，06:78明确M7只验最终链路；SMTP接受后崩溃的outbox重投是M4运行行为，M7应验收而非拥有worker。模型M7(0.85)，台账M4不改。 |
| E-93 | M4 | M7/0.61 | 持久通知重试、脱敏及cron恢复属M4咨询通知，依据06:12/78、09:85/86；M7不承接生产通知状态机。模型偏M7(0.61)，台账M4不改。 |
| E-94 | M4 | M7/0.59 | M4随功能追加chat-notifications及其适配/权限契约，06:78、09:85明确不能等M7；M7负责最终真实接线验收（06:15）。模型M7(0.59)提示验收成分多，不构成转移实现责任；台账M4不改。 |

## 17节优先测试输入

筛选严格按edge模板：severity选择最高影响档（数据丢失/损坏、钱款错误或越权）且likelihood不是rare。这里的“高影响档”与confidence=high不同；低置信选择仍原样保留并标风险，不把它改写成确定事实。

共53条：E-02、E-03、E-04、E-05、E-08、E-10、E-11、E-14、E-15、E-16、E-17、E-20、E-29、E-34、E-37、E-38、E-40、E-42、E-43、E-44、E-45、E-46、E-48、E-56、E-57、E-58、E-61、E-62、E-63、E-64、E-68、E-69、E-70、E-71、E-72、E-74、E-75、E-77、E-78、E-79、E-80、E-81、E-82、E-83、E-85、E-86、E-87、E-88、E-89、E-91、E-93、E-95、E-96。

其中最高影响选择自身为high置信的29条：E-02、E-03、E-04、E-05、E-08、E-10、E-11、E-14、E-15、E-42、E-43、E-58、E-68、E-69、E-70、E-71、E-72、E-74、E-75、E-78、E-80、E-81、E-83、E-85、E-87、E-88、E-89、E-91、E-96。

最高风险重点（按源条款归并，不替代53条完整输入）：

- 账号与会话：E-02/03/04/05/08/10/11/14/15、E-68/69/70/71/72/74/75、E-95/96。用真实Auth.js初登/刷新/SSR/退出和撤销/过期/并发校验，不能只验Token解析。
- 必要聊天与持久化：E-16/17/20/34/37/38/40、E-77/78/79、E-85/86/87/88/89/91/93。优先消息持久化与通知分离、重试去重、分页游标、授权撤销、保留边界及默认关闭的实际清理。
- 分析与时间账本：E-42/43/44/45/46/48/56/57/58、E-80/81/82/83。验证同意门控、终态关联、DST/午夜、完整快照、lease/代次、时区revision、清理后的历史不伪造重算。
- 看板真来源：E-61/62/63/64。由真实访问/GLB/消息事实到固定作业再到只读看板，核计数与缺样本、失败、旧值；核心数据不可交未接入。
- 素材制作证据：E-29入最高影响筛选，但severity/likelihood置信分别须看原line；真实工具操作和文件证据不可用文字声明替代，E-30仍须先具体化。

rare不等于免测：E-12/13/19/27/32/47/59/60/65/66/73/94因模型likelihood选择rare不在53条里；尤其越权、恢复和注入/回放仍应保留安全负例。模型筛选也不能移除M2的PC/键盘/触屏和GLB真失败验收（E-97..104），它们选择中档影响不等于已验收。

## 104行真实TS_CHECK

line列逐字复制helper响应；owner列前者是台账，后者是模型，未替换源归属。每行模型均jev-1.13.0；对应完整响应/日志就在本目录。

| 编号 | ledger→model | state_sha256 | 17优先 | 真实line |
|---|---|---|---|---|
| E-01 | M3→M3 | `79d35705a979745e` | — | `edge: severity=a feature degrades or a user is blocked until retry(medium 0.52) likelihood=routine, many users will hit it(low 0.02) executable=yes(0.73) owner=M3(high 1.00)` |
| E-02 | M3→M3 | `1f4ae005ee601f67` | 是 | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(high 0.97) likelihood=routine, many users will hit it(low 0.32) executable=yes(0.77) owner=M3(high 1.00)` |
| E-03 | M3→M3 | `66823e74d3d76ea8` | 是 | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(high 1.00) likelihood=occasional(high 0.82) executable=yes(0.81) owner=M3(high 1.00)` |
| E-04 | M3→M3 | `4ec76019a86d3149` | 是 | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(high 0.85) likelihood=routine, many users will hit it(high 0.94) executable=unsure(0.54) owner=M3(high 1.00)` |
| E-05 | M3→M3 | `fd22d8cc91d0e863` | 是 | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(high 0.85) likelihood=routine, many users will hit it(medium 0.62) executable=yes(0.68) owner=M3(high 1.00)` |
| E-06 | M3→M3 | `45883e8f1995d418` | — | `edge: severity=a feature degrades or a user is blocked until retry(medium 0.55) likelihood=occasional(medium 0.73) executable=yes(0.75) owner=M3(high 1.00)` |
| E-07 | M3→M3 | `e792f991177d5e69` | — | `edge: severity=a feature degrades or a user is blocked until retry(low 0.43) likelihood=occasional(low 0.28) executable=yes(0.72) owner=M3(high 1.00)` |
| E-08 | M3→M3 | `61afb16c324436d7` | 是 | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(high 0.95) likelihood=occasional(medium 0.52) executable=unsure(0.63) owner=M3(high 1.00)` |
| E-09 | M3→M3 | `1f2363d2d284ef4c` | — | `edge: severity=cosmetic or a confusing message only(low 0.39) likelihood=occasional(low 0.32) executable=yes(0.79) owner=M3(high 1.00)` |
| E-10 | M3→M3 | `3be2c7966370c02d` | 是 | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(high 0.98) likelihood=routine, many users will hit it(high 0.94) executable=yes(0.82) owner=M3(high 1.00)` |
| E-11 | M3→M3 | `5223cd6bad83bbf9` | 是 | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(high 1.00) likelihood=occasional(low 0.34) executable=yes(0.75) owner=M3(high 1.00)` |
| E-12 | M3→M3 | `c87757f74c287a61` | — | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(high 0.98) likelihood=rare, needs deliberate misuse(high 0.79) executable=yes(0.66) owner=M3(high 1.00)` |
| E-13 | M3→M3 | `f09b84dfd622d83b` | — | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(high 1.00) likelihood=rare, needs deliberate misuse(low 0.31) executable=yes(0.66) owner=M3(high 1.00)` |
| E-14 | M3→M3 | `8626671c4ea1c3a7` | 是 | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(high 0.91) likelihood=occasional(low 0.41) executable=unsure(0.57) owner=M3(high 1.00)` |
| E-15 | M3→M3 | `386f0d6989de7c02` | 是 | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(high 1.00) likelihood=occasional(low 0.47) executable=yes(0.73) owner=M3(high 1.00)` |
| E-16 | M4→M4 | `9415cc5f45ca8705` | 是 | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(medium 0.52) likelihood=routine, many users will hit it(low 0.47) executable=yes(0.73) owner=M4(high 1.00)` |
| E-17 | M4→M4 | `9132d736a71a436c` | 是 | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(low 0.28) likelihood=occasional(medium 0.70) executable=yes(0.80) owner=M4(high 1.00)` |
| E-18 | M4→M4 | `22e75c03919514d8` | — | `edge: severity=a feature degrades or a user is blocked until retry(high 0.80) likelihood=occasional(high 0.79) executable=yes(0.85) owner=M4(high 0.97)` |
| E-19 | M4→M4 | `ee10e465063cc7d4` | — | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(high 1.00) likelihood=rare, needs deliberate misuse(high 0.98) executable=yes(0.74) owner=M4(high 0.98)` |
| E-20 | M4→M4 | `894f9f56814de911` | 是 | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(low 0.35) likelihood=occasional(medium 0.62) executable=yes(0.72) owner=M4(medium 0.69)` |
| E-21 | M1→M1 | `e052a709ecb808b7` | — | `edge: severity=a feature degrades or a user is blocked until retry(medium 0.56) likelihood=routine, many users will hit it(high 1.00) executable=yes(0.79) owner=M1(high 1.00)` |
| E-22 | M1→M1 | `0778df37a19b8889` | — | `edge: severity=a feature degrades or a user is blocked until retry(high 0.94) likelihood=occasional(medium 0.74) executable=yes(0.77) owner=M1(high 0.99)` |
| E-23 | M1→M1 | `860c3a3e50f2f566` | — | `edge: severity=a feature degrades or a user is blocked until retry(medium 0.74) likelihood=routine, many users will hit it(medium 0.71) executable=yes(0.78) owner=M1(high 1.00)` |
| E-24 | M1→M1 | `f51520ec044483df` | — | `edge: severity=a feature degrades or a user is blocked until retry(low 0.37) likelihood=routine, many users will hit it(high 0.82) executable=yes(0.81) owner=M1(high 0.99)` |
| E-25 | M1→M1 | `ff212721d1d5684d` | — | `edge: severity=a feature degrades or a user is blocked until retry(high 0.78) likelihood=routine, many users will hit it(high 0.83) executable=unsure(0.50) owner=M1(high 0.97)` |
| E-26 | M1→M1 | `8e555393c121c407` | — | `edge: severity=cosmetic or a confusing message only(low 0.37) likelihood=occasional(low 0.19) executable=yes(0.73) owner=M1(high 1.00)` |
| E-27 | M1→M6 | `497d6a9032ab6884` | — | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(low 0.29) likelihood=rare, needs deliberate misuse(medium 0.50) executable=yes(0.65) owner=M6(low 0.39)` |
| E-28 | M1→M1 | `13bd392eadc2553c` | — | `edge: severity=a feature degrades or a user is blocked until retry(medium 0.68) likelihood=occasional(medium 0.53) executable=yes(0.71) owner=M1(high 1.00)` |
| E-29 | M1→M7 | `92a60d5f973a69b0` | 是 | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(medium 0.70) likelihood=occasional(low 0.20) executable=yes(0.69) owner=M7(high 0.85)` |
| E-30 | M1→M1 | `2140c3d6be97521f` | — | `edge: severity=a feature degrades or a user is blocked until retry(low 0.47) likelihood=occasional(low 0.27) executable=no(0.32) owner=M1(high 0.97)` |
| E-31 | M4→M4 | `5500e6345e1089c4` | — | `edge: severity=a feature degrades or a user is blocked until retry(medium 0.74) likelihood=routine, many users will hit it(medium 0.74) executable=yes(0.72) owner=M4(high 1.00)` |
| E-32 | M4→M4 | `594facd9610a0fac` | — | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(high 1.00) likelihood=rare, needs deliberate misuse(high 0.97) executable=unsure(0.64) owner=M4(high 0.93)` |
| E-33 | M4→M4 | `3cccfe347adb821d` | — | `edge: severity=a feature degrades or a user is blocked until retry(medium 0.64) likelihood=occasional(high 0.76) executable=unsure(0.60) owner=M4(high 1.00)` |
| E-34 | M4→M4 | `488714d7d3142844` | 是 | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(low 0.29) likelihood=routine, many users will hit it(high 0.76) executable=unsure(0.64) owner=M4(high 1.00)` |
| E-35 | M4→M4 | `3b90d4097f82ddc2` | — | `edge: severity=a feature degrades or a user is blocked until retry(high 0.88) likelihood=occasional(medium 0.74) executable=unsure(0.63) owner=M4(high 1.00)` |
| E-36 | M4→M4 | `cecdb88bb55d0608` | — | `edge: severity=a feature degrades or a user is blocked until retry(low 0.49) likelihood=occasional(low 0.32) executable=yes(0.81) owner=M4(high 1.00)` |
| E-37 | M4→M4 | `caf049f4e809cf8c` | 是 | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(medium 0.59) likelihood=occasional(high 0.94) executable=yes(0.70) owner=M4(high 0.95)` |
| E-38 | M4→M4 | `7db87efae04a456d` | 是 | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(medium 0.74) likelihood=occasional(medium 0.74) executable=yes(0.73) owner=M4(high 1.00)` |
| E-39 | M4→M4 | `bd67f69cd0a1594f` | — | `edge: severity=a feature degrades or a user is blocked until retry(medium 0.59) likelihood=occasional(high 0.83) executable=unsure(0.56) owner=M4(high 0.99)` |
| E-40 | M4→M4 | `d3bf2c4e6cfe14fd` | 是 | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(medium 0.74) likelihood=occasional(medium 0.74) executable=yes(0.65) owner=M4(high 0.90)` |
| E-41 | M4→M4 | `a982384d407f4592` | — | `edge: severity=a feature degrades or a user is blocked until retry(low 0.25) likelihood=occasional(high 0.93) executable=yes(0.74) owner=M4(high 0.99)` |
| E-42 | M5→M5 | `c5224df884b6715c` | 是 | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(high 0.91) likelihood=routine, many users will hit it(medium 0.74) executable=yes(0.78) owner=M5(high 1.00)` |
| E-43 | M5→M5 | `a214603bb016cfd7` | 是 | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(high 1.00) likelihood=occasional(high 0.82) executable=yes(0.75) owner=M5(high 1.00)` |
| E-44 | M5→M5 | `1a95307ac147a025` | 是 | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(medium 0.70) likelihood=routine, many users will hit it(high 0.80) executable=yes(0.70) owner=M5(high 1.00)` |
| E-45 | M5→M5 | `f3919f73b0ee17cf` | 是 | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(low 0.49) likelihood=routine, many users will hit it(low 0.46) executable=unsure(0.58) owner=M5(high 1.00)` |
| E-46 | M5→M5 | `d9b9dc98ecb39b5b` | 是 | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(medium 0.56) likelihood=routine, many users will hit it(low 0.32) executable=yes(0.73) owner=M5(high 0.90)` |
| E-47 | M5→M5 | `93acc6b6be136b5c` | — | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(high 0.97) likelihood=rare, needs deliberate misuse(high 0.97) executable=yes(0.66) owner=M5(high 1.00)` |
| E-48 | M5→M5 | `9aea76a489d72d3c` | 是 | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(medium 0.70) likelihood=routine, many users will hit it(medium 0.53) executable=unsure(0.55) owner=M5(high 1.00)` |
| E-49 | M6→M6 | `554776ecf3c6b1fd` | — | `edge: severity=a feature degrades or a user is blocked until retry(low 0.35) likelihood=occasional(low 0.43) executable=yes(0.79) owner=M6(high 1.00)` |
| E-50 | M6→M6 | `ec7e89d7463ad087` | — | `edge: severity=a feature degrades or a user is blocked until retry(low 0.37) likelihood=occasional(low 0.28) executable=yes(0.75) owner=M6(high 1.00)` |
| E-51 | M6→M6 | `6b13f43e88b48f30` | — | `edge: severity=a feature degrades or a user is blocked until retry(medium 0.64) likelihood=occasional(high 0.93) executable=yes(0.77) owner=M6(high 1.00)` |
| E-52 | M6→M6 | `5a79cf1617d86368` | — | `edge: severity=a feature degrades or a user is blocked until retry(low 0.41) likelihood=occasional(high 0.88) executable=yes(0.74) owner=M6(high 1.00)` |
| E-53 | M6→M6 | `747b976aafedafcc` | — | `edge: severity=a feature degrades or a user is blocked until retry(medium 0.51) likelihood=routine, many users will hit it(medium 0.69) executable=yes(0.72) owner=M6(high 1.00)` |
| E-54 | M6→M6 | `f137479593f38843` | — | `edge: severity=a feature degrades or a user is blocked until retry(low 0.30) likelihood=occasional(medium 0.51) executable=yes(0.75) owner=M6(high 0.98)` |
| E-55 | M5→M5 | `ab9835469018c952` | — | `edge: severity=a feature degrades or a user is blocked until retry(low 0.43) likelihood=routine, many users will hit it(medium 0.62) executable=yes(0.74) owner=M5(high 1.00)` |
| E-56 | M5→M5 | `59ce5f0d1c4b6644` | 是 | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(medium 0.70) likelihood=occasional(medium 0.70) executable=yes(0.76) owner=M5(high 1.00)` |
| E-57 | M5→M5 | `3184b611bf5888e3` | 是 | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(medium 0.73) likelihood=routine, many users will hit it(low 0.35) executable=yes(0.74) owner=M5(high 1.00)` |
| E-58 | M5→M5 | `94b8e7dbbce2388f` | 是 | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(high 0.82) likelihood=occasional(low 0.46) executable=yes(0.65) owner=M5(high 1.00)` |
| E-59 | M5→M5 | `080579fe63eaaf45` | — | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(high 0.85) likelihood=rare, needs deliberate misuse(high 0.93) executable=yes(0.87) owner=M5(high 0.99)` |
| E-60 | M5→M5 | `3609aeb6ec90bda8` | — | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(high 0.97) likelihood=rare, needs deliberate misuse(high 0.83) executable=unsure(0.49) owner=M5(high 1.00)` |
| E-61 | M6→M6 | `e47871cf8b7fe1b3` | 是 | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(medium 0.71) likelihood=routine, many users will hit it(low 0.49) executable=unsure(0.50) owner=M6(high 0.77)` |
| E-62 | M6→M5 | `4684445500f917a8` | 是 | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(medium 0.67) likelihood=routine, many users will hit it(medium 0.70) executable=unsure(0.57) owner=M5(medium 0.55)` |
| E-63 | M6→M6 | `9dbafe50ed10a0ef` | 是 | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(low 0.31) likelihood=routine, many users will hit it(low 0.41) executable=unsure(0.56) owner=M6(high 0.76)` |
| E-64 | M6→M6 | `60f666abeecadb62` | 是 | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(low 0.46) likelihood=routine, many users will hit it(low 0.39) executable=yes(0.67) owner=M6(high 0.87)` |
| E-65 | M6→M6 | `34da4a0d2a93e8a6` | — | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(low 0.17) likelihood=rare, needs deliberate misuse(low 0.38) executable=yes(0.77) owner=M6(high 0.98)` |
| E-66 | M6→M6 | `ef3ee744b202da27` | — | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(high 1.00) likelihood=rare, needs deliberate misuse(medium 0.62) executable=unsure(0.51) owner=M6(high 0.91)` |
| E-67 | M6→M6 | `b6f230fb4f80f55e` | — | `edge: severity=a feature degrades or a user is blocked until retry(high 0.94) likelihood=occasional(high 0.80) executable=yes(0.77) owner=M6(high 0.98)` |
| E-68 | M3→M3 | `410fceccc53f8c1c` | 是 | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(high 1.00) likelihood=occasional(low 0.47) executable=yes(0.72) owner=M3(high 1.00)` |
| E-69 | M3→M3 | `8df178b0f2652c76` | 是 | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(high 0.97) likelihood=routine, many users will hit it(low 0.49) executable=yes(0.72) owner=M3(high 1.00)` |
| E-70 | M3→M3 | `e4608a59689ac509` | 是 | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(high 1.00) likelihood=occasional(medium 0.70) executable=yes(0.68) owner=M3(high 0.98)` |
| E-71 | M3→M3 | `5b775522606e9a9d` | 是 | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(high 0.97) likelihood=routine, many users will hit it(high 0.83) executable=yes(0.65) owner=M3(high 0.99)` |
| E-72 | M3→M3 | `e4717b0457329788` | 是 | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(high 0.94) likelihood=occasional(medium 0.58) executable=yes(0.69) owner=M3(high 1.00)` |
| E-73 | M3→M3 | `8d845cd0594a045b` | — | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(high 1.00) likelihood=rare, needs deliberate misuse(medium 0.67) executable=yes(0.68) owner=M3(high 1.00)` |
| E-74 | M3→M3 | `824c73dcfe8466d3` | 是 | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(high 1.00) likelihood=occasional(medium 0.52) executable=yes(0.70) owner=M3(high 1.00)` |
| E-75 | M3→M3 | `d10709315c941563` | 是 | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(high 0.94) likelihood=occasional(high 0.85) executable=unsure(0.55) owner=M3(high 1.00)` |
| E-76 | M4→M4 | `dd2750e52e731fae` | — | `edge: severity=a feature degrades or a user is blocked until retry(high 0.90) likelihood=routine, many users will hit it(high 0.88) executable=yes(0.72) owner=M4(high 0.99)` |
| E-77 | M4→M4 | `a3e5442f8554eca2` | 是 | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(medium 0.69) likelihood=occasional(low 0.23) executable=yes(0.70) owner=M4(high 0.99)` |
| E-78 | M4→M4 | `83039825be6bc211` | 是 | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(high 1.00) likelihood=occasional(low 0.35) executable=yes(0.76) owner=M4(high 0.97)` |
| E-79 | M4→M4 | `87275c34858a90ae` | 是 | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(low 0.25) likelihood=occasional(medium 0.59) executable=unsure(0.51) owner=M4(high 0.99)` |
| E-80 | M5→M5 | `fa2fcd1839971c7a` | 是 | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(high 0.91) likelihood=routine, many users will hit it(low 0.34) executable=yes(0.73) owner=M5(high 1.00)` |
| E-81 | M5→M5 | `f7f3874093846222` | 是 | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(high 0.97) likelihood=occasional(medium 0.53) executable=yes(0.71) owner=M5(high 0.98)` |
| E-82 | M5→M5 | `ff4eb15c5b2ed229` | 是 | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(medium 0.61) likelihood=routine, many users will hit it(high 0.85) executable=unsure(0.44) owner=M5(high 1.00)` |
| E-83 | M5→M5 | `1313f42e80235d34` | 是 | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(high 0.95) likelihood=occasional(low 0.28) executable=yes(0.69) owner=M5(high 1.00)` |
| E-84 | M5→M5 | `45b5e6099fba2f78` | — | `edge: severity=a feature degrades or a user is blocked until retry(low 0.46) likelihood=occasional(low 0.34) executable=yes(0.72) owner=M5(low 0.41)` |
| E-85 | M4→M4 | `c5499b017938a7e9` | 是 | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(high 0.90) likelihood=routine, many users will hit it(low 0.43) executable=yes(0.71) owner=M4(medium 0.50)` |
| E-86 | M4→M5 | `08756e1eb651fde1` | 是 | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(medium 0.71) likelihood=occasional(low 0.44) executable=yes(0.84) owner=M5(high 0.76)` |
| E-87 | M4→M5 | `719ed53dd37b1a79` | 是 | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(high 0.91) likelihood=occasional(low 0.35) executable=yes(0.67) owner=M5(high 0.98)` |
| E-88 | M4→M5 | `0a2e204c0921ba67` | 是 | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(high 1.00) likelihood=occasional(low 0.47) executable=unsure(0.57) owner=M5(medium 0.70)` |
| E-89 | M4→M4 | `f343b3d109465fdc` | 是 | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(high 0.79) likelihood=routine, many users will hit it(medium 0.62) executable=yes(0.75) owner=M4(high 0.99)` |
| E-90 | M4→M4 | `63432c141ba2aabf` | — | `edge: severity=a feature degrades or a user is blocked until retry(low 0.31) likelihood=occasional(medium 0.74) executable=yes(0.76) owner=M4(high 0.94)` |
| E-91 | M4→M4 | `4eba19b4fb63b15d` | 是 | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(high 0.85) likelihood=occasional(medium 0.64) executable=yes(0.65) owner=M4(medium 0.70)` |
| E-92 | M4→M7 | `5926e1f3da775260` | — | `edge: severity=a feature degrades or a user is blocked until retry(low 0.34) likelihood=occasional(high 0.78) executable=unsure(0.49) owner=M7(high 0.85)` |
| E-93 | M4→M7 | `e631625cff022e05` | 是 | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(low 0.43) likelihood=occasional(medium 0.74) executable=unsure(0.57) owner=M7(medium 0.61)` |
| E-94 | M4→M7 | `e9e4cf23860232e4` | — | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(high 1.00) likelihood=rare, needs deliberate misuse(medium 0.73) executable=unsure(0.60) owner=M7(medium 0.59)` |
| E-95 | M3→M3 | `942e8443e275ef7d` | 是 | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(medium 0.69) likelihood=routine, many users will hit it(low 0.30) executable=yes(0.79) owner=M3(high 1.00)` |
| E-96 | M3→M3 | `3dd8cba219483abc` | 是 | `edge: severity=data is lost or corrupted, money moves wrongly, or a permission is bypassed(high 0.97) likelihood=occasional(low 0.27) executable=unsure(0.62) owner=M3(high 1.00)` |
| E-97 | M2→M2 | `4b58aa08b9487574` | — | `edge: severity=a feature degrades or a user is blocked until retry(high 0.88) likelihood=occasional(low 0.34) executable=yes(0.81) owner=M2(high 1.00)` |
| E-98 | M2→M2 | `c6fb49f3a7b4babb` | — | `edge: severity=a feature degrades or a user is blocked until retry(high 0.90) likelihood=routine, many users will hit it(high 0.85) executable=yes(0.83) owner=M2(high 1.00)` |
| E-99 | M2→M2 | `cc537a90db3f0775` | — | `edge: severity=a feature degrades or a user is blocked until retry(low 0.49) likelihood=routine, many users will hit it(high 0.82) executable=yes(0.75) owner=M2(high 0.91)` |
| E-100 | M2→M2 | `a79999d476ece5f3` | — | `edge: severity=a feature degrades or a user is blocked until retry(high 0.83) likelihood=routine, many users will hit it(medium 0.66) executable=yes(0.70) owner=M2(high 0.97)` |
| E-101 | M2→M2 | `50008f5e51ae405d` | — | `edge: severity=a feature degrades or a user is blocked until retry(high 0.97) likelihood=occasional(medium 0.53) executable=yes(0.70) owner=M2(high 1.00)` |
| E-102 | M2→M2 | `8e3aac49a13ee36b` | — | `edge: severity=a feature degrades or a user is blocked until retry(high 0.93) likelihood=routine, many users will hit it(high 0.90) executable=unsure(0.64) owner=M2(high 1.00)` |
| E-103 | M2→M2 | `1fc32420920fb445` | — | `edge: severity=a feature degrades or a user is blocked until retry(high 0.94) likelihood=occasional(high 0.78) executable=unsure(0.60) owner=M2(high 0.98)` |
| E-104 | M2→M2 | `c6f0b42de689f67e` | — | `edge: severity=a feature degrades or a user is blocked until retry(high 0.76) likelihood=routine, many users will hit it(high 0.78) executable=unsure(0.62) owner=M2(high 1.00)` |

## 最终完整性核验

- 104个state、104个完整JSON响应、104个单记录独立日志、104个退出码0均已核验。
- 104个真实state_sha256均与本地实际输入一致；日志与响应model/verdicts/usage逐项一致。
- 104个state未含中日韩文字；没有language_warning，职责描述共832字符；状态场景、触发、期望按中文源行顺序逐句翻译。
- 已提供1条no的完整最小改写、27条unsure建议、9项职责分歧源解释、53项17节优先输入。
- 未写13、未修改ledger/产品/主judgments，未调用真人，未执行任何生产清理。
